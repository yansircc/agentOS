import { Effect, Layer, ManagedRuntime } from "effect";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";

import { AdmissionLive } from "../src/admission";
import { EventBusLive } from "../src/ledger";
import { Ledger, LedgerLive } from "../src/ledger";
import { AiBinding } from "../src/llm";
import { QuotaLive } from "../src/quota";
import { RefResolverLive } from "../src/ref-resolver";
import { type InternalSubmitSpec, submitAgentEffect } from "../src/submit-agent";
import { defineRegisteredTool, validateToolRegistry, type Tool } from "../src/tools";
import type { EventHandler } from "../src/types";
import { finalTextResp, stubAi, toolCallResp } from "./_stub-ai";

interface TestEnv {
  readonly AGENT_DO: DurableObjectNamespace;
}

const testEnv = env as unknown as TestEnv;

const makeTool = (): Tool =>
  defineRegisteredTool({
    definition: {
      type: "function",
      function: {
        name: "lookup",
        description: "Lookup a value",
        parameters: { type: "object", properties: {}, required: [] },
      },
    },
    execute: async () => ({ value: 42 }),
    authorityClass: "read",
    originRef: {
      originId: "@agent-os/tool-registry/test",
      originKind: "tool_provider",
    },
  });

const makeSpec = (scope: string, tool: Tool): InternalSubmitSpec => ({
  intent: "lookup",
  context: {},
  route: { kind: "cf-ai-binding", modelId: "@cf/stub/test" } as const,
  tools: { lookup: tool },
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
    endpoint: () => null,
    credential: () => null,
  });
  const admission = AdmissionLive(state).pipe(Layer.provide(eventBus));
  return ManagedRuntime.make(Layer.mergeAll(ledger, quota, aiLayer, admission, refs));
};

describe("tool registry generator", () => {
  it("binds tool identity and authority in one contract", () => {
    const tool = makeTool();

    expect(validateToolRegistry({ lookup: tool })).toEqual({ ok: true });
    expect(tool.contract).toEqual({
      toolId: "lookup",
      authorityRef: {
        authorityId: "tool:lookup",
        authorityClass: "read",
      },
      originRef: {
        originId: "@agent-os/tool-registry/test",
        originKind: "tool_provider",
      },
      roles: ["generator"],
    });
  });

  it("rejects tools without a single authority contract before execution", () => {
    const bareTool = {
      definition: {
        type: "function",
        function: {
          name: "lookup",
          description: "Lookup a value",
          parameters: { type: "object", properties: {}, required: [] },
        },
      },
      execute: async () => ({ value: 42 }),
    } as unknown as Tool;

    expect(validateToolRegistry({ lookup: bareTool })).toEqual({
      ok: false,
      issues: [
        {
          kind: "missing_contract",
          registryKey: "lookup",
          toolName: "lookup",
        },
      ],
    });
  });

  it("settles tool execution as a lived claim in tool.executed", async () => {
    const scope = "tool-registry-claim";
    const id = testEnv.AGENT_DO.idFromName(scope);
    const stub = testEnv.AGENT_DO.get(id);

    await runInDurableObject(stub, async (_inst, state) => {
      const ai = stubAi([toolCallResp("lookup", "{}", "call-1"), finalTextResp("done")]);
      const runtime = buildRuntime(state, ai);

      const result = await runtime.runPromise(submitAgentEffect(makeSpec(scope, makeTool())));
      expect(result.ok).toBe(true);

      const events = await runtime.runPromise(
        Effect.gen(function* () {
          const l = yield* Ledger;
          return yield* l.events(scope);
        }),
      );
      const executed = events.find((event) => event.kind === "tool.executed");
      expect(executed?.payload).toEqual(
        expect.objectContaining({
          name: "lookup",
          claim: expect.objectContaining({
            phase: "lived",
            operationRef: "tool:tool-registry-claim:1:0:call-1",
            authorityRef: {
              authorityId: "tool:lookup",
              authorityClass: "read",
            },
            originRef: {
              originId: "@agent-os/tool-registry/test",
              originKind: "tool_provider",
            },
            anchorRef: {
              anchorId: "tool:tool-registry-claim:1:0:call-1",
              anchorKind: "carrier_proof",
              carrierRef: "tool:lookup",
            },
          }),
        }),
      );

      await runtime.dispose();
    });
  });

  it("settles tool failures as rejected claims before run abort", async () => {
    const scope = "tool-registry-rejected";
    const id = testEnv.AGENT_DO.idFromName(scope);
    const stub = testEnv.AGENT_DO.get(id);
    const failingTool = defineRegisteredTool({
      definition: {
        type: "function",
        function: {
          name: "lookup",
          description: "Lookup a value",
          parameters: { type: "object", properties: {}, required: [] },
        },
      },
      execute: async () => {
        throw new Error("upstream down");
      },
      authorityClass: "read",
    });

    await runInDurableObject(stub, async (_inst, state) => {
      const ai = stubAi([toolCallResp("lookup", "{}", "call-1")]);
      const runtime = buildRuntime(state, ai);

      const result = await runtime.runPromise(submitAgentEffect(makeSpec(scope, failingTool)));
      expect(result.ok).toBe(false);

      const events = await runtime.runPromise(
        Effect.gen(function* () {
          const l = yield* Ledger;
          return yield* l.events(scope);
        }),
      );
      const rejected = events.find((event) => event.kind === "tool.rejected");
      expect(rejected?.payload).toEqual(
        expect.objectContaining({
          runId: 1,
          name: "lookup",
          claim: expect.objectContaining({
            phase: "rejected",
            operationRef: "tool:tool-registry-rejected:1:0:call-1",
            rejectionRef: {
              rejectionId: "tool:tool-registry-rejected:1:0:call-1",
              rejectionKind: "provider_rejected",
              reason: "Error: upstream down",
            },
          }),
        }),
      );
      expect(events.some((event) => event.kind === "agent.aborted.tool_error")).toBe(true);

      await runtime.dispose();
    });
  });
});
