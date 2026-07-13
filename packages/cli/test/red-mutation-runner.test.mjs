import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  applyExactEdits,
  parseRunnerArgs,
  runRepositoryMutationCase,
  selectRegisteredRedCases,
} from "../src/check/red-mutation-runner.mjs";

const git = (root, args) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

const withRepo = (run) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentos-red-runner-test-"));
  fs.writeFileSync(path.join(root, "data.txt"), "good\n");
  fs.writeFileSync(
    path.join(root, "checker.mjs"),
    [
      'import fs from "node:fs";',
      'if (process.argv[2] !== undefined && !process.argv[2].startsWith("$(touch ")) process.exit(9);',
      'if (fs.readFileSync("data.txt", "utf8") === "bad\\n") {',
      '  console.error("semantic marker");',
      "  process.exit(1);",
      "}",
      "",
    ].join("\n"),
  );
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "proof@example.invalid"]);
  git(root, ["config", "user.name", "Proof Test"]);
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "test: seed proof fixture"]);
  try {
    return run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
};

const proofEntry = (extraArg) => ({
  ruleId: "fixture-rule",
  proof: {
    command: {
      cwd: ".",
      argv: ["node", "checker.mjs", ...(extraArg === undefined ? [] : [extraArg])],
      dependencyMode: "linked",
    },
    positive: { expectedExitCode: 0 },
  },
});
const redCase = (outputIncludes = "semantic marker") => ({
  id: "reject-bad",
  edits: [{ op: "replace", path: "data.txt", before: "good\n", after: "bad\n" }],
  expected: { exitCode: 1, outputIncludes },
});

void test("runs one exact mutation in a detached worktree and leaves the source unchanged", () =>
  withRepo((root) => {
    const result = runRepositoryMutationCase({
      sourceRoot: root,
      entry: proofEntry(),
      redCase: redCase(),
    });
    assert.deepEqual(result, {
      ruleId: "fixture-rule",
      caseId: "reject-bad",
      status: "rejected",
    });
    assert.equal(fs.readFileSync(path.join(root, "data.txt"), "utf8"), "good\n");
    assert.equal(git(root, ["status", "--porcelain=v1"]), "");
    assert.doesNotMatch(git(root, ["worktree", "list", "--porcelain"]), /agentos-red-mutation/u);
  }));

void test("does not count an already-red baseline as mutation proof", () =>
  withRepo((root) => {
    fs.writeFileSync(path.join(root, "data.txt"), "bad\n");
    git(root, ["add", "data.txt"]);
    git(root, ["commit", "-qm", "test: make baseline red"]);
    assert.throws(
      () =>
        runRepositoryMutationCase({
          sourceRoot: root,
          entry: proofEntry(),
          redCase: {
            ...redCase(),
            edits: [{ op: "replace", path: "data.txt", before: "bad\n", after: "worse\n" }],
          },
        }),
      /positive baseline: expected exit 0, observed 1/u,
    );
  }));

void test("requires exact one-match edits and rejects escaping paths", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentos-red-edit-test-"));
  try {
    fs.writeFileSync(path.join(root, "data.txt"), "same same\n");
    assert.throws(
      () =>
        applyExactEdits({
          root,
          edits: [{ op: "replace", path: "data.txt", before: "same", after: "changed" }],
        }),
      /expected one match, observed 2/u,
    );
    assert.throws(
      () =>
        applyExactEdits({
          root,
          edits: [{ op: "create", path: "../escape.txt", content: "bad" }],
        }),
      /unsafe red mutation path/u,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

void test("passes argv literally without shell expansion and cleans up failed diagnostics", () =>
  withRepo((root) => {
    const sentinel = path.join(root, "sentinel");
    const literal = `$(touch ${sentinel})`;
    assert.throws(
      () =>
        runRepositoryMutationCase({
          sourceRoot: root,
          entry: proofEntry(literal),
          redCase: redCase("wrong marker"),
        }),
      /missing diagnostic wrong marker/u,
    );
    assert.equal(fs.existsSync(sentinel), false);
    assert.equal(git(root, ["status", "--porcelain=v1"]), "");
    assert.doesNotMatch(git(root, ["worktree", "list", "--porcelain"]), /agentos-red-mutation/u);
  }));

void test("fails closed when a red-case filter selects zero cases", () => {
  assert.throws(
    () =>
      selectRegisteredRedCases({
        coverage: {
          entries: [
            {
              ruleId: "fixture-rule",
              proof: { kind: "algorithmic", redCases: [redCase()] },
            },
          ],
        },
        ruleId: "fixture-rule",
        caseKind: "invalidInputFixture",
      }),
    /no red mutation cases matched invalidInputFixture/u,
  );
});

void test("parses a closed runner CLI grammar", () => {
  assert.deepEqual(parseRunnerArgs(["--all"]), { ruleId: undefined, caseKind: undefined });
  assert.deepEqual(parseRunnerArgs(["--rule", "public-api", "--kind", "repositoryMutation"]), {
    ruleId: "public-api",
    caseKind: "repositoryMutation",
  });
  assert.throws(() => parseRunnerArgs(["--all", "--rule", "public-api"]), /exactly one/u);
  assert.throws(() => parseRunnerArgs(["--all", "--unknown"]), /unknown argument/u);
  assert.throws(() => parseRunnerArgs(["--all", "--kind", "fixture"]), /unknown red case kind/u);
  assert.throws(() => parseRunnerArgs(["--rule"]), /requires a value/u);
});
