/**
 * Quota state machine — deterministic contract test.
 *
 * Bypasses AgentDOBase to compose production Layers directly (LedgerLive +
 * EventBusLive + QuotaLive over real DO SQLite from runInDurableObject's
 * state, plus a Layer.succeed(AiBinding, stubAi(...))). This isolates the
 * substrate algorithm from any LLM behavior — every test result is
 * structurally determined by the canned response queue.
 *
 * Replaces the LLM-dependent quota assertions previously in
 * examples/spike-01-effect/test.sh (reviewer's 2026-05-25 P1 finding).
 */

import { Effect, Layer, ManagedRuntime } from "effect";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { EventBusLive } from "../src/event-bus";
import { Ledger, LedgerLive } from "../src/ledger";
import { AiBinding } from "../src/llm";
import { QuotaLive } from "../src/quota-service";
import { withQuota } from "../src/quota";
import {
  type InternalSubmitSpec,
  submitAgentEffect,
} from "../src/submit-agent";
import type { Tool } from "../src/tools";
import type { EventHandler } from "../src/types";
import { finalTextResp, stubAi, toolCallResp } from "./_stub-ai";

interface TestEnv {
  readonly AGENT_DO: DurableObjectNamespace;
}

const testEnv = env as unknown as TestEnv;

const makeQuotaTool = (limit: number): Tool =>
  withQuota(
    {
      definition: {
        type: "function",
        function: {
          name: "get_current_time",
          description: "Returns the current time as ISO string",
          parameters: { type: "object", properties: {}, required: [] },
        },
      },
      execute: async () => "2026-05-25T00:00:00Z",
    },
    { windowMs: 60_000, limit, amount: 1 },
  );

const makeSpec = (scope: string, limit: number): InternalSubmitSpec => ({
  intent: "what time is it",
  context: {},
  agent: { provider: "@cf/stub", model: "test" },
  tools: { get_current_time: makeQuotaTool(limit) },
  budget: { maxTurns: 3 },
  deliver: { event: "test.delivered", scope },
});

const buildRuntime = (state: DurableObjectState, ai: Ai) => {
  const handlers = new Map<string, Set<EventHandler>>();
  const eventBus = EventBusLive(handlers);
  const ledger = LedgerLive(state.storage.sql).pipe(Layer.provide(eventBus));
  const quota = QuotaLive(state).pipe(Layer.provide(eventBus));
  const aiLayer = Layer.succeed(AiBinding, ai);
  return ManagedRuntime.make(Layer.mergeAll(ledger, quota, aiLayer));
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
});
