import type { SubmitSpec } from "@agent-os/runtime";
import {
  credential,
  createAgentDurableObject,
  defineAgentDO,
  durableObjectRpcClient,
  endpoint,
  openAIChat,
  type AgentSubmitSpec,
  type CloudflareAgentEnv,
} from "../src";

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

defineAgentDO<TestEnv>({
  on: {
    "test.event": ({ agent }) => {
      void agent.emit("test.followup", {});
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
});

declare const agent: InstanceType<typeof LlmDO>;
declare const facadeSpec: AgentSubmitSpec;
declare const fullSpec: SubmitSpec;

void agent.emit("test.followup", {});
// @ts-expect-error facade clients do not expose low-level emitEvent
void agent.emitEvent({ event: "test.followup", data: {} });
// @ts-expect-error facade clients do not expose low-level dispatchToScope
void agent.dispatchToScope({} as never);
// @ts-expect-error facade clients do not expose low-level scheduleEvent
void agent.scheduleEvent({ event: "test.followup", data: {}, at: scheduleAt });

void agent.submit(facadeSpec);
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
