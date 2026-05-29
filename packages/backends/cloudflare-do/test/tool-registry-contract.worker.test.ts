import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "@effect/vitest";

import { AdmissionLive } from "../src/admission";
import { EventBusLive } from "../src/ledger";
import { Ledger, LedgerLive } from "../src/ledger";
import { AiBinding, LlmTransportLive } from "../src/llm";
import { QuotaLive } from "../src/quota";
import { RefResolverLive } from "@agent-os/kernel/ref-resolver";
import { type InternalSubmitSpec, submitAgentEffect } from "@agent-os/runtime";
import {
  defineToolFromDefinition,
  defineTool,
  permissiveToolAdmitter,
  validateToolRegistry,
  type Tool,
} from "@agent-os/kernel/tools";
import { materialRequirement } from "@agent-os/kernel/material-ref";
import type { EventHandler } from "@agent-os/kernel/types";
import { finalTextResp, stubAi, toolCallResp } from "./_stub-ai";

interface TestEnv {
  readonly AGENT_DO: DurableObjectNamespace;
}

const testEnv = env as unknown as TestEnv;

const makeTool = (): Tool =>
  defineToolFromDefinition({
    definition: {
      type: "function",
      function: {
        name: "lookup",
        description: "Lookup a value",
        parameters: { type: "object", properties: {}, required: [] },
      },
    },
    execute: async () => ({ value: 42 }),
    admit: permissiveToolAdmitter,
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
    material: () => null,
  });
  const providerBase = Layer.mergeAll(aiLayer, refs);
  const llmTransport = LlmTransportLive.pipe(Layer.provide(providerBase));
  const admission = AdmissionLive(state).pipe(
    Layer.provide(Layer.mergeAll(eventBus, providerBase)),
  );
  return ManagedRuntime.make(Layer.mergeAll(ledger, quota, aiLayer, llmTransport, admission, refs));
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
      requiredMaterials: [],
      originRef: {
        originId: "@agent-os/tool-registry/test",
        originKind: "tool_provider",
      },
      roles: ["generator", "admitter"],
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

  it("requires an admitter on every contracted tool", () => {
    const tool = makeTool();
    const missingAdmitter = {
      ...tool,
      admit: undefined,
      contract: {
        ...tool.contract,
        roles: ["generator"],
      },
    } as unknown as Tool;

    expect(validateToolRegistry({ lookup: missingAdmitter })).toEqual({
      ok: false,
      issues: [
        {
          kind: "unregistered_contract",
          toolId: "lookup",
        },
        {
          kind: "missing_admitter",
          toolId: "lookup",
        },
        {
          kind: "missing_admitter_role",
          toolId: "lookup",
        },
      ],
    });
  });

  it("requires contracts produced by the registry constructor", () => {
    const tool = makeTool();
    const handBuiltContract = {
      ...tool,
      contract: {
        toolId: "lookup",
        authorityRef: {
          authorityId: "tool:lookup",
          authorityClass: "read",
        },
        requiredMaterials: [],
        roles: ["generator", "admitter"],
      },
    } as unknown as Tool;

    expect(validateToolRegistry({ lookup: handBuiltContract })).toEqual({
      ok: false,
      issues: [
        {
          kind: "unregistered_contract",
          toolId: "lookup",
        },
      ],
    });
  });

  it("binds authority required materials into the tool contract", () => {
    const tool = defineToolFromDefinition({
      definition: {
        type: "function",
        function: {
          name: "deploy",
          description: "Deploy a worker",
          parameters: { type: "object", properties: {}, required: [] },
        },
      },
      execute: async () => ({ ok: true }),
      admit: permissiveToolAdmitter,
      authorityClass: "deploy",
      requiredMaterials: [
        materialRequirement({
          slot: "cf_api_token",
          kind: "credential",
          provider: "cloudflare",
          purpose: "deploy",
        }),
        materialRequirement({
          slot: "worker_namespace",
          kind: "binding",
          provider: "cloudflare",
          bindingKind: "worker",
        }),
      ],
    });

    expect(validateToolRegistry({ deploy: tool })).toEqual({ ok: true });
    expect(tool.contract.requiredMaterials).toEqual([
      {
        slot: "cf_api_token",
        kind: "credential",
        required: true,
        provider: "cloudflare",
        purpose: "deploy",
      },
      {
        slot: "worker_namespace",
        kind: "binding",
        required: true,
        provider: "cloudflare",
        bindingKind: "worker",
      },
    ]);
  });

  it("rejects material requirements with fields from a different kind", () => {
    const tool = makeTool();
    const invalidMaterials = {
      ...tool,
      contract: {
        ...tool.contract,
        requiredMaterials: [
          {
            slot: "api",
            kind: "credential",
            required: true,
            bindingKind: "d1",
          },
        ],
      },
    } as unknown as Tool;

    expect(validateToolRegistry({ lookup: invalidMaterials })).toEqual({
      ok: false,
      issues: [
        {
          kind: "invalid_required_material",
          toolId: "lookup",
        },
        {
          kind: "unregistered_contract",
          toolId: "lookup",
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
              anchorId: "tool.executed:tool:tool-registry-claim:1:0:call-1",
              anchorKind: "carrier_proof",
              carrierRef: "tool:lookup",
            },
          }),
        }),
      );

      await runtime.dispose();
    });
  });

  it("decodes tool args before admit or execute", async () => {
    const scope = "tool-registry-schema-decode";
    const id = testEnv.AGENT_DO.idFromName(scope);
    const stub = testEnv.AGENT_DO.get(id);
    let admitted = false;
    let executed = false;
    const tool = defineTool({
      name: "lookup",
      description: "Lookup a value",
      args: Schema.Struct({ key: Schema.String }),
      authority: "read",
      admit: () => {
        admitted = true;
        return { ok: true };
      },
      execute: async () => {
        executed = true;
        return { value: 42 };
      },
    });

    await runInDurableObject(stub, async (_inst, state) => {
      const ai = stubAi([toolCallResp("lookup", '{"key":1}', "call-1")]);
      const runtime = buildRuntime(state, ai);

      const result = await runtime.runPromise(submitAgentEffect(makeSpec(scope, tool)));
      expect(result.ok).toBe(false);
      expect(admitted).toBe(false);
      expect(executed).toBe(false);

      const events = await runtime.runPromise(
        Effect.gen(function* () {
          const l = yield* Ledger;
          return yield* l.events(scope);
        }),
      );
      expect(events.some((event) => event.kind === "tool.executed")).toBe(false);
      expect(events.some((event) => event.kind === "tool.rejected")).toBe(false);
      expect(events.some((event) => event.kind === "agent.aborted.tool_error")).toBe(true);

      await runtime.dispose();
    });
  });

  it("requires an explicit admitter at construction", () => {
    expect(() =>
      defineToolFromDefinition({
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
      } as never),
    ).toThrow("tool admitter is required");
  });

  it("settles malformed admitter rejection refs as rejected claims", async () => {
    const scope = "tool-registry-admitter-malformed-rejection";
    const id = testEnv.AGENT_DO.idFromName(scope);
    const stub = testEnv.AGENT_DO.get(id);
    let executed = false;
    const malformedRejectionTool = defineToolFromDefinition({
      definition: {
        type: "function",
        function: {
          name: "lookup",
          description: "Lookup a value",
          parameters: { type: "object", properties: {}, required: [] },
        },
      },
      admit: () =>
        ({
          ok: false,
          rejectionRef: {
            rejectionId: "",
            rejectionKind: "not_a_kind",
          },
        }) as never,
      execute: async () => {
        executed = true;
        return { value: 42 };
      },
      authorityClass: "write",
    });

    await runInDurableObject(stub, async (_inst, state) => {
      const ai = stubAi([toolCallResp("lookup", "{}", "call-1")]);
      const runtime = buildRuntime(state, ai);

      const result = await runtime.runPromise(
        submitAgentEffect(makeSpec(scope, malformedRejectionTool)),
      );
      expect(result.ok).toBe(false);
      expect(executed).toBe(false);

      const events = await runtime.runPromise(
        Effect.gen(function* () {
          const l = yield* Ledger;
          return yield* l.events(scope);
        }),
      );
      const rejected = events.find((event) => event.kind === "tool.rejected");
      expect(rejected?.payload).toEqual(
        expect.objectContaining({
          claim: expect.objectContaining({
            phase: "rejected",
            operationRef: "tool:tool-registry-admitter-malformed-rejection:1:0:call-1",
            rejectionRef: {
              rejectionId: "tool:tool-registry-admitter-malformed-rejection:1:0:call-1",
              rejectionKind: "policy_denied",
              reason: "invalid_admitter_rejection_ref",
            },
          }),
        }),
      );

      await runtime.dispose();
    });
  });

  it("settles admitter throws as provider rejections", async () => {
    const scope = "tool-registry-admitter-throw";
    const id = testEnv.AGENT_DO.idFromName(scope);
    const stub = testEnv.AGENT_DO.get(id);
    let executed = false;
    const throwingAdmitterTool = defineToolFromDefinition({
      definition: {
        type: "function",
        function: {
          name: "lookup",
          description: "Lookup a value",
          parameters: { type: "object", properties: {}, required: [] },
        },
      },
      admit: () => {
        throw new Error("policy service down");
      },
      execute: async () => {
        executed = true;
        return { value: 42 };
      },
      authorityClass: "write",
    });

    await runInDurableObject(stub, async (_inst, state) => {
      const ai = stubAi([toolCallResp("lookup", "{}", "call-1")]);
      const runtime = buildRuntime(state, ai);

      const result = await runtime.runPromise(
        submitAgentEffect(makeSpec(scope, throwingAdmitterTool)),
      );
      expect(result.ok).toBe(false);
      expect(executed).toBe(false);

      const events = await runtime.runPromise(
        Effect.gen(function* () {
          const l = yield* Ledger;
          return yield* l.events(scope);
        }),
      );
      const rejected = events.find((event) => event.kind === "tool.rejected");
      expect(rejected?.payload).toEqual(
        expect.objectContaining({
          claim: expect.objectContaining({
            phase: "rejected",
            operationRef: "tool:tool-registry-admitter-throw:1:0:call-1",
            rejectionRef: {
              rejectionId: "tool:tool-registry-admitter-throw:1:0:call-1",
              rejectionKind: "provider_rejected",
              reason: "admitter_error:Error",
            },
          }),
        }),
      );

      await runtime.dispose();
    });
  });

  it("settles malformed admitter verdicts as rejected claims", async () => {
    const scope = "tool-registry-admitter-malformed";
    const id = testEnv.AGENT_DO.idFromName(scope);
    const stub = testEnv.AGENT_DO.get(id);
    let executed = false;
    const malformedAdmitterTool = defineToolFromDefinition({
      definition: {
        type: "function",
        function: {
          name: "lookup",
          description: "Lookup a value",
          parameters: { type: "object", properties: {}, required: [] },
        },
      },
      admit: () => undefined as never,
      execute: async () => {
        executed = true;
        return { value: 42 };
      },
      authorityClass: "write",
    });

    await runInDurableObject(stub, async (_inst, state) => {
      const ai = stubAi([toolCallResp("lookup", "{}", "call-1")]);
      const runtime = buildRuntime(state, ai);

      const result = await runtime.runPromise(
        submitAgentEffect(makeSpec(scope, malformedAdmitterTool)),
      );
      expect(result.ok).toBe(false);
      expect(executed).toBe(false);

      const events = await runtime.runPromise(
        Effect.gen(function* () {
          const l = yield* Ledger;
          return yield* l.events(scope);
        }),
      );
      const rejected = events.find((event) => event.kind === "tool.rejected");
      expect(rejected?.payload).toEqual(
        expect.objectContaining({
          claim: expect.objectContaining({
            phase: "rejected",
            operationRef: "tool:tool-registry-admitter-malformed:1:0:call-1",
            rejectionRef: {
              rejectionId: "tool:tool-registry-admitter-malformed:1:0:call-1",
              rejectionKind: "policy_denied",
              reason: "invalid_admitter_verdict",
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
    const failingTool = defineToolFromDefinition({
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
      admit: permissiveToolAdmitter,
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
              rejectionId: "tool.rejected:tool:tool-registry-rejected:1:0:call-1",
              rejectionKind: "provider_rejected",
              reason: "Error",
            },
          }),
        }),
      );
      expect(events.some((event) => event.kind === "agent.aborted.tool_error")).toBe(true);

      await runtime.dispose();
    });
  });
});
