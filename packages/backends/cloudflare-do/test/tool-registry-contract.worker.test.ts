import { Context, Effect, Layer, ManagedRuntime, Schema } from "effect";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type {} from "@effect/vitest";

import { AdmissionLive } from "../src/admission";
import { EventBusLive } from "../src/ledger";
import { Ledger, LedgerLive } from "../src/ledger";
import { QuotaLive } from "../src/quota";
import { RefResolverLive } from "@agent-os/kernel/ref-resolver";
import { LlmTransport, type InternalSubmitSpec, submitAgentEffect } from "@agent-os/runtime";
import { defineTool, pureToolExecution, type Tool } from "@agent-os/kernel/tools";
import type { EventHandler } from "@agent-os/kernel/types";
import { finalTextResp, stubLlmTransport, toolCallResp } from "./_stub-ai";
import { allowToolAdmitter, makeLookupTool } from "./_tool-fixture";
import { testEventIdentity } from "./_identity";
import type { BackendProtocolEventIdentity } from "@agent-os/backend-protocol";

interface TestEnv {
  readonly AGENT_DO: DurableObjectNamespace;
}

const testEnv = env as unknown as TestEnv;

const toolRegistryAuthorityRef = {
  authorityClass: "llm_route" as const,
  authorityId: "tool-registry-contract",
};

const makeSpec = (scope: string, tool: Tool): InternalSubmitSpec => ({
  intent: "lookup",
  context: {},
  route: {
    kind: "openai-chat-compatible",
    endpointRef: "test-endpoint",
    credentialRef: "test-credential",
    modelId: "test-model",
  } as const,
  tools: { lookup: tool },
  budget: { maxTurns: 3 },
  scope,
  scopeRef: { kind: "conversation", scopeId: scope },
  effectAuthorityRef: toolRegistryAuthorityRef,
});

const buildRuntime = (
  state: DurableObjectState,
  llm: Context.Tag.Service<typeof LlmTransport>,
  identity: BackendProtocolEventIdentity,
) => {
  const handlers = new Map<string, Set<EventHandler>>();
  const eventBus = EventBusLive(handlers);
  const ledger = LedgerLive(state).pipe(Layer.provide(eventBus));
  const quota = QuotaLive(state, identity).pipe(Layer.provide(eventBus));
  const llmTransport = Layer.succeed(LlmTransport, llm);
  const refs = RefResolverLive({
    material: () => null,
  });
  const admission = AdmissionLive(state, identity).pipe(
    Layer.provide(Layer.mergeAll(eventBus, llmTransport)),
  );
  return ManagedRuntime.make(Layer.mergeAll(ledger, quota, llmTransport, admission, refs));
};

describe("tool registry generator", () => {
  it("settles tool execution as a lived claim in tool.executed", async () => {
    const scope = "tool-registry-claim";
    const id = testEnv.AGENT_DO.idFromName(scope);
    const stub = testEnv.AGENT_DO.get(id);

    await runInDurableObject(stub, async (_inst, state) => {
      const llm = stubLlmTransport([toolCallResp("lookup", "{}", "call-1"), finalTextResp("done")]);
      const identity = testEventIdentity(scope, toolRegistryAuthorityRef);
      const runtime = buildRuntime(state, llm, identity);

      const result = await runtime.runPromise(submitAgentEffect(makeSpec(scope, makeLookupTool())));
      expect(result.ok).toBe(true);

      const events = await runtime.runPromise(
        Effect.gen(function* () {
          const l = yield* Ledger;
          return yield* l.events(identity);
        }),
      );
      const executed = events.find((event) => event.kind === "tool.executed");
      expect(executed?.payload).toEqual(
        expect.objectContaining({
          name: "lookup",
          claim: expect.objectContaining({
            phase: "lived",
            operationRef: "tool:tool-registry-claim:1:0:call-1",
            effectAuthorityRef: {
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
      execution: pureToolExecution(),
      execute: async () => {
        executed = true;
        return { value: 42 };
      },
    });

    await runInDurableObject(stub, async (_inst, state) => {
      const llm = stubLlmTransport([toolCallResp("lookup", '{"key":1}', "call-1")]);
      const identity = testEventIdentity(scope, toolRegistryAuthorityRef);
      const runtime = buildRuntime(state, llm, identity);

      const result = await runtime.runPromise(submitAgentEffect(makeSpec(scope, tool)));
      expect(result.ok).toBe(false);
      expect(admitted).toBe(false);
      expect(executed).toBe(false);

      const events = await runtime.runPromise(
        Effect.gen(function* () {
          const l = yield* Ledger;
          return yield* l.events(identity);
        }),
      );
      expect(events.some((event) => event.kind === "tool.executed")).toBe(false);
      expect(events.some((event) => event.kind === "tool.rejected")).toBe(false);
      expect(events.some((event) => event.kind === "agent.aborted.tool_error")).toBe(true);

      await runtime.dispose();
    });
  });

  it("settles malformed admitter rejection refs as rejected claims", async () => {
    const scope = "tool-registry-admitter-malformed-rejection";
    const id = testEnv.AGENT_DO.idFromName(scope);
    const stub = testEnv.AGENT_DO.get(id);
    let executed = false;
    const malformedRejectionTool = defineTool({
      name: "lookup",
      description: "Lookup a value",
      args: Schema.Struct({}),
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
      authority: "write",
      execution: pureToolExecution(),
    });

    await runInDurableObject(stub, async (_inst, state) => {
      const llm = stubLlmTransport([toolCallResp("lookup", "{}", "call-1")]);
      const identity = testEventIdentity(scope, toolRegistryAuthorityRef);
      const runtime = buildRuntime(state, llm, identity);

      const result = await runtime.runPromise(
        submitAgentEffect(makeSpec(scope, malformedRejectionTool)),
      );
      expect(result.ok).toBe(false);
      expect(executed).toBe(false);

      const events = await runtime.runPromise(
        Effect.gen(function* () {
          const l = yield* Ledger;
          return yield* l.events(identity);
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
    const throwingAdmitterTool = defineTool({
      name: "lookup",
      description: "Lookup a value",
      args: Schema.Struct({}),
      admit: () => {
        throw new Error("policy service down");
      },
      execute: async () => {
        executed = true;
        return { value: 42 };
      },
      authority: "write",
      execution: pureToolExecution(),
    });

    await runInDurableObject(stub, async (_inst, state) => {
      const llm = stubLlmTransport([toolCallResp("lookup", "{}", "call-1")]);
      const identity = testEventIdentity(scope, toolRegistryAuthorityRef);
      const runtime = buildRuntime(state, llm, identity);

      const result = await runtime.runPromise(
        submitAgentEffect(makeSpec(scope, throwingAdmitterTool)),
      );
      expect(result.ok).toBe(false);
      expect(executed).toBe(false);

      const events = await runtime.runPromise(
        Effect.gen(function* () {
          const l = yield* Ledger;
          return yield* l.events(identity);
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
    const malformedAdmitterTool = defineTool({
      name: "lookup",
      description: "Lookup a value",
      args: Schema.Struct({}),
      admit: () => undefined as never,
      execute: async () => {
        executed = true;
        return { value: 42 };
      },
      authority: "write",
      execution: pureToolExecution(),
    });

    await runInDurableObject(stub, async (_inst, state) => {
      const llm = stubLlmTransport([toolCallResp("lookup", "{}", "call-1")]);
      const identity = testEventIdentity(scope, toolRegistryAuthorityRef);
      const runtime = buildRuntime(state, llm, identity);

      const result = await runtime.runPromise(
        submitAgentEffect(makeSpec(scope, malformedAdmitterTool)),
      );
      expect(result.ok).toBe(false);
      expect(executed).toBe(false);

      const events = await runtime.runPromise(
        Effect.gen(function* () {
          const l = yield* Ledger;
          return yield* l.events(identity);
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
    const failingTool = defineTool({
      name: "lookup",
      description: "Lookup a value",
      args: Schema.Struct({}),
      execute: async () => {
        throw new Error("upstream down");
      },
      admit: allowToolAdmitter,
      authority: "read",
      execution: pureToolExecution(),
    });

    await runInDurableObject(stub, async (_inst, state) => {
      const llm = stubLlmTransport([toolCallResp("lookup", "{}", "call-1")]);
      const identity = testEventIdentity(scope, toolRegistryAuthorityRef);
      const runtime = buildRuntime(state, llm, identity);

      const result = await runtime.runPromise(submitAgentEffect(makeSpec(scope, failingTool)));
      expect(result.ok).toBe(false);

      const events = await runtime.runPromise(
        Effect.gen(function* () {
          const l = yield* Ledger;
          return yield* l.events(identity);
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

  it("settles hanging tool execution as budget_time and aborts the tool signal", async () => {
    const scope = "tool-registry-budget-time";
    const id = testEnv.AGENT_DO.idFromName(scope);
    const stub = testEnv.AGENT_DO.get(id);
    let observedSignal: AbortSignal | undefined;
    let aborted = false;
    const hangingTool = defineTool({
      name: "lookup",
      description: "Lookup a value",
      args: Schema.Struct({}),
      execute: async (_args, ctx) => {
        observedSignal = ctx.signal;
        ctx.signal.addEventListener("abort", () => {
          aborted = true;
        });
        await new Promise<never>(() => {});
      },
      admit: allowToolAdmitter,
      authority: "read",
      execution: pureToolExecution(),
    });

    await runInDurableObject(stub, async (_inst, state) => {
      const llm = stubLlmTransport([toolCallResp("lookup", "{}", "call-1")]);
      const identity = testEventIdentity(scope, toolRegistryAuthorityRef);
      const runtime = buildRuntime(state, llm, identity);
      const spec: InternalSubmitSpec = {
        ...makeSpec(scope, hangingTool),
        budget: { maxTurns: 3, timeMs: 50, toolRetries: 0 },
      };

      const result = await runtime.runPromise(submitAgentEffect(spec));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("budget_time");
      }
      expect(observedSignal).toBeInstanceOf(AbortSignal);
      expect(aborted || observedSignal?.aborted).toBe(true);

      const events = await runtime.runPromise(
        Effect.gen(function* () {
          const l = yield* Ledger;
          return yield* l.events(identity);
        }),
      );
      expect(events.some((event) => event.kind === "tool.executed")).toBe(false);
      expect(events.some((event) => event.kind === "tool.rejected")).toBe(true);
      expect(events.some((event) => event.kind === "agent.aborted.budget_time")).toBe(true);
      expect(events.some((event) => event.kind === "agent.run.completed")).toBe(false);

      await runtime.dispose();
    });
  });
});
