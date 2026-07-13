import assert from "node:assert/strict";
import os from "node:os";
import test from "node:test";
import { runRuleAcceptance, validateRuleAcceptance } from "../src/check/manifest-rules.mjs";
import { readValidatedProofRegistry, runRegisteredProof } from "../src/check/proof-runner.mjs";

const validate = (rule) => {
  const failures = [];
  validateRuleAcceptance(rule, failures);
  return failures;
};

void test("proofClass requires declared proof classes", () => {
  assert.deepEqual(
    validate({
      id: "package-proof",
      acceptance: {
        engine: "proofClass",
        proofClasses: ["test"],
      },
    }),
    [],
  );

  assert.match(
    validate({
      id: "missing-proof-class",
      acceptance: {
        engine: "proofClass",
      },
    }).join("\n"),
    /requires non-empty proofClasses/u,
  );
});

void test("algorithmic rules must not execute package commands", () => {
  assert.match(
    validate({
      id: "algorithmic-package-command",
      acceptance: {
        engine: "algorithmic",
        checker: "event-namespaces",
        reason: "requires AST collection across package source declarations",
        packageCommands: ["pnpm --filter @agent-os/runtime test"],
      },
    }).join("\n"),
    /must not execute packageCommands/u,
  );
});

void test("algorithmic rules must declare a checker and reason", () => {
  assert.deepEqual(
    validate({
      id: "event-namespaces",
      acceptance: {
        engine: "algorithmic",
        checker: "event-namespaces",
        reason: "requires AST collection across package source declarations",
      },
    }),
    [],
  );

  assert.match(
    validate({
      id: "missing-reason",
      acceptance: {
        engine: "algorithmic",
        checker: "event-namespaces",
      },
    }).join("\n"),
    /requires reason/u,
  );
});

void test("engine set is closed", () => {
  assert.match(
    validate({
      id: "case-analysis",
      acceptance: {
        engine: "ruleSpecificEscapeHatch",
      },
    }).join("\n"),
    /acceptance.engine must be one of/u,
  );
});

void test("direct guard executes package proof while structural traversal preserves its tier", async () => {
  const registry = readValidatedProofRegistry();
  const rule = registry.rulesSource.rules.find((candidate) => candidate.id === "workspace-job");

  const structural = await runRuleAcceptance(rule, {
    execution: "structural",
    registry,
    writeOutput: false,
  });
  assert.equal(structural.executed, false);

  const direct = await runRuleAcceptance(rule, { registry, writeOutput: false });
  assert.equal(direct.executed, true);
  assert.equal(direct.result.status, 0);
  assert.match(`${direct.result.stdout}${direct.result.stderr}`, /Tests\s+\d+ passed/u);
});

void test("validated proof registry is identity- and root-bound", () => {
  const registry = readValidatedProofRegistry();
  const forged = { ...registry };
  assert.throws(
    () => runRegisteredProof({ ruleId: "workspace-job", registry: forged }),
    /validated registry for the execution root/u,
  );
  assert.throws(
    () =>
      runRegisteredProof({
        root: os.tmpdir(),
        ruleId: "workspace-job",
        registry,
      }),
    /validated registry for the execution root/u,
  );
});
