import { Effect } from "effect";
import { describe, expect, it } from "@effect/vitest";
import {
  EXTERNAL_EFFECT_CONFORMANCE_SCENARIOS,
  externalEffectConformance,
  type ExternalEffectConformanceAdapter,
  type ExternalEffectConformanceScenario,
  type ExternalEffectConformanceScenarioId,
} from "../src/testing";

const passingAdapter: ExternalEffectConformanceAdapter = {
  runScenario: (scenario) =>
    Effect.succeed({
      scenarioId: scenario.id,
      status: "passed" as const,
      summary: scenario.requirement,
    }),
};

const failingAdapter = (
  failedScenarioId: ExternalEffectConformanceScenarioId,
): ExternalEffectConformanceAdapter => ({
  runScenario: (scenario) =>
    Effect.succeed(
      scenario.id === failedScenarioId
        ? {
            scenarioId: scenario.id,
            status: "failed" as const,
            issues: [{ code: "not_observed", message: "scenario did not hold" }],
          }
        : {
            scenarioId: scenario.id,
            status: "passed" as const,
          },
    ),
});

describe("external-effect testing conformance", () => {
  it.effect("returns a passing structured report when every scenario passes", () =>
    Effect.gen(function* () {
      const report = yield* externalEffectConformance(passingAdapter);

      expect(report.status).toBe("passed");
      expect(report.failures).toEqual([]);
      expect(report.scenarios.map((entry) => entry.scenario.id)).toEqual(
        EXTERNAL_EFFECT_CONFORMANCE_SCENARIOS.map((scenario) => scenario.id),
      );
      expect(report.scenarios.every((entry) => entry.issues.length === 0)).toBe(true);
    }),
  );

  it.effect("fails the report when any required scenario fails", () =>
    Effect.gen(function* () {
      const report = yield* externalEffectConformance(
        failingAdapter("digest_or_contract_mismatch_fails_closed"),
      );

      expect(report.status).toBe("failed");
      expect(report.failures).toHaveLength(1);
      expect(report.failures[0]).toMatchObject({
        status: "failed",
        scenario: { id: "digest_or_contract_mismatch_fails_closed" },
        issues: [{ code: "not_observed" }],
      });
    }),
  );

  it.effect("fails closed when an adapter reports the wrong scenario id", () =>
    Effect.gen(function* () {
      const adapter: ExternalEffectConformanceAdapter = {
        runScenario: (scenario: ExternalEffectConformanceScenario) =>
          Effect.succeed({
            scenarioId:
              scenario.id === "request_before_effect"
                ? "duplicate_attempt_reuses_existing"
                : scenario.id,
            status: "passed" as const,
          }),
      };

      const report = yield* externalEffectConformance(adapter);

      expect(report.status).toBe("failed");
      expect(report.failures[0]).toMatchObject({
        scenario: { id: "request_before_effect" },
        issues: [{ code: "scenario_id_mismatch" }],
      });
    }),
  );
});
