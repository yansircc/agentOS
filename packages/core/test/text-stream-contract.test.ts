/**
 * submitTextStream — spec-31 contract tests.
 *
 * Validates:
 *   - token deltas are SSE-only;
 *   - final facts match submit()'s llm.response / deliver shape;
 *   - native OpenAI-compatible / Anthropic / Gemini wires share the public surface;
 *   - client disconnect writes abort, not deliver.
 */

import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";

import type { LedgerEventRpc } from "../src";
import type { TextStreamTestDO } from "./test-worker";

interface TestEnv {
  readonly TEXT_STREAM_DO: DurableObjectNamespace<TextStreamTestDO>;
}

interface TextStreamRpc {
  readonly submitText: () => Promise<Response>;
  readonly submitAnthropicText: () => Promise<Response>;
  readonly submitGeminiText: () => Promise<Response>;
  readonly cancelTextAfterFirstChunkForTest: () => Promise<LedgerEventRpc[]>;
  readonly events: () => Promise<LedgerEventRpc[]>;
}

interface SseFrame {
  readonly event?: string;
  readonly data?: string;
}

const testEnv = env as unknown as TestEnv;

const stubFor = (scope: string): TextStreamRpc =>
  testEnv.TEXT_STREAM_DO.get(
    testEnv.TEXT_STREAM_DO.idFromName(scope),
  ) as unknown as TextStreamRpc;

const parseFrame = (raw: string): SseFrame => {
  let event: string | undefined;
  let data: string | undefined;
  for (const line of raw.split("\n")) {
    if (line.startsWith("event: ")) event = line.slice(7);
    if (line.startsWith("data: ")) data = line.slice(6);
  }
  return { event, data };
};

const readFrames = async (
  response: Response,
  stop: (frame: SseFrame) => boolean,
  timeoutMs = 1_000,
): Promise<SseFrame[]> => {
  if (response.body === null) throw new Error("missing body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const frames: SseFrame[] = [];
  let buffer = "";
  const deadline = Date.now() + timeoutMs;

  try {
    while (Date.now() < deadline) {
      const read = await Promise.race([
        reader.read(),
        new Promise<ReadableStreamReadResult<Uint8Array>>((resolve) =>
          setTimeout(() => resolve({ done: true, value: undefined }), 20),
        ),
      ]);
      if (read.done) break;
      buffer += decoder.decode(read.value, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const frame = parseFrame(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
        frames.push(frame);
        if (stop(frame)) {
          await reader.cancel().catch(() => undefined);
          return frames;
        }
        boundary = buffer.indexOf("\n\n");
      }
    }
  } finally {
    reader.releaseLock();
  }
  throw new Error("timed out waiting for SSE frame");
};

const waitForKind = async (
  stub: TextStreamRpc,
  kind: string,
): Promise<LedgerEventRpc[]> => {
  const deadline = Date.now() + 1_000;
  let rows: LedgerEventRpc[] = [];
  while (Date.now() < deadline) {
    rows = await stub.events();
    if (rows.some((row) => row.kind === kind)) return rows;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${kind}`);
};

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("submitTextStream — spec-31", () => {
  it("streams token frames and commits equivalent final ledger facts", async () => {
    const fetchCalls: Array<{ readonly url: string; readonly body: unknown }> =
      [];
    const encoder = new TextEncoder();
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push({
        url: String(input),
        body: JSON.parse(String(init?.body ?? "{}")) as unknown,
      });
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                [
                  'data: {"choices":[{"delta":{"content":"Hel"}}]}',
                  "",
                  'data: {"choices":[{"delta":{"content":"lo"}}]}',
                  "",
                  'data: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":2,"total_tokens":9}}',
                  "",
                  "data: [DONE]",
                  "",
                ].join("\n"),
              ),
            );
            controller.close();
          },
        }),
        { status: 200 },
      );
    }) as typeof globalThis.fetch;

    const stub = stubFor("text-stream-success");
    const response = await stub.submitText();
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    const frames = await readFrames(response, (frame) => frame.event === "done");
    expect(frames.map((frame) => frame.event)).toEqual([
      "token",
      "token",
      "usage",
      "done",
    ]);
    expect(frames.map((frame) => JSON.parse(frame.data ?? "{}"))).toEqual([
      { delta: "Hel" },
      { delta: "lo" },
      { promptTokens: 7, completionTokens: 2, totalTokens: 9 },
      { turnId: 1, llmResponseId: 2, deliveredId: 3 },
    ]);

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.url).toBe(
      "https://text-stream.test/v1/chat/completions",
    );
    expect(fetchCalls[0]?.body).toMatchObject({
      model: "text-stream-model",
      stream: true,
      stream_options: { include_usage: true },
    });

    const rows = await stub.events();
    expect(rows.map((row) => row.kind)).toEqual([
      "chat.ingested",
      "llm.response",
      "text.done",
    ]);
    expect(rows[1]?.payload).toEqual({
      turn: { id: rows[0]?.id, index: 0 },
      text: "Hello",
      toolCalls: [],
      usage: { promptTokens: 7, completionTokens: 2, totalTokens: 9 },
    });
    expect(rows[2]?.payload).toEqual({
      final: "Hello",
      turn: { id: rows[0]?.id, index: 0 },
    });
  });

  it("streams native Anthropic Messages SSE through the same public surface", async () => {
    const fetchCalls: Array<{
      readonly url: string;
      readonly headers: Headers;
      readonly body: unknown;
    }> = [];
    const encoder = new TextEncoder();
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push({
        url: String(input),
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body ?? "{}")) as unknown,
      });
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                [
                  'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":5,"output_tokens":0}}}',
                  "",
                  'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Bon"}}',
                  "",
                  'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"jour"}}',
                  "",
                  'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":2}}',
                  "",
                  'event: message_stop\ndata: {"type":"message_stop"}',
                  "",
                ].join("\n"),
              ),
            );
            controller.close();
          },
        }),
        { status: 200 },
      );
    }) as typeof globalThis.fetch;

    const stub = stubFor("text-stream-anthropic");
    const frames = await readFrames(
      await stub.submitAnthropicText(),
      (frame) => frame.event === "done",
    );

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.url).toBe("https://anthropic-stream.test/v1/messages");
    expect(fetchCalls[0]?.headers.get("x-api-key")).toBe("test-key");
    expect(fetchCalls[0]?.headers.get("anthropic-version")).toBe("2023-06-01");
    expect(fetchCalls[0]?.body).toMatchObject({
      model: "claude-test",
      stream: true,
      max_tokens: expect.any(Number),
    });
    expect(frames.map((frame) => frame.event)).toEqual([
      "usage",
      "token",
      "token",
      "usage",
      "done",
    ]);

    const rows = await stub.events();
    expect(rows.map((row) => row.kind)).toEqual([
      "chat.ingested",
      "llm.response",
      "text.done",
    ]);
    expect(rows[1]?.payload).toMatchObject({
      text: "Bonjour",
      toolCalls: [],
      usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 },
    });
  });

  it("streams native Gemini SSE through the same public surface", async () => {
    const fetchCalls: Array<{
      readonly url: string;
      readonly headers: Headers;
      readonly body: unknown;
    }> = [];
    const encoder = new TextEncoder();
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push({
        url: String(input),
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body ?? "{}")) as unknown,
      });
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                [
                  'data: {"candidates":[{"content":{"parts":[{"text":"Ni"}]}}]}',
                  "",
                  'data: {"candidates":[{"content":{"parts":[{"text":"hao"}]}}],"usageMetadata":{"promptTokenCount":6,"candidatesTokenCount":2,"totalTokenCount":8}}',
                  "",
                ].join("\n"),
              ),
            );
            controller.close();
          },
        }),
        { status: 200 },
      );
    }) as typeof globalThis.fetch;

    const stub = stubFor("text-stream-gemini");
    const frames = await readFrames(
      await stub.submitGeminiText(),
      (frame) => frame.event === "done",
    );

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.url).toBe(
      "https://gemini-stream.test/v1beta/models/gemini-test:streamGenerateContent?alt=sse",
    );
    expect(fetchCalls[0]?.headers.get("x-goog-api-key")).toBe("test-key");
    expect(fetchCalls[0]?.body).toMatchObject({
      contents: expect.any(Array),
    });
    expect(frames.map((frame) => frame.event)).toEqual([
      "token",
      "token",
      "usage",
      "done",
    ]);

    const rows = await stub.events();
    expect(rows.map((row) => row.kind)).toEqual([
      "chat.ingested",
      "llm.response",
      "text.done",
    ]);
    expect(rows[1]?.payload).toMatchObject({
      text: "Nihao",
      toolCalls: [],
      usage: { promptTokens: 6, completionTokens: 2, totalTokens: 8 },
    });
  });

  it("client disconnect writes abort without llm.response or deliver", async () => {
    const encoder = new TextEncoder();
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n',
              ),
            );
            init?.signal?.addEventListener("abort", () => {
              controller.error(new Error("provider stream aborted"));
            });
          },
        }),
        { status: 200 },
      )) as typeof globalThis.fetch;

    const stub = stubFor("text-stream-client-disconnect");
    const rows = await stub
      .cancelTextAfterFirstChunkForTest()
      .then(async () => waitForKind(stub, "agent.aborted.client_disconnect"));
    expect(rows.map((row) => row.kind)).toEqual([
      "chat.ingested",
      "agent.aborted.client_disconnect",
    ]);
    expect(JSON.stringify(rows)).not.toContain("llm.response");
    expect(JSON.stringify(rows)).not.toContain("text.done");
  });
});
