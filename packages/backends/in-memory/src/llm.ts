import { Effect, Layer } from "effect";
import { UpstreamFailure } from "@agent-os/kernel/errors";
import type { LlmRequest, LlmResponse, LlmRoute, LlmWireDescriptor } from "@agent-os/llm-protocol";
import { LlmTransport } from "@agent-os/runtime";

export interface InMemoryLlmTransportOptions {
  readonly handler?: (request: LlmRequest) => LlmResponse | Promise<LlmResponse>;
  readonly responses?: ReadonlyArray<LlmResponse>;
}

const IN_MEMORY_LLM_TRANSPORT_VERSION = "1.0.0";

const routeKind = (route: LlmRoute): string =>
  typeof route.kind === "string" ? route.kind : "unknown";

const inMemoryWireDescriptor = (route: LlmRoute): LlmWireDescriptor => ({
  method: "POST",
  url: `in-memory://${routeKind(route)}`,
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

const responseQueueHandler = (
  responses: ReadonlyArray<LlmResponse>,
): ((request: LlmRequest) => LlmResponse | Promise<LlmResponse>) => {
  const queue = [...responses];
  return () => {
    const next = queue.shift();
    if (next === undefined) {
      return Promise.reject(new UpstreamFailure({ cause: "in_memory_llm_response_missing" }));
    }
    return next;
  };
};

export const InMemoryLlmTransportLive = (
  options: InMemoryLlmTransportOptions = {},
): Layer.Layer<LlmTransport> => {
  const handler = options.handler ?? responseQueueHandler(options.responses ?? []);
  return Layer.succeed(LlmTransport, {
    resolveRoute: (route) =>
      Effect.succeed({
        wireDescriptor: inMemoryWireDescriptor(route),
        providerOutputAdapterId: `${routeKind(route)}@in-memory-${IN_MEMORY_LLM_TRANSPORT_VERSION}`,
        providerOutputAdapterVersion: IN_MEMORY_LLM_TRANSPORT_VERSION,
        transportAdapterId: `in-memory-llm-transport@${IN_MEMORY_LLM_TRANSPORT_VERSION}`,
        transportAdapterVersion: IN_MEMORY_LLM_TRANSPORT_VERSION,
      }),
    call: (request) =>
      Effect.tryPromise({
        try: () => Promise.resolve(handler(request)),
        catch: (cause) => new UpstreamFailure({ cause }),
      }),
  });
};
