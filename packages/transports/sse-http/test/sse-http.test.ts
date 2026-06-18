import { describe, expect, it, vi } from "vite-plus/test";
import {
  createAttachedStreamSseResponse,
  createSseHttpResponse,
  createSseHttpTextResponse,
  decodeSseHttpEvents,
  encodeSseHttpEvent,
  encodeSseHttpJsonEvent,
  parseSseHttpEventBlock,
  responseToSseHttpChunks,
  SSE_HTTP_CONTENT_TYPE,
} from "../src";
import type { AttachedStreamOutboundFrame } from "@agent-os/attached-stream";

const collectAsync = async <A>(source: AsyncIterable<A>): Promise<ReadonlyArray<A>> => {
  const values: A[] = [];
  for await (const value of source) values.push(value);
  return values;
};

describe("@agent-os/sse-http", () => {
  it("encodes and parses generic SSE events", async () => {
    expect(encodeSseHttpEvent({ event: "ready", data: "one\ntwo" })).toBe(
      "event: ready\ndata: one\ndata: two\n\n",
    );
    expect(encodeSseHttpJsonEvent("ledger", { id: 1, ok: true })).toBe(
      'event: ledger\ndata: {"id":1,"ok":true}\n\n',
    );
    expect(parseSseHttpEventBlock('event: ledger\ndata: {"id":1}')).toEqual({
      event: "ledger",
      data: '{"id":1}',
    });

    async function* chunks(): AsyncGenerator<string | Uint8Array> {
      yield "event: heartbeat\ndata: {}\n\n";
      yield new TextEncoder().encode('event: ledger\ndata: {"id":1');
      yield "}\n\n";
    }

    await expect(collectAsync(decodeSseHttpEvents(chunks()))).resolves.toEqual([
      { event: "heartbeat", data: "{}" },
      { event: "ledger", data: '{"id":1}' },
    ]);
  });

  it("creates a Web Fetch SSE response from encoded chunks", async () => {
    const response = createSseHttpResponse(["event: one\ndata: 1\n\n"]);
    expect(response.headers.get("content-type")).toBe(SSE_HTTP_CONTENT_TYPE);
    expect(response.headers.get("cache-control")).toBe("no-cache");
    expect(await response.text()).toBe("event: one\ndata: 1\n\n");
  });

  it("runs cancel hooks when the response body is cancelled", async () => {
    const onCancel = vi.fn();
    async function* source(): AsyncGenerator<string> {
      yield "event: one\ndata: 1\n\n";
      await new Promise<void>(() => undefined);
    }
    const response = createSseHttpResponse(source(), { onCancel });
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("creates a text SSE response without a stream lifecycle", async () => {
    const response = createSseHttpTextResponse("event: ready\ndata: {}\n\n");
    expect(response.headers.get("content-type")).toBe(SSE_HTTP_CONTENT_TYPE);
    expect(await response.text()).toBe("event: ready\ndata: {}\n\n");
  });

  it("converts Web Fetch responses into generic SSE chunks", async () => {
    const textResponse = new Response("event: one\ndata: 1\n\n");
    await expect(
      collectAsync(decodeSseHttpEvents(responseToSseHttpChunks(textResponse))),
    ).resolves.toEqual([{ event: "one", data: "1" }]);

    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        controller.enqueue(new TextEncoder().encode("event: two\n"));
        controller.enqueue(new TextEncoder().encode("data: 2\n\n"));
        controller.close();
      },
    });
    await expect(
      collectAsync(decodeSseHttpEvents(responseToSseHttpChunks(new Response(stream)))),
    ).resolves.toEqual([{ event: "two", data: "2" }]);

    await expect(collectAsync(responseToSseHttpChunks(new Response(null)))).resolves.toEqual([]);
  });

  it("wraps attached-stream output frames as SSE-over-HTTP", async () => {
    async function* output(): AsyncGenerator<AttachedStreamOutboundFrame> {
      yield {
        kind: "opened",
        streamRef: "attached/test",
        seq: 0,
        mode: "output_only",
      };
      yield {
        kind: "output",
        streamRef: "attached/test",
        seq: 1,
        channel: "stdout",
        payload: "hello",
      };
    }

    const response = createAttachedStreamSseResponse(output());
    expect(response.headers.get("content-type")).toBe(SSE_HTTP_CONTENT_TYPE);
    expect(await response.text()).toContain("event: opened");
    expect(await createAttachedStreamSseResponse(output()).text()).toContain("event: output");
  });
});
