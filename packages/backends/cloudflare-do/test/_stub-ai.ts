/**
 * Test helper: deterministic LlmTransport service.
 *
 * Tests feed agentOS-owned LlmResponse values directly. Provider wire JSON is
 * not part of runtime/submit/admission tests; provider projection is covered by
 * @agent-os/llm-transport-effect-ai.
 */

import { Context, Effect } from "effect";
import type { LlmResponse } from "@agent-os/kernel/llm";
import { UpstreamFailure } from "@agent-os/kernel/errors";
import { LlmTransport } from "@agent-os/runtime";

const DEFAULT_USAGE = {
  promptTokens: 10,
  completionTokens: 5,
  totalTokens: 15,
};

export const toolCallResp = (
  toolName: string,
  argsJson: string,
  id = `call-${Math.random().toString(36).slice(2, 10)}`,
): LlmResponse => ({
  items: [
    {
      type: "tool_call",
      call: { id, type: "function", function: { name: toolName, arguments: argsJson } },
    },
  ],
  usage: DEFAULT_USAGE,
});

export const structuredToolResp = (argsJson: string, id = "c1"): LlmResponse =>
  toolCallResp("_submit_structured", argsJson, id);

export const finalTextResp = (text: string): LlmResponse => ({
  items: [{ type: "message", text }],
  usage: DEFAULT_USAGE,
});

export const stubLlmTransport = (
  responses: ReadonlyArray<LlmResponse>,
): Context.Tag.Service<typeof LlmTransport> => {
  let i = 0;
  return {
    describeRoute: (route) => ({
      providerOutputAdapterId: `${route.kind}@test-output-1.0.0`,
      providerOutputAdapterVersion: "1.0.0",
      transportAdapterId: "test-llm-transport@1.0.0",
      transportAdapterVersion: "1.0.0",
    }),
    call: () =>
      Effect.gen(function* () {
        const next = responses[i];
        if (next === undefined) {
          return yield* new UpstreamFailure({
            cause: {
              reason: "stub_llm_transport_queue_exhausted",
              call: i + 1,
              length: responses.length,
            },
          });
        }
        i += 1;
        return next;
      }),
  };
};

export type { LlmResponse };
