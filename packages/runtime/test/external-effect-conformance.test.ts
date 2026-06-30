import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import { describe, expect, it } from "@effect/vitest";
import { defineExternalEffectAttempt } from "../src/external-effect";
import {
  EXTERNAL_EFFECT_CONFORMANCE_SCENARIOS,
  externalEffectConformance,
  type ExternalEffectConformanceEvidence,
  type ExternalEffectConformanceAdapter,
  type ExternalEffectConformanceScenario,
  type ExternalEffectConformanceScenarioId,
} from "../src/testing";

type ExampleSpec = { readonly value: string };
type ExampleEvent = { readonly idempotencyKey: string; readonly attemptKey: string };
type ExampleProjection =
  | { readonly status: "running"; readonly request: ExampleRequest }
  | { readonly status: "done"; readonly value: string };
type ExampleRequest = { readonly requestId: string };

const evidenceFor = (
  scenario: ExternalEffectConformanceScenario,
): ExternalEffectConformanceEvidence => ({
  observations: Object.fromEntries(
    scenario.requiredObservations.map((observation) => [observation, true]),
  ),
});

const passingAdapter: ExternalEffectConformanceAdapter = {
  runScenario: (scenario) =>
    Effect.succeed({
      scenarioId: scenario.id,
      status: "passed" as const,
      summary: scenario.requirement,
      evidence: evidenceFor(scenario),
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
            evidence: evidenceFor(scenario),
          },
    ),
});

describe("external-effect testing conformance", () => {
  it("keeps external-effect public source vocabulary-neutral", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../src/external-effect/index.ts", import.meta.url)),
      "utf8",
    );
    for (const forbidden of [
      "@agent-os/core",
      "workspace-job",
      "PreClaim",
      "LedgerEvent",
      "requestedEventId",
      "zeroY3",
      "provider",
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });

  it.effect("defineExternalEffectAttempt fixes caller types without owning effect channels", () =>
    Effect.gen(function* () {
      const runExampleAttempt = defineExternalEffectAttempt<
        ExampleSpec,
        ExampleEvent,
        ExampleProjection,
        ExampleRequest,
        string
      >();

      const projection = yield* runExampleAttempt({
        spec: { value: "typed" },
        idempotencyKey: "key-1",
        readEvents: () => Effect.succeed([]),
        projectByIdempotencyKey: () => ({ status: "missing" }),
        projectCurrent: () => ({ status: "done", value: "unexpected" }),
        isRunningProjection: (current) => current.status === "running",
        activeSpecFromRunningProjection: (spec) => spec,
        requestStateFromRunningProjection: (current) => {
          if (current.status !== "running") {
            throw new Error("test expected running projection");
          }
          return current.request;
        },
        request: (spec) => Effect.succeed({ requestId: spec.value }),
        runRequested: ({ request }) => Effect.succeed({ status: "done", value: request.requestId }),
      });

      expect(projection).toEqual({ status: "done", value: "typed" });
    }),
  );

  it.effect("returns a passing structured report when every scenario passes", () =>
    Effect.gen(function* () {
      const report = yield* externalEffectConformance(passingAdapter);

      expect(report.status).toBe("passed");
      expect(report.failures).toEqual([]);
      expect(report.scenarios.map((entry) => entry.scenario.id)).toEqual(
        EXTERNAL_EFFECT_CONFORMANCE_SCENARIOS.map((scenario) => scenario.id),
      );
      expect(report.scenarios.every((entry) => entry.scenario.requiredObservations.length > 0)).toBe(
        true,
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
            evidence: evidenceFor(scenario),
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

  it.effect("fails closed when an adapter passes without required observations", () =>
    Effect.gen(function* () {
      const adapter: ExternalEffectConformanceAdapter = {
        runScenario: (scenario) =>
          Effect.succeed({
            scenarioId: scenario.id,
            status: "passed" as const,
            evidence: { observations: {} },
          }),
      };

      const report = yield* externalEffectConformance(adapter);

      expect(report.status).toBe("failed");
      expect(report.failures[0]).toMatchObject({
        scenario: { id: "request_before_effect" },
        issues: [{ code: "scenario_required_observation_missing" }],
      });
    }),
  );
});
