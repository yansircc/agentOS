import { projectTurnStream, type TurnStreamFrame } from "@agent-os/turn-stream";
import {
  adaptAnthropicDeltaChunk,
  adaptGeminiDeltaChunk,
  adaptOpenAiCompatibleDeltaChunk,
  streamLlmTurn,
  type LlmTransportFetch,
  type LlmTransportMessage,
} from "../src";
import {
  llmCallSnapshotFromResponse,
  replayLlmResponseFromSnapshot,
  type LlmRequest,
  type LlmRoute,
} from "@agent-os/llm-protocol";
import type { RefResolver } from "@agent-os/kernel/ref-resolver";

const messages: ReadonlyArray<LlmTransportMessage> = [
  { role: "system", content: "be direct" },
  { role: "user", content: "hello" },
];

const resolver = (materials: Readonly<Record<string, string>>): RefResolver => ({
  material: (ref) => materials[`${ref.kind}:${ref.ref}`] ?? null,
});

const collect = async (
  frames: AsyncIterable<TurnStreamFrame>,
): Promise<ReadonlyArray<TurnStreamFrame>> => {
  const out: TurnStreamFrame[] = [];
  for await (const frame of frames) out.push(frame);
  return out;
};

const parseJsonBody = (body: BodyInit | null | undefined): unknown => {
  expect(typeof body).toBe("string");
  return JSON.parse(typeof body === "string" ? body : "null");
};

const textStream = (text: string): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });

const mockResponse = (spec: {
  readonly body: string;
  readonly status?: number;
  readonly contentType?: string;
}): Response =>
  ({
    ok: (spec.status ?? 200) >= 200 && (spec.status ?? 200) < 300,
    status: spec.status ?? 200,
    headers: {
      get: (name: string): string | null =>
        name.toLowerCase() === "content-type"
          ? (spec.contentType ?? "text/event-stream; charset=utf-8")
          : null,
    },
    body: textStream(spec.body),
  }) as unknown as Response;

const sse = (...data: ReadonlyArray<string>): Response =>
  mockResponse({
    body: data.map((entry) => `data: ${entry}\n\n`).join(""),
  });

describe("@agent-os/llm-transport-http", () => {
  it("replay mode live LLM provider adapter not called when call snapshot is present", () => {
    let liveLlmProviderAdapterCalled = false;
    const fetch: LlmTransportFetch = async () => {
      liveLlmProviderAdapterCalled = true;
      return sse("[DONE]");
    };
    const request: LlmRequest = {
      route: {
        kind: "test-route",
        endpointRef: "llm",
        credentialRef: "llm-key",
        modelId: "model-a",
      },
      messages,
    };
    const snapshot = llmCallSnapshotFromResponse({
      wireDescriptor: {
        method: "POST",
        url: "https://llm.example/chat",
        headers: [["Content-Type", "application/json"]],
      },
      request,
      response: {
        items: [{ type: "message", text: "snapshot" }],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      },
    });

    const replayed = replayLlmResponseFromSnapshot(snapshot);

    expect(replayed.items).toEqual([{ type: "message", text: "snapshot" }]);
    expect(liveLlmProviderAdapterCalled).toBe(false);
    expect(fetch).toBeDefined();
  });

  it("maps OpenAI-compatible deltas into text, curated metadata, and terminal frames", () => {
    expect(
      adaptOpenAiCompatibleDeltaChunk({
        turnRef: "turn/openai",
        seq: 4,
        chunk: {
          choices: [
            { delta: { role: "assistant" } },
            { delta: { content: "hel" } },
            { delta: {}, finish_reason: "stop" },
          ],
          usage: {
            prompt_tokens: 1,
            completion_tokens: 2,
            total_tokens: 3,
            raw_body: "not copied",
          },
        },
      }),
    ).toEqual([
      { kind: "text_delta", turnRef: "turn/openai", seq: 4, text: "hel" },
      {
        kind: "metadata",
        turnRef: "turn/openai",
        seq: 5,
        data: { provider: "openai_compatible", finishReason: "stop" },
      },
      {
        kind: "metadata",
        turnRef: "turn/openai",
        seq: 6,
        data: {
          provider: "openai_compatible",
          usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
        },
      },
    ]);

    expect(
      adaptOpenAiCompatibleDeltaChunk({
        turnRef: "turn/openai",
        seq: 7,
        chunk: "[DONE]",
      }),
    ).toEqual([{ kind: "done", turnRef: "turn/openai", seq: 7 }]);
  });

  it("maps Anthropic deltas and named no-op events", () => {
    expect(
      adaptAnthropicDeltaChunk({
        turnRef: "turn/anthropic",
        seq: 0,
        chunk: { type: "ping" },
      }),
    ).toEqual([]);

    expect(
      adaptAnthropicDeltaChunk({
        turnRef: "turn/anthropic",
        seq: 1,
        chunk: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "hi" },
        },
      }),
    ).toEqual([{ kind: "text_delta", turnRef: "turn/anthropic", seq: 1, text: "hi" }]);

    expect(
      adaptAnthropicDeltaChunk({
        turnRef: "turn/anthropic",
        seq: 2,
        chunk: {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { output_tokens: 5, raw_body: "not copied" },
        },
      }),
    ).toEqual([
      {
        kind: "metadata",
        turnRef: "turn/anthropic",
        seq: 2,
        data: { provider: "anthropic", usage: { output_tokens: 5 } },
      },
      {
        kind: "metadata",
        turnRef: "turn/anthropic",
        seq: 3,
        data: { provider: "anthropic", finishReason: "end_turn" },
      },
    ]);

    expect(
      adaptAnthropicDeltaChunk({
        turnRef: "turn/anthropic",
        seq: 4,
        chunk: { type: "message_stop" },
      }),
    ).toEqual([{ kind: "done", turnRef: "turn/anthropic", seq: 4 }]);
  });

  it("maps Gemini deltas into text, curated metadata, and done on finishReason", () => {
    expect(
      adaptGeminiDeltaChunk({
        turnRef: "turn/gemini",
        seq: 10,
        chunk: {
          candidates: [
            {
              content: { parts: [{ text: "" }, { text: "ok" }] },
              finishReason: "STOP",
            },
          ],
          usageMetadata: {
            promptTokenCount: 1,
            candidatesTokenCount: 2,
            totalTokenCount: 3,
            raw_body: "not copied",
          },
        },
      }),
    ).toEqual([
      { kind: "text_delta", turnRef: "turn/gemini", seq: 10, text: "ok" },
      {
        kind: "metadata",
        turnRef: "turn/gemini",
        seq: 11,
        data: { provider: "gemini", finishReason: "STOP" },
      },
      {
        kind: "metadata",
        turnRef: "turn/gemini",
        seq: 12,
        data: {
          provider: "gemini",
          usage: { promptTokenCount: 1, candidatesTokenCount: 2, totalTokenCount: 3 },
        },
      },
      { kind: "done", turnRef: "turn/gemini", seq: 13 },
    ]);
  });

  it("turns unknown or unsupported content-bearing provider chunks into safe errors", () => {
    const frames = [
      ...adaptOpenAiCompatibleDeltaChunk({
        turnRef: "turn/openai",
        seq: 0,
        chunk: { choices: [{ delta: { tool_calls: [{ secret: "not copied" }] } }] },
      }),
      ...adaptAnthropicDeltaChunk({
        turnRef: "turn/anthropic",
        seq: 1,
        chunk: {
          type: "content_block_delta",
          delta: { type: "input_json_delta", partial_json: '{"secret":true}' },
        },
      }),
      ...adaptGeminiDeltaChunk({
        turnRef: "turn/gemini",
        seq: 2,
        chunk: { candidates: [{ content: { parts: [{ inlineData: { data: "secret" } }] } }] },
      }),
      ...adaptGeminiDeltaChunk({
        turnRef: "turn/gemini",
        seq: 3,
        chunk: { object: "unknown", body: "secret" },
      }),
    ];

    expect(frames).toEqual([
      {
        kind: "error",
        turnRef: "turn/openai",
        seq: 0,
        reason: "openai_compatible_unsupported_chunk",
      },
      {
        kind: "error",
        turnRef: "turn/anthropic",
        seq: 1,
        reason: "anthropic_unsupported_chunk",
      },
      { kind: "error", turnRef: "turn/gemini", seq: 2, reason: "gemini_unsupported_chunk" },
      { kind: "error", turnRef: "turn/gemini", seq: 3, reason: "gemini_unknown_chunk" },
    ]);
    expect(JSON.stringify(frames)).not.toContain("secret");
  });

  it("streams OpenAI-compatible SSE through existing turn delta frames", async () => {
    const seen: Array<{ readonly input: string; readonly init: RequestInit }> = [];
    const fetch: LlmTransportFetch = async (input, init) => {
      seen.push({ input, init });
      return sse(
        JSON.stringify({ choices: [{ delta: { role: "assistant" } }] }),
        JSON.stringify({ choices: [{ delta: { content: "hel" } }] }),
        JSON.stringify({ choices: [{ delta: { content: "lo" } }] }),
        JSON.stringify({ choices: [{ finish_reason: "stop" }], usage: { total_tokens: 7 } }),
        "[DONE]",
      );
    };

    const route: LlmRoute = {
      kind: "openai-chat-compatible",
      endpointRef: "openai",
      credentialRef: "openai-key",
      modelId: "gpt-test",
    };
    const frames = await collect(
      streamLlmTurn({
        route,
        resolver: resolver({
          "endpoint:openai": "https://provider.example",
          "credential:openai-key": "sk-secret",
        }),
        messages,
        turnRef: "turn-1",
        fetch,
      }),
    );

    expect(seen[0]?.input).toBe("https://provider.example/chat/completions");
    expect(seen[0]?.init.headers).toMatchObject({
      Authorization: "Bearer sk-secret",
      Accept: "text/event-stream",
      "Content-Type": "application/json",
    });
    const openAiBody = parseJsonBody(seen[0]?.init.body) as { readonly tools?: unknown };
    expect(openAiBody).toMatchObject({
      model: "gpt-test",
      messages,
      stream: true,
      stream_options: { include_usage: true },
    });
    expect(openAiBody.tools).toBeUndefined();
    expect(projectTurnStream(frames, "turn-1")).toMatchObject({
      status: "done",
      text: "hello",
      includedSeqs: [0, 1, 2, 3, 4],
    });
  });

  it("fast-fails missing credential material without calling fetch", async () => {
    let called = false;
    const fetch: LlmTransportFetch = async () => {
      called = true;
      return sse("[DONE]");
    };

    const frames = await collect(
      streamLlmTurn({
        route: {
          kind: "openai-chat-compatible",
          endpointRef: "openai",
          credentialRef: "missing",
          modelId: "gpt-test",
        },
        resolver: resolver({ "endpoint:openai": "https://provider.example" }),
        messages,
        turnRef: "turn-2",
        fetch,
      }),
    );

    expect(called).toBe(false);
    expect(frames).toEqual([
      {
        kind: "error",
        turnRef: "turn-2",
        seq: 0,
        reason: "llm_transport_http_missing_credential_material",
      },
    ]);
  });

  it("does not read or expose provider HTTP error bodies", async () => {
    const fetch: LlmTransportFetch = async () =>
      mockResponse({
        body: "raw body with sk-secret and provider internals",
        status: 401,
        contentType: "text/plain",
      });

    const frames = await collect(
      streamLlmTurn({
        route: {
          kind: "openai-chat-compatible",
          endpointRef: "openai",
          credentialRef: "openai-key",
          modelId: "gpt-test",
        },
        resolver: resolver({
          "endpoint:openai": "https://provider.example",
          "credential:openai-key": "sk-secret",
        }),
        messages,
        turnRef: "turn-3",
        fetch,
      }),
    );

    expect(JSON.stringify(frames)).not.toContain("raw body");
    expect(JSON.stringify(frames)).not.toContain("sk-secret");
    expect(frames).toEqual([
      {
        kind: "error",
        turnRef: "turn-3",
        seq: 0,
        reason: "llm_transport_http_http_error_401",
      },
    ]);
  });

  it("streams Anthropic Messages SSE", async () => {
    const seen: RequestInit[] = [];
    const fetch: LlmTransportFetch = async (_input, init) => {
      seen.push(init);
      return sse(
        JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 3 } } }),
        JSON.stringify({
          type: "content_block_delta",
          delta: { type: "text_delta", text: "hi" },
        }),
        JSON.stringify({
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { output_tokens: 2 },
        }),
        JSON.stringify({ type: "message_stop" }),
      );
    };

    const frames = await collect(
      streamLlmTurn({
        route: {
          kind: "anthropic-messages",
          endpointRef: "anthropic",
          credentialRef: "anthropic-key",
          modelId: "claude-test",
        },
        resolver: resolver({
          "endpoint:anthropic": "https://api.anthropic.example",
          "credential:anthropic-key": "anthropic-secret",
        }),
        messages,
        turnRef: "turn-4",
        fetch,
      }),
    );

    expect(seen[0]?.headers).toMatchObject({
      "x-api-key": "anthropic-secret",
      "anthropic-version": "2023-06-01",
    });
    const anthropicBody = parseJsonBody(seen[0]?.body) as { readonly tools?: unknown };
    expect(anthropicBody).toMatchObject({
      model: "claude-test",
      system: "be direct",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
    });
    expect(anthropicBody.tools).toBeUndefined();
    expect(projectTurnStream(frames, "turn-4")).toMatchObject({
      status: "done",
      text: "hi",
    });
  });

  it("streams Gemini SSE", async () => {
    const seen: Array<{ readonly input: string; readonly init: RequestInit }> = [];
    const fetch: LlmTransportFetch = async (input, init) => {
      seen.push({ input, init });
      return sse(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
          usageMetadata: { totalTokenCount: 5 },
        }),
      );
    };

    const frames = await collect(
      streamLlmTurn({
        route: {
          kind: "gemini-generate-content",
          endpointRef: "gemini",
          credentialRef: "gemini-key",
          modelId: "gemini-test",
        },
        resolver: resolver({
          "endpoint:gemini": "https://generativelanguage.example",
          "credential:gemini-key": "gemini-secret",
        }),
        messages,
        turnRef: "turn-5",
        fetch,
      }),
    );

    expect(seen[0]?.input).toBe(
      "https://generativelanguage.example/v1beta/models/gemini-test:streamGenerateContent?alt=sse",
    );
    const body = parseJsonBody(seen[0]?.init.body) as {
      readonly systemInstruction?: unknown;
      readonly contents?: unknown;
      readonly tools?: unknown;
    };
    expect(body.systemInstruction).toEqual({ parts: [{ text: "be direct" }] });
    expect(body.contents).toEqual([{ role: "user", parts: [{ text: "hello" }] }]);
    expect(body.tools).toBeUndefined();
    expect(projectTurnStream(frames, "turn-5")).toMatchObject({
      status: "done",
      text: "ok",
    });
  });

  it("turns malformed provider chunks into sanitized error frames", async () => {
    const fetch: LlmTransportFetch = async () => sse("{not json and contains sk-secret");

    const frames = await collect(
      streamLlmTurn({
        route: {
          kind: "openai-chat-compatible",
          endpointRef: "openai",
          credentialRef: "openai-key",
          modelId: "gpt-test",
        },
        resolver: resolver({
          "endpoint:openai": "https://provider.example",
          "credential:openai-key": "sk-secret",
        }),
        messages,
        turnRef: "turn-6",
        fetch,
      }),
    );

    expect(JSON.stringify(frames)).not.toContain("not json");
    expect(JSON.stringify(frames)).not.toContain("sk-secret");
    expect(frames).toEqual([
      {
        kind: "error",
        turnRef: "turn-6",
        seq: 0,
        reason: "llm_transport_http_chunk_json_invalid",
      },
    ]);
  });

  it("fast-fails malformed tool-call arguments before provider fetch", async () => {
    const fetch = vi.fn<LlmTransportFetch>();
    const frames = await collect(
      streamLlmTurn({
        route: {
          kind: "anthropic-messages",
          endpointRef: "anthropic",
          credentialRef: "anthropic-key",
          modelId: "claude-test",
        },
        resolver: resolver({
          "endpoint:anthropic": "https://anthropic.example",
          "credential:anthropic-key": "anthropic-secret",
        }),
        messages: [
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call-1",
                type: "function",
                function: { name: "weather", arguments: "{bad json" },
              },
            ],
          },
        ],
        turnRef: "turn-7",
        fetch,
      }),
    );

    expect(fetch).not.toHaveBeenCalled();
    expect(JSON.stringify(frames)).not.toContain("{bad json");
    expect(JSON.stringify(frames)).not.toContain("anthropic-secret");
    expect(frames).toEqual([
      {
        kind: "error",
        turnRef: "turn-7",
        seq: 0,
        reason: "llm_transport_http_tool_arguments_json_invalid",
      },
    ]);
  });
});
