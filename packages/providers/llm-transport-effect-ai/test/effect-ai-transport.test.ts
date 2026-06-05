import {
  GenerateTextResponse,
  type Service as LanguageModelService,
} from "@effect/ai/LanguageModel";
import {
  makePart as makeResponsePart,
  type Part as ResponsePart,
  type Usage as ResponseUsage,
} from "@effect/ai/Response";
import type { Any as AnyTool } from "@effect/ai/Tool";
import {
  HttpClient as HttpClientTag,
  type HttpClient as HttpClientService,
} from "@effect/platform/HttpClient";
import type { HttpClientRequest } from "@effect/platform/HttpClientRequest";
import type { HttpClientResponse } from "@effect/platform/HttpClientResponse";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Fiber, Layer, Option, Schema, Stream } from "effect";
import { ensureAgentSchema } from "@agent-os/kernel/agent-schema";
import type { LlmRequest, ToolDefinition } from "@agent-os/kernel/llm";
import { RefResolverLive } from "@agent-os/kernel/ref-resolver";
import { ProviderHttpFailure, UpstreamFailure } from "@agent-os/kernel/errors";
import { LlmTransport } from "@agent-os/runtime";
import {
  callEffectAiLanguageModel,
  effectAiPromptFromMessages,
  effectAiToolkitFromToolDefinitions,
  EffectAiMissingUsage,
  EffectAiPromptError,
  type EffectAiLanguageModelFactory,
  makeEffectAiLlmTransportLayer,
  normalizeEffectAiResponse,
} from "../src";

const finish = (usage: ResponseUsage) =>
  makeResponsePart("finish", {
    reason: "stop",
    usage,
  });

const response = (
  parts: ReadonlyArray<ResponsePart<Record<string, AnyTool>>>,
): GenerateTextResponse<Record<string, AnyTool>> => new GenerateTextResponse([...parts]);

type OpenAiRoute = Extract<LlmRequest["route"], { readonly kind: "openai-chat-compatible" }>;

const openAiRoute = (): OpenAiRoute => ({
  kind: "openai-chat-compatible",
  endpointRef: "openai",
  credentialRef: "openai-key",
  modelId: "gpt-test",
});

const request = (overrides: Partial<LlmRequest> = {}): LlmRequest => ({
  route: openAiRoute(),
  messages: [{ role: "user", content: "hello" }],
  ...overrides,
});

const lookupTool = (): ToolDefinition => ({
  type: "function",
  function: {
    name: "lookup",
    description: "Look up a value.",
    parameters: ensureAgentSchema(Schema.Struct({ q: Schema.String })),
  },
});

const fakeModel = (generateText: LanguageModelService["generateText"]): LanguageModelService => ({
  generateText,
  generateObject: () => Effect.die("generateObject is not used by a87 transport"),
  streamText: () => Stream.die("streamText is not used by a87 transport"),
});

const httpResponse = (status: number, body: unknown): HttpClientResponse =>
  ({
    status,
    json: Effect.succeed(body),
    text: Effect.succeed(JSON.stringify(body)),
  }) as unknown as HttpClientResponse;

const fakeHttpClient = (
  execute: (request: HttpClientRequest) => Effect.Effect<HttpClientResponse>,
): HttpClientService =>
  ({
    execute,
  }) as unknown as HttpClientService;

const httpClientLive = (client: HttpClientService) => Layer.succeed(HttpClientTag, client);

const resolverLive = RefResolverLive({
  material: (ref) => (ref.kind === "endpoint" ? "https://provider.example/base" : "sk-secret"),
});

const decodeRequestBody = (requestValue: HttpClientRequest): unknown => {
  const body = requestValue.body;
  if (body._tag !== "Uint8Array") {
    throw new Error(`expected JSON request body, got ${body._tag}`);
  }
  return JSON.parse(new TextDecoder().decode(body.body)) as unknown;
};

const expectFailure = <E>(exit: Exit.Exit<unknown, E>): E => {
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) {
    const failure = Cause.failureOption(exit.cause);
    expect(Option.isSome(failure)).toBe(true);
    if (Option.isSome(failure)) return failure.value;
  }
  expect.fail("expected failed exit");
};

describe("@agent-os/llm-transport-effect-ai", () => {
  it.effect("sends openai-chat-compatible requests through chat completions wire", () =>
    Effect.gen(function* () {
      let captured: HttpClientRequest | undefined;
      const client = fakeHttpClient((providerRequest) => {
        captured = providerRequest;
        return Effect.succeed(
          httpResponse(200, {
            choices: [
              {
                message: {
                  reasoning: "hidden reasoning",
                  content: "done",
                  tool_calls: [
                    {
                      id: "call-2",
                      type: "function",
                      function: { name: "lookup", arguments: '{"q":"next"}' },
                    },
                  ],
                },
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
          }),
        );
      });

      const result = yield* Effect.gen(function* () {
        const transport = yield* LlmTransport;
        return yield* transport.call(
          request({
            messages: [
              { role: "user", content: "hello" },
              {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "call-1",
                    type: "function",
                    function: { name: "lookup", arguments: '{"q":"x"}' },
                  },
                ],
              },
              { role: "tool", tool_call_id: "call-1", name: "lookup", content: '{"ok":false}' },
            ],
            tools: [lookupTool()],
          }),
        );
      }).pipe(
        Effect.provide(makeEffectAiLlmTransportLayer<never>(() => Effect.die("model unused"))),
        Effect.provide(httpClientLive(client)),
        Effect.provide(resolverLive),
      );

      expect(captured?.url).toBe("https://provider.example/base/chat/completions");
      const body = decodeRequestBody(captured!);
      expect(body).toMatchObject({
        model: "gpt-test",
        stream: false,
        messages: [
          { role: "user", content: "hello" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call-1",
                type: "function",
                function: { name: "lookup", arguments: '{"q":"x"}' },
              },
            ],
          },
          { role: "tool", tool_call_id: "call-1", name: "lookup", content: '{"ok":false}' },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "lookup",
              description: "Look up a value.",
              parameters: lookupTool().function.parameters.projections.openai,
            },
          },
        ],
      });
      expect(JSON.stringify(body)).not.toContain("function_call_output");
      expect(JSON.stringify(body)).not.toContain('"input"');
      expect(result).toEqual({
        items: [
          { type: "reasoning", redacted: true },
          { type: "message", text: "done" },
          {
            type: "tool_call",
            call: {
              id: "call-2",
              type: "function",
              function: { name: "lookup", arguments: '{"q":"next"}' },
            },
          },
        ],
        usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
      });
    }),
  );

  it.effect("maps openai-chat-compatible provider HTTP failures into provider taxonomy", () =>
    Effect.gen(function* () {
      const client = fakeHttpClient(() =>
        Effect.succeed(
          httpResponse(400, { error: { code: "bad_tool_result", type: "invalid_request_error" } }),
        ),
      );
      const exit = yield* Effect.exit(
        Effect.gen(function* () {
          const transport = yield* LlmTransport;
          return yield* transport.call(request());
        }).pipe(
          Effect.provide(makeEffectAiLlmTransportLayer<never>(() => Effect.die("model unused"))),
          Effect.provide(httpClientLive(client)),
          Effect.provide(resolverLive),
        ),
      );
      const failure = expectFailure(exit);
      expect(failure).toBeInstanceOf(UpstreamFailure);
      expect(failure.cause).toBeInstanceOf(ProviderHttpFailure);
      if (failure.cause instanceof ProviderHttpFailure) {
        expect(failure.cause.status).toBe(400);
        expect(failure.cause.code).toBe("bad_tool_result");
        expect(failure.cause.type).toBe("invalid_request_error");
        expect(failure.cause.flags).toEqual(["schema"]);
      }
    }),
  );

  it.effect("decodes openai-chat-compatible camelCase usage for non-OpenAI routers", () =>
    Effect.gen(function* () {
      const client = fakeHttpClient(() =>
        Effect.succeed(
          httpResponse(200, {
            choices: [{ message: { content: "ok" } }],
            usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
          }),
        ),
      );
      const normalized = yield* Effect.gen(function* () {
        const transport = yield* LlmTransport;
        return yield* transport.call(request());
      }).pipe(
        Effect.provide(makeEffectAiLlmTransportLayer<never>(() => Effect.die("model unused"))),
        Effect.provide(httpClientLive(client)),
        Effect.provide(resolverLive),
      );
      expect(normalized).toEqual({
        items: [{ type: "message", text: "ok" }],
        usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
      });
    }),
  );

  it.effect("does not route openai-chat-compatible through the Effect AI model factory", () => {
    let factoryCalls = 0;
    let captured: HttpClientRequest | undefined;
    const client = fakeHttpClient((providerRequest) => {
      captured = providerRequest;
      return Effect.succeed(
        httpResponse(200, {
          choices: [{ message: { content: "ok" } }],
          usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
        }),
      );
    });
    const modelFactory: EffectAiLanguageModelFactory<never> = () => {
      factoryCalls += 1;
      return Effect.die("openai-chat-compatible must not use Effect AI OpenAI Responses");
    };

    return Effect.gen(function* () {
      const transport = yield* LlmTransport;
      const descriptor = transport.describeRoute(request().route);
      expect(descriptor.providerOutputAdapterVersion).toBe("openai-chat-completions-output-v1");
      const result = yield* transport.call(request());

      expect(result.items).toEqual([{ type: "message", text: "ok" }]);
      expect(factoryCalls).toBe(0);
      expect(captured?.url).toBe("https://provider.example/base/chat/completions");
    }).pipe(
      Effect.provide(makeEffectAiLlmTransportLayer(modelFactory)),
      Effect.provide(httpClientLive(client)),
      Effect.provide(resolverLive),
    );
  });

  it.effect("projects agentOS messages to Effect AI prompt without raw provider shapes", () =>
    Effect.gen(function* () {
      const prompt = yield* effectAiPromptFromMessages([
        { role: "system", content: "be direct" },
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: "calling",
          tool_calls: [
            {
              id: "call-1",
              type: "function",
              function: { name: "lookup", arguments: '{"q":"x"}' },
              metadata: { google: { thoughtSignature: "sig-1" }, raw: "drop" },
            },
          ],
        },
        { role: "tool", tool_call_id: "call-1", name: "lookup", content: '{"ok":true}' },
      ]);

      expect(prompt).toEqual([
        { role: "system", content: "be direct" },
        { role: "user", content: [{ type: "text", text: "hi" }] },
        {
          role: "assistant",
          content: [
            { type: "text", text: "calling" },
            {
              type: "tool-call",
              id: "call-1",
              name: "lookup",
              params: { q: "x" },
              providerExecuted: false,
              options: { google: { thoughtSignature: "sig-1" } },
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              id: "call-1",
              name: "lookup",
              isFailure: false,
              result: { ok: true },
              providerExecuted: false,
            },
          ],
        },
      ]);
    }),
  );

  it.effect(
    "fails tool-result prompt conversion when Gemini would receive an empty tool name",
    () =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(
          effectAiPromptFromMessages([
            { role: "tool", tool_call_id: "call-1", content: '{"ok":true}' },
          ]),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(Exit.causeOption(exit).pipe((option) => option._tag)).toBe("Some");
        }
      }),
  );

  it.effect(
    "builds Effect AI tools from AgentSchema source and sentinel handlers fail if called",
    () =>
      Effect.gen(function* () {
        const toolkit = effectAiToolkitFromToolDefinitions([lookupTool()]);
        expect(Object.keys(toolkit.tools)).toEqual(["lookup"]);

        const exit = yield* Effect.exit(
          (toolkit.handle as (name: string, params: unknown) => Effect.Effect<unknown>)("lookup", {
            q: "x",
          }),
        );
        expect(Exit.isFailure(exit)).toBe(true);
      }),
  );

  it.effect("normalizes Effect AI response parts into agentOS LlmOutputItem ADT", () =>
    Effect.gen(function* () {
      const normalized = yield* normalizeEffectAiResponse(
        response([
          makeResponsePart("text", { text: "hello" }),
          makeResponsePart("reasoning", {
            text: "hidden",
            metadata: { google: { thoughtSignature: "reasoning-sig" } },
          }),
          makeResponsePart("tool-call", {
            id: "call-1",
            name: "lookup",
            params: { q: "x" },
            providerExecuted: false,
            metadata: { google: { thoughtSignature: "sig-1" }, openai: { itemId: "drop" } },
          }),
          finish({ inputTokens: 1, outputTokens: 2, totalTokens: 3 }),
        ]),
      );

      expect(normalized).toEqual({
        items: [
          { type: "message", text: "hello" },
          {
            type: "reasoning",
            redacted: true,
            metadata: { google: { thoughtSignature: "reasoning-sig" } },
          },
          {
            type: "tool_call",
            call: {
              id: "call-1",
              type: "function",
              function: { name: "lookup", arguments: '{"q":"x"}' },
              metadata: { google: { thoughtSignature: "sig-1" } },
            },
          },
        ],
        usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
      });
    }),
  );

  it.effect("fails when Effect AI usage omits any required token field", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        normalizeEffectAiResponse(
          response([
            makeResponsePart("text", { text: "x" }),
            finish({ inputTokens: undefined, outputTokens: 2, totalTokens: undefined }),
          ]),
        ),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Exit.causeOption(exit);
        expect(failure._tag).toBe("Some");
      }
    }),
  );

  it.effect(
    "rejects provider-executed tool calls instead of converting them into agentOS facts",
    () =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(
          normalizeEffectAiResponse(
            response([
              makeResponsePart("tool-call", {
                id: "call-1",
                name: "lookup",
                params: { q: "x" },
                providerExecuted: true,
              }),
              finish({ inputTokens: 1, outputTokens: 2, totalTokens: 3 }),
            ]),
          ),
        );
        expect(Exit.isFailure(exit)).toBe(true);
      }),
  );

  it.effect(
    "calls the model with disableToolCallResolution and no caller LanguageModel context",
    () =>
      Effect.gen(function* () {
        const model = fakeModel((options) => {
          expect(options.disableToolCallResolution).toBe(true);
          expect(options.toolChoice).toEqual({ tool: "lookup" });
          expect(options.toolkit).toBeDefined();
          return Effect.succeed(
            response([
              makeResponsePart("tool-call", {
                id: "call-1",
                name: "lookup",
                params: { q: "x" },
                providerExecuted: false,
              }),
              finish({ inputTokens: 1, outputTokens: 2, totalTokens: 3 }),
            ]),
          );
        });

        const result = yield* callEffectAiLanguageModel(
          model,
          request({
            tools: [lookupTool()],
            tool_choice: { type: "function", function: { name: "lookup" } },
          }),
        );

        expect(result.items).toHaveLength(1);
        expect(result.usage.totalTokens).toBe(3);
      }),
  );

  it.effect(
    "resolves provider material inside the transport layer and redacts it from output",
    () => {
      let calls = 0;
      const modelFactory: EffectAiLanguageModelFactory<never> = (resolved) => {
        calls += 1;
        expect(resolved.route.kind).toBe("anthropic-messages");
        expect(resolved.endpoint).toBe("https://provider.example/base");
        expect(resolved.credential).toBe("sk-secret");
        return Effect.succeed(
          fakeModel(() =>
            Effect.succeed(
              response([
                makeResponsePart("text", { text: "ok" }),
                finish({ inputTokens: 1, outputTokens: 2, totalTokens: 3 }),
              ]),
            ),
          ),
        );
      };

      return Effect.gen(function* () {
        const transport = yield* LlmTransport;
        const result = yield* transport.call(
          request({
            route: {
              kind: "anthropic-messages",
              endpointRef: "openai",
              credentialRef: "openai-key",
              modelId: "claude-test",
            },
          }),
        );

        expect(calls).toBe(1);
        expect(JSON.stringify(result)).not.toContain("sk-secret");
      }).pipe(
        Effect.provide(makeEffectAiLlmTransportLayer(modelFactory)),
        Effect.provide(httpClientLive(fakeHttpClient(() => Effect.die("http unused")))),
        Effect.provide(resolverLive),
      );
    },
  );

  it.effect("bridges AbortSignal to Effect interruption for slow provider calls", () =>
    Effect.gen(function* () {
      const controller = new AbortController();
      const model = fakeModel(() => Effect.never);
      const fiber = yield* Effect.fork(
        callEffectAiLanguageModel(model, request(), {
          signal: controller.signal,
        }),
      );
      controller.abort();
      const exit = yield* Fiber.await(fiber);
      expect(expectFailure(exit)).toBeInstanceOf(UpstreamFailure);
    }),
  );

  it.effect("keeps adapter failures typed before transport maps them to UpstreamFailure", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        normalizeEffectAiResponse(
          response([
            makeResponsePart("text", { text: "x" }),
            finish({ inputTokens: undefined, outputTokens: 2, totalTokens: undefined }),
          ]),
        ),
      );
      expect(expectFailure(exit)).toBeInstanceOf(EffectAiMissingUsage);

      const promptExit = yield* Effect.exit(
        effectAiPromptFromMessages([
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "bad",
                type: "function",
                function: { name: "lookup", arguments: "{bad" },
              },
            ],
          },
        ]),
      );
      expect(Exit.isFailure(promptExit)).toBe(true);
      expect(expectFailure(promptExit)).toBeInstanceOf(EffectAiPromptError);
    }),
  );
});
