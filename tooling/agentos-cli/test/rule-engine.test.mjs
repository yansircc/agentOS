import assert from "node:assert/strict";
import test from "node:test";
import { validateRuleAcceptance } from "../src/check/manifest-rules.mjs";

const validate = (rule) => {
  const failures = [];
  validateRuleAcceptance(rule, failures);
  return failures;
};

void test("packageCommand only accepts package-owned commands", () => {
  assert.deepEqual(
    validate({
      id: "package-owned",
      acceptance: {
        engine: "packageCommand",
        commands: ["bun run --cwd packages/runtime test -- test/projection.test.ts"],
      },
    }),
    [],
  );

  assert.match(
    validate({
      id: "repo-script",
      acceptance: {
        engine: "packageCommand",
        commands: ["node tooling/agentos-cli/src/check/check-public-api.mjs"],
      },
    }).join("\n"),
    /package-owned test command/u,
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
