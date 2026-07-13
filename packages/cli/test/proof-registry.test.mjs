import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  algorithmicCheckerComponents,
  algorithmicCheckerSource,
  hasAlgorithmicChecker,
} from "../src/check/algorithmic-checks.mjs";
import { proofRegistryFailures } from "../src/check/proof-registry.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const readJson = (relativePath) =>
  JSON.parse(fs.readFileSync(path.join(repoRoot, relativePath), "utf8"));
const baseline = () => ({
  coverage: readJson("packages/cli/src/check/check-coverage.source.json"),
  rulesSource: readJson("docs/agent/boundary-rules.source.json"),
});
const failuresFor = ({ coverage, rulesSource }, overrides = {}) =>
  proofRegistryFailures({
    coverage,
    rulesSource,
    repoRoot,
    hasAlgorithmicChecker: overrides.hasAlgorithmicChecker ?? hasAlgorithmicChecker,
    algorithmicCheckerSource: overrides.algorithmicCheckerSource ?? algorithmicCheckerSource,
    algorithmicCheckerComponents:
      overrides.algorithmicCheckerComponents ?? algorithmicCheckerComponents,
  });

void test("accepts the single Phase O proof registry", () => {
  assert.deepEqual(failuresFor(baseline()), []);
});

void test("freezes the post-cut inventory at 56 semantic proofs and one gate composition", () => {
  const { coverage, rulesSource } = baseline();
  assert.equal(coverage.entries.length, 57);
  assert.equal(rulesSource.rules.length, 57);
  assert.deepEqual(
    new Set(coverage.entries.map((entry) => entry.ruleId)),
    new Set(rulesSource.rules.map((rule) => rule.id)),
  );
  const proofKindCounts = coverage.entries.reduce((counts, entry) => {
    counts[entry.proof.kind] = (counts[entry.proof.kind] ?? 0) + 1;
    return counts;
  }, {});
  assert.deepEqual(proofKindCounts, {
    algorithmic: 19,
    gateComposition: 1,
    generatedProjection: 3,
    packageTest: 34,
  });
  assert.deepEqual(
    coverage.entries
      .filter((entry) => entry.proof.kind === "gateComposition")
      .map((entry) => entry.ruleId),
    ["convergence-boundary"],
  );
});

void test("deletes obsolete aliases from rules, coverage, groups, and checker dispatch", () => {
  const { coverage, rulesSource } = baseline();
  const obsolete = new Set(["boundaries", "d12-a155-substrate-absorption"]);
  const groupedRuleIds = Object.values(rulesSource.commandGroups)
    .flat()
    .filter((step) => step.type === "rule")
    .map((step) => step.id);
  assert.equal(
    rulesSource.rules.some((rule) => obsolete.has(rule.id)),
    false,
  );
  assert.equal(
    coverage.entries.some((entry) => obsolete.has(entry.ruleId)),
    false,
  );
  assert.equal(
    groupedRuleIds.some((ruleId) => obsolete.has(ruleId)),
    false,
  );
  for (const ruleId of obsolete) assert.equal(hasAlgorithmicChecker(ruleId), false, ruleId);
});

void test("keeps the positive registry in the structural gate", () => {
  const missingReference = baseline();
  missingReference.rulesSource.commandGroups.all =
    missingReference.rulesSource.commandGroups.all.filter(
      (step) => step.type !== "group" || step.id !== "guard-coverage",
    );
  assert.ok(
    failuresFor(missingReference).some((failure) =>
      failure.includes("commandGroups.all must include guard-coverage exactly once"),
    ),
  );

  const replacedCommand = baseline();
  replacedCommand.rulesSource.commandGroups["guard-coverage"][0].command = "vp fmt --check";
  assert.ok(
    failuresFor(replacedCommand).some((failure) =>
      failure.includes("commandGroups.guard-coverage must own the positive registry command"),
    ),
  );
});

void test("rejects a missing live proof source", () => {
  const input = baseline();
  input.coverage.entries.find((entry) => entry.ruleId === "public-api").source.path =
    "packages/cli/src/check/algorithmic/phase-o-missing.mjs";
  assert.ok(
    failuresFor(input).some((failure) => failure.includes("live proof source does not exist")),
  );
});

void test("rejects unverifiable historical provenance", () => {
  const input = baseline();
  input.coverage.entries.find((entry) => entry.ruleId === "public-api").source = {
    kind: "historical",
    commit: "0".repeat(40),
    path: "packages/cli/src/check/algorithmic/repo-surface-checks.mjs",
    supersededBy: "public-api",
  };
  assert.ok(
    failuresFor(input).some((failure) =>
      failure.includes("historical proof source does not exist"),
    ),
  );
});

void test("accepts immutable historical provenance bound to each current proof class", () => {
  const commit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim();
  const cases = [
    ["public-api", "packages/cli/src/check/algorithmic/repo-surface-checks.mjs"],
    ["agent-routes", "packages/cli/src/generate/generate-agent-docs.mjs"],
    ["workspace-job", "packages/runtime/test/_workspace-job-data-plane-cases.ts"],
  ];
  for (const [ruleId, sourcePath] of cases) {
    const input = baseline();
    input.coverage.entries.find((entry) => entry.ruleId === ruleId).source = {
      kind: "historical",
      commit,
      path: sourcePath,
      supersededBy: ruleId,
    };
    assert.deepEqual(failuresFor(input), [], ruleId);
  }
});

void test("binds historical supersession to the current rule identity", () => {
  const input = baseline();
  input.coverage.entries.find((entry) => entry.ruleId === "public-api").source = {
    kind: "historical",
    commit: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim(),
    path: "packages/cli/src/check/algorithmic/repo-surface-checks.mjs",
    supersededBy: "different-rule",
  };
  assert.ok(
    failuresFor(input).some((failure) =>
      failure.includes("historical source supersededBy must equal the current rule id"),
    ),
  );
});

void test("rejects a historical tree masquerading as a source file", () => {
  const input = baseline();
  input.coverage.entries.find((entry) => entry.ruleId === "public-api").source = {
    kind: "historical",
    commit: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim(),
    path: "packages",
    supersededBy: "public-api",
  };
  assert.ok(
    failuresFor(input).some((failure) =>
      failure.includes("historical proof source must be an immutable file blob"),
    ),
  );
});

void test("rejects a historical tree id masquerading as a commit", () => {
  const input = baseline();
  input.coverage.entries.find((entry) => entry.ruleId === "public-api").source = {
    kind: "historical",
    commit: execFileSync("git", ["rev-parse", "HEAD^{tree}"], {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim(),
    path: "package.json",
    supersededBy: "public-api",
  };
  assert.ok(
    failuresFor(input).some((failure) =>
      failure.includes("historical source commit must be an immutable commit object"),
    ),
  );
});

void test("rejects mechanical or red-less semantic proof", () => {
  const mechanical = baseline();
  mechanical.coverage.entries.find((entry) => entry.ruleId === "public-api").proof.kind =
    "formatter";
  assert.ok(
    failuresFor(mechanical).some((failure) => failure.includes("unsupported proof kind formatter")),
  );

  const redLess = baseline();
  redLess.coverage.entries.find((entry) => entry.ruleId === "public-api").proof.redCases = [];
  assert.ok(
    failuresFor(redLess).some((failure) =>
      failure.includes("requires at least one executable red case"),
    ),
  );
});

void test("rejects transition-era fields instead of silently accepting a second authority", () => {
  const mutations = [
    ["transition", (input) => (input.coverage.transition = {})],
    [
      "target",
      (input) =>
        (input.coverage.entries.find((entry) => entry.ruleId === "public-api").target = {}),
    ],
    [
      "assertions",
      (input) =>
        (input.coverage.entries.find((entry) => entry.ruleId === "public-api").assertions = []),
    ],
    [
      "targetTransition",
      (input) =>
        (input.coverage.entries.find(
          (entry) => entry.ruleId === "public-api",
        ).proof.targetTransition = {}),
    ],
  ];
  for (const [field, mutate] of mutations) {
    const input = baseline();
    mutate(input);
    assert.ok(
      failuresFor(input).some((failure) => failure.includes(`unexpected field ${field}`)),
      field,
    );
  }
});

void test("rejects unsupported and mechanical proof kinds", () => {
  for (const kind of ["unsupported", "formatter"]) {
    const input = baseline();
    input.coverage.entries.find((entry) => entry.ruleId === "public-api").proof.kind = kind;
    assert.ok(
      failuresFor(input).some((failure) => failure.includes(`unsupported proof kind ${kind}`)),
      kind,
    );
  }
});

void test("classifies gate composition from checker metadata in both directions", () => {
  const semanticAsComposition = baseline();
  semanticAsComposition.coverage.entries.find((entry) => entry.ruleId === "public-api").proof.kind =
    "gateComposition";
  assert.ok(
    failuresFor(semanticAsComposition).some((failure) =>
      failure.includes("gateComposition proof requires a non-empty component-bearing checker"),
    ),
  );

  const compositionAsSemantic = baseline();
  compositionAsSemantic.coverage.entries.find(
    (entry) => entry.ruleId === "convergence-boundary",
  ).proof.kind = "algorithmic";
  assert.ok(
    failuresFor(compositionAsSemantic).some((failure) =>
      failure.includes("component-bearing checker requires gateComposition proof"),
    ),
  );
});

void test("requires unique registered composition components with source metadata", () => {
  const input = baseline();
  const duplicateComponents = (checkerId) =>
    checkerId === "convergence-boundary"
      ? ["client-boundaries", "client-boundaries"]
      : algorithmicCheckerComponents(checkerId);
  assert.ok(
    failuresFor(input, { algorithmicCheckerComponents: duplicateComponents }).some((failure) =>
      failure.includes("gate composition components must be unique"),
    ),
  );

  const missingSource = (checkerId) =>
    checkerId === "client-boundaries" ? undefined : algorithmicCheckerSource(checkerId);
  assert.ok(
    failuresFor(input, { algorithmicCheckerSource: missingSource }).some((failure) =>
      failure.includes("gate composition component lacks source metadata: client-boundaries"),
    ),
  );

  const invalidSource = (checkerId) =>
    checkerId === "client-boundaries"
      ? { path: "packages/cli/src/check/algorithmic/missing-component.mjs", symbol: "missing" }
      : algorithmicCheckerSource(checkerId);
  assert.ok(
    failuresFor(input, { algorithmicCheckerSource: invalidSource }).some((failure) =>
      failure.includes(
        "live proof source does not exist: packages/cli/src/check/algorithmic/missing",
      ),
    ),
  );
});

void test("binds algorithmic source path and symbol to dispatcher metadata", () => {
  const input = baseline();
  const entry = input.coverage.entries.find((candidate) => candidate.ruleId === "public-api");
  entry.source = {
    kind: "live",
    path: "packages/cli/src/check/algorithmic/runtime-structural-checks.mjs",
    selector: { kind: "symbol", value: "checkBackendNeutrality" },
  };
  assert.ok(
    failuresFor(input).some((failure) =>
      failure.includes("algorithmic source must match the registered checker"),
    ),
  );
});

void test("binds generated source to the invoked generator", () => {
  const input = baseline();
  const entry = input.coverage.entries.find((candidate) => candidate.ruleId === "agent-routes");
  entry.source.path = "packages/cli/src/generate/generate-carrier-reference.mjs";
  assert.ok(
    failuresFor(input).some((failure) =>
      failure.includes("generated source must be the generator invoked"),
    ),
  );
});

void test("binds package entrypoint, selector, and helper import closure", () => {
  const selectorInput = baseline();
  const selectorEntry = selectorInput.coverage.entries.find(
    (candidate) => candidate.ruleId === "workspace-job",
  );
  selectorEntry.proof.command.argv[selectorEntry.proof.command.argv.length - 1] =
    "missing selector";
  assert.ok(
    failuresFor(selectorInput).some((failure) =>
      failure.includes("package source selector must equal the command -t selector"),
    ),
  );

  const closureInput = baseline();
  const closureEntry = closureInput.coverage.entries.find(
    (candidate) => candidate.ruleId === "workspace-job",
  );
  closureEntry.source.path = "packages/runtime/test/_submit-agent-material-cases.ts";
  assert.ok(
    failuresFor(closureInput).some((failure) =>
      failure.includes("package source must be in the entrypoint import closure"),
    ),
  );
});

void test("binds boundary acceptance directly to the proof command", () => {
  const checkerInput = baseline();
  checkerInput.rulesSource.rules.find(
    (rule) => rule.id === "backend-provider-axis-boundary",
  ).acceptance.checker = "backend-neutrality";
  assert.ok(
    failuresFor(checkerInput).some((failure) =>
      failure.includes(
        "backend-provider-axis-boundary: boundary rule acceptance must match algorithmic proof checker",
      ),
    ),
  );

  const engineInput = baseline();
  engineInput.rulesSource.rules.find((rule) => rule.id === "workspace-job").acceptance.engine =
    "algorithmic";
  assert.ok(
    failuresFor(engineInput).some((failure) =>
      failure.includes("boundary rule acceptance must use proofClass for packageTest proof"),
    ),
  );
});

void test("derives package proof tier from the focused command", () => {
  const testAsRuntime = baseline();
  testAsRuntime.rulesSource.rules.find(
    (rule) => rule.id === "workspace-job",
  ).acceptance.proofClasses = ["runtime"];
  assert.ok(
    failuresFor(testAsRuntime).some((failure) =>
      failure.includes(
        "workspace-job: boundary rule proofClasses must equal derived package test tier test",
      ),
    ),
  );

  const runtimeAsTest = baseline();
  runtimeAsTest.rulesSource.rules.find(
    (rule) => rule.id === "node-postgres-effect-governance",
  ).acceptance.proofClasses = ["test"];
  assert.ok(
    failuresFor(runtimeAsTest).some((failure) =>
      failure.includes(
        "node-postgres-effect-governance: boundary rule proofClasses must equal derived package test tier runtime",
      ),
    ),
  );

  const crossedRuntimeConfig = baseline();
  const argv = crossedRuntimeConfig.coverage.entries.find(
    (entry) => entry.ruleId === "node-postgres-effect-governance",
  ).proof.command.argv;
  argv[argv.indexOf("vitest.node.config.ts")] = "vitest.cloudflare.config.ts";
  assert.ok(
    failuresFor(crossedRuntimeConfig).some((failure) =>
      failure.includes("config and entrypoint must select one canonical runtime tier"),
    ),
  );
});
