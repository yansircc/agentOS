import { Effect, Layer } from "effect";
import { UpstreamFailure } from "@agent-os/kernel/errors";
import type { LlmRequest, LlmResponse } from "@agent-os/kernel/llm";
import { LlmTransport } from "@agent-os/runtime";

export interface InMemoryLlmTransportOptions {
  readonly handler?: (request: LlmRequest) => LlmResponse | Promise<LlmResponse>;
  readonly responses?: ReadonlyArray<LlmResponse>;
}

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
    call: (request) =>
      Effect.tryPromise({
        try: () => Promise.resolve(handler(request)),
        catch: (cause) => new UpstreamFailure({ cause }),
      }),
  });
};
