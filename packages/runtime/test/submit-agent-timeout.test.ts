import { Deferred, Effect, Fiber, Schema } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "@effect/vitest";

import { Ledger } from "../src/ledger";
import { BoundaryEvents } from "../src/boundary-events";
import { MaterializedProjections } from "../src/projection";
import { Quota } from "../src/quota-service";
import { Admission } from "../src/admission";
import { DEFAULT_LLM_CALL_TIMEOUT_MS, submitAgentEffect } from "../src/submit-agent";
import { decodeRecordedLedgerEvent, type LedgerEvent } from "@agent-os/kernel/types";
import { LlmTransport, type LlmRoute, type LlmWireDescriptor } from "@agent-os/llm-protocol";
import {
  RUNTIME_FACT_OWNER,
  decodeRuntimeLedgerEvent,
  type SubmitSpec,
} from "@agent-os/runtime-protocol";
import { RefResolverEmpty } from "@agent-os/kernel/ref-resolver";
import { internalSubmitSpec, type InternalSubmitSpec } from "../src/internal-submit";

const timeoutScope = {
  scope: "timeout-scope",
  scopeRef: { kind: "conversation" as const, scopeId: "timeout-scope" },
};

const makePublicSpec = (budget?: InternalSubmitSpec["budget"]): SubmitSpec => ({
  intent: "hang",
  context: {},
  route: {
    kind: "openai-chat-compatible",
    endpointRef: "test-endpoint",
    credentialRef: "test-credential",
    modelId: "test-model",
  },
  tools: {},
  ...(budget === undefined ? {} : { budget }),
  effectAuthorityRef: { authorityClass: "llm_route", authorityId: "timeout-route" },
});

const makeSpec = (budget?: InternalSubmitSpec["budget"]): InternalSubmitSpec =>
  internalSubmitSpec(makePublicSpec(budget), timeoutScope);

const makeStructuredSpec = (budget?: InternalSubmitSpec["budget"]): InternalSubmitSpec =>
  internalSubmitSpec(
    {
      ...makePublicSpec(budget),
      outputSchema: Schema.Struct({ summary: Schema.String }),
    },
    timeoutScope,
  );

const routeKind = (route: LlmRoute): string =>
  typeof route.kind === "string" ? route.kind : "unknown";

const testWireDescriptor = (route: LlmRoute): LlmWireDescriptor => ({
  method: "POST",
  url: `test-llm://${routeKind(route)}`,
  headers: [
    ["x-agentos-endpoint-ref", String(route.endpointRef ?? "")],
    ["x-agentos-credential-ref", String(route.credentialRef ?? "")],
  ],
  bodySchema: {
    type: "object",
    properties: {
      messages: {
        type: "array",
        items: { type: "object", properties: {}, additionalProperties: true },
      },
    },
    additionalProperties: true,
  },
});

const runWithHungLlm = (
  spec: InternalSubmitSpec,
  options: {
    readonly providerObservesAbort?: boolean;
    readonly providerAttemptStarted?: Deferred.Deferred<void>;
  } = {},
) =>
  Effect.gen(function* () {
    const events: LedgerEvent[] = [];
    let nextId = 1;
    let aborted = false;
    const providerObservesAbort = options.providerObservesAbort ?? true;
    const markProviderAttemptStarted =
      options.providerAttemptStarted === undefined
        ? Effect.void
        : Deferred.succeed(options.providerAttemptStarted, undefined).pipe(Effect.asVoid);
    const ledger = {
      commit: (
        specs: ReadonlyArray<{
          readonly kind: string;
          readonly payload: unknown;
          readonly scopeRef: LedgerEvent["scopeRef"];
          readonly effectAuthorityRef: LedgerEvent["effectAuthorityRef"];
        }>,
      ) =>
        Effect.sync(() => {
          const committed = specs.map((spec) => ({
            id: nextId++,
            ts: Date.now(),
            kind: spec.kind,
            scopeRef: spec.scopeRef,
            effectAuthorityRef: spec.effectAuthorityRef,
            factOwnerRef: RUNTIME_FACT_OWNER,
            payload: spec.payload,
          }));
          events.push(...committed);
          return committed.map(decodeRecordedLedgerEvent);
        }),
      events: () => Effect.succeed(events.map(decodeRecordedLedgerEvent)),
      streamSnapshot: () => Effect.succeed(events.map(decodeRecordedLedgerEvent)),
    };
    const llm = {
      resolveRoute: (route: LlmRoute) =>
        Effect.succeed({
          wireDescriptor: testWireDescriptor(route),
          providerOutputAdapterId: "test-provider-output@1.0.0",
          providerOutputAdapterVersion: "1.0.0",
          transportAdapterId: "test-runtime@1.0.0",
          transportAdapterVersion: "1.0.0",
        }),
      call: (_request: unknown, options?: { readonly signal?: AbortSignal }) => {
        if (providerObservesAbort) {
          options?.signal?.addEventListener("abort", () => {
            aborted = true;
          });
        }
        return markProviderAttemptStarted.pipe(
          Effect.andThen(
            providerObservesAbort
              ? Effect.never
              : Effect.promise(() => new Promise<never>(() => {})),
          ),
        );
      },
    };
    const quota = {
      tryGrant: () => Effect.succeed({ granted: true, consumed: 0, limit: 1 }),
    };
    const admission = {
      attemptStructured: (input: { readonly signal?: AbortSignal }) => {
        input.signal?.addEventListener("abort", () => {
          aborted = true;
        });
        return markProviderAttemptStarted.pipe(Effect.andThen(Effect.never));
      },
      invalidate: () => Effect.succeed({ barrierId: 1 }),
    };
    const boundaryEvents = {
      commit: () => Effect.die(new Error("boundary events are not used in timeout tests")),
    };
    const projections = {
      get: () => Effect.succeed(null),
      list: () => Effect.succeed([]),
      status: () =>
        Effect.succeed({
          kind: "test.projection",
          scope: "conversation:timeout-scope",
          version: 1,
          status: "current" as const,
          lastAppliedEventId: 0,
          lastRebuiltEventId: null,
          updatedAt: null,
        }),
      rebuild: () =>
        Effect.succeed({
          kind: "test.projection",
          scope: "conversation:timeout-scope",
          version: 1,
          status: "current" as const,
          lastAppliedEventId: 0,
          lastRebuiltEventId: 0,
          updatedAt: null,
          rows: 0,
        }),
    };

    const fiber = yield* submitAgentEffect(spec).pipe(
      Effect.provideService(Ledger, ledger),
      Effect.provideService(BoundaryEvents, boundaryEvents),
      Effect.provideService(MaterializedProjections, projections),
      Effect.provideService(LlmTransport, llm),
      Effect.provideService(Quota, quota),
      Effect.provideService(Admission, admission),
      Effect.provide(RefResolverEmpty),
      Effect.forkChild,
    );
    return { result: yield* Fiber.join(fiber), events, aborted };
  });

const forkHungLlmAfterProviderAttempt = (
  spec: InternalSubmitSpec,
  options: { readonly providerObservesAbort?: boolean } = {},
) =>
  Effect.gen(function* () {
    const providerAttemptStarted = yield* Deferred.make<void>();
    const fiber = yield* runWithHungLlm(spec, {
      ...options,
      providerAttemptStarted,
    }).pipe(Effect.forkChild);
    yield* Deferred.await(providerAttemptStarted);
    return fiber;
  });

describe("submit agent LLM provider timeout", () => {
  it.effect("settles budget timeout while the provider call is in-flight", () =>
    Effect.gen(function* () {
      const fiber = yield* forkHungLlmAfterProviderAttempt(makeSpec({ maxTurns: 1, timeMs: 10 }));
      yield* TestClock.adjust("11 millis");
      const { result, events, aborted } = yield* Fiber.join(fiber);

      expect(result).toMatchObject({ ok: false, reason: "budget_time" });
      expect(aborted).toBe(true);
      expect(events.some((event) => event.kind === "llm.response")).toBe(false);
      expect(events.find((event) => event.kind === "agent.aborted.budget_time")).toBeDefined();
      for (const event of events) decodeRuntimeLedgerEvent(event);
    }),
  );

  it.effect("settles default provider timeout when submit has no time budget", () =>
    Effect.gen(function* () {
      const fiber = yield* forkHungLlmAfterProviderAttempt(makeSpec({ maxTurns: 1 }));
      yield* TestClock.adjust(`${DEFAULT_LLM_CALL_TIMEOUT_MS + 1} millis`);
      const { result, events, aborted } = yield* Fiber.join(fiber);

      expect(result).toMatchObject({ ok: false, reason: "upstream_failure" });
      expect(aborted).toBe(true);
      expect(events.some((event) => event.kind === "llm.response")).toBe(false);
      const abortedEvent = events.find((event) => event.kind === "agent.aborted.upstream_failure");
      expect(abortedEvent?.payload).toMatchObject({
        cause: "provider_timeout",
        timeoutMs: DEFAULT_LLM_CALL_TIMEOUT_MS,
      });
      for (const event of events) decodeRuntimeLedgerEvent(event);
    }),
  );

  it.effect("settles provider timeout when submit has a large finite run budget", () =>
    Effect.gen(function* () {
      const fiber = yield* forkHungLlmAfterProviderAttempt(
        makeSpec({ maxTurns: 1, timeMs: DEFAULT_LLM_CALL_TIMEOUT_MS + 60_000 }),
      );
      yield* TestClock.adjust(`${DEFAULT_LLM_CALL_TIMEOUT_MS + 1} millis`);
      const { result, events, aborted } = yield* Fiber.join(fiber);

      expect(result).toMatchObject({ ok: false, reason: "upstream_failure" });
      expect(aborted).toBe(true);
      expect(events.some((event) => event.kind === "llm.response")).toBe(false);
      const abortedEvent = events.find((event) => event.kind === "agent.aborted.upstream_failure");
      expect(abortedEvent?.payload).toMatchObject({
        cause: "provider_timeout",
        timeoutMs: DEFAULT_LLM_CALL_TIMEOUT_MS,
      });
      for (const event of events) decodeRuntimeLedgerEvent(event);
    }),
  );

  it.effect("settles configured provider timeout independently from run budget", () =>
    Effect.gen(function* () {
      const llmCallTimeoutMs = DEFAULT_LLM_CALL_TIMEOUT_MS + 30_000;
      const fiber = yield* forkHungLlmAfterProviderAttempt(
        makeSpec({
          maxTurns: 1,
          timeMs: llmCallTimeoutMs + 60_000,
          llmCallTimeoutMs,
        }),
      );
      yield* TestClock.adjust(`${llmCallTimeoutMs + 1} millis`);
      const { result, events, aborted } = yield* Fiber.join(fiber);

      expect(result).toMatchObject({ ok: false, reason: "upstream_failure" });
      expect(aborted).toBe(true);
      expect(events.some((event) => event.kind === "llm.response")).toBe(false);
      const abortedEvent = events.find((event) => event.kind === "agent.aborted.upstream_failure");
      expect(abortedEvent?.payload).toMatchObject({
        cause: "provider_timeout",
        timeoutMs: llmCallTimeoutMs,
      });
      for (const event of events) decodeRuntimeLedgerEvent(event);
    }),
  );

  it.effect("caps configured provider timeout by remaining run budget", () =>
    Effect.gen(function* () {
      const fiber = yield* forkHungLlmAfterProviderAttempt(
        makeSpec({
          maxTurns: 1,
          timeMs: 10,
          llmCallTimeoutMs: DEFAULT_LLM_CALL_TIMEOUT_MS + 30_000,
        }),
      );
      yield* TestClock.adjust("11 millis");
      const { result, events, aborted } = yield* Fiber.join(fiber);

      expect(result).toMatchObject({ ok: false, reason: "budget_time" });
      expect(aborted).toBe(true);
      expect(events.some((event) => event.kind === "llm.response")).toBe(false);
      expect(events.find((event) => event.kind === "agent.aborted.budget_time")).toBeDefined();
      for (const event of events) decodeRuntimeLedgerEvent(event);
    }),
  );

  it.effect("settles timeout even when the provider cannot observe AbortSignal", () =>
    Effect.gen(function* () {
      const fiber = yield* forkHungLlmAfterProviderAttempt(makeSpec({ maxTurns: 1 }), {
        providerObservesAbort: false,
      });
      yield* TestClock.adjust(`${DEFAULT_LLM_CALL_TIMEOUT_MS + 1} millis`);
      const { result, events, aborted } = yield* Fiber.join(fiber);

      expect(result).toMatchObject({ ok: false, reason: "upstream_failure" });
      expect(aborted).toBe(false);
      expect(events.some((event) => event.kind === "llm.response")).toBe(false);
      expect(events.find((event) => event.kind === "agent.aborted.upstream_failure")).toBeDefined();
      for (const event of events) decodeRuntimeLedgerEvent(event);
    }),
  );

  it.effect("settles structured-output provider timeout with a large finite run budget", () =>
    Effect.gen(function* () {
      const fiber = yield* forkHungLlmAfterProviderAttempt(
        makeStructuredSpec({ timeMs: DEFAULT_LLM_CALL_TIMEOUT_MS + 60_000 }),
      );
      yield* TestClock.adjust(`${DEFAULT_LLM_CALL_TIMEOUT_MS + 1} millis`);
      const { result, events, aborted } = yield* Fiber.join(fiber);

      expect(result).toMatchObject({ ok: false, reason: "upstream_failure" });
      expect(aborted).toBe(true);
      expect(events.some((event) => event.kind === "agent.run.completed")).toBe(false);
      const abortedEvent = events.find((event) => event.kind === "agent.aborted.upstream_failure");
      expect(abortedEvent?.payload).toMatchObject({
        cause: "provider_timeout",
        timeoutMs: DEFAULT_LLM_CALL_TIMEOUT_MS,
      });
      for (const event of events) decodeRuntimeLedgerEvent(event);
    }),
  );

  it.effect("settles structured-output provider timeout without leaving an open run", () =>
    Effect.gen(function* () {
      const fiber = yield* forkHungLlmAfterProviderAttempt(makeStructuredSpec({ timeMs: 10 }));
      yield* TestClock.adjust("11 millis");
      const { result, events, aborted } = yield* Fiber.join(fiber);

      expect(result).toMatchObject({ ok: false, reason: "budget_time" });
      expect(aborted).toBe(true);
      expect(events.some((event) => event.kind === "agent.run.completed")).toBe(false);
      expect(events.find((event) => event.kind === "agent.aborted.budget_time")).toBeDefined();
      for (const event of events) decodeRuntimeLedgerEvent(event);
    }),
  );
});
