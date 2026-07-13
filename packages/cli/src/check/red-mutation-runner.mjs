#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  algorithmicCheckerComponents,
  algorithmicCheckerSource,
  hasAlgorithmicChecker,
} from "./algorithmic-checks.mjs";
import { proofRegistryFailures } from "./proof-registry.mjs";

const defaultRepoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const ansi = /\u001b\[[0-?]*[ -/]*[@-~]/gu;

const cleanOutput = (value) => String(value ?? "").replace(ansi, "");
const combinedOutput = (result) => `${cleanOutput(result.stdout)}${cleanOutput(result.stderr)}`;
const git = (root, args, options = {}) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8", ...options });

const assertInside = (root, candidate, label) => {
  const relative = path.relative(root, candidate);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return;
  throw new Error(`${label} escapes the proof worktree`);
};

const resolveEditPath = (root, relativePath) => {
  if (path.isAbsolute(relativePath) || relativePath.split(/[\\/]/u).includes("..")) {
    throw new Error(`unsafe red mutation path: ${relativePath}`);
  }
  const target = path.resolve(root, relativePath);
  assertInside(root, target, relativePath);
  let ancestor = path.dirname(target);
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  assertInside(fs.realpathSync(root), fs.realpathSync(ancestor), relativePath);
  if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) {
    throw new Error(`red mutation target must not be a symlink: ${relativePath}`);
  }
  return target;
};

export const applyExactEdits = ({ root, edits }) => {
  const paths = [];
  for (const edit of edits) {
    const target = resolveEditPath(root, edit.path);
    if (edit.op === "replace") {
      if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
        throw new Error(`red mutation source is not a file: ${edit.path}`);
      }
      const source = fs.readFileSync(target, "utf8");
      const occurrences = source.split(edit.before).length - 1;
      if (occurrences !== 1) {
        throw new Error(
          `${edit.path}: exact red mutation expected one match, observed ${occurrences}`,
        );
      }
      fs.writeFileSync(target, source.replace(edit.before, edit.after));
    } else if (edit.op === "create") {
      if (fs.existsSync(target)) throw new Error(`red mutation create target exists: ${edit.path}`);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, edit.content);
    } else {
      throw new Error(`unsupported red mutation edit ${String(edit.op)}`);
    }
    if (edit.stage === true) git(root, ["add", "--force", "--", edit.path]);
    paths.push(edit.path);
  }
  return [...new Set(paths)].sort();
};

export const runArgv = ({ root, command }) => {
  const [rawExecutable, ...args] = command.argv;
  const executable = rawExecutable === "node" ? process.execPath : rawExecutable;
  return spawnSync(executable, args, {
    cwd: path.join(root, command.cwd),
    encoding: "utf8",
    shell: false,
    env: {
      ...process.env,
      CI: "true",
      PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN: "false",
    },
  });
};

const assertResult = ({ result, expected, label }) => {
  if (result.error !== undefined) throw result.error;
  if (result.status !== expected.exitCode) {
    throw new Error(
      `${label}: expected exit ${expected.exitCode}, observed ${String(result.status)}\n${combinedOutput(result)}`,
    );
  }
  const output = combinedOutput(result);
  if (expected.outputIncludes !== undefined && !output.includes(expected.outputIncludes)) {
    throw new Error(`${label}: missing diagnostic ${expected.outputIncludes}\n${output}`);
  }
  if (expected.minPassedTests !== undefined) {
    const counts = [...output.matchAll(/Tests\s+(\d+) passed/gu)].map((match) => Number(match[1]));
    if (counts.length === 0 || Math.max(...counts) < expected.minPassedTests) {
      throw new Error(`${label}: focused package test did not execute\n${output}`);
    }
  }
};

const statusPaths = (root) =>
  git(root, ["status", "--porcelain=v1", "--untracked-files=all"])
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(3).split(" -> ").at(-1))
    .sort();

const linkDependencies = (sourceRoot, worktree) => {
  const source = path.join(sourceRoot, "node_modules");
  const target = path.join(worktree, "node_modules");
  if (fs.existsSync(source) && !fs.existsSync(target)) fs.symlinkSync(source, target, "dir");
};

const copyPreparedPaths = (sourceRoot, worktree, relativePaths = []) => {
  for (const relativePath of relativePaths) {
    const source = resolveEditPath(sourceRoot, relativePath);
    if (!fs.existsSync(source)) {
      throw new Error(`prepared proof artifact is missing: ${relativePath}`);
    }
    const target = path.join(worktree, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(source, target, { recursive: true });
  }
};

const installDependencies = (worktree) => {
  const result = spawnSync("pnpm", ["install", "--offline", "--frozen-lockfile"], {
    cwd: worktree,
    encoding: "utf8",
    shell: false,
    env: { ...process.env, CI: "true" },
  });
  assertResult({ result, expected: { exitCode: 0 }, label: "isolated dependency install" });
};

const withDetachedWorktree = ({ sourceRoot, command, run }) => {
  const before = git(sourceRoot, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (before !== "") throw new Error("red mutation source checkout must be clean");
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "agentos-red-mutation-"));
  const worktree = path.join(parent, "worktree");
  let added = false;
  let value;
  let runError;
  try {
    git(sourceRoot, ["worktree", "add", "--detach", worktree, "HEAD"], { stdio: "pipe" });
    added = true;
    if (command.dependencyMode === "isolatedInstall") installDependencies(worktree);
    else linkDependencies(sourceRoot, worktree);
    copyPreparedPaths(sourceRoot, worktree, command.copyPaths);
    value = run(worktree);
  } catch (error) {
    runError = error;
  }

  let cleanupError;
  try {
    if (added) {
      git(sourceRoot, ["worktree", "remove", "--force", worktree], { stdio: "pipe" });
    }
  } catch (error) {
    cleanupError = error;
  } finally {
    git(sourceRoot, ["worktree", "prune"], { stdio: "pipe" });
    fs.rmSync(parent, { recursive: true, force: true });
  }
  const after = git(sourceRoot, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (after !== before) throw new Error("red mutation changed the source checkout");
  if (runError !== undefined) throw runError;
  if (cleanupError !== undefined) throw cleanupError;
  return value;
};

export const runRepositoryMutationCase = ({ sourceRoot, entry, redCase }) =>
  withDetachedWorktree({
    sourceRoot,
    command: entry.proof.command,
    run: (worktree) => {
      const baseline = runArgv({ root: worktree, command: entry.proof.command });
      assertResult({
        result: baseline,
        expected: {
          exitCode: entry.proof.positive.expectedExitCode,
          minPassedTests: entry.proof.positive.minPassedTests,
        },
        label: `${entry.ruleId} positive baseline`,
      });
      const expectedPaths = applyExactEdits({ root: worktree, edits: redCase.edits });
      const observedPaths = statusPaths(worktree);
      if (JSON.stringify(observedPaths) !== JSON.stringify(expectedPaths)) {
        throw new Error(
          `${entry.ruleId}/${redCase.id}: mutation paths ${JSON.stringify(observedPaths)} do not match ${JSON.stringify(expectedPaths)}`,
        );
      }
      const red = runArgv({ root: worktree, command: entry.proof.command });
      assertResult({
        result: red,
        expected: redCase.expected,
        label: `${entry.ruleId}/${redCase.id}`,
      });
      return { ruleId: entry.ruleId, caseId: redCase.id, status: "rejected" };
    },
  });

export const selectRegisteredRedCases = ({ coverage, ruleId, caseKind }) => {
  const entries = coverage.entries.filter(
    (entry) =>
      entry.proof?.kind !== "unsupported" && (ruleId === undefined || entry.ruleId === ruleId),
  );
  if (entries.length === 0) throw new Error(`no proof entry matched ${ruleId ?? "selection"}`);
  const selected = entries.flatMap((entry) =>
    entry.proof.redCases
      .filter((redCase) => caseKind === undefined || redCase.kind === caseKind)
      .map((redCase) => ({ entry, redCase })),
  );
  if (selected.length === 0)
    throw new Error(`no red mutation cases matched ${caseKind ?? "selection"}`);
  return selected;
};

export const runRegisteredRedMutations = ({ sourceRoot = defaultRepoRoot, ruleId, caseKind }) => {
  const coverage = JSON.parse(
    fs.readFileSync(
      path.join(sourceRoot, "packages/cli/src/check/check-coverage.source.json"),
      "utf8",
    ),
  );
  const rulesSource = JSON.parse(
    fs.readFileSync(path.join(sourceRoot, "docs/agent/boundary-rules.source.json"), "utf8"),
  );
  const registryFailures = proofRegistryFailures({
    coverage,
    rulesSource,
    repoRoot: sourceRoot,
    hasAlgorithmicChecker,
    algorithmicCheckerSource,
    algorithmicCheckerComponents,
  });
  if (registryFailures.length > 0) {
    throw new Error(`invalid proof registry:\n${registryFailures.join("\n")}`);
  }
  const results = [];
  for (const { entry, redCase } of selectRegisteredRedCases({ coverage, ruleId, caseKind })) {
    results.push(runRepositoryMutationCase({ sourceRoot, entry, redCase }));
  }
  return results;
};

const redCaseKinds = new Set(["repositoryMutation"]);

export const parseRunnerArgs = (args) => {
  let all = false;
  let ruleId;
  let caseKind;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--all") {
      if (all) throw new Error("--all may be specified only once");
      all = true;
      continue;
    }
    if (arg === "--rule" || arg === "--kind") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      if (arg === "--rule") {
        if (ruleId !== undefined) throw new Error("--rule may be specified only once");
        ruleId = value;
      } else {
        if (caseKind !== undefined) throw new Error("--kind may be specified only once");
        if (!redCaseKinds.has(value)) throw new Error(`unknown red case kind ${value}`);
        caseKind = value;
      }
      index += 1;
      continue;
    }
    throw new Error(`unknown argument ${arg}`);
  }
  if (all === (ruleId !== undefined)) {
    throw new Error("exactly one of --all or --rule <id> is required");
  }
  return { ruleId, caseKind };
};

const isCli =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isCli) {
  try {
    const { ruleId, caseKind } = parseRunnerArgs(process.argv.slice(2));
    try {
      const results = runRegisteredRedMutations({ ruleId, caseKind });
      for (const result of results) {
        console.log(`${result.ruleId}/${result.caseId}: ${result.status}`);
      }
      console.log(`red mutation proofs passed: ${results.length}`);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error("usage: red-mutation-runner.mjs --all|--rule <id> [--kind repositoryMutation]");
    process.exitCode = 64;
  }
}
