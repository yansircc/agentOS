import assert from "node:assert/strict";
import test from "node:test";
import { validateRuleAcceptance } from "../src/check/manifest-rules.mjs";

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
