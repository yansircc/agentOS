/**
 * SubmitSpec.system field — deterministic contract test.
 *
 * Validates the three-axis duality (spec-24 §5.1.1):
 *   system  = behavior program (stable)
 *   intent  = task input       (variable)
 *   context = facts            (variable)
 *
 * When `system` is supplied, the system message uses it verbatim plus the
 * Context block. When absent, the default "You are an agent. Goal: …"
 * wrapper is preserved (backward compatibility). The user message is
 * always the intent.
 *
 * Uses a recording AI stub that captures the first call's params so we
 * can assert on the exact message shape submit-agent built.
 */

import { Exit, Layer, ManagedRuntime } from "effect";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";

import { AdmissionLive } from "../src/admission";
import { EventBusLive } from "../src/ledger";
import { LedgerLive } from "../src/ledger";
import { AiBinding } from "../src/llm";
import { RefResolverLive } from "../src/ref-resolver";
import { QuotaLive } from "../src/quota";
import { sqlText } from "../src/storage/sql-row";
import { type InternalSubmitSpec, submitAgentEffect } from "../src/submit-agent";
import type { EventHandler } from "../src/types";
import { finalTextResp } from "./_stub-ai";

interface TestEnv {
  readonly AGENT_DO: DurableObjectNamespace;
}

const testEnv = env as unknown as TestEnv;

interface CapturedCall {
  readonly model: string;
  readonly params: {
    readonly messages: ReadonlyArray<{
      readonly role: string;
      readonly content: string | null;
    }>;
    readonly tools?: unknown;
  };
}

/** Stub AI that records every .run() call's params before returning a
 *  canned response. */
function recordingStubAi(responses: ReadonlyArray<unknown>): {
  ai: Ai;
  readonly calls: ReadonlyArray<CapturedCall>;
} {
  const calls: CapturedCall[] = [];
  let i = 0;
  const ai = {
    run: ((model: string, params: unknown) => {
      calls.push({ model, params: params as CapturedCall["params"] });
      const r = responses[i];
      if (r === undefined) {
        throw new Error(
          `recordingStubAi: queue exhausted at call #${i + 1} (queue=${responses.length})`,
        );
      }
      i += 1;
      return Promise.resolve(r);
    }) as Ai["run"],
  } as Ai;
  return { ai, calls };
}

function buildRuntime(state: DurableObjectState, ai: Ai) {
  const handlers = new Map<string, Set<EventHandler>>();
  const eventBus = EventBusLive(handlers);
  const ledger = LedgerLive(state.storage.sql).pipe(Layer.provide(eventBus));
  const quota = QuotaLive(state).pipe(Layer.provide(eventBus));
  const aiLayer = Layer.succeed(AiBinding, ai);
  const refs = RefResolverLive({
    material: () => null,
  });
  const admission = AdmissionLive(state).pipe(Layer.provide(eventBus));
  return ManagedRuntime.make(Layer.mergeAll(ledger, quota, aiLayer, admission, refs));
}

const baseSpec = (scope: string): InternalSubmitSpec => ({
  intent: "Conduct one interview turn.",
  context: { topic: "ROVs", priorTurns: [] },
  route: { kind: "cf-ai-binding", modelId: "@cf/stub/test" } as const,
  tools: {},
  budget: { maxTurns: 1 },
  deliver: {
    event: "test.delivered",
    scope,
    scopeRef: { kind: "conversation", scopeId: scope },
  },
});

describe("SubmitSpec.system field — behavior-program axis", () => {
  it("when `system` is supplied, system message uses it (no default wrapper)", async () => {
    const scope = "system-field-supplied";
    const stub = testEnv.AGENT_DO.get(testEnv.AGENT_DO.idFromName(scope));
    const customSystem =
      "You are an interview agent for writers. Follow EEAT discipline. Output Chinese questions.";

    await runInDurableObject(stub, async (_inst, state) => {
      const { ai, calls } = recordingStubAi([finalTextResp("done")]);
      const runtime = buildRuntime(state, ai);

      const result = await runtime.runPromise(
        submitAgentEffect({ ...baseSpec(scope), system: customSystem }),
      );

      expect(result.ok).toBe(true);
      expect(calls.length).toBeGreaterThanOrEqual(1);

      const firstMessages = calls[0]?.params.messages;
      expect(firstMessages).toBeDefined();
      const systemMsg = firstMessages?.[0];
      const userMsg = firstMessages?.[1];

      expect(systemMsg?.role).toBe("system");
      // System message content STARTS with the caller's program — no
      // "You are an agent. Goal: …" prefix.
      expect(systemMsg?.content?.startsWith(customSystem)).toBe(true);
      expect(systemMsg?.content?.includes("You are an agent. Goal:")).toBe(false);
      // Context block still appended.
      expect(systemMsg?.content?.includes("Context available:")).toBe(true);

      // User message = intent verbatim.
      expect(userMsg?.role).toBe("user");
      expect(userMsg?.content).toBe("Conduct one interview turn.");

      const events = state.storage.sql
        .exec("SELECT id, kind, payload FROM events ORDER BY id ASC")
        .toArray();
      const llmResponse = events.find((row) => row.kind === "llm.response");
      const delivered = events.find((row) => row.kind === "test.delivered");
      expect(JSON.parse(sqlText(llmResponse?.payload, "events.payload"))).toEqual({
        turn: { id: Number(events[0]?.id), index: 0 },
        text: "done",
        toolCalls: [],
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      });
      expect(JSON.parse(sqlText(delivered?.payload, "events.payload"))).toEqual({
        final: "done",
        turn: { id: Number(events[0]?.id), index: 0 },
      });

      await runtime.dispose();
    });
  });

  it("when `system` is absent, default wrapper is preserved (backward compatibility)", async () => {
    const scope = "system-field-absent";
    const stub = testEnv.AGENT_DO.get(testEnv.AGENT_DO.idFromName(scope));

    await runInDurableObject(stub, async (_inst, state) => {
      const { ai, calls } = recordingStubAi([finalTextResp("done")]);
      const runtime = buildRuntime(state, ai);

      const result = await runtime.runPromise(submitAgentEffect(baseSpec(scope)));

      expect(result.ok).toBe(true);
      const firstMessages = calls[0]?.params.messages;
      const systemMsg = firstMessages?.[0];
      const userMsg = firstMessages?.[1];

      expect(systemMsg?.role).toBe("system");
      expect(
        systemMsg?.content?.startsWith("You are an agent. Goal: Conduct one interview turn."),
      ).toBe(true);
      expect(systemMsg?.content?.includes("Use the provided tools")).toBe(true);

      expect(userMsg?.role).toBe("user");
      expect(userMsg?.content).toBe("Conduct one interview turn.");

      await runtime.dispose();
    });
  });

  it("user message is always intent, regardless of `system` presence", async () => {
    const scope = "system-field-user-msg-invariant";
    const stub = testEnv.AGENT_DO.get(testEnv.AGENT_DO.idFromName(scope));

    await runInDurableObject(stub, async (_inst, state) => {
      const intent = "Specific task input #42";

      // First: with system
      const { ai: ai1, calls: calls1 } = recordingStubAi([finalTextResp("ok")]);
      const runtime1 = buildRuntime(state, ai1);
      const exit1 = await runtime1.runPromiseExit(
        submitAgentEffect({
          ...baseSpec(scope),
          intent,
          system: "Behavior program text",
        }),
      );
      expect(Exit.isSuccess(exit1)).toBe(true);
      expect(calls1[0]?.params.messages[1]?.content).toBe(intent);
      await runtime1.dispose();

      // Second: without system, different scope to avoid ledger interference
      const scope2 = "system-field-user-msg-invariant-2";
      const stub2 = testEnv.AGENT_DO.get(testEnv.AGENT_DO.idFromName(scope2));
      await runInDurableObject(stub2, async (_inst2, state2) => {
        const { ai: ai2, calls: calls2 } = recordingStubAi([finalTextResp("ok")]);
        const runtime2 = buildRuntime(state2, ai2);
        const exit2 = await runtime2.runPromiseExit(
          submitAgentEffect({ ...baseSpec(scope2), intent }),
        );
        expect(Exit.isSuccess(exit2)).toBe(true);
        expect(calls2[0]?.params.messages[1]?.content).toBe(intent);
        await runtime2.dispose();
      });
    });
  });
});
