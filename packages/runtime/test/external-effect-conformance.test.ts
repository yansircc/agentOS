import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import { describe, expect, it } from "@effect/vitest";
import {
  defineExternalEffectAttempt,
  projectExternalEffectAttempt,
  runExternalEffectAttempt,
  type ExternalEffectKnownAttemptProjectionStatus,
} from "../src/external-effect";
import {
  EXTERNAL_EFFECT_ADAPTER_OBSERVED_SCENARIOS,
  EXTERNAL_EFFECT_CONFORMANCE_SCENARIOS,
  EXTERNAL_EFFECT_RUNNER_JOIN_SCENARIOS,
  externalEffectConformance,
  type ExternalEffectConformanceEvidence,
  type ExternalEffectConformanceAdapter,
  type ExternalEffectConformanceScenario,
  type ExternalEffectConformanceScenarioId,
} from "../src/testing";

type ExampleSpec = { readonly value: string };
type ExampleEvent = { readonly idempotencyKey: string; readonly attemptKey: string };
type ExampleProjection =
  | {
      readonly status: "running";
      readonly request: ExampleRequest;
      readonly evidenceRefs?: ReadonlyArray<string>;
    }
  | { readonly status: "done"; readonly value: string; readonly evidenceRefs?: ReadonlyArray<string> }
  | { readonly status: "indeterminate"; readonly evidenceRefs: ReadonlyArray<string> };
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

  it("partitions conformance scenarios by executable owner", () => {
    expect(EXTERNAL_EFFECT_RUNNER_JOIN_SCENARIOS.map((scenario) => scenario.id)).toEqual([
      "request_before_effect",
      "duplicate_attempt_reuses_existing",
      "running_replay_uses_caller_request",
      "running_replay_does_not_duplicate_request",
    ]);
    expect(EXTERNAL_EFFECT_ADAPTER_OBSERVED_SCENARIOS.map((scenario) => scenario.id)).toEqual([
      "crash_reconcile_from_projection",
      "witness_missing_or_provider_unknown_indeterminate",
      "digest_or_contract_mismatch_fails_closed",
      "invalid_projection_fails_closed",
      "error_channel_preserved",
      "r_channel_non_leakage",
      "provider_evidence_cannot_change_canonical_ref",
      "receipt_backed_attempt_projection_preserves_caller_vocabulary",
    ]);

    const partitionedIds = new Set([
      ...EXTERNAL_EFFECT_RUNNER_JOIN_SCENARIOS.map((scenario) => scenario.id),
      ...EXTERNAL_EFFECT_ADAPTER_OBSERVED_SCENARIOS.map((scenario) => scenario.id),
    ]);
    expect(partitionedIds.size).toBe(EXTERNAL_EFFECT_CONFORMANCE_SCENARIOS.length);
    expect([...partitionedIds].sort()).toEqual(
      EXTERNAL_EFFECT_CONFORMANCE_SCENARIOS.map((scenario) => scenario.id).sort(),
    );
  });

  it.effect("proves runner-owned join scenarios through the existing runner surface", () =>
    Effect.gen(function* () {
      const requestBeforeEffect: string[] = [];
      const created = yield* runExternalEffectAttempt<
        ExampleSpec,
        ExampleEvent,
        ExampleProjection,
        ExampleRequest,
        string,
        never,
        never
      >({
        spec: { value: "created" },
        idempotencyKey: "key-created",
        readEvents: () => Effect.succeed([]),
        projectByIdempotencyKey: () => ({ status: "missing" }),
        projectCurrent: () => ({ status: "done", value: "unexpected" }),
        isRunningProjection: (current) => current.status === "running",
        activeSpecFromRunningProjection: (spec) => spec,
        requestStateFromRunningProjection: () => ({ requestId: "unexpected" }),
        request: (spec) =>
          Effect.sync(() => {
            requestBeforeEffect.push("request");
            return { requestId: spec.value };
          }),
        runRequested: ({ request }) =>
          Effect.sync(() => {
            requestBeforeEffect.push("effect");
            return { status: "done", value: request.requestId } satisfies ExampleProjection;
          }),
      });

      expect(created).toEqual({ status: "done", value: "created" });
      expect(requestBeforeEffect).toEqual(["request", "effect"]);

      const duplicateCalls: string[] = [];
      const duplicate = yield* runExternalEffectAttempt<
        ExampleSpec,
        ExampleEvent,
        ExampleProjection,
        ExampleRequest,
        string,
        never,
        never
      >({
        spec: { value: "duplicate" },
        idempotencyKey: "key-duplicate",
        readEvents: () =>
          Effect.succeed([{ idempotencyKey: "key-duplicate", attemptKey: "attempt-1" }]),
        projectByIdempotencyKey: () => ({ status: "found", attemptKey: "attempt-1" }),
        projectCurrent: () => ({ status: "done", value: "existing" }),
        isRunningProjection: (current) => current.status === "running",
        activeSpecFromRunningProjection: (spec) => spec,
        requestStateFromRunningProjection: () => ({ requestId: "unexpected" }),
        request: () =>
          Effect.sync(() => {
            duplicateCalls.push("request");
            return { requestId: "unexpected" };
          }),
        runRequested: () =>
          Effect.sync(() => {
            duplicateCalls.push("effect");
            return { status: "done", value: "unexpected" } satisfies ExampleProjection;
          }),
      });

      expect(duplicate).toEqual({ status: "done", value: "existing" });
      expect(duplicateCalls).toEqual([]);

      const runningReplayCalls: string[] = [];
      const runningReplay = yield* runExternalEffectAttempt<
        ExampleSpec,
        ExampleEvent,
        ExampleProjection,
        ExampleRequest,
        string,
        never,
        never
      >({
        spec: { value: "incoming" },
        idempotencyKey: "key-running",
        readEvents: () =>
          Effect.succeed([{ idempotencyKey: "key-running", attemptKey: "attempt-2" }]),
        projectByIdempotencyKey: () => ({ status: "found", attemptKey: "attempt-2" }),
        projectCurrent: () => ({ status: "running", request: { requestId: "existing-request" } }),
        isRunningProjection: (current) => current.status === "running",
        activeSpecFromRunningProjection: () => ({ value: "active-from-projection" }),
        requestStateFromRunningProjection: (projection) => {
          if (projection.status !== "running") throw new Error("expected running projection");
          return projection.request;
        },
        request: () =>
          Effect.sync(() => {
            runningReplayCalls.push("request");
            return { requestId: "new-request" };
          }),
        runRequested: ({ activeSpec, request }) =>
          Effect.sync(() => {
            runningReplayCalls.push(`${activeSpec.value}:${request.requestId}`);
            return { status: "done", value: request.requestId } satisfies ExampleProjection;
          }),
      });

      expect(runningReplay).toEqual({ status: "done", value: "existing-request" });
      expect(runningReplayCalls).toEqual(["active-from-projection:existing-request"]);
    }),
  );

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

  it("projects caller-owned attempts into neutral status and evidence refs", () => {
    const events: ReadonlyArray<ExampleEvent> = [
      { idempotencyKey: "key-running", attemptKey: "attempt-running" },
      { idempotencyKey: "key-settled", attemptKey: "attempt-settled" },
    ];
    const projectByIdempotencyKey = (
      history: ReadonlyArray<ExampleEvent>,
      idempotencyKey: string,
    ) => {
      const event = history.find((entry) => entry.idempotencyKey === idempotencyKey);
      return event === undefined
        ? ({ status: "missing" } as const)
        : ({ status: "found", attemptKey: event.attemptKey } as const);
    };
    const statusFromProjection = (
      projection: ExampleProjection,
    ): ExternalEffectKnownAttemptProjectionStatus => {
      if (projection.status === "running") return "running";
      if (projection.status === "done") return "settled";
      return "indeterminate";
    };
    const evidenceRefsFromProjection = (projection: ExampleProjection): ReadonlyArray<string> =>
      projection.evidenceRefs ?? [];

    expect(
      projectExternalEffectAttempt<ExampleEvent, ExampleProjection, string, string>({
        idempotencyKey: "key-missing",
        events,
        projectByIdempotencyKey,
        projectCurrent: () => ({ status: "done", value: "unexpected" }),
        statusFromProjection,
        evidenceRefsFromProjection,
      }),
    ).toEqual({
      idempotencyKey: "key-missing",
      status: "missing",
      evidenceRefs: [],
    });

    expect(
      projectExternalEffectAttempt<ExampleEvent, ExampleProjection, string, string>({
        idempotencyKey: "key-running",
        events,
        projectByIdempotencyKey,
        projectCurrent: () => ({
          status: "running",
          request: { requestId: "request-1" },
          evidenceRefs: ["caller.request:1"],
        }),
        statusFromProjection,
        evidenceRefsFromProjection,
      }),
    ).toEqual({
      idempotencyKey: "key-running",
      status: "running",
      attemptKey: "attempt-running",
      evidenceRefs: ["caller.request:1"],
    });

    expect(
      projectExternalEffectAttempt<ExampleEvent, ExampleProjection, string, string>({
        idempotencyKey: "key-settled",
        events,
        projectByIdempotencyKey,
        projectCurrent: () => ({
          status: "done",
          value: "ok",
          evidenceRefs: ["caller.receipt:1"],
        }),
        statusFromProjection,
        evidenceRefsFromProjection,
      }),
    ).toEqual({
      idempotencyKey: "key-settled",
      status: "settled",
      attemptKey: "attempt-settled",
      evidenceRefs: ["caller.receipt:1"],
    });
  });

  it.effect("returns a passing structured report when every scenario passes", () =>
    Effect.gen(function* () {
      const report = yield* externalEffectConformance(passingAdapter);

      expect(report.status).toBe("passed");
      expect(report.failures).toEqual([]);
      expect(report.scenarios.map((entry) => entry.scenario.id)).toEqual(
        EXTERNAL_EFFECT_CONFORMANCE_SCENARIOS.map((scenario) => scenario.id),
      );
      expect(
        report.scenarios.every((entry) => entry.scenario.requiredObservations.length > 0),
      ).toBe(true);
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
