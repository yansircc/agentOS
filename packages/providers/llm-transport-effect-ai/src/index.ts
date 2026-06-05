import {
  type GenerateTextResponse,
  type Service as LanguageModelService,
  type ToolChoice,
} from "@effect/ai/LanguageModel";
import type {
  AssistantMessagePartEncoded,
  MessageEncoded,
  ProviderOptions,
  RawInput,
} from "@effect/ai/Prompt";
import type {
  AnyPart as ResponseAnyPart,
  ProviderMetadata as ResponseProviderMetadata,
  ToolCallPart as ResponseToolCallPart,
  ToolResultPart as ResponseToolResultPart,
  Usage as ResponseUsage,
} from "@effect/ai/Response";
import { make as makeTool, type Any as AnyTool } from "@effect/ai/Tool";
import type { WithHandler as ToolkitWithHandler } from "@effect/ai/Toolkit";
import { AnthropicClient, make as makeAnthropicClient } from "@effect/ai-anthropic/AnthropicClient";
import { make as makeAnthropicLanguageModel } from "@effect/ai-anthropic/AnthropicLanguageModel";
import { GoogleClient, make as makeGoogleClient } from "@effect/ai-google/GoogleClient";
import { make as makeGoogleLanguageModel } from "@effect/ai-google/GoogleLanguageModel";
import { OpenAiClient, make as makeOpenAiClient } from "@effect/ai-openai/OpenAiClient";
import { make as makeOpenAiLanguageModel } from "@effect/ai-openai/OpenAiLanguageModel";
import type * as HttpClient from "@effect/platform/HttpClient";
import { Context, Data, Effect, Layer, Schema } from "effect";
import * as Redacted from "effect/Redacted";
import type * as Scope from "effect/Scope";
import type {
  LlmMessage,
  LlmOutputItem,
  LlmRequest,
  LlmResponse,
  LlmRoute,
  LlmToolCall,
  LlmUsage,
  ToolDefinition,
} from "@agent-os/kernel/llm";
import { DEFAULTS } from "@agent-os/kernel/llm";
import { credentialMaterialRef, endpointMaterialRef } from "@agent-os/kernel/material-ref";
import {
  RefResolutionFailed,
  RefResolverService,
  resolveStringMaterial,
} from "@agent-os/kernel/ref-resolver";
import { UpstreamFailure } from "@agent-os/kernel/errors";
import { LlmTransport, type LlmCallOptions } from "@agent-os/runtime";

export type EffectAiSupportedRoute = Extract<
  LlmRoute,
  { readonly kind: "openai-chat-compatible" | "anthropic-messages" | "gemini-generate-content" }
>;

export interface EffectAiResolvedRoute {
  readonly route: EffectAiSupportedRoute;
  readonly endpoint: string;
  readonly credential: string;
}

export class EffectAiUnsupportedRoute extends Data.TaggedError(
  "agent_os.effect_ai_unsupported_route",
)<{
  readonly kind: LlmRoute["kind"];
}> {}

export class EffectAiPromptError extends Data.TaggedError("agent_os.effect_ai_prompt_error")<{
  readonly reason: "tool_call_arguments_json_invalid" | "tool_result_name_missing";
  readonly toolCallId?: string;
}> {}

export class EffectAiMissingUsage extends Data.TaggedError("agent_os.effect_ai_missing_usage")<{
  readonly field: "inputTokens" | "outputTokens" | "totalTokens";
}> {}

export class EffectAiProviderExecutedToolRejected extends Data.TaggedError(
  "agent_os.effect_ai_provider_executed_tool_rejected",
)<{
  readonly part: "tool-call" | "tool-result";
  readonly name: string;
}> {}

export class EffectAiUnsupportedOutputPart extends Data.TaggedError(
  "agent_os.effect_ai_unsupported_output_part",
)<{
  readonly part: string;
}> {}

export class EffectAiJsonEncodeFailed extends Data.TaggedError(
  "agent_os.effect_ai_json_encode_failed",
)<{
  readonly part: "tool-call" | "tool-result";
  readonly name: string;
  readonly cause: unknown;
}> {}

export class EffectAiToolHandlerCalled extends Data.TaggedError(
  "agent_os.effect_ai_tool_handler_called",
)<{
  readonly name: string;
}> {}

export class EffectAiAborted extends Data.TaggedError("agent_os.effect_ai_aborted")<{}> {}

export type EffectAiAdapterError =
  | EffectAiUnsupportedRoute
  | EffectAiPromptError
  | EffectAiMissingUsage
  | EffectAiProviderExecutedToolRejected
  | EffectAiUnsupportedOutputPart
  | EffectAiJsonEncodeFailed
  | EffectAiToolHandlerCalled
  | EffectAiAborted;

export type EffectAiLanguageModelFactory<R = never> = (
  input: EffectAiResolvedRoute,
) => Effect.Effect<LanguageModelService, unknown, R>;

export const EFFECT_AI_TRANSPORT_ADAPTER_VERSION = "effect-ai-transport-v1";
const EFFECT_AI_PROVIDER_OUTPUT_ADAPTER_VERSION = "effect-ai-output-v1";

const parseJsonOrText = (
  value: string | null,
  toolCallId?: string,
): Effect.Effect<unknown, EffectAiPromptError> => {
  if (value === null || value.trim() === "") return Effect.succeed({});
  return Effect.try({
    try: () => JSON.parse(value) as unknown,
    catch: () =>
      new EffectAiPromptError({
        reason: "tool_call_arguments_json_invalid",
        toolCallId,
      }),
  });
};

const stringifyJson = (
  value: unknown,
  part: "tool-call" | "tool-result",
  name: string,
): Effect.Effect<string, EffectAiJsonEncodeFailed> =>
  Effect.try({
    try: () => JSON.stringify(value),
    catch: (cause) => new EffectAiJsonEncodeFailed({ part, name, cause }),
  });

const googleThoughtSignature = (
  metadata: Readonly<Record<string, unknown>> | undefined,
): string | undefined => {
  const google = metadata?.google;
  if (typeof google !== "object" || google === null) return undefined;
  const thoughtSignature = (google as { readonly thoughtSignature?: unknown }).thoughtSignature;
  return typeof thoughtSignature === "string" && thoughtSignature.length > 0
    ? thoughtSignature
    : undefined;
};

const allowlistedPromptOptions = (
  metadata: Readonly<Record<string, unknown>> | undefined,
): ProviderOptions | undefined => {
  const thoughtSignature = googleThoughtSignature(metadata);
  return thoughtSignature === undefined ? undefined : { google: { thoughtSignature } };
};

const allowlistedToolCallMetadata = (
  metadata: ResponseProviderMetadata,
): Readonly<Record<string, unknown>> | undefined => {
  const thoughtSignature = googleThoughtSignature(metadata);
  return thoughtSignature === undefined ? undefined : { google: { thoughtSignature } };
};

export const effectAiPromptFromMessages = (
  messages: ReadonlyArray<LlmMessage>,
): Effect.Effect<RawInput, EffectAiPromptError> =>
  Effect.forEach(messages, (message): Effect.Effect<MessageEncoded, EffectAiPromptError> => {
    switch (message.role) {
      case "system":
        return Effect.succeed({
          role: "system",
          content: message.content ?? "",
        });
      case "user":
        return Effect.succeed({
          role: "user",
          content: [{ type: "text", text: message.content ?? "" }],
        });
      case "assistant":
        return Effect.gen(function* () {
          const content: AssistantMessagePartEncoded[] = [];
          if (message.content !== null && message.content !== "") {
            content.push({ type: "text", text: message.content });
          }
          for (const call of message.tool_calls ?? []) {
            content.push({
              type: "tool-call",
              id: call.id,
              name: call.function.name,
              params: yield* parseJsonOrText(call.function.arguments, call.id),
              providerExecuted: false,
              options: allowlistedPromptOptions(call.metadata),
            });
          }
          return { role: "assistant", content };
        });
      case "tool":
        return Effect.gen(function* () {
          if (message.name === undefined || message.name.length === 0) {
            return yield* new EffectAiPromptError({
              reason: "tool_result_name_missing",
              toolCallId: message.tool_call_id,
            });
          }
          return {
            role: "tool",
            content: [
              {
                type: "tool-result",
                id: message.tool_call_id ?? "",
                name: message.name,
                isFailure: false,
                result: yield* parseJsonOrText(message.content, message.tool_call_id),
                providerExecuted: false,
              },
            ],
          };
        });
    }
  });

export const effectAiToolFromDefinition = (definition: ToolDefinition): AnyTool =>
  makeTool(definition.function.name, {
    description: definition.function.description,
    success: Schema.Unknown,
  }).setParameters(
    definition.function.parameters.source as unknown as Schema.Struct<Schema.Struct.Fields>,
  );

export const effectAiToolkitFromToolDefinitions = (
  definitions: ReadonlyArray<ToolDefinition>,
): ToolkitWithHandler<Record<string, AnyTool>> => {
  const tools = Object.fromEntries(
    definitions.map((definition) => {
      const tool = effectAiToolFromDefinition(definition);
      return [tool.name, tool];
    }),
  ) as Record<string, AnyTool>;

  return {
    tools,
    handle: (name) => Effect.fail(new EffectAiToolHandlerCalled({ name: String(name) })) as never,
  };
};

const normalizeUsage = (usage: ResponseUsage): Effect.Effect<LlmUsage, EffectAiMissingUsage> =>
  Effect.gen(function* () {
    if (usage.inputTokens === undefined) {
      return yield* new EffectAiMissingUsage({ field: "inputTokens" });
    }
    if (usage.outputTokens === undefined) {
      return yield* new EffectAiMissingUsage({ field: "outputTokens" });
    }
    if (usage.totalTokens === undefined) {
      return yield* new EffectAiMissingUsage({ field: "totalTokens" });
    }
    return {
      promptTokens: usage.inputTokens,
      completionTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
    };
  });

const normalizeToolCall = (
  part: ResponseToolCallPart<string, unknown>,
): Effect.Effect<LlmToolCall, EffectAiProviderExecutedToolRejected | EffectAiJsonEncodeFailed> =>
  Effect.gen(function* () {
    if (part.providerExecuted) {
      return yield* new EffectAiProviderExecutedToolRejected({
        part: "tool-call",
        name: part.name,
      });
    }
    return {
      id: part.id,
      type: "function",
      function: {
        name: part.name,
        arguments: yield* stringifyJson(part.params, "tool-call", part.name),
      },
      metadata: allowlistedToolCallMetadata(part.metadata),
    };
  });

const normalizeToolResult = (
  part: ResponseToolResultPart<string, unknown, unknown>,
): Effect.Effect<
  Extract<LlmOutputItem, { readonly type: "tool_result" }>,
  EffectAiProviderExecutedToolRejected | EffectAiJsonEncodeFailed
> =>
  Effect.gen(function* () {
    if (part.providerExecuted) {
      return yield* new EffectAiProviderExecutedToolRejected({
        part: "tool-result",
        name: part.name,
      });
    }
    return {
      type: "tool_result",
      callId: part.id,
      name: part.name,
      content: yield* stringifyJson(part.encodedResult, "tool-result", part.name),
    };
  });

export const normalizeEffectAiResponse = (
  response: GenerateTextResponse<Record<string, AnyTool>>,
): Effect.Effect<
  LlmResponse,
  | EffectAiMissingUsage
  | EffectAiProviderExecutedToolRejected
  | EffectAiUnsupportedOutputPart
  | EffectAiJsonEncodeFailed
> =>
  Effect.gen(function* () {
    const usage = yield* normalizeUsage(response.usage);
    const items: LlmOutputItem[] = [];
    for (const part of response.content as ReadonlyArray<ResponseAnyPart>) {
      switch (part.type) {
        case "text":
          if (part.text.length > 0) items.push({ type: "message", text: part.text });
          break;
        case "reasoning":
          items.push({
            type: "reasoning",
            redacted: true,
            metadata: allowlistedToolCallMetadata(part.metadata),
          });
          break;
        case "tool-call":
          items.push({ type: "tool_call", call: yield* normalizeToolCall(part) });
          break;
        case "tool-result":
          items.push(yield* normalizeToolResult(part));
          break;
        case "error":
          items.push({ type: "error", message: String(part.error) });
          break;
        case "finish":
        case "response-metadata":
          break;
        default:
          return yield* new EffectAiUnsupportedOutputPart({ part: part.type });
      }
    }
    return { items, usage };
  });

const toolChoiceForRequest = (request: LlmRequest): ToolChoice<string> | undefined =>
  request.tool_choice === undefined ? undefined : { tool: request.tool_choice.function.name };

const withAbortSignal = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  signal: AbortSignal | undefined,
): Effect.Effect<A, E | EffectAiAborted, R> => {
  if (signal === undefined) return effect;
  const abort = Effect.async<never, EffectAiAborted>((resume) => {
    if (signal.aborted) {
      resume(Effect.fail(new EffectAiAborted()));
      return;
    }
    const onAbort = () => resume(Effect.fail(new EffectAiAborted()));
    signal.addEventListener("abort", onAbort, { once: true });
    return Effect.sync(() => signal.removeEventListener("abort", onAbort));
  });
  return Effect.raceFirst(effect, abort);
};

export const callEffectAiLanguageModel = (
  model: LanguageModelService,
  request: LlmRequest,
  options: LlmCallOptions = {},
): Effect.Effect<LlmResponse, UpstreamFailure> =>
  Effect.gen(function* () {
    const prompt = yield* effectAiPromptFromMessages(request.messages);
    const toolkit =
      request.tools === undefined || request.tools.length === 0
        ? undefined
        : effectAiToolkitFromToolDefinitions(request.tools);
    const response = yield* withAbortSignal(
      model.generateText({
        prompt,
        toolkit,
        disableToolCallResolution: true,
        toolChoice: toolChoiceForRequest(request),
      }),
      options.signal,
    );
    return yield* normalizeEffectAiResponse(response);
  }).pipe(Effect.mapError((cause) => new UpstreamFailure({ cause })));

export const resolveEffectAiRoute = (
  refs: Context.Tag.Service<RefResolverService>,
  route: LlmRoute,
): Effect.Effect<EffectAiResolvedRoute, EffectAiUnsupportedRoute | RefResolutionFailed> =>
  Effect.gen(function* () {
    const endpoint = yield* resolveStringMaterial(refs, endpointMaterialRef(route.endpointRef));
    const credential = yield* resolveStringMaterial(
      refs,
      credentialMaterialRef(route.credentialRef),
    );
    return { route, endpoint, credential };
  });

export const defaultEffectAiLanguageModelFactory: EffectAiLanguageModelFactory<
  HttpClient.HttpClient | Scope.Scope
> = (input) =>
  Effect.gen(function* () {
    switch (input.route.kind) {
      case "openai-chat-compatible": {
        const client = yield* makeOpenAiClient({
          apiUrl: input.endpoint,
          apiKey: Redacted.make(input.credential),
        });
        return yield* makeOpenAiLanguageModel({
          model: input.route.modelId,
          config: { strict: false },
        }).pipe(Effect.provideService(OpenAiClient, client));
      }
      case "anthropic-messages": {
        const client = yield* makeAnthropicClient({
          apiUrl: input.endpoint,
          apiKey: Redacted.make(input.credential),
          anthropicVersion: input.route.anthropicVersion ?? DEFAULTS.anthropicVersion,
        });
        return yield* makeAnthropicLanguageModel({ model: input.route.modelId }).pipe(
          Effect.provideService(AnthropicClient, client),
        );
      }
      case "gemini-generate-content": {
        const client = yield* makeGoogleClient({
          apiUrl: input.endpoint,
          apiKey: Redacted.make(input.credential),
        });
        return yield* makeGoogleLanguageModel({ model: input.route.modelId }).pipe(
          Effect.provideService(GoogleClient, client),
        );
      }
    }
  });

export const makeEffectAiLlmTransportLayer = <R>(
  modelFactory: EffectAiLanguageModelFactory<R> = defaultEffectAiLanguageModelFactory as never,
): Layer.Layer<LlmTransport, never, RefResolverService | R> =>
  Layer.effect(
    LlmTransport,
    Effect.gen(function* () {
      const refs = yield* RefResolverService;
      const context = yield* Effect.context<R>();
      return {
        describeRoute: (route) => ({
          providerOutputAdapterId: `${route.kind}@${EFFECT_AI_PROVIDER_OUTPUT_ADAPTER_VERSION}`,
          providerOutputAdapterVersion: EFFECT_AI_PROVIDER_OUTPUT_ADAPTER_VERSION,
          transportAdapterId: `effect-ai@${EFFECT_AI_TRANSPORT_ADAPTER_VERSION}`,
          transportAdapterVersion: EFFECT_AI_TRANSPORT_ADAPTER_VERSION,
        }),
        call: (request, options) =>
          Effect.gen(function* () {
            const resolved = yield* resolveEffectAiRoute(refs, request.route).pipe(
              Effect.mapError((cause) =>
                cause instanceof EffectAiUnsupportedRoute ? new UpstreamFailure({ cause }) : cause,
              ),
            );
            const model = yield* modelFactory(resolved).pipe(
              Effect.provide(context),
              Effect.mapError((cause) => new UpstreamFailure({ cause })),
            );
            return yield* callEffectAiLanguageModel(model, request, options);
          }),
      };
    }),
  );
