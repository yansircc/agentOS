import type { SubmitSpec } from "@agent-os/runtime-protocol";
import { credentialMaterialRef } from "@agent-os/kernel/material-ref";
import { defineAgentSubmitBindings } from "@agent-os/runtime-protocol";
import type { LlmTransport } from "@agent-os/llm-protocol";
import type { RefResolverService } from "@agent-os/kernel/ref-resolver";
import type { Layer } from "effect";
import {
  credential,
  createAgentDurableObject,
  defineAgentDO,
  endpoint,
  openAIChat,
  type AgentSubmitSpec,
  type CloudflareAgentEnv,
} from "../src";
import { durableObjectRpcClient } from "../src/do-rpc";

interface TestEnv extends CloudflareAgentEnv {
  readonly LLM_ENDPOINT: string;
  readonly LLM_KEY: string;
  readonly AGENT_DO: DurableObjectNamespace;
}

interface ProductRpc {
  readonly submitWorkspacePrompt: (input: {
    readonly prompt: string;
    readonly files: ReadonlyArray<{ readonly path: string }>;
  }) => Promise<{ readonly ok: boolean }>;
  readonly invalidFunctionInput: (input: { readonly fn: () => void }) => Promise<void>;
  readonly value: string;
}

const scheduleAt = 1_700_000_000_000;
declare const llmTransport: (env: TestEnv) => Layer.Layer<LlmTransport, never, RefResolverService>;

defineAgentDO<TestEnv>({
  on: {
    "test.event": ({ agent }) => {
      void agent.emit("test.followup", {});
      // @ts-expect-error facade handler clients do not expose raw ledger reads
      void agent.events({} as never);
      // @ts-expect-error facade handler clients do not expose raw event streams
      void agent.streamEvents({} as never);
      // @ts-expect-error facade handler clients do not expose projection admin
      void agent.projectionRebuild({} as never);
      // @ts-expect-error event-only facade clients do not expose submit
      void agent.submit({
        intent: "run",
        input: {},
        effectAuthorityRef: { authorityClass: "llm_route", authorityId: "route" },
      });
    },
  },
});

const LlmDO = defineAgentDO<TestEnv>({
  bindings: [
    endpoint<TestEnv>("llm").from((env) => env.LLM_ENDPOINT),
    credential<TestEnv>("llm-key").from((env) => env.LLM_KEY),
  ],
  llms: {
    default: openAIChat({
      model: "gpt-4.1-mini",
      endpoint: "llm",
      credential: "llm-key",
    }),
  },
  llmTransport,
});

declare const agent: InstanceType<typeof LlmDO>;
declare const facadeSpec: AgentSubmitSpec;
declare const fullSpec: SubmitSpec;
declare const lookupTool: NonNullable<NonNullable<AgentSubmitSpec["bindings"]>["tools"]>[string];

void agent.emit("test.followup", {});
// @ts-expect-error facade clients do not expose low-level emitEvent
void agent.emitEvent({ event: "test.followup", data: {} });
// @ts-expect-error facade clients do not expose low-level dispatchToScope
void agent.dispatchToScope({} as never);
// @ts-expect-error facade clients do not expose low-level scheduleEvent
void agent.scheduleEvent({ event: "test.followup", data: {}, at: scheduleAt });

void agent.submit(facadeSpec);
void agent.submit({
  ...facadeSpec,
  bindings: defineAgentSubmitBindings({
    tools: { lookup: lookupTool },
    materials: { facade_token: credentialMaterialRef("facade-token") },
    resolvedMaterials: { facade_token: "resolved-provider-material" },
    context: { input: {}, source: "run-binding" },
    decisionInterrupts: [{ toolName: "lookup", reason: "approval_required" }],
  }),
  resume: {
    runId: 1,
    turn: { id: 1, index: 0 },
    interruptId: "decision:lookup",
    gateRef: "gate:lookup",
    decisionRef: "decision:approved",
    resume: { approved: true },
  },
});
void agent.submit({
  ...facadeSpec,
  bindings: defineAgentSubmitBindings({
    // @ts-expect-error submit material bindings carry symbolic MaterialRef values
    materials: { facade_token: "resolved-provider-material" },
  }),
});
// @ts-expect-error facade submit does not accept full SubmitSpec
void agent.submit(fullSpec);

const _objectDeliverSubmitSpec: AgentSubmitSpec = {
  intent: "run",
  input: {},
  effectAuthorityRef: { authorityClass: "llm_route", authorityId: "route" },
  // @ts-expect-error facade submit does not accept app deliver event names
  deliver: "test.done",
};

const LowLevelDO = createAgentDurableObject<TestEnv>();
declare const lowLevelAgent: InstanceType<typeof LowLevelDO>;
void lowLevelAgent.emitEvent({ event: "test.low", data: {} });
// @ts-expect-error low-level clients do not expose facade emit alias
void lowLevelAgent.emit("test.low", {});
// @ts-expect-error low-level clients do not expose facade dispatch alias
void lowLevelAgent.dispatch({} as never);
// @ts-expect-error low-level clients do not expose facade schedule alias
void lowLevelAgent.schedule("test.low", {}, { at: scheduleAt });

declare const env: TestEnv;
const rpc = durableObjectRpcClient<ProductRpc>(env.AGENT_DO, "agent-scope");
void rpc.submitWorkspacePrompt({ prompt: "run", files: [{ path: "README.md" }] });
// @ts-expect-error non-method properties are not projected into the RPC client
void rpc.value;
// @ts-expect-error function-bearing payloads cannot cross Durable Object RPC
void rpc.invalidFunctionInput({ fn: () => undefined });
