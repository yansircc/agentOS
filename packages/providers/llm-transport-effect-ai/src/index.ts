import {
  type GenerateTextResponse,
  type Service as LanguageModelService,
  type ToolChoice,
} from "effect/unstable/ai/LanguageModel";
import type {
  AssistantMessagePartEncoded,
  MessageEncoded,
  ProviderOptions,
  RawInput,
} from "effect/unstable/ai/Prompt";
import type {
  AnyPart as ResponseAnyPart,
  ProviderMetadata as ResponseProviderMetadata,
  ToolCallPart as ResponseToolCallPart,
  ToolResultPart as ResponseToolResultPart,
  Usage as ResponseUsage,
} from "effect/unstable/ai/Response";
import { dynamic as makeDynamicTool, type Any as AnyTool } from "effect/unstable/ai/Tool";
import type { WithHandler as ToolkitWithHandler } from "effect/unstable/ai/Toolkit";
import { AnthropicClient, make as makeAnthropicClient } from "@effect/ai-anthropic/AnthropicClient";
import { make as makeAnthropicLanguageModel } from "@effect/ai-anthropic/AnthropicLanguageModel";
import { FetchHttpClient } from "effect/unstable/http";
import {
  HttpClient as HttpClientTag,
  type HttpClient as HttpClientService,
} from "effect/unstable/http/HttpClient";
import type { HttpClientError } from "effect/unstable/http/HttpClientError";
import type { HttpBodyError } from "effect/unstable/http/HttpBody";
import {
  bodyJson as httpBodyJson,
  post as httpPost,
  type HttpClientRequest,
} from "effect/unstable/http/HttpClientRequest";
import { Data, Effect, Layer, Schema } from "effect";
import * as Redacted from "effect/Redacted";
import type * as Scope from "effect/Scope";
import { LlmTransport, projectAgentSchemaForLlmTool } from "@agent-os/llm-protocol";
import type {
  LlmMessage,
  LlmOutputItem,
  LlmRequest,
  LlmResponse,
  LlmRoute,
  LlmCallOptions,
  LlmTransportRouteDescriptor,
  LlmToolCall,
  LlmUsage,
  LlmWireDescriptor,
} from "@agent-os/llm-protocol";
import {
  credentialMaterialRef,
  endpointMaterialRef,
  materialRefKey,
} from "@agent-os/kernel/material-ref";
import {
  RefResolutionFailed,
  RefResolverService,
  type ResolvedMaterialService,
} from "@agent-os/kernel/ref-resolver";
import { openLive } from "@agent-os/kernel/live-edge";
import {
  ProviderHttpFailure,
  ProviderOutputDecodeError,
  UpstreamFailure,
} from "@agent-os/kernel/errors";
import type { ToolDefinition } from "@agent-os/kernel/tools";

const ANTHROPIC_DEFAULT_VERSION = "2023-06-01";

interface EffectAiRouteBase extends LlmRoute {
  readonly endpointRef: string;
  readonly credentialRef: string;
  readonly modelId: string;
}

interface OpenAiChatCompatibleRoute extends EffectAiRouteBase {
  readonly kind: "openai-chat-compatible";
}

interface AnthropicMessagesRoute extends EffectAiRouteBase {
  readonly kind: "anthropic-messages";
  readonly anthropicVersion?: string;
}

export type EffectAiSupportedRoute = OpenAiChatCompatibleRoute | AnthropicMessagesRoute;

type EffectAiLanguageModelRoute = AnthropicMessagesRoute;

const hasRouteMaterial = (
  route: LlmRoute,
): route is LlmRoute & {
  readonly kind: unknown;
  readonly endpointRef: string;
  readonly credentialRef: string;
  readonly modelId: string;
} =>
  typeof route.kind === "string" &&
  typeof route.endpointRef === "string" &&
  typeof route.credentialRef === "string" &&
  typeof route.modelId === "string";

const isEffectAiSupportedRoute = (route: LlmRoute): route is EffectAiSupportedRoute =>
  hasRouteMaterial(route) &&
  (route.kind === "openai-chat-compatible" || route.kind === "anthropic-messages");

export interface EffectAiResolvedRoute<
  Route extends EffectAiSupportedRoute = EffectAiSupportedRoute,
> {
  readonly route: Route;
}

interface EffectAiLiveRoute<
  Route extends EffectAiSupportedRoute = EffectAiSupportedRoute,
> extends EffectAiResolvedRoute<Route> {
  readonly endpoint: string;
  readonly credential: string;
}

export class EffectAiUnsupportedRoute extends Data.TaggedError(
  "agent_os.effect_ai_unsupported_route",
)<{
  readonly kind: unknown;
}> {}

export class EffectAiPromptError extends Data.TaggedError("agent_os.effect_ai_prompt_error")<{
  readonly reason: "tool_call_arguments_json_invalid" | "tool_result_name_missing";
  readonly toolCallId?: string;
}> {}

export class EffectAiMissingUsage extends Data.TaggedError("agent_os.effect_ai_missing_usage")<{
  readonly field: "inputTokens.total" | "outputTokens.total";
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
  input: EffectAiLiveRoute<EffectAiLanguageModelRoute>,
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

const credentialPlaceholder = (credentialRef: string): string =>
  "${credential:" + credentialRef + "}";

const endpointPlaceholder = (endpointRef: string): string => "${endpoint:" + endpointRef + "}";

const chatBodySchema = (modelId: string): LlmWireDescriptor["bodySchema"] => ({
  type: "object",
  properties: {
    model: { type: "string", enum: [modelId] },
    messages: {
      type: "array",
      items: { type: "object", properties: {}, additionalProperties: true },
    },
    tools: {
      type: "array",
      items: { type: "object", properties: {}, additionalProperties: true },
    },
  },
  required: ["model", "messages"],
  additionalProperties: true,
});

const effectAiWireDescriptor = (resolved: EffectAiResolvedRoute): LlmWireDescriptor => {
  switch (resolved.route.kind) {
    case "openai-chat-compatible":
      return {
        method: "POST",
        url: endpointPlaceholder(resolved.route.endpointRef) + "/chat/completions",
        headers: [
          ["accept", "application/json"],
          ["authorization", "Bearer " + credentialPlaceholder(resolved.route.credentialRef)],
          ["content-type", "application/json"],
        ],
        bodySchema: chatBodySchema(resolved.route.modelId),
      };
    case "anthropic-messages":
      return {
        method: "POST",
        url: endpointPlaceholder(resolved.route.endpointRef) + "/v1/messages",
        headers: [
          ["anthropic-version", resolved.route.anthropicVersion ?? ANTHROPIC_DEFAULT_VERSION],
          ["content-type", "application/json"],
          ["x-api-key", credentialPlaceholder(resolved.route.credentialRef)],
        ],
        bodySchema: chatBodySchema(resolved.route.modelId),
      };
  }
};

const effectAiRouteDescriptor = (resolved: EffectAiResolvedRoute): LlmTransportRouteDescriptor => ({
  wireDescriptor: effectAiWireDescriptor(resolved),
  providerOutputAdapterId:
    resolved.route.kind === "openai-chat-compatible"
      ? resolved.route.kind + "@" + OPENAI_CHAT_PROVIDER_OUTPUT_ADAPTER_VERSION
      : resolved.route.kind + "@" + EFFECT_AI_PROVIDER_OUTPUT_ADAPTER_VERSION,
  providerOutputAdapterVersion:
    resolved.route.kind === "openai-chat-compatible"
      ? OPENAI_CHAT_PROVIDER_OUTPUT_ADAPTER_VERSION
      : EFFECT_AI_PROVIDER_OUTPUT_ADAPTER_VERSION,
  transportAdapterId: "effect-ai@" + EFFECT_AI_TRANSPORT_ADAPTER_VERSION,
  transportAdapterVersion: EFFECT_AI_TRANSPORT_ADAPTER_VERSION,
});

const resolveEffectAiRouteForTransport = (
  route: LlmRoute,
): Effect.Effect<EffectAiResolvedRoute, UpstreamFailure> =>
  resolveEffectAiRoute(route).pipe(Effect.mapError((cause) => new UpstreamFailure({ cause })));

const resolveOpenAiChatCompatibleRouteForTransport = (
  route: LlmRoute,
): Effect.Effect<EffectAiResolvedRoute<OpenAiChatCompatibleRoute>, UpstreamFailure> =>
  resolveEffectAiRoute(route).pipe(
    Effect.flatMap((resolved) =>
      resolved.route.kind === "openai-chat-compatible"
        ? Effect.succeed({ route: resolved.route })
        : Effect.fail(new EffectAiUnsupportedRoute({ kind: resolved.route.kind })),
    ),
    Effect.mapError((cause) => new UpstreamFailure({ cause })),
  );

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

const allowlistedPromptOptions = (
  _metadata: Readonly<Record<string, unknown>> | undefined,
): ProviderOptions | undefined => undefined;

const allowlistedToolCallMetadata = (
  _metadata: ResponseProviderMetadata,
): Readonly<Record<string, unknown>> | undefined => undefined;

export const effectAiPromptFromMessages = (
  messages: ReadonlyArray<LlmMessage>,
): Effect.Effect<RawInput, EffectAiPromptError> =>
  Effect.withSpan("agentos.llm_transport.effect_ai.prompt_from_messages")(
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
              const options = allowlistedPromptOptions(call.metadata);
              content.push({
                type: "tool-call",
                id: call.id,
                name: call.function.name,
                params: yield* parseJsonOrText(call.function.arguments, call.id),
                providerExecuted: false,
                ...(options === undefined ? {} : { options }),
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
    }),
  );

export const effectAiToolFromDefinition = (definition: ToolDefinition): AnyTool =>
  makeDynamicTool(definition.function.name, {
    description: definition.function.description,
    parameters: projectAgentSchemaForLlmTool(definition.function.parameters),
    success: Schema.Unknown,
  });

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
    const promptTokens = usage.inputTokens.total;
    const completionTokens = usage.outputTokens.total;
    if (promptTokens === undefined) {
      return yield* new EffectAiMissingUsage({ field: "inputTokens.total" });
    }
    if (completionTokens === undefined) {
      return yield* new EffectAiMissingUsage({ field: "outputTokens.total" });
    }
    return {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
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
    const metadata = allowlistedToolCallMetadata(part.metadata);
    return {
      id: part.id,
      type: "function",
      function: {
        name: part.name,
        arguments: yield* stringifyJson(part.params, "tool-call", part.name),
      },
      ...(metadata === undefined ? {} : { metadata }),
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
  Effect.withSpan("agentos.llm_transport.effect_ai.normalize_response")(
    Effect.gen(function* () {
      const usage = yield* normalizeUsage(response.usage);
      const items: LlmOutputItem[] = [];
      for (const part of response.content as ReadonlyArray<ResponseAnyPart>) {
        switch (part.type) {
          case "text":
            if (part.text.length > 0) items.push({ type: "message", text: part.text });
            break;
          case "reasoning":
            {
              const metadata = allowlistedToolCallMetadata(part.metadata);
              items.push({
                type: "reasoning",
                redacted: true,
                ...(metadata === undefined ? {} : { metadata }),
              });
            }
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
    }),
  );

const toolChoiceForRequest = (request: LlmRequest): ToolChoice<string> | undefined =>
  request.tool_choice === undefined
    ? undefined
    : request.tool_choice === "required"
      ? "required"
      : { tool: request.tool_choice.function.name };

const withAbortSignal = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  signal: AbortSignal | undefined,
): Effect.Effect<A, E | EffectAiAborted, R> => {
  if (signal === undefined) return effect;
  const abort = Effect.callback<never, EffectAiAborted>((resume) => {
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
    parameters: projectAgentSchemaForLlmTool(definition.function.parameters),
  },
});

const openAiChatBodyFromRequest = (
  request: LlmRequest,
  route: OpenAiChatCompatibleRoute,
): Readonly<Record<string, unknown>> => ({
  model: route.modelId,
  messages: request.messages,
  ...(request.tools === undefined || request.tools.length === 0
    ? {}
    : { tools: request.tools.map(openAiToolFromDefinition) }),
  ...(request.tool_choice === undefined ? {} : { tool_choice: request.tool_choice }),
  stream: false,
});

const openAiChatRequest = (
  resolved: EffectAiLiveRoute<OpenAiChatCompatibleRoute>,
  request: LlmRequest,
): Effect.Effect<HttpClientRequest, HttpBodyError> =>
  httpPost(`${withoutTrailingSlash(resolved.endpoint)}/chat/completions`, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${resolved.credential}`,
      "Content-Type": "application/json",
    },
  }).pipe(httpBodyJson(openAiChatBodyFromRequest(request, resolved.route)));

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
  resolved: EffectAiLiveRoute<OpenAiChatCompatibleRoute>,
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
  Effect.withSpan("agentos.llm_transport.effect_ai.call_model")(
    Effect.gen(function* () {
      const prompt = yield* effectAiPromptFromMessages(request.messages);
      const toolkit =
        request.tools === undefined || request.tools.length === 0
          ? undefined
          : effectAiToolkitFromToolDefinitions(request.tools);
      const response =
        toolkit === undefined
          ? yield* withAbortSignal(
              model.generateText({
                prompt,
                disableToolCallResolution: true,
              }),
              options.signal,
            )
          : yield* withAbortSignal(
              model.generateText({
                prompt,
                toolkit,
                disableToolCallResolution: true,
                toolChoice: toolChoiceForRequest(request),
              }),
              options.signal,
            );
      return yield* normalizeEffectAiResponse(response);
    }).pipe(Effect.mapError((cause) => new UpstreamFailure({ cause }))),
  );

export const resolveEffectAiRoute = (
  route: LlmRoute,
): Effect.Effect<EffectAiResolvedRoute, EffectAiUnsupportedRoute> => {
  if (!isEffectAiSupportedRoute(route)) {
    return Effect.withSpan("agentos.llm_transport.effect_ai.resolve_route")(
      Effect.fail(new EffectAiUnsupportedRoute({ kind: route.kind })),
    );
  }
  return Effect.withSpan("agentos.llm_transport.effect_ai.resolve_route")(
    Effect.succeed({ route }),
  );
};

const withStringMaterial = <A, E, R>(
  refs: ResolvedMaterialService,
  ref: ReturnType<typeof endpointMaterialRef> | ReturnType<typeof credentialMaterialRef>,
  use: (value: string) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | RefResolutionFailed, R> =>
  Effect.acquireUseRelease(
    refs.material(ref),
    (handle): Effect.Effect<A, E | RefResolutionFailed, R> => {
      const value = openLive(handle.value);
      return typeof value === "string"
        ? use(value)
        : Effect.fail(
            new RefResolutionFailed({
              kind: ref.kind,
              ref: materialRefKey(ref),
              reason: "material_type_mismatch",
            }),
          );
    },
    (handle) => handle.dispose(),
  );

const withEffectAiLiveRoute = <Route extends EffectAiSupportedRoute, A, E, R>(
  refs: ResolvedMaterialService,
  route: Route,
  use: (resolved: EffectAiLiveRoute<Route>) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | RefResolutionFailed, R> =>
  withStringMaterial(refs, endpointMaterialRef(route.endpointRef), (endpoint) =>
    withStringMaterial(refs, credentialMaterialRef(route.credentialRef), (credential) =>
      use({ route, endpoint, credential }),
    ),
  );

export const defaultEffectAiLanguageModelFactory: EffectAiLanguageModelFactory<
  HttpClientService | Scope.Scope
> = (input) =>
  Effect.withSpan("agentos.llm_transport.effect_ai.default_model_factory")(
    Effect.gen(function* () {
      const client = yield* makeAnthropicClient({
        apiUrl: input.endpoint,
        apiKey: Redacted.make(input.credential),
        apiVersion: input.route.anthropicVersion ?? ANTHROPIC_DEFAULT_VERSION,
      });
      return yield* makeAnthropicLanguageModel({ model: input.route.modelId }).pipe(
        Effect.provideService(AnthropicClient, client),
      );
    }),
  );

export const makeEffectAiLlmTransportLayer = <R>(
  modelFactory: EffectAiLanguageModelFactory<R> = defaultEffectAiLanguageModelFactory as never,
): Layer.Layer<LlmTransport, never, RefResolverService | HttpClientService | R> =>
  Layer.effect(
    LlmTransport,
    Effect.withSpan("agentos.llm_transport.effect_ai.layer")(
      Effect.gen(function* () {
        const refs = yield* RefResolverService;
        const httpClient = yield* HttpClientTag;
        const context = yield* Effect.context<R>();
        return {
          resolveRoute: (route) =>
            resolveEffectAiRouteForTransport(route).pipe(Effect.map(effectAiRouteDescriptor)),
          call: (request, options) =>
            Effect.gen(function* () {
              const resolved = yield* resolveEffectAiRouteForTransport(request.route);
              return yield* withEffectAiLiveRoute(refs, resolved.route, (liveRoute) =>
                Effect.gen(function* () {
                  if (liveRoute.route.kind === "openai-chat-compatible") {
                    return yield* callOpenAiChatCompatible(
                      httpClient,
                      {
                        route: liveRoute.route,
                        endpoint: liveRoute.endpoint,
                        credential: liveRoute.credential,
                      },
                      request,
                      options,
                    );
                  }
                  const model = yield* modelFactory({
                    route: liveRoute.route,
                    endpoint: liveRoute.endpoint,
                    credential: liveRoute.credential,
                  }).pipe(
                    Effect.provide(context),
                    Effect.mapError((cause) => new UpstreamFailure({ cause })),
                  );
                  return yield* callEffectAiLanguageModel(model, request, options);
                }),
              ).pipe(
                Effect.mapError((cause) =>
                  cause instanceof UpstreamFailure ? cause : new UpstreamFailure({ cause }),
                ),
              );
            }),
        };
      }),
    ),
  );

/**
 * OpenAI-compatible chat-completions provider for the provider-neutral
 * {@link LlmTransport} port. Consumers provide material refs through
 * `RefResolverService`; provider HTTP execution is owned by this package.
 *
 * @public
 */
export const makeOpenAiCompatibleLlmTransportLayer = (): Layer.Layer<
  LlmTransport,
  never,
  RefResolverService | HttpClientService
> =>
  Layer.effect(
    LlmTransport,
    Effect.withSpan("agentos.llm_transport.openai_compatible.layer")(
      Effect.gen(function* () {
        const refs = yield* RefResolverService;
        const httpClient = yield* HttpClientTag;
        return {
          resolveRoute: (route) =>
            resolveOpenAiChatCompatibleRouteForTransport(route).pipe(
              Effect.map(effectAiRouteDescriptor),
            ),
          call: (request, options) =>
            Effect.gen(function* () {
              const resolved = yield* resolveOpenAiChatCompatibleRouteForTransport(request.route);
              return yield* withEffectAiLiveRoute(refs, resolved.route, (liveRoute) =>
                callOpenAiChatCompatible(httpClient, liveRoute, request, options),
              ).pipe(
                Effect.mapError((cause) =>
                  cause instanceof UpstreamFailure ? cause : new UpstreamFailure({ cause }),
                ),
              );
            }),
        };
      }),
    ),
  );

/**
 * Fetch-runtime OpenAI-compatible chat-completions live layer. This is the
 * Cloudflare Worker / browser-fetch surface a Durable Object consumer can pass
 * directly as `llmTransport`.
 *
 * @public
 */
export const OpenAiCompatibleLlmTransportLive: Layer.Layer<
  LlmTransport,
  never,
  RefResolverService
> = makeOpenAiCompatibleLlmTransportLayer().pipe(Layer.provide(FetchHttpClient.layer));
