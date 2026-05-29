import type { SubmitSpec } from "@agent-os/runtime";
import {
  credential,
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

void agent.submit(facadeSpec);
// @ts-expect-error facade submit does not accept full SubmitSpec
void agent.submit(fullSpec);
