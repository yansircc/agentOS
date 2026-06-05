import { Effect, Fiber, Schema, TestClock } from "effect";
import { describe, expect, it } from "@effect/vitest";

import { Ledger } from "../src/ledger";
import { LlmTransport } from "../src/llm-transport";
import { Quota } from "../src/quota-service";
import { Admission } from "../src/admission";
import { DEFAULT_LLM_CALL_TIMEOUT_MS, submitAgentEffect } from "../src/submit-agent";
import type { InternalSubmitSpec } from "../src/submit";
import type { LedgerEvent } from "@agent-os/kernel/types";
import { decodeRuntimeLedgerEvent } from "../src/runtime-events";

const eventIdentity = (scopeId: string) => ({
  scopeRef: { kind: "conversation" as const, scopeId },
  factOwnerRef: "@agent-os/test",
  effectAuthorityRef: { authorityClass: "test", authorityId: scopeId },
});

const makeSpec = (budget?: InternalSubmitSpec["budget"]): InternalSubmitSpec => ({
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
  deliver: {
    event: "test.delivered",
    scope: "timeout-scope",
    scopeRef: { kind: "conversation", scopeId: "timeout-scope" },
  },
});

const makeStructuredSpec = (budget?: InternalSubmitSpec["budget"]): InternalSubmitSpec => ({
  ...makeSpec(budget),
  outputSchema: Schema.Struct({ summary: Schema.String }),
});

const runWithHungLlm = (
  spec: InternalSubmitSpec,
  options: { readonly providerObservesAbort?: boolean } = {},
) =>
  Effect.gen(function* () {
    const events: LedgerEvent[] = [];
    let nextId = 1;
    let aborted = false;
    const providerObservesAbort = options.providerObservesAbort ?? true;
    const ledger = {
      commit: (
        specs: ReadonlyArray<{
          readonly kind: string;
          readonly payload: unknown;
          readonly scope: string;
        }>,
      ) =>
        Effect.sync(() => {
          const committed = specs.map((spec) => ({
            id: nextId++,
            ts: Date.now(),
            kind: spec.kind,
            ...eventIdentity(spec.scope),
            payload: spec.payload,
          }));
          events.push(...committed);
          return committed;
        }),
      events: () => Effect.succeed(events),
      streamSnapshot: () => Effect.succeed(events),
    };
    const llm = {
      describeRoute: () => ({
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
          return Effect.never;
        }
        return Effect.promise(() => new Promise<never>(() => {}));
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
        return Effect.never;
      },
      invalidate: () => Effect.succeed({ barrierId: 1 }),
    };

    const fiber = yield* submitAgentEffect(spec).pipe(
      Effect.provideService(Ledger, ledger),
      Effect.provideService(LlmTransport, llm),
      Effect.provideService(Quota, quota),
      Effect.provideService(Admission, admission),
      Effect.fork,
    );
    return { result: yield* Fiber.join(fiber), events, aborted };
  });

describe("submit agent LLM provider timeout", () => {
  it.effect("settles budget timeout while the provider call is in-flight", () =>
    Effect.gen(function* () {
      const fiber = yield* runWithHungLlm(makeSpec({ maxTurns: 1, timeMs: 10 })).pipe(Effect.fork);
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
      const fiber = yield* runWithHungLlm(makeSpec({ maxTurns: 1 })).pipe(Effect.fork);
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

  it.effect("settles timeout even when the provider cannot observe AbortSignal", () =>
    Effect.gen(function* () {
      const fiber = yield* runWithHungLlm(makeSpec({ maxTurns: 1 }), {
        providerObservesAbort: false,
      }).pipe(Effect.fork);
      yield* TestClock.adjust(`${DEFAULT_LLM_CALL_TIMEOUT_MS + 1} millis`);
      const { result, events, aborted } = yield* Fiber.join(fiber);

      expect(result).toMatchObject({ ok: false, reason: "upstream_failure" });
      expect(aborted).toBe(false);
      expect(events.some((event) => event.kind === "llm.response")).toBe(false);
      expect(events.find((event) => event.kind === "agent.aborted.upstream_failure")).toBeDefined();
      for (const event of events) decodeRuntimeLedgerEvent(event);
    }),
  );

  it.effect("settles structured-output provider timeout without leaving an open run", () =>
    Effect.gen(function* () {
      const fiber = yield* runWithHungLlm(makeStructuredSpec({ timeMs: 10 })).pipe(Effect.fork);
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
