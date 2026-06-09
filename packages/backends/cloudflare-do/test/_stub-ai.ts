/**
 * Test helper: deterministic LlmTransport service.
 *
 * Tests feed agentOS-owned LlmResponse values directly. Provider wire JSON is
 * not part of runtime/submit/admission tests; provider projection is covered by
 * @agent-os/llm-transport-effect-ai.
 */

import { Context, Effect } from "effect";
import {
  LlmTransport,
  type LlmResponse,
  type LlmRoute,
  type LlmWireDescriptor,
} from "@agent-os/llm-protocol";
import { UpstreamFailure } from "@agent-os/kernel/errors";

const DEFAULT_USAGE = {
  promptTokens: 10,
  completionTokens: 5,
  totalTokens: 15,
};

const routeKind = (route: LlmRoute): string =>
  typeof route.kind === "string" ? route.kind : "unknown";

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

export const stubLlmWireDescriptor = (route: LlmRoute): LlmWireDescriptor => ({
  method: "POST",
  url: `test-llm://${routeKind(route)}`,
  headers: [
    ["x-agentos-endpoint-ref", String(route.endpointRef ?? "")],
    ["x-agentos-credential-ref", String(route.credentialRef ?? "")],
  ],
  bodySchema: {
    type: "object",
    properties: {
      messages: {
        type: "array",
        items: { type: "object", properties: {}, additionalProperties: true },
      },
    },
    additionalProperties: true,
  },
});

export const stubLlmTransport = (
  responses: ReadonlyArray<LlmResponse>,
): Context.Tag.Service<typeof LlmTransport> => {
  let i = 0;
  return {
    resolveRoute: (route) =>
      Effect.succeed({
        wireDescriptor: stubLlmWireDescriptor(route),
        providerOutputAdapterId: `${routeKind(route)}@test-output-1.0.0`,
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
