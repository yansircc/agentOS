import assert from "node:assert/strict";
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
const failuresFor = ({ coverage, rulesSource }) =>
  proofRegistryFailures({
    coverage,
    rulesSource,
    repoRoot,
    hasAlgorithmicChecker,
    algorithmicCheckerSource,
    algorithmicCheckerComponents,
  });

void test("accepts the single Phase O proof registry", () => {
  assert.deepEqual(failuresFor(baseline()), []);
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

void test("permits unsupported proof only for the two #478 deletion aliases", () => {
  const input = baseline();
  input.coverage.entries.find((entry) => entry.ruleId === "public-api").proof = {
    kind: "unsupported",
    reason: "test",
  };
  assert.ok(
    failuresFor(input).some((failure) =>
      failure.includes("unsupported proof must derive from a retiring rule transition"),
    ),
  );
});

void test("rejects a rule that adds its own retirement authority", () => {
  const input = baseline();
  const ruleId = "public-api";
  const ruleIndex = input.rulesSource.rules.findIndex((rule) => rule.id === ruleId);
  const entry = input.coverage.entries.find((candidate) => candidate.ruleId === ruleId);
  input.coverage.transition.ruleActions.push({
    ruleId,
    action: "retire",
    cutoverTask: 478,
    removalCondition: "self-authorized",
  });
  entry.source = {
    kind: "live",
    path: "docs/agent/boundary-rules.source.json",
    selector: { kind: "jsonPointer", value: `/rules/${ruleIndex}` },
  };
  entry.proof = { kind: "unsupported", reason: "self-authorized" };
  assert.ok(
    failuresFor(input).some((failure) =>
      failure.includes("public-api: Phase O transition action is not authorized before CST #478"),
    ),
  );
});

void test("freezes the exact Phase O action for each authorized transition", () => {
  const input = baseline();
  const action = input.coverage.transition.ruleActions.find(
    (candidate) => candidate.ruleId === "convergence-boundary",
  );
  action.action = "retire";
  action.removalCondition = "rewritten transition";
  assert.ok(
    failuresFor(input).some((failure) =>
      failure.includes(
        "convergence-boundary: Phase O transition action must remain gateComposition through CST #478",
      ),
    ),
  );
});

void test("requires retiring aliases to source their boundary-rule objects", () => {
  for (const ruleId of ["boundaries", "d12-a155-substrate-absorption"]) {
    const input = baseline();
    input.coverage.entries.find((entry) => entry.ruleId === ruleId).source = {
      kind: "live",
      path: "packages/cli/src/check/proof-registry.mjs",
      selector: { kind: "symbol", value: "proofRegistryFailures" },
    };
    assert.ok(
      failuresFor(input).some((failure) =>
        failure.includes(`${ruleId}: retiring rule source must be its matching`),
      ),
      ruleId,
    );
  }
});

void test("requires strict RFC 6901 syntax for retiring rule selectors", () => {
  for (const pointer of ["not-a-pointer", "/rules/18~2", "/rules/18~"]) {
    const input = baseline();
    input.coverage.entries.find((entry) => entry.ruleId === "boundaries").source.selector.value =
      pointer;
    assert.ok(
      failuresFor(input).some((failure) =>
        failure.includes("invalid JSON pointer selector syntax"),
      ),
      pointer,
    );
  }
});

void test("binds a retiring JSON pointer to the declared rule object", () => {
  for (const pointer of ["", "/rules/46"]) {
    const input = baseline();
    input.coverage.entries.find((entry) => entry.ruleId === "boundaries").source.selector.value =
      pointer;
    assert.ok(
      failuresFor(input).some((failure) =>
        failure.includes("JSON pointer selector must resolve to rule boundaries"),
      ),
      JSON.stringify(pointer),
    );
  }
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

void test("requires an exact target transition instead of prose", () => {
  const input = baseline();
  const entry = input.coverage.entries.find(
    (candidate) => candidate.ruleId === "backend-provider-axis-boundary",
  );
  entry.proof.targetTransition.to.checker = "backend-neutrality";
  assert.ok(
    failuresFor(input).some((failure) =>
      failure.includes("target transition must bind exact from/to targets"),
    ),
  );
});
