/**
 * Quota state machine — deterministic contract test.
 *
 * Bypasses the DO facade to compose production Layers directly (LedgerLive +
 * EventBusLive + QuotaLive over real DO SQLite from runInDurableObject's
 * state, plus a Layer.succeed(AiBinding, stubAi(...))). This isolates the
 * substrate algorithm from any LLM behavior — every test result is
 * structurally determined by the canned response queue.
 *
 * Replaces the retired LLM-dependent spike quota assertions (reviewer's
 * 2026-05-25 P1 finding).
 */

import { Cause, Effect, Exit, Layer, ManagedRuntime, Option } from "effect";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type {} from "@effect/vitest";

import { AdmissionLive } from "../src/admission";
import { EventBusLive } from "../src/ledger";
import { Ledger, LedgerLive } from "../src/ledger";
import { AiBinding, LlmTransportLive } from "../src/llm";
import { RefResolverLive } from "@agent-os/kernel/ref-resolver";
import { QuotaLive } from "../src/quota";
import { withQuota } from "../src/quota";
import { type InternalSubmitSpec, submitAgentEffect } from "@agent-os/runtime";
import {
  defineToolFromDefinition,
  permissiveToolAdmitter,
  pureToolExecution,
  type Tool,
} from "@agent-os/kernel/tools";
import type { EventHandler } from "@agent-os/kernel/types";
import { finalTextResp, stubAi, toolCallResp } from "./_stub-ai";

interface TestEnv {
  readonly AGENT_DO: DurableObjectNamespace;
}

const testEnv = env as unknown as TestEnv;

const makeQuotaTool = (limit: number): Tool =>
  withQuota(
    defineToolFromDefinition({
      definition: {
        type: "function",
        function: {
          name: "get_current_time",
          description: "Returns the current time as ISO string",
          parameters: { type: "object", properties: {}, required: [] },
        },
      },
      execute: async () => "2026-05-25T00:00:00Z",
      admit: permissiveToolAdmitter,
      authorityClass: "read",
      execution: pureToolExecution(),
    }),
    { windowMs: 60_000, limit, amount: 1 },
  );

const makeSpec = (scope: string, limit: number): InternalSubmitSpec => ({
  intent: "what time is it",
  context: {},
  route: { kind: "cf-ai-binding", modelId: "@cf/stub/test" } as const,
  tools: { get_current_time: makeQuotaTool(limit) },
  budget: { maxTurns: 3 },
  deliver: {
    event: "test.delivered",
    scope,
    scopeRef: { kind: "conversation", scopeId: scope },
  },
});

const buildRuntime = (state: DurableObjectState, ai: Ai) => {
  const handlers = new Map<string, Set<EventHandler>>();
  const eventBus = EventBusLive(handlers);
  const ledger = LedgerLive(state.storage.sql).pipe(Layer.provide(eventBus));
  const quota = QuotaLive(state).pipe(Layer.provide(eventBus));
  const aiLayer = Layer.succeed(AiBinding, ai);
  const refs = RefResolverLive({
    material: () => null,
  });
  const providerBase = Layer.mergeAll(aiLayer, refs);
  const llmTransport = LlmTransportLive.pipe(Layer.provide(providerBase));
  const admission = AdmissionLive(state).pipe(
    Layer.provide(Layer.mergeAll(eventBus, providerBase)),
  );
  return ManagedRuntime.make(Layer.mergeAll(ledger, quota, aiLayer, llmTransport, admission, refs));
};

describe("quota state machine — deterministic", () => {
  it("3 submits with limit=2 → 2 consumed, 1 rate_limited, 1 tool_error abort", async () => {
    const scope = "quota-rate-limit-3rd";
    const id = testEnv.AGENT_DO.idFromName(scope);
    const stub = testEnv.AGENT_DO.get(id);

    await runInDurableObject(stub, async (_inst, state) => {
      // Each successful submit: one tool_call turn, one final text turn.
      // Submit 3 hits rate_limit on the tool_call turn → aborts (no second
      // LLM call). 2*2 + 1 = 5 stub responses pre-loaded.
      const ai = stubAi([
        toolCallResp("get_current_time", "{}", "c1"),
        finalTextResp("ok 1"),
        toolCallResp("get_current_time", "{}", "c2"),
        finalTextResp("ok 2"),
        toolCallResp("get_current_time", "{}", "c3"),
      ]);

      const runtime = buildRuntime(state, ai);

      const r1 = await runtime.runPromise(submitAgentEffect(makeSpec(scope, 2)));
      const r2 = await runtime.runPromise(submitAgentEffect(makeSpec(scope, 2)));
      const r3 = await runtime.runPromise(submitAgentEffect(makeSpec(scope, 2)));

      expect(r1.ok).toBe(true);
      expect(r2.ok).toBe(true);
      expect(r3.ok).toBe(false);
      if (!r3.ok) {
        expect(r3.reason).toBe("tool_error");
      }

      const events = await runtime.runPromise(
        Effect.gen(function* () {
          const l = yield* Ledger;
          return yield* l.events(scope);
        }),
      );

      const counts = events.reduce<Record<string, number>>((acc, e) => {
        acc[e.kind] = (acc[e.kind] ?? 0) + 1;
        return acc;
      }, {});

      expect(counts["dispatch.consumed"]).toBe(2);
      expect(counts["dispatch.rate_limited"]).toBe(1);
      expect(counts["agent.aborted.tool_error"]).toBe(1);

      await runtime.dispose();
    });
  });

  it("malformed dispatch.consumed payload → SqlError escapes Promise (validates a304601 P2 fix)", async () => {
    const scope = "quota-malformed-payload";
    const id = testEnv.AGENT_DO.idFromName(scope);
    const stub = testEnv.AGENT_DO.get(id);

    await runInDurableObject(stub, async (_inst, state) => {
      // One stub response is enough — the submit aborts during the first
      // tryGrant call when it reads the corrupted row.
      const ai = stubAi([toolCallResp("get_current_time", "{}", "c1")]);

      const runtime = buildRuntime(state, ai);

      // Touch Ledger to trigger ensureSchema (creates events table).
      await runtime.runPromise(
        Effect.gen(function* () {
          const l = yield* Ledger;
          yield* l.events("__init__");
        }),
      );

      // Inject a malformed dispatch.consumed row directly. Payload is
      // valid JSON but fails ConsumedPayloadSchema:
      //   - amount is "x" (not a finite number)
      //   - matches the key the tool will look up
      // Without the v0.2.9 P2 fix, this row would silently be parsed as
      // `consumed += NaN`, polluting the running total. With the fix,
      // Schema.decodeUnknownSync throws → tx rollback → SqlError escapes.
      state.storage.sql.exec(
        "INSERT INTO events (ts, kind, scope, payload) VALUES (?, ?, ?, ?)",
        Date.now(),
        "dispatch.consumed",
        scope,
        JSON.stringify({
          key: "get_current_time",
          amount: "x",
          toolName: "get_current_time",
        }),
      );

      // Now run a submit that consumes quota. The Quota.tryGrant
      // transactionSync will SELECT the malformed row, decode fails,
      // transactionSync rolls back, Effect.try wraps the throw as
      // SqlError. SqlError is NOT caught by submitAgentEffect.catchTags
      // → surfaces as a Cause.Fail in the Exit.
      const exit = await runtime.runPromiseExit(submitAgentEffect(makeSpec(scope, 2)));

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.failureOption(exit.cause);
        expect(Option.isSome(failure)).toBe(true);
        if (Option.isSome(failure)) {
          expect(failure.value._tag).toBe("agent_os.sql_error");
        }
      }

      await runtime.dispose();
    });
  });
});
