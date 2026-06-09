import {
  encodeAttachedStreamSse,
  type AttachedStreamOutboundFrame,
} from "@agent-os/attached-stream";
import {
  composeBatchedSubmitRunStream,
  encodeRunStreamSse,
  type ComposeBatchedSubmitRunStreamSpec,
} from "@agent-os/run-stream";

export const SSE_HTTP_CONTENT_TYPE = "text/event-stream; charset=utf-8";

export type SseHttpChunk = string | Uint8Array;
export type SseHttpSource = Iterable<SseHttpChunk> | AsyncIterable<SseHttpChunk>;

export interface SseHttpResponseOptions {
  readonly headers?: HeadersInit;
  readonly onCancel?: () => void | Promise<void>;
}

const isAsyncIterable = (value: SseHttpSource): value is AsyncIterable<SseHttpChunk> =>
  typeof (value as { readonly [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] ===
  "function";

async function* toAsyncIterable(source: SseHttpSource): AsyncGenerator<SseHttpChunk> {
  if (isAsyncIterable(source)) {
    for await (const chunk of source) yield chunk;
    return;
  }
  for (const chunk of source) yield chunk;
}

const sseHeaders = (init?: HeadersInit): Headers => {
  const headers = new Headers(init);
  if (!headers.has("Content-Type")) headers.set("Content-Type", SSE_HTTP_CONTENT_TYPE);
  if (!headers.has("Cache-Control")) headers.set("Cache-Control", "no-cache");
  if (!headers.has("Connection")) headers.set("Connection", "keep-alive");
  return headers;
};

/**
 * Creates a Web Fetch Server-Sent Events response from already-encoded chunks.
 * @experimental
 */
export const createSseHttpResponse = (
  source: SseHttpSource,
  options: SseHttpResponseOptions = {},
): Response => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start: (controller) => {
      void (async () => {
        try {
          for await (const chunk of toAsyncIterable(source)) {
            controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
          }
          controller.close();
        } catch (cause) {
          controller.error(cause);
        }
      })();
    },
    cancel: () => {
      void Promise.resolve(options.onCancel?.()).catch(() => undefined);
    },
  });
  return new Response(stream, { headers: sseHeaders(options.headers) });
};

/**
 * Creates a Web Fetch Server-Sent Events response from a complete text body.
 * @experimental
 */
export const createSseHttpTextResponse = (
  body: string,
  options: Omit<SseHttpResponseOptions, "onCancel"> = {},
): Response => new Response(body, { headers: sseHeaders(options.headers) });

/**
 * Moved transport wrapper for batched submit/run streams.
 * @experimental
 */
export const createBatchedSubmitRunStreamResponse = async (
  spec: ComposeBatchedSubmitRunStreamSpec,
  options: Omit<SseHttpResponseOptions, "onCancel"> = {},
): Promise<Response> =>
  createSseHttpTextResponse(
    (await composeBatchedSubmitRunStream(spec)).map(encodeRunStreamSse).join(""),
    options,
  );

/**
 * SSE-over-HTTP wrapper for output-only attached streams.
 * @experimental
 */
export const createAttachedStreamSseResponse = (
  output: AsyncIterable<AttachedStreamOutboundFrame>,
  options: SseHttpResponseOptions = {},
): Response => createSseHttpResponse(outputToSse(output), options);

async function* outputToSse(
  output: AsyncIterable<AttachedStreamOutboundFrame>,
): AsyncGenerator<string> {
  for await (const frame of output) yield encodeAttachedStreamSse(frame);
}
