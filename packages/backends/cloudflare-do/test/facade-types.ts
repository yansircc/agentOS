import type { SubmitSpec } from "@agent-os/runtime";
import {
  credential,
  createAgentDurableObject,
  defineAgentDO,
  endpoint,
  openAIChat,
  type AgentSubmitSpec,
  type CloudflareAgentEnv,
} from "../src";

interface TestEnv extends CloudflareAgentEnv {
  readonly LLM_ENDPOINT: string;
  readonly LLM_KEY: string;
}

const scheduleAt = 1_700_000_000_000;

defineAgentDO<TestEnv>({
  on: {
    "test.event": ({ agent }) => {
      void agent.emit("test.followup", {});
      // @ts-expect-error event-only facade clients do not expose submit
      void agent.submit({ intent: "run", input: {}, deliver: "test.done" });
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
void agent.dispatchToScope(fullSpec.deliver as never);
// @ts-expect-error facade clients do not expose low-level scheduleEvent
void agent.scheduleEvent({ event: "test.followup", data: {}, at: scheduleAt });

void agent.submit(facadeSpec);
// @ts-expect-error facade submit does not accept full SubmitSpec
void agent.submit(fullSpec);

const _objectDeliverSpec: AgentSubmitSpec = {
  intent: "run",
  input: {},
  // @ts-expect-error facade submit deliver is a single event name
  deliver: { event: "test.done" },
};

const LowLevelDO = createAgentDurableObject<TestEnv>();
declare const lowLevelAgent: InstanceType<typeof LowLevelDO>;
void lowLevelAgent.emitEvent({ event: "test.low", data: {} });
// @ts-expect-error low-level clients do not expose facade emit alias
void lowLevelAgent.emit("test.low", {});
// @ts-expect-error low-level clients do not expose facade dispatch alias
void lowLevelAgent.dispatch(fullSpec.deliver as never);
// @ts-expect-error low-level clients do not expose facade schedule alias
void lowLevelAgent.schedule("test.low", {}, { at: scheduleAt });
