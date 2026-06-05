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
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Fiber, Option, Schema, Stream } from "effect";
import { ensureAgentSchema } from "@agent-os/kernel/agent-schema";
import type { LlmRequest, ToolDefinition } from "@agent-os/kernel/llm";
import { RefResolverLive } from "@agent-os/kernel/ref-resolver";
import { UpstreamFailure } from "@agent-os/kernel/errors";
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

const request = (overrides: Partial<LlmRequest> = {}): LlmRequest => ({
  route: {
    kind: "openai-chat-compatible",
    endpointRef: "openai",
    credentialRef: "openai-key",
    modelId: "gpt-test",
  },
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
        expect(resolved.endpoint).toBe("https://provider.example");
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
        const result = yield* transport.call(request());

        expect(calls).toBe(1);
        expect(JSON.stringify(result)).not.toContain("sk-secret");
      }).pipe(
        Effect.provide(makeEffectAiLlmTransportLayer(modelFactory)),
        Effect.provide(
          RefResolverLive({
            material: (ref) => (ref.kind === "endpoint" ? "https://provider.example" : "sk-secret"),
          }),
        ),
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
