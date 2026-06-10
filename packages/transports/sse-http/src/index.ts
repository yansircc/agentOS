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

export type SseHttpEvent = {
  readonly event?: string;
  readonly data: string;
};

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

export const encodeSseHttpData = (value: unknown): string =>
  JSON.stringify(value)
    .split(/\r?\n/)
    .map((line) => `data: ${line}`)
    .join("\n");

export const encodeSseHttpEvent = (event: SseHttpEvent): string =>
  `${event.event === undefined ? "" : `event: ${event.event}\n`}${event.data
    .split(/\r?\n/)
    .map((line) => `data: ${line}`)
    .join("\n")}\n\n`;

export const encodeSseHttpJsonEvent = (eventName: string, value: unknown): string =>
  `event: ${eventName}\n${encodeSseHttpData(value)}\n\n`;

export const parseSseHttpEventBlock = (block: string): SseHttpEvent => {
  let event: string | undefined;
  const data: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith("event:")) {
      event = line.slice("event:".length).trim();
      continue;
    }
    if (line.startsWith("data:")) data.push(line.slice("data:".length).trimStart());
  }
  return { event, data: data.join("\n") };
};

export async function* decodeSseHttpEvents(
  chunks: AsyncIterable<SseHttpChunk>,
): AsyncGenerator<SseHttpEvent> {
  const decoder = new TextDecoder();
  let buffer = "";

  const flushBuffered = function* (): Generator<SseHttpEvent> {
    while (true) {
      const boundary = buffer.indexOf("\n\n");
      if (boundary < 0) return;
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      yield parseSseHttpEventBlock(block);
    }
  };

  for await (const chunk of chunks) {
    buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    yield* flushBuffered();
  }
  buffer += decoder.decode();
  const tail = buffer.trim().length > 0 ? parseSseHttpEventBlock(buffer) : null;
  buffer = "";
  if (tail !== null) yield tail;
}

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
