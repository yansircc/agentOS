import {
  GenerateTextResponse,
  type GenerateTextOptions,
  type Service as LanguageModelService,
} from "effect/unstable/ai/LanguageModel";
import {
  makePart as makeResponsePart,
  type Part as ResponsePart,
  Usage as ResponseUsage,
} from "effect/unstable/ai/Response";
import type { Any as AnyTool } from "effect/unstable/ai/Tool";
import {
  HttpClient as HttpClientTag,
  type HttpClient as HttpClientService,
} from "effect/unstable/http/HttpClient";
import type { HttpClientRequest } from "effect/unstable/http/HttpClientRequest";
import type { HttpClientResponse } from "effect/unstable/http/HttpClientResponse";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Fiber, Layer, Option, Schema, Stream } from "effect";
import { ensureAgentSchema } from "@agent-os/core/agent-schema";
import {
  LlmProviderContinuationFailure,
  llmCallSnapshotFromResponse,
  LlmTransport,
  markerFromProviderContinuation,
  projectAgentSchemaForLlmTool,
  replayLlmResponseFromSnapshot,
  type LlmRequest,
  type LlmProviderContinuationStore,
} from "@agent-os/core/llm-protocol";
import type { ToolDefinition } from "@agent-os/core/tools";
import {
  RefResolutionFailed,
  RefResolverLive,
  type RefResolverService,
} from "@agent-os/core/ref-resolver";
import { fixtureRefResolver } from "../_material-resolver-fixture";
import {
  ProviderHttpFailure,
  ProviderOutputDecodeError,
  UpstreamFailure,
} from "@agent-os/core/errors";
import {
  callEffectAiLanguageModel,
  effectAiPromptFromMessages,
  effectAiToolkitFromToolDefinitions,
  EffectAiMissingUsage,
  EffectAiPromptError,
  EffectAiUnsupportedRoute,
  type EffectAiLanguageModelFactory,
  makeEffectAiLlmTransportLayer,
  normalizeEffectAiResponse,
} from "../../src/llm-effect-ai";
import {
  makeOpenAiCompatibleLlmTransportLayer,
  OpenAiCompatibleLlmTransportLive,
  preflightOpenAiCompatibleProviderMaterial,
} from "../../src/llm-effect-ai/openai-compatible";

const usage = (spec: {
  readonly inputTokens: number | undefined;
  readonly outputTokens: number | undefined;
  readonly totalTokens?: number | undefined;
}): ResponseUsage =>
  new ResponseUsage({
    inputTokens: {
      uncached: undefined,
      total: spec.inputTokens,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: {
      total: spec.outputTokens,
      text: undefined,
      reasoning: undefined,
    },
  });

const finish = (spec: {
  readonly inputTokens: number | undefined;
  readonly outputTokens: number | undefined;
  readonly totalTokens?: number | undefined;
}) =>
  makeResponsePart("finish", {
    reason: "stop",
    usage: usage(spec),
    response: undefined,
  });

const response = (
  parts: ReadonlyArray<ResponsePart<Record<string, AnyTool>>>,
): GenerateTextResponse<Record<string, AnyTool>> => new GenerateTextResponse([...parts]);

const openAiRoute = (): LlmRequest["route"] => ({
  kind: "openai-chat-compatible",
  endpointRef: "openai",
  credentialRef: "openai-key",
  modelId: "gpt-test",
});

const request = (overrides: Partial<LlmRequest> = {}): LlmRequest => ({
  route: openAiRoute(),
  messages: [{ role: "user", content: "hello" }],
  materialResolution: {
    truthIdentity: {
      scopeRef: { kind: "conversation", scopeId: "tenant-a" },
      effectAuthorityRef: { authorityId: "llm-test", authorityClass: "test" },
    },
    expectedVersions: {},
  },
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

const resolverLive = RefResolverLive(
  fixtureRefResolver((ref) =>
    ref.kind === "endpoint" ? "https://provider.example/base" : "sk-secret",
  ),
);

const _doCompatibleOpenAiLayer: Layer.Layer<LlmTransport, never, RefResolverService> =
  OpenAiCompatibleLlmTransportLive;

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
    const failure = Cause.findErrorOption(exit.cause);
    expect(Option.isSome(failure)).toBe(true);
    if (Option.isSome(failure)) return failure.value;
  }
  expect.fail("expected failed exit");
};

describe("@agent-os/runtime/llm-effect-ai", () => {
  it("replay mode live LLM provider adapter not called when call snapshot is present", () => {
    let liveLlmProviderAdapterCalled = false;
    const liveModelFactory: EffectAiLanguageModelFactory<never> = () =>
      Effect.sync(() => {
        liveLlmProviderAdapterCalled = true;
        return fakeModel(() => Effect.die("live LLM provider adapter should not be called"));
      });
    const snapshot = llmCallSnapshotFromResponse({
      wireDescriptor: {
        method: "POST",
        url: "https://llm.example/chat",
        headers: [["Content-Type", "application/json"]],
      },
      request: request(),
      response: {
        items: [{ type: "message", text: "snapshot" }],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      },
    });

    const replayed = replayLlmResponseFromSnapshot(snapshot);

    expect(replayed.items).toEqual([{ type: "message", text: "snapshot" }]);
    expect(liveLlmProviderAdapterCalled).toBe(false);
    expect(liveModelFactory).toBeDefined();
  });

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
              parameters: projectAgentSchemaForLlmTool(lookupTool().function.parameters),
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

  it("preflights OpenAI-compatible provider material without exposing secret values", () => {
    const diagnostics = preflightOpenAiCompatibleProviderMaterial({
      route: openAiRoute(),
      refResolver: fixtureRefResolver((ref) => (ref.kind === "credential" ? "sk-secret" : null)),
      routeBindingRef: "default",
      modelMaterial: { ref: "openai-model", value: "gpt-test" },
    });

    expect(diagnostics).toEqual([]);
    expect(JSON.stringify(diagnostics)).not.toContain("sk-secret");
  });

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

  it.effect("fails before provider execution when a pinned material version is unavailable", () =>
    Effect.gen(function* () {
      let providerCalls = 0;
      const client = fakeHttpClient(() => {
        providerCalls += 1;
        return Effect.succeed(httpResponse(200, {}));
      });
      const exit = yield* Effect.exit(
        Effect.gen(function* () {
          const transport = yield* LlmTransport;
          return yield* transport.call(
            request({
              materialResolution: {
                truthIdentity: request().materialResolution!.truthIdentity,
                expectedVersions: {
                  "endpoint:_:openai": "deleted-v0",
                  "credential:_:openai-key": "deleted-v0",
                },
              },
            }),
          );
        }).pipe(
          Effect.provide(makeEffectAiLlmTransportLayer<never>(() => Effect.die("model unused"))),
          Effect.provide(httpClientLive(client)),
          Effect.provide(resolverLive),
        ),
      );
      const failure = expectFailure(exit);
      expect(failure).toBeInstanceOf(UpstreamFailure);
      expect(failure.cause).toBeInstanceOf(RefResolutionFailed);
      expect(failure.cause).toMatchObject({
        reason: "material_version_mismatch",
        expectedVersion: "deleted-v0",
        actualVersion: "fixture-v1",
      });
      expect(providerCalls).toBe(0);
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
      const descriptor = yield* transport.resolveRoute(request().route);
      expect(descriptor.wireDescriptor).toMatchObject({
        method: "POST",
        url: "${endpoint:openai}/chat/completions",
      });
      expect(JSON.stringify(descriptor.wireDescriptor)).not.toContain("https://provider.example");
      expect(JSON.stringify(descriptor.wireDescriptor)).not.toContain("sk-secret");
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

  it.effect("openai-compatible layer owns provider HTTP and rejects other route kinds", () =>
    Effect.gen(function* () {
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

      const result = yield* Effect.gen(function* () {
        const transport = yield* LlmTransport;
        return yield* transport.call(request());
      }).pipe(
        Effect.provide(makeOpenAiCompatibleLlmTransportLayer()),
        Effect.provide(httpClientLive(client)),
        Effect.provide(resolverLive),
      );

      expect(result.items).toEqual([{ type: "message", text: "ok" }]);
      expect(captured?.url).toBe("https://provider.example/base/chat/completions");

      const exit = yield* Effect.exit(
        Effect.gen(function* () {
          const transport = yield* LlmTransport;
          return yield* transport.resolveRoute({
            kind: "anthropic-messages",
            endpointRef: "openai",
            credentialRef: "openai-key",
            modelId: "claude-test",
          });
        }).pipe(
          Effect.provide(makeOpenAiCompatibleLlmTransportLayer()),
          Effect.provide(httpClientLive(client)),
          Effect.provide(resolverLive),
        ),
      );
      const failure = expectFailure(exit);
      expect(failure).toBeInstanceOf(UpstreamFailure);
      expect(failure.cause).toBeInstanceOf(EffectAiUnsupportedRoute);
    }),
  );

  it.effect("roundtrips bound assistant continuation on the next tool-result call", () => {
    const bodies: unknown[] = [];
    const client = fakeHttpClient((providerRequest) => {
      bodies.push(decodeRequestBody(providerRequest));
      return Effect.succeed(
        bodies.length === 1
          ? httpResponse(200, {
              choices: [
                {
                  message: {
                    content: "",
                    reasoning_content: "reasoning-token",
                    encrypted_content: "encrypted-token",
                    tool_calls: [
                      {
                        id: "call-1",
                        type: "function",
                        function: { name: "lookup", arguments: '{"q":"x"}' },
                      },
                    ],
                  },
                },
              ],
              usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
            })
          : httpResponse(200, {
              choices: [{ message: { content: "done" } }],
              usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
            }),
      );
    });

    return Effect.gen(function* () {
      const transport = yield* LlmTransport;
      const first = yield* transport.call(
        request({
          continuationContext: {
            truthIdentityFingerprint: "tenant-a|llm-test",
            turn: { id: 7, index: 0 },
          },
        }),
      );
      if (first.continuation?.kind !== "available") expect.fail("expected continuation");
      const firstContinuation = first.continuation.value;
      expect(firstContinuation.kind).toBe("live");
      const marker = markerFromProviderContinuation(firstContinuation);
      expect(JSON.stringify(marker)).not.toContain("reasoning-token");
      expect(JSON.stringify(marker)).not.toContain("encrypted-token");

      const second = yield* transport.call(
        request({
          continuationContext: {
            truthIdentityFingerprint: "tenant-a|llm-test",
            turn: { id: 7, index: 1 },
          },
          messages: [
            {
              role: "assistant",
              content: "",
              tool_calls: first.items
                .filter((item) => item.type === "tool_call")
                .map((item) => item.call),
              continuation: firstContinuation,
            },
            {
              role: "tool",
              tool_call_id: "call-1",
              name: "lookup",
              content: '{"ok":true}',
            },
          ],
        }),
      );
      expect(second.items).toEqual([{ type: "message", text: "done" }]);
      expect(bodies[1]).toMatchObject({
        messages: [
          {
            role: "assistant",
            reasoning_content: "reasoning-token",
            encrypted_content: "encrypted-token",
          },
          { role: "tool", tool_call_id: "call-1" },
        ],
      });
    }).pipe(
      Effect.provide(makeOpenAiCompatibleLlmTransportLayer()),
      Effect.provide(httpClientLive(client)),
      Effect.provide(resolverLive),
    );
  });

  it.effect("fails closed on a partial provider continuation shape", () => {
    const client = fakeHttpClient(() =>
      Effect.succeed(
        httpResponse(200, {
          choices: [{ message: { content: "", reasoning_content: "reasoning-only" } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      ),
    );

    return Effect.gen(function* () {
      const transport = yield* LlmTransport;
      const exit = yield* Effect.exit(
        transport.call(
          request({
            continuationContext: {
              truthIdentityFingerprint: "tenant-a|llm-test",
              turn: { id: 9, index: 0 },
            },
          }),
        ),
      );
      const failure = expectFailure(exit);
      expect(failure).toBeInstanceOf(UpstreamFailure);
      expect(failure.cause).toBeInstanceOf(ProviderOutputDecodeError);
    }).pipe(
      Effect.provide(makeOpenAiCompatibleLlmTransportLayer()),
      Effect.provide(httpClientLive(client)),
      Effect.provide(resolverLive),
    );
  });

  it.effect("does not preserve arbitrary provider message fields", () => {
    const client = fakeHttpClient(() =>
      Effect.succeed(
        httpResponse(200, {
          choices: [
            {
              message: {
                content: "done",
                provider_private_state: "must-not-cross-adapter",
              },
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      ),
    );

    return Effect.gen(function* () {
      const transport = yield* LlmTransport;
      const result = yield* transport.call(request());
      expect(result.continuation).toBeUndefined();
      expect(JSON.stringify(result)).not.toContain("must-not-cross-adapter");
    }).pipe(
      Effect.provide(makeOpenAiCompatibleLlmTransportLayer()),
      Effect.provide(httpClientLive(client)),
      Effect.provide(resolverLive),
    );
  });

  it.effect("opens sealed continuation and rejects cross-model reuse before HTTP", () => {
    const sealed = new Map<
      string,
      Parameters<LlmProviderContinuationStore["seal"]>[0]["payload"]
    >();
    const store: LlmProviderContinuationStore = {
      available: true,
      seal: ({ payload }) =>
        Effect.sync(() => {
          sealed.set("continuation-1", payload);
          return "continuation-1";
        }),
      open: ({ ref }) => {
        const payload = sealed.get(ref);
        return payload === undefined
          ? Effect.fail(new LlmProviderContinuationFailure({ reason: "sealed_ref_missing" }))
          : Effect.succeed(payload);
      },
    };
    const bodies: unknown[] = [];
    const client = fakeHttpClient((providerRequest) => {
      bodies.push(decodeRequestBody(providerRequest));
      return Effect.succeed(
        httpResponse(200, {
          choices: [
            {
              message: {
                content: "",
                reasoning_content: "reasoning-token",
                encrypted_content: "encrypted-token",
                tool_calls: [],
              },
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
        }),
      );
    });

    return Effect.gen(function* () {
      const transport = yield* LlmTransport;
      const first = yield* transport.call(
        request({
          continuationContext: {
            truthIdentityFingerprint: "tenant-a|llm-test",
            turn: { id: 8, index: 0 },
          },
        }),
      );
      if (first.continuation?.kind !== "available") expect.fail("expected continuation");
      const firstContinuation = first.continuation.value;
      expect(firstContinuation).toMatchObject({ kind: "sealed", ref: "continuation-1" });
      expect(markerFromProviderContinuation(firstContinuation).sealedRef).toBe("continuation-1");

      yield* transport.call(
        request({
          continuationContext: {
            truthIdentityFingerprint: "tenant-a|llm-test",
            turn: { id: 8, index: 1 },
          },
          messages: [
            {
              role: "assistant",
              content: "",
              continuation: firstContinuation,
            },
          ],
        }),
      );
      expect(bodies[1]).toMatchObject({
        messages: [
          {
            role: "assistant",
            reasoning_content: "reasoning-token",
            encrypted_content: "encrypted-token",
          },
        ],
      });

      const exit = yield* Effect.exit(
        transport.call(
          request({
            route: { ...openAiRoute(), modelId: "other-model" },
            continuationContext: {
              truthIdentityFingerprint: "tenant-a|llm-test",
              turn: { id: 8, index: 1 },
            },
            messages: [
              {
                role: "assistant",
                content: "",
                continuation: firstContinuation,
              },
            ],
          }),
        ),
      );
      expect(expectFailure(exit)).toBeInstanceOf(UpstreamFailure);
      expect(bodies).toHaveLength(2);
    }).pipe(
      Effect.provide(makeOpenAiCompatibleLlmTransportLayer(store)),
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

  it.effect("fails tool-result prompt conversion when the tool result name is missing", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        effectAiPromptFromMessages([
          { role: "tool", tool_call_id: "call-1", content: '{"ok":true}' },
        ]),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(exit.cause).toBeDefined();
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
          },
          {
            type: "tool_call",
            call: {
              id: "call-1",
              type: "function",
              function: { name: "lookup", arguments: '{"q":"x"}' },
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
        expect(exit.cause).toBeDefined();
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
        const model = fakeModel((options: GenerateTextOptions<Record<string, AnyTool>>) => {
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

  it.effect("passes required tool choice to the model", () =>
    Effect.gen(function* () {
      const model = fakeModel((options: GenerateTextOptions<Record<string, AnyTool>>) => {
        expect(options.disableToolCallResolution).toBe(true);
        expect(options.toolChoice).toBe("required");
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
          tool_choice: "required",
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
      const fiber = yield* Effect.forkChild(
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
