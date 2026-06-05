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
import {
  HttpClient as HttpClientTag,
  type HttpClient as HttpClientService,
} from "@effect/platform/HttpClient";
import type { HttpClientError } from "@effect/platform/HttpClientError";
import type { HttpBodyError } from "@effect/platform/HttpBody";
import {
  bodyJson as httpBodyJson,
  post as httpPost,
  type HttpClientRequest,
} from "@effect/platform/HttpClientRequest";
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
import {
  ProviderHttpFailure,
  ProviderOutputDecodeError,
  UpstreamFailure,
} from "@agent-os/kernel/errors";
import { LlmTransport, type LlmCallOptions } from "@agent-os/runtime";

export type EffectAiSupportedRoute = Extract<
  LlmRoute,
  { readonly kind: "openai-chat-compatible" | "anthropic-messages" | "gemini-generate-content" }
>;

type EffectAiLanguageModelRoute = Exclude<
  EffectAiSupportedRoute,
  { readonly kind: "openai-chat-compatible" }
>;
type OpenAiChatCompatibleRoute = Extract<
  EffectAiSupportedRoute,
  { readonly kind: "openai-chat-compatible" }
>;

export interface EffectAiResolvedRoute<
  Route extends EffectAiSupportedRoute = EffectAiSupportedRoute,
> {
  readonly route: Route;
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
  input: EffectAiResolvedRoute<EffectAiLanguageModelRoute>,
) => Effect.Effect<LanguageModelService, unknown, R>;

export const EFFECT_AI_TRANSPORT_ADAPTER_VERSION = "effect-ai-transport-v1";
const EFFECT_AI_PROVIDER_OUTPUT_ADAPTER_VERSION = "effect-ai-output-v1";
const OPENAI_CHAT_PROVIDER_OUTPUT_ADAPTER_VERSION = "openai-chat-completions-output-v1";

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const stringField = (
  record: Readonly<Record<string, unknown>>,
  field: string,
): string | undefined => {
  const value = record[field];
  return typeof value === "string" ? value : undefined;
};

const numberField = (
  record: Readonly<Record<string, unknown>>,
  field: string,
): number | undefined => {
  const value = record[field];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
};

const arrayField = (
  record: Readonly<Record<string, unknown>>,
  field: string,
): ReadonlyArray<unknown> | undefined => {
  const value = record[field];
  return Array.isArray(value) ? value : undefined;
};

const providerFlagsForStatus = (
  status: number,
): ReadonlyArray<"auth" | "rate_limited" | "schema" | "overloaded" | "unavailable"> => {
  if (status === 401 || status === 403) return ["auth"];
  if (status === 429) return ["rate_limited"];
  if (status === 400 || status === 422) return ["schema"];
  if (status === 503) return ["unavailable"];
  if (status >= 500) return ["overloaded"];
  return [];
};

const providerHttpFailure = (status: number, body: unknown): ProviderHttpFailure => {
  const error = isRecord(body) && isRecord(body.error) ? body.error : undefined;
  return new ProviderHttpFailure({
    provider: "openai",
    status,
    ...(error !== undefined && typeof error.code === "string" ? { code: error.code } : {}),
    ...(error !== undefined && typeof error.type === "string" ? { type: error.type } : {}),
    flags: providerFlagsForStatus(status),
  });
};

const decodeFailure = (field: string): ProviderOutputDecodeError =>
  new ProviderOutputDecodeError({ field, reason: "missing_or_invalid_field" });

const usageDecodeFailure = (field: string): ProviderOutputDecodeError =>
  new ProviderOutputDecodeError({ field, reason: "missing_or_invalid_usage" });

const withoutTrailingSlash = (value: string): string => value.replace(/\/$/, "");

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

const openAiToolFromDefinition = (definition: ToolDefinition) => ({
  type: "function" as const,
  function: {
    name: definition.function.name,
    description: definition.function.description,
    parameters: definition.function.parameters.projections.openai,
  },
});

const openAiChatBodyFromRequest = (request: LlmRequest): Readonly<Record<string, unknown>> => ({
  model: request.route.modelId,
  messages: request.messages,
  ...(request.tools === undefined || request.tools.length === 0
    ? {}
    : { tools: request.tools.map(openAiToolFromDefinition) }),
  ...(request.tool_choice === undefined ? {} : { tool_choice: request.tool_choice }),
  stream: false,
});

const openAiChatRequest = (
  resolved: EffectAiResolvedRoute<OpenAiChatCompatibleRoute>,
  request: LlmRequest,
): Effect.Effect<HttpClientRequest, HttpBodyError> =>
  httpPost(`${withoutTrailingSlash(resolved.endpoint)}/chat/completions`, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${resolved.credential}`,
      "Content-Type": "application/json",
    },
  }).pipe(httpBodyJson(openAiChatBodyFromRequest(request)));

const responseJsonOrEmpty = <E>(response: {
  readonly json: Effect.Effect<unknown, E>;
}): Effect.Effect<unknown> => response.json.pipe(Effect.orElseSucceed(() => ({})));

const normalizeOpenAiChatUsage = (
  body: Readonly<Record<string, unknown>>,
): Effect.Effect<LlmUsage, ProviderOutputDecodeError> =>
  Effect.gen(function* () {
    const usage = body.usage;
    if (!isRecord(usage)) return yield* usageDecodeFailure("usage");
    const promptTokens = numberField(usage, "prompt_tokens") ?? numberField(usage, "promptTokens");
    const completionTokens =
      numberField(usage, "completion_tokens") ?? numberField(usage, "completionTokens");
    const totalTokens = numberField(usage, "total_tokens") ?? numberField(usage, "totalTokens");
    if (promptTokens === undefined) return yield* usageDecodeFailure("usage.prompt_tokens");
    if (completionTokens === undefined) {
      return yield* usageDecodeFailure("usage.completion_tokens");
    }
    if (totalTokens === undefined) return yield* usageDecodeFailure("usage.total_tokens");
    return { promptTokens, completionTokens, totalTokens };
  });

const firstOpenAiChatMessage = (
  body: Readonly<Record<string, unknown>>,
): Effect.Effect<Readonly<Record<string, unknown>>, ProviderOutputDecodeError> =>
  Effect.gen(function* () {
    const choices = arrayField(body, "choices");
    const firstChoice = choices?.[0];
    if (!isRecord(firstChoice)) return yield* decodeFailure("choices[0]");
    const message = firstChoice.message;
    if (!isRecord(message)) return yield* decodeFailure("choices[0].message");
    return message;
  });

const openAiChatReasoningPresent = (message: Readonly<Record<string, unknown>>): boolean =>
  (typeof message.reasoning === "string" && message.reasoning.length > 0) ||
  (Array.isArray(message.reasoning_details) && message.reasoning_details.length > 0);

const normalizeOpenAiToolCall = (
  raw: unknown,
  index: number,
): Effect.Effect<LlmToolCall, ProviderOutputDecodeError> =>
  Effect.gen(function* () {
    if (!isRecord(raw)) return yield* decodeFailure(`choices[0].message.tool_calls[${index}]`);
    const fn = raw.function;
    if (!isRecord(fn)) {
      return yield* decodeFailure(`choices[0].message.tool_calls[${index}].function`);
    }
    const id = stringField(raw, "id");
    const type = stringField(raw, "type");
    const name = stringField(fn, "name");
    const args = stringField(fn, "arguments");
    if (id === undefined) return yield* decodeFailure(`choices[0].message.tool_calls[${index}].id`);
    if (type !== "function") {
      return yield* decodeFailure(`choices[0].message.tool_calls[${index}].type`);
    }
    if (name === undefined) {
      return yield* decodeFailure(`choices[0].message.tool_calls[${index}].function.name`);
    }
    if (args === undefined) {
      return yield* decodeFailure(`choices[0].message.tool_calls[${index}].function.arguments`);
    }
    return {
      id,
      type: "function",
      function: { name, arguments: args },
    };
  });

const normalizeOpenAiChatCompatibleResponse = (
  body: unknown,
): Effect.Effect<LlmResponse, ProviderOutputDecodeError> =>
  Effect.gen(function* () {
    if (!isRecord(body)) return yield* decodeFailure("response");
    const usage = yield* normalizeOpenAiChatUsage(body);
    const message = yield* firstOpenAiChatMessage(body);
    const items: LlmOutputItem[] = [];
    if (openAiChatReasoningPresent(message)) items.push({ type: "reasoning", redacted: true });
    const content = stringField(message, "content");
    if (content !== undefined && content.length > 0) items.push({ type: "message", text: content });
    const refusal = stringField(message, "refusal");
    if (refusal !== undefined && refusal.length > 0) {
      items.push({ type: "refusal", reason: refusal });
    }
    const toolCalls = arrayField(message, "tool_calls") ?? [];
    for (let index = 0; index < toolCalls.length; index += 1) {
      items.push({
        type: "tool_call",
        call: yield* normalizeOpenAiToolCall(toolCalls[index], index),
      });
    }
    return { items, usage };
  });

const callOpenAiChatCompatible = (
  httpClient: HttpClientService,
  resolved: EffectAiResolvedRoute<OpenAiChatCompatibleRoute>,
  request: LlmRequest,
  options: LlmCallOptions = {},
): Effect.Effect<LlmResponse, UpstreamFailure> =>
  Effect.gen(function* () {
    const providerRequest = yield* openAiChatRequest(resolved, request);
    const response = yield* withAbortSignal(httpClient.execute(providerRequest), options.signal);
    const body = yield* responseJsonOrEmpty(response);
    if (response.status < 200 || response.status >= 300) {
      return yield* providerHttpFailure(response.status, body);
    }
    return yield* normalizeOpenAiChatCompatibleResponse(body);
  }).pipe(
    Effect.mapError(
      (
        cause:
          | HttpBodyError
          | HttpClientError
          | EffectAiAborted
          | ProviderHttpFailure
          | ProviderOutputDecodeError,
      ) => new UpstreamFailure({ cause }),
    ),
  );

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
  HttpClientService | Scope.Scope
> = (input) =>
  Effect.gen(function* () {
    switch (input.route.kind) {
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
): Layer.Layer<LlmTransport, never, RefResolverService | HttpClientService | R> =>
  Layer.effect(
    LlmTransport,
    Effect.gen(function* () {
      const refs = yield* RefResolverService;
      const httpClient = yield* HttpClientTag;
      const context = yield* Effect.context<R>();
      return {
        describeRoute: (route) => ({
          providerOutputAdapterId:
            route.kind === "openai-chat-compatible"
              ? `${route.kind}@${OPENAI_CHAT_PROVIDER_OUTPUT_ADAPTER_VERSION}`
              : `${route.kind}@${EFFECT_AI_PROVIDER_OUTPUT_ADAPTER_VERSION}`,
          providerOutputAdapterVersion:
            route.kind === "openai-chat-compatible"
              ? OPENAI_CHAT_PROVIDER_OUTPUT_ADAPTER_VERSION
              : EFFECT_AI_PROVIDER_OUTPUT_ADAPTER_VERSION,
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
            if (resolved.route.kind === "openai-chat-compatible") {
              return yield* callOpenAiChatCompatible(
                httpClient,
                {
                  route: resolved.route,
                  endpoint: resolved.endpoint,
                  credential: resolved.credential,
                },
                request,
                options,
              );
            }
            const model = yield* modelFactory({
              route: resolved.route,
              endpoint: resolved.endpoint,
              credential: resolved.credential,
            }).pipe(
              Effect.provide(context),
              Effect.mapError((cause) => new UpstreamFailure({ cause })),
            );
            return yield* callEffectAiLanguageModel(model, request, options);
          }),
      };
    }),
  );
