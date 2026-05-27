import { projectTurnStream, type TurnStreamFrame } from "@agent-os/turn-stream";
import { streamLlmTurn, type LlmTransportFetch, type LlmTransportMessage } from "../src";
import type { RefResolver } from "@agent-os/core/ref-resolver";
import type { LlmRoute, ToolDefinition } from "@agent-os/core";

const messages: ReadonlyArray<LlmTransportMessage> = [
  { role: "system", content: "be direct" },
  { role: "user", content: "hello" },
];

const weatherTool: ToolDefinition = {
  type: "function",
  function: {
    name: "weather",
    description: "get weather",
    parameters: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
      additionalProperties: false,
    },
  },
};

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
        tools: [weatherTool],
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
    expect(parseJsonBody(seen[0]?.init.body)).toMatchObject({
      model: "gpt-test",
      messages,
      tools: [weatherTool],
      stream: true,
      stream_options: { include_usage: true },
    });
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

  it("streams Anthropic Messages SSE and shapes tools as input_schema", async () => {
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
        tools: [weatherTool],
        turnRef: "turn-4",
        fetch,
      }),
    );

    expect(seen[0]?.headers).toMatchObject({
      "x-api-key": "anthropic-secret",
      "anthropic-version": "2023-06-01",
    });
    expect(parseJsonBody(seen[0]?.body)).toMatchObject({
      model: "claude-test",
      system: "be direct",
      messages: [{ role: "user", content: "hello" }],
      tools: [{ name: "weather", input_schema: weatherTool.function.parameters }],
      stream: true,
    });
    expect(projectTurnStream(frames, "turn-4")).toMatchObject({
      status: "done",
      text: "hi",
    });
  });

  it("streams Gemini SSE and strips schema fields Gemini rejects", async () => {
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
        tools: [weatherTool],
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
      readonly tools: ReadonlyArray<{
        readonly functionDeclarations: ReadonlyArray<{
          readonly parameters: { readonly additionalProperties?: unknown };
        }>;
      }>;
    };
    expect(body.systemInstruction).toEqual({ parts: [{ text: "be direct" }] });
    expect(body.contents).toEqual([{ role: "user", parts: [{ text: "hello" }] }]);
    expect(body.tools[0].functionDeclarations[0].parameters.additionalProperties).toBeUndefined();
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
        reason: "openai_compatible_malformed_chunk",
      },
    ]);
  });
});
