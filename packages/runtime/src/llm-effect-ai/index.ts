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
  StreamPart as ResponseStreamPart,
  ToolCallPart as ResponseToolCallPart,
  ToolResultPart as ResponseToolResultPart,
  Usage as ResponseUsage,
} from "effect/unstable/ai/Response";
import { dynamic as makeDynamicTool, type Any as AnyTool } from "effect/unstable/ai/Tool";
import type { WithHandler as ToolkitWithHandler } from "effect/unstable/ai/Toolkit";
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
import { Data, Effect, Layer, Schema, Stream } from "effect";
import {
  LlmProviderContinuationFailure,
  LlmProviderContinuationStoreNone,
  LlmTransport,
  llmStreamDeltaFrame,
  llmStreamTerminalFrame,
  llmRouteFingerprint,
  projectAgentSchemaForLlmTool,
  validateProviderContinuationBinding,
} from "@agent-os/core/llm-protocol";
import type {
  LlmMessage,
  LlmOutputItem,
  LlmRequest,
  LlmResponse,
  LlmRoute,
  LlmCallOptions,
  LlmStreamFrame,
  LlmTransportRouteDescriptor,
  LlmToolCall,
  LlmUsage,
  LlmWireDescriptor,
  LlmProviderContinuation,
  LlmProviderContinuationBinding,
  LlmProviderContinuationJson,
  LlmProviderContinuationStore,
} from "@agent-os/core/llm-protocol";
import {
  credentialMaterialRef,
  endpointMaterialRef,
  materialRefKey,
} from "@agent-os/core/material-ref";
import {
  RefResolutionFailed,
  RefResolverService,
  type RefResolver,
  type ResolvedMaterialService,
} from "@agent-os/core/ref-resolver";
import { captureLive, openLive } from "@agent-os/core/live-edge";
import {
  ProviderHttpFailure,
  ProviderOutputDecodeError,
  UpstreamFailure,
} from "@agent-os/core/errors";
import type { ToolDefinition } from "@agent-os/core/tools";
import {
  providerMaterialPreflightDetailJson,
  type ProviderMaterialPreflightDetail,
} from "../runtime-diagnostic-carrier";

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

export interface ProviderMaterialPreflightDiagnostic {
  readonly pass: "provider_material";
  readonly reason: string;
  readonly detail: string;
}

export interface OpenAiCompatibleProviderMaterialPreflightInput {
  readonly route: LlmRoute;
  readonly refResolver?: RefResolver;
  readonly routeBindingRef?: string;
  readonly modelMaterial?: {
    readonly ref: string;
    readonly value: unknown;
  };
  readonly materialStatus?: {
    readonly endpoint: "present" | "missing" | "invalid";
    readonly credential: "present" | "missing" | "invalid";
  };
}

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

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

const isHttpEndpoint = (value: string): boolean =>
  URL.canParse(value) &&
  ((protocol) => protocol === "http:" || protocol === "https:")(new URL(value).protocol);

const routeKind = (route: LlmRoute): string | undefined =>
  typeof route.kind === "string" && route.kind.length > 0 ? route.kind : undefined;

type ProviderMaterialPreflightStatus =
  ProviderMaterialPreflightDetail["materials"][number]["status"];

const materialStatusForValue = (
  value: unknown,
  validate: (value: string) => boolean,
): ProviderMaterialPreflightStatus => {
  if (value === null || value === undefined) return "missing";
  if (!isNonEmptyString(value)) return "invalid";
  return validate(value) ? "present" : "invalid";
};

const resolverMaterialStatus = (
  refResolver: RefResolver | undefined,
  _ref: ReturnType<typeof endpointMaterialRef> | ReturnType<typeof credentialMaterialRef>,
  _validate: (value: string) => boolean,
): ProviderMaterialPreflightStatus => {
  return refResolver === undefined ? "missing" : "present";
};

export const preflightOpenAiCompatibleProviderMaterial = (
  input: OpenAiCompatibleProviderMaterialPreflightInput,
): ReadonlyArray<ProviderMaterialPreflightDiagnostic> => {
  const route = input.route;
  const routeIsOpenAi = route.kind === "openai-chat-compatible";
  const endpointRef =
    routeIsOpenAi && isNonEmptyString(route.endpointRef) ? route.endpointRef : undefined;
  const credentialRef =
    routeIsOpenAi && isNonEmptyString(route.credentialRef) ? route.credentialRef : undefined;
  const routeModelStatus = routeIsOpenAi && isNonEmptyString(route.modelId) ? "present" : "invalid";
  const modelStatus =
    input.modelMaterial === undefined
      ? routeModelStatus
      : materialStatusForValue(input.modelMaterial.value, isNonEmptyString);
  const materials: ProviderMaterialPreflightDetail["materials"] = [
    {
      kind: "endpoint",
      ref: endpointRef ?? "endpointRef",
      status:
        endpointRef === undefined
          ? "invalid"
          : (input.materialStatus?.endpoint ??
            resolverMaterialStatus(
              input.refResolver,
              endpointMaterialRef(endpointRef),
              isHttpEndpoint,
            )),
    },
    {
      kind: "credential",
      ref: credentialRef ?? "credentialRef",
      status:
        credentialRef === undefined
          ? "invalid"
          : (input.materialStatus?.credential ??
            resolverMaterialStatus(
              input.refResolver,
              credentialMaterialRef(credentialRef),
              isNonEmptyString,
            )),
    },
    {
      kind: "model",
      ref: input.modelMaterial?.ref ?? "modelId",
      status: modelStatus,
    },
  ];
  const detail: ProviderMaterialPreflightDetail = {
    kind: "provider_material_preflight",
    provider: "openai-compatible",
    ...(routeKind(route) === undefined ? {} : { routeKind: routeKind(route) }),
    ...(input.routeBindingRef === undefined ? {} : { routeBindingRef: input.routeBindingRef }),
    routeStatus: routeIsOpenAi && routeModelStatus === "present" ? "present" : "invalid",
    materials,
  };
  if (detail.routeStatus === "present" && materials.every((row) => row.status === "present")) {
    return [];
  }
  return [
    {
      pass: "provider_material",
      reason: "OpenAI-compatible provider material preflight failed",
      detail: providerMaterialPreflightDetailJson(detail),
    },
  ];
};

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
          ["accept", "text/event-stream"],
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

interface EffectAiStreamState {
  readonly sequence: number;
  readonly items: ReadonlyArray<LlmOutputItem>;
  readonly textItems: ReadonlyMap<string, number>;
  readonly reasoningIds: ReadonlySet<string>;
  readonly toolParamIds: ReadonlySet<string>;
  readonly terminal: boolean;
}

const initialEffectAiStreamState = (): EffectAiStreamState => ({
  sequence: 0,
  items: [],
  textItems: new Map(),
  reasoningIds: new Set(),
  toolParamIds: new Set(),
  terminal: false,
});

const effectAiStreamDecodeFailure = (field: string): UpstreamFailure =>
  new UpstreamFailure({
    cause: new ProviderOutputDecodeError({ field, reason: "missing_or_invalid_field" }),
  });

const withEffectAiFrame = (
  state: EffectAiStreamState,
  frame: LlmStreamFrame,
  patch: Partial<Omit<EffectAiStreamState, "sequence">> = {},
): readonly [EffectAiStreamState, ReadonlyArray<LlmStreamFrame>] => [
  { ...state, ...patch, sequence: state.sequence + 1 },
  [frame],
];

const normalizeEffectAiStreamPart = (
  state: EffectAiStreamState,
  part: ResponseStreamPart<Record<string, AnyTool>>,
): Effect.Effect<readonly [EffectAiStreamState, ReadonlyArray<LlmStreamFrame>], UpstreamFailure> =>
  Effect.gen(function* () {
    if (state.terminal) return yield* effectAiStreamDecodeFailure("stream.part_after_finish");
    switch (part.type) {
      case "text-start": {
        if (state.textItems.has(part.id)) {
          return yield* effectAiStreamDecodeFailure(`stream.text.${part.id}.duplicate_start`);
        }
        const items = [...state.items, { type: "message" as const, text: "" }];
        const textItems = new Map(state.textItems).set(part.id, items.length - 1);
        return withEffectAiFrame(
          state,
          llmStreamDeltaFrame(state.sequence, { type: "text_start", id: part.id }),
          { items, textItems },
        );
      }
      case "text-delta": {
        const index = state.textItems.get(part.id);
        const current = index === undefined ? undefined : state.items[index];
        if (index === undefined || current?.type !== "message") {
          return yield* effectAiStreamDecodeFailure(`stream.text.${part.id}.delta_without_start`);
        }
        const items = [...state.items];
        items[index] = { type: "message", text: current.text + part.delta };
        return withEffectAiFrame(
          state,
          llmStreamDeltaFrame(state.sequence, {
            type: "text_delta",
            id: part.id,
            text: part.delta,
          }),
          { items },
        );
      }
      case "text-end": {
        if (!state.textItems.has(part.id)) {
          return yield* effectAiStreamDecodeFailure(`stream.text.${part.id}.end_without_start`);
        }
        const textItems = new Map(state.textItems);
        textItems.delete(part.id);
        return withEffectAiFrame(
          state,
          llmStreamDeltaFrame(state.sequence, { type: "text_end", id: part.id }),
          { textItems },
        );
      }
      case "reasoning-start": {
        if (state.reasoningIds.has(part.id)) {
          return yield* effectAiStreamDecodeFailure(`stream.reasoning.${part.id}.duplicate_start`);
        }
        const item = { type: "reasoning" as const, redacted: true as const };
        return withEffectAiFrame(
          state,
          llmStreamDeltaFrame(state.sequence, { type: "reasoning", item }),
          {
            items: [...state.items, item],
            reasoningIds: new Set(state.reasoningIds).add(part.id),
          },
        );
      }
      case "reasoning-delta":
        return state.reasoningIds.has(part.id)
          ? [state, []]
          : yield* effectAiStreamDecodeFailure(`stream.reasoning.${part.id}.delta_without_start`);
      case "reasoning-end": {
        if (!state.reasoningIds.has(part.id)) {
          return yield* effectAiStreamDecodeFailure(
            `stream.reasoning.${part.id}.end_without_start`,
          );
        }
        const reasoningIds = new Set(state.reasoningIds);
        reasoningIds.delete(part.id);
        return [{ ...state, reasoningIds }, []];
      }
      case "tool-params-start":
        return state.toolParamIds.has(part.id)
          ? yield* effectAiStreamDecodeFailure(`stream.tool.${part.id}.duplicate_start`)
          : [{ ...state, toolParamIds: new Set(state.toolParamIds).add(part.id) }, []];
      case "tool-params-delta":
        return state.toolParamIds.has(part.id)
          ? [state, []]
          : yield* effectAiStreamDecodeFailure(`stream.tool.${part.id}.delta_without_start`);
      case "tool-params-end": {
        if (!state.toolParamIds.has(part.id)) {
          return yield* effectAiStreamDecodeFailure(`stream.tool.${part.id}.end_without_start`);
        }
        const toolParamIds = new Set(state.toolParamIds);
        toolParamIds.delete(part.id);
        return [{ ...state, toolParamIds }, []];
      }
      case "tool-call": {
        const item = {
          type: "tool_call" as const,
          call: yield* normalizeToolCall(part).pipe(
            Effect.mapError((cause) => new UpstreamFailure({ cause })),
          ),
        };
        return withEffectAiFrame(
          state,
          llmStreamDeltaFrame(state.sequence, { type: "tool_call", item }),
          { items: [...state.items, item] },
        );
      }
      case "tool-result": {
        const item = yield* normalizeToolResult(part).pipe(
          Effect.mapError((cause) => new UpstreamFailure({ cause })),
        );
        return withEffectAiFrame(
          state,
          llmStreamDeltaFrame(state.sequence, { type: "tool_result", item }),
          { items: [...state.items, item] },
        );
      }
      case "error": {
        const item = { type: "error" as const, message: String(part.error) };
        return withEffectAiFrame(
          state,
          llmStreamDeltaFrame(state.sequence, { type: "error", item }),
          { items: [...state.items, item] },
        );
      }
      case "finish": {
        if (
          state.textItems.size > 0 ||
          state.reasoningIds.size > 0 ||
          state.toolParamIds.size > 0
        ) {
          return yield* effectAiStreamDecodeFailure("stream.finish_with_open_parts");
        }
        const usage = yield* normalizeUsage(part.usage).pipe(
          Effect.mapError((cause) => new UpstreamFailure({ cause })),
        );
        const response: LlmResponse = {
          items: state.items.filter((item) => item.type !== "message" || item.text.length > 0),
          usage,
        };
        const terminal = yield* llmStreamTerminalFrame(state.sequence, response);
        return withEffectAiFrame(state, terminal, { terminal: true });
      }
      case "response-metadata":
        return [state, []];
      case "tool-approval-request":
      case "file":
      case "source":
        return yield* effectAiStreamDecodeFailure(`stream.unsupported.${part.type}`);
    }
  });

const toolChoiceForRequest = (request: LlmRequest): ToolChoice<string> | undefined =>
  request.tool_choice === undefined
    ? undefined
    : request.tool_choice === "required"
      ? "required"
      : { tool: request.tool_choice.function.name };

const abortSignalEffect = (signal: AbortSignal): Effect.Effect<never, EffectAiAborted> =>
  Effect.callback<never, EffectAiAborted>((resume) => {
    if (signal.aborted) {
      resume(Effect.fail(new EffectAiAborted()));
      return;
    }
    const onAbort = () => resume(Effect.fail(new EffectAiAborted()));
    signal.addEventListener("abort", onAbort, { once: true });
    return Effect.sync(() => signal.removeEventListener("abort", onAbort));
  });

const withAbortSignal = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  signal: AbortSignal | undefined,
): Effect.Effect<A, E | EffectAiAborted, R> =>
  signal === undefined ? effect : Effect.raceFirst(effect, abortSignalEffect(signal));

const withAbortStream = <A, E, R>(
  stream: Stream.Stream<A, E, R>,
  signal: AbortSignal | undefined,
): Stream.Stream<A, E | EffectAiAborted, R> =>
  signal === undefined ? stream : Stream.interruptWhen(stream, abortSignalEffect(signal));

const openAiToolFromDefinition = (definition: ToolDefinition) => ({
  type: "function" as const,
  function: {
    name: definition.function.name,
    description: definition.function.description,
    parameters: projectAgentSchemaForLlmTool(definition.function.parameters),
  },
});

const openAiContinuationAdapterId =
  "openai-chat-compatible@" + OPENAI_CHAT_PROVIDER_OUTPUT_ADAPTER_VERSION;

const openAiContinuationBinding = (
  request: LlmRequest,
  route: OpenAiChatCompatibleRoute,
  position: "response" | "request",
): Effect.Effect<LlmProviderContinuationBinding, LlmProviderContinuationFailure> => {
  const context = request.continuationContext;
  if (context === undefined) {
    return Effect.fail(new LlmProviderContinuationFailure({ reason: "truth_identity_mismatch" }));
  }
  const sourceIndex = position === "response" ? context.turn.index : context.turn.index - 1;
  if (sourceIndex < 0) {
    return Effect.fail(new LlmProviderContinuationFailure({ reason: "source_turn_mismatch" }));
  }
  return Effect.succeed({
    adapterId: openAiContinuationAdapterId,
    adapterVersion: OPENAI_CHAT_PROVIDER_OUTPUT_ADAPTER_VERSION,
    routeFingerprint: llmRouteFingerprint(route),
    modelFingerprint: `model-v1:${route.modelId}`,
    truthIdentityFingerprint: context.truthIdentityFingerprint,
    sourceTurn: { id: context.turn.id, index: sourceIndex },
    successorTurn: {
      id: context.turn.id,
      index: position === "response" ? context.turn.index + 1 : context.turn.index,
    },
  });
};

const openAiContinuationPayload = (
  value: LlmProviderContinuationJson,
): Effect.Effect<
  Readonly<{ reasoning_content: string; encrypted_content: string }>,
  LlmProviderContinuationFailure
> => {
  if (
    !isRecord(value) ||
    typeof value.reasoning_content !== "string" ||
    typeof value.encrypted_content !== "string"
  ) {
    return Effect.fail(new LlmProviderContinuationFailure({ reason: "continuation_malformed" }));
  }
  return Effect.succeed({
    reasoning_content: value.reasoning_content,
    encrypted_content: value.encrypted_content,
  });
};

const openAiContinuationValue = (
  continuation: LlmProviderContinuation,
  expected: LlmProviderContinuationBinding,
  store: LlmProviderContinuationStore,
): Effect.Effect<
  Readonly<{ reasoning_content: string; encrypted_content: string }>,
  LlmProviderContinuationFailure
> =>
  Effect.gen(function* () {
    const mismatch = validateProviderContinuationBinding(continuation.binding, expected);
    if (mismatch !== null) return yield* mismatch;
    const payload =
      continuation.kind === "live"
        ? continuation.payload
        : yield* store.open({ binding: continuation.binding, ref: continuation.ref });
    return yield* openAiContinuationPayload(openLive(payload));
  });

const openAiWireMessage = (
  message: LlmMessage,
  request: LlmRequest,
  route: OpenAiChatCompatibleRoute,
  store: LlmProviderContinuationStore,
): Effect.Effect<Readonly<Record<string, unknown>>, LlmProviderContinuationFailure> =>
  Effect.gen(function* () {
    const { continuation, ...wireMessage } = message;
    if (continuation === undefined) return wireMessage;
    if (message.role !== "assistant") {
      return yield* new LlmProviderContinuationFailure({ reason: "continuation_malformed" });
    }
    const expected = yield* openAiContinuationBinding(request, route, "request");
    const payload = yield* openAiContinuationValue(continuation, expected, store);
    return { ...wireMessage, ...payload };
  });

const openAiChatBodyFromRequest = (
  request: LlmRequest,
  route: OpenAiChatCompatibleRoute,
  store: LlmProviderContinuationStore,
): Effect.Effect<Readonly<Record<string, unknown>>, LlmProviderContinuationFailure> =>
  Effect.gen(function* () {
    const messages = yield* Effect.forEach(request.messages, (message) =>
      openAiWireMessage(message, request, route, store),
    );
    return {
      model: route.modelId,
      messages,
      ...(request.tools === undefined || request.tools.length === 0
        ? {}
        : { tools: request.tools.map(openAiToolFromDefinition) }),
      ...(request.tool_choice === undefined ? {} : { tool_choice: request.tool_choice }),
      stream: true,
      stream_options: { include_usage: true },
    };
  });

const openAiChatRequest = (
  resolved: EffectAiLiveRoute<OpenAiChatCompatibleRoute>,
  request: LlmRequest,
  store: LlmProviderContinuationStore,
): Effect.Effect<HttpClientRequest, HttpBodyError | LlmProviderContinuationFailure> =>
  Effect.gen(function* () {
    const body = yield* openAiChatBodyFromRequest(request, resolved.route, store);
    return yield* httpPost(`${withoutTrailingSlash(resolved.endpoint)}/chat/completions`, {
      headers: {
        Accept: "text/event-stream",
        Authorization: `Bearer ${resolved.credential}`,
        "Content-Type": "application/json",
      },
    }).pipe(httpBodyJson(body));
  });

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

const decodeOpenAiContinuation = (
  message: Readonly<Record<string, unknown>>,
  request: LlmRequest,
  route: OpenAiChatCompatibleRoute,
  store: LlmProviderContinuationStore,
): Effect.Effect<
  LlmProviderContinuation | undefined,
  ProviderOutputDecodeError | LlmProviderContinuationFailure
> =>
  Effect.gen(function* () {
    const reasoning = message.reasoning_content;
    const encrypted = message.encrypted_content;
    if (reasoning === undefined && encrypted === undefined) return undefined;
    if (typeof reasoning !== "string" || typeof encrypted !== "string") {
      return yield* decodeFailure("choices[0].message.provider_continuation");
    }
    const binding = yield* openAiContinuationBinding(request, route, "response");
    const payload = captureLive({
      reasoning_content: reasoning,
      encrypted_content: encrypted,
    });
    if (!store.available) return { kind: "live", binding, payload };
    const ref = yield* store.seal({ binding, payload });
    return { kind: "sealed", binding, ref };
  });

interface OpenAiStreamToolCall {
  readonly id: string;
  readonly name: string;
  readonly argumentsJson: string;
}

interface OpenAiStreamState {
  readonly sequence: number;
  readonly items: ReadonlyArray<LlmOutputItem>;
  readonly textId?: string;
  readonly textItemIndex?: number;
  readonly reasoningSeen: boolean;
  readonly refusalItemIndex?: number;
  readonly toolCalls: ReadonlyMap<number, OpenAiStreamToolCall>;
  readonly usage?: LlmUsage;
  readonly finishSeen: boolean;
  readonly reasoningContent: string;
  readonly encryptedContent: string;
  readonly reasoningContentSeen: boolean;
  readonly encryptedContentSeen: boolean;
  readonly terminal: boolean;
}

const initialOpenAiStreamState = (): OpenAiStreamState => ({
  sequence: 0,
  items: [],
  reasoningSeen: false,
  toolCalls: new Map(),
  finishSeen: false,
  reasoningContent: "",
  encryptedContent: "",
  reasoningContentSeen: false,
  encryptedContentSeen: false,
  terminal: false,
});

const parseOpenAiSseData = (
  data: string,
): Effect.Effect<Readonly<Record<string, unknown>>, ProviderOutputDecodeError> =>
  Effect.try({
    try: () => JSON.parse(data) as unknown,
    catch: () => decodeFailure("stream.sse_json"),
  }).pipe(
    Effect.flatMap((value) =>
      isRecord(value) ? Effect.succeed(value) : Effect.fail(decodeFailure("stream.sse_event")),
    ),
  );

const openAiStreamToolCallChunk = (
  state: OpenAiStreamState,
  raw: unknown,
): Effect.Effect<ReadonlyMap<number, OpenAiStreamToolCall>, ProviderOutputDecodeError> =>
  Effect.gen(function* () {
    if (!isRecord(raw)) return yield* decodeFailure("stream.tool_call");
    const index = numberField(raw, "index");
    if (index === undefined || !Number.isInteger(index) || index < 0) {
      return yield* decodeFailure("stream.tool_call.index");
    }
    const previous = state.toolCalls.get(index);
    const fn = raw.function;
    if (fn !== undefined && !isRecord(fn)) {
      return yield* decodeFailure(`stream.tool_call.${index}.function`);
    }
    const id = stringField(raw, "id") ?? previous?.id;
    const name = (isRecord(fn) ? stringField(fn, "name") : undefined) ?? previous?.name;
    const argumentsDelta = isRecord(fn) ? (stringField(fn, "arguments") ?? "") : "";
    if (id === undefined || name === undefined) {
      return yield* decodeFailure(`stream.tool_call.${index}.identity`);
    }
    return new Map(state.toolCalls).set(index, {
      id,
      name,
      argumentsJson: (previous?.argumentsJson ?? "") + argumentsDelta,
    });
  });

const appendOpenAiText = (
  state: OpenAiStreamState,
  text: string,
): readonly [OpenAiStreamState, ReadonlyArray<LlmStreamFrame>] => {
  const items = [...state.items];
  const frames: LlmStreamFrame[] = [];
  let sequence = state.sequence;
  let textId = state.textId;
  let textItemIndex = state.textItemIndex;
  if (textId === undefined || textItemIndex === undefined) {
    textId = "text-0";
    textItemIndex = items.length;
    items.push({ type: "message", text: "" });
    frames.push(llmStreamDeltaFrame(sequence++, { type: "text_start", id: textId }));
  }
  const current = items[textItemIndex];
  if (current?.type === "message") {
    items[textItemIndex] = { type: "message", text: current.text + text };
  }
  frames.push(llmStreamDeltaFrame(sequence++, { type: "text_delta", id: textId, text }));
  return [{ ...state, sequence, items, textId, textItemIndex }, frames];
};

const normalizeOpenAiStreamEvent = (
  state: OpenAiStreamState,
  body: Readonly<Record<string, unknown>>,
): Effect.Effect<
  readonly [OpenAiStreamState, ReadonlyArray<LlmStreamFrame>],
  ProviderOutputDecodeError
> =>
  Effect.gen(function* () {
    if (state.terminal) return yield* decodeFailure("stream.event_after_terminal");
    let next = state;
    const frames: LlmStreamFrame[] = [];
    const usageRaw = body.usage;
    if (usageRaw !== undefined) {
      next = { ...next, usage: yield* normalizeOpenAiChatUsage(body) };
    }
    const choices = arrayField(body, "choices") ?? [];
    for (let choiceIndex = 0; choiceIndex < choices.length; choiceIndex += 1) {
      const choice = choices[choiceIndex];
      if (!isRecord(choice)) return yield* decodeFailure(`stream.choices[${choiceIndex}]`);
      const delta = choice.delta;
      if (delta !== undefined && !isRecord(delta)) {
        return yield* decodeFailure(`stream.choices[${choiceIndex}].delta`);
      }
      if (isRecord(delta)) {
        const content = stringField(delta, "content");
        const reasoning = stringField(delta, "reasoning_content");
        const encrypted = stringField(delta, "encrypted_content");
        const redactedReasoning = stringField(delta, "reasoning");
        if (reasoning !== undefined || encrypted !== undefined || redactedReasoning !== undefined) {
          if (!next.reasoningSeen) {
            const item = { type: "reasoning" as const, redacted: true as const };
            frames.push(llmStreamDeltaFrame(next.sequence, { type: "reasoning", item }));
            next = {
              ...next,
              sequence: next.sequence + 1,
              reasoningSeen: true,
              items: [...next.items, item],
            };
          }
          next = {
            ...next,
            reasoningContent: next.reasoningContent + (reasoning ?? ""),
            encryptedContent: next.encryptedContent + (encrypted ?? ""),
            reasoningContentSeen: next.reasoningContentSeen || reasoning !== undefined,
            encryptedContentSeen: next.encryptedContentSeen || encrypted !== undefined,
          };
        }
        if (content !== undefined && content.length > 0) {
          const [textState, textFrames] = appendOpenAiText(next, content);
          next = textState;
          frames.push(...textFrames);
        }
        const refusal = stringField(delta, "refusal");
        if (refusal !== undefined && refusal.length > 0) {
          const items = [...next.items];
          const index = next.refusalItemIndex ?? items.length;
          const current = items[index];
          items[index] = {
            type: "refusal",
            reason: current?.type === "refusal" ? current.reason + refusal : refusal,
          };
          next = { ...next, items, refusalItemIndex: index };
        }
        for (const toolCall of arrayField(delta, "tool_calls") ?? []) {
          next = { ...next, toolCalls: yield* openAiStreamToolCallChunk(next, toolCall) };
        }
      }
      if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
        if (typeof choice.finish_reason !== "string") {
          return yield* decodeFailure(`stream.choices[${choiceIndex}].finish_reason`);
        }
        next = { ...next, finishSeen: true };
      }
    }
    return [next, frames];
  });

const finishOpenAiStream = (
  state: OpenAiStreamState,
  request: LlmRequest,
  route: OpenAiChatCompatibleRoute,
  store: LlmProviderContinuationStore,
): Effect.Effect<readonly [OpenAiStreamState, ReadonlyArray<LlmStreamFrame>], UpstreamFailure> =>
  Effect.gen(function* () {
    if (state.terminal || !state.finishSeen || state.usage === undefined) {
      return yield* new UpstreamFailure({
        cause: decodeFailure("stream.done_without_finish_or_usage"),
      });
    }
    let sequence = state.sequence;
    const items = [...state.items];
    const frames: LlmStreamFrame[] = [];
    if (state.textId !== undefined) {
      frames.push(llmStreamDeltaFrame(sequence++, { type: "text_end", id: state.textId }));
    }
    for (const [, tool] of [...state.toolCalls.entries()].sort(([left], [right]) => left - right)) {
      yield* Effect.try({
        try: () => JSON.parse(tool.argumentsJson) as unknown,
        catch: () => decodeFailure(`stream.tool_call.${tool.id}.arguments`),
      }).pipe(
        Effect.filterOrFail(isRecord, () => decodeFailure(`stream.tool_call.${tool.id}.arguments`)),
        Effect.mapError((cause) => new UpstreamFailure({ cause })),
      );
      const item = {
        type: "tool_call" as const,
        call: {
          id: tool.id,
          type: "function" as const,
          function: { name: tool.name, arguments: tool.argumentsJson },
        },
      };
      items.push(item);
      frames.push(llmStreamDeltaFrame(sequence++, { type: "tool_call", item }));
    }
    if (state.refusalItemIndex !== undefined) {
      const item = items[state.refusalItemIndex];
      if (item?.type === "refusal") {
        frames.push(llmStreamDeltaFrame(sequence++, { type: "refusal", item }));
      }
    }
    if (state.reasoningContentSeen !== state.encryptedContentSeen) {
      return yield* new UpstreamFailure({
        cause: decodeFailure("stream.provider_continuation"),
      });
    }
    const continuationMessage = !state.reasoningContentSeen
      ? {}
      : {
          reasoning_content: state.reasoningContent,
          encrypted_content: state.encryptedContent,
        };
    const continuation = yield* decodeOpenAiContinuation(
      continuationMessage,
      request,
      route,
      store,
    ).pipe(Effect.mapError((cause) => new UpstreamFailure({ cause })));
    const response: LlmResponse = {
      items: items.filter((item) => item.type !== "message" || item.text.length > 0),
      usage: state.usage,
      ...(continuation === undefined
        ? {}
        : { continuation: { kind: "available" as const, value: continuation } }),
    };
    frames.push(yield* llmStreamTerminalFrame(sequence++, response));
    return [{ ...state, sequence, items, terminal: true }, frames];
  });

const streamOpenAiChatCompatible = (
  httpClient: HttpClientService,
  resolved: EffectAiLiveRoute<OpenAiChatCompatibleRoute>,
  request: LlmRequest,
  store: LlmProviderContinuationStore,
  options: LlmCallOptions = {},
): Stream.Stream<LlmStreamFrame, UpstreamFailure> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const providerRequest = yield* openAiChatRequest(resolved, request, store);
      const response = yield* withAbortSignal(httpClient.execute(providerRequest), options.signal);
      if (response.status < 200 || response.status >= 300) {
        return yield* providerHttpFailure(response.status, yield* responseJsonOrEmpty(response));
      }
      return withAbortStream(response.stream, options.signal).pipe(
        Stream.decodeText,
        Stream.splitLines,
        Stream.filter((line) => line.startsWith("data:")),
        Stream.map((line) => line.slice("data:".length).trim()),
        Stream.mapAccumEffect(initialOpenAiStreamState, (state, data) =>
          data === "[DONE]"
            ? finishOpenAiStream(state, request, resolved.route, store)
            : parseOpenAiSseData(data).pipe(
                Effect.flatMap((body) => normalizeOpenAiStreamEvent(state, body)),
                Effect.mapError((cause) => new UpstreamFailure({ cause })),
              ),
        ),
        Stream.mapError((cause) =>
          cause instanceof UpstreamFailure ? cause : new UpstreamFailure({ cause }),
        ),
      );
    }).pipe(
      Effect.mapError((cause) =>
        cause instanceof UpstreamFailure ? cause : new UpstreamFailure({ cause }),
      ),
    ),
  );

export const streamEffectAiLanguageModel = (
  model: LanguageModelService,
  request: LlmRequest,
  options: LlmCallOptions = {},
): Stream.Stream<LlmStreamFrame, UpstreamFailure> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const prompt = yield* effectAiPromptFromMessages(request.messages);
      const toolkit =
        request.tools === undefined || request.tools.length === 0
          ? undefined
          : effectAiToolkitFromToolDefinitions(request.tools);
      const parts =
        toolkit === undefined
          ? model.streamText({
              prompt,
              disableToolCallResolution: true,
            })
          : model.streamText({
              prompt,
              toolkit,
              disableToolCallResolution: true,
              toolChoice: toolChoiceForRequest(request),
            });
      return withAbortStream(parts, options.signal).pipe(
        Stream.mapAccumEffect(initialEffectAiStreamState, normalizeEffectAiStreamPart),
        Stream.mapError((cause) =>
          cause instanceof UpstreamFailure ? cause : new UpstreamFailure({ cause }),
        ),
      );
    }).pipe(
      Effect.mapError((cause) =>
        cause instanceof UpstreamFailure ? cause : new UpstreamFailure({ cause }),
      ),
      Effect.withSpan("agentos.llm_transport.effect_ai.stream_model"),
    ),
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
  request: LlmRequest,
  ref: ReturnType<typeof endpointMaterialRef> | ReturnType<typeof credentialMaterialRef>,
  use: (value: string, version: string) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | RefResolutionFailed, R> =>
  request.materialResolution === undefined
    ? Effect.fail(
        new RefResolutionFailed({
          kind: ref.kind,
          ref: materialRefKey(ref),
          reason: "resolver_failed",
        }),
      )
    : Effect.acquireUseRelease(
        refs.material({
          truthIdentity: request.materialResolution.truthIdentity,
          materialRef: ref,
          ...(request.materialResolution.expectedVersions?.[materialRefKey(ref)] === undefined
            ? {}
            : {
                expectedVersion: request.materialResolution.expectedVersions[materialRefKey(ref)],
              }),
        }),
        (handle): Effect.Effect<A, E | RefResolutionFailed, R> => {
          const value = openLive(handle.value);
          return typeof value === "string"
            ? (
                request.materialResolution?.onResolved?.({
                  materialRef: handle.ref,
                  version: handle.version,
                }) ?? Effect.void
              ).pipe(Effect.andThen(use(value, handle.version)))
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
  request: LlmRequest,
  route: Route,
  use: (resolved: EffectAiLiveRoute<Route>) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | RefResolutionFailed, R> =>
  withStringMaterial(refs, request, endpointMaterialRef(route.endpointRef), (endpoint) =>
    withStringMaterial(refs, request, credentialMaterialRef(route.credentialRef), (credential) =>
      use({ route, endpoint, credential }),
    ),
  );

export const makeEffectAiLlmTransportLayer = <R>(
  modelFactory: EffectAiLanguageModelFactory<R>,
  continuationStore: LlmProviderContinuationStore = LlmProviderContinuationStoreNone,
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
          stream: (request, options) =>
            Stream.unwrap(
              Effect.gen(function* () {
                const resolved = yield* resolveEffectAiRouteForTransport(request.route);
                return yield* withEffectAiLiveRoute(refs, request, resolved.route, (liveRoute) =>
                  liveRoute.route.kind === "openai-chat-compatible"
                    ? Effect.succeed(
                        streamOpenAiChatCompatible(
                          httpClient,
                          {
                            route: liveRoute.route,
                            endpoint: liveRoute.endpoint,
                            credential: liveRoute.credential,
                          },
                          request,
                          continuationStore,
                          options,
                        ),
                      )
                    : modelFactory({
                        route: liveRoute.route,
                        endpoint: liveRoute.endpoint,
                        credential: liveRoute.credential,
                      }).pipe(
                        Effect.provide(context),
                        Effect.map((model) => streamEffectAiLanguageModel(model, request, options)),
                        Effect.mapError((cause) => new UpstreamFailure({ cause })),
                      ),
                ).pipe(
                  Effect.mapError((cause) =>
                    cause instanceof UpstreamFailure ? cause : new UpstreamFailure({ cause }),
                  ),
                );
              }),
            ),
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
export const makeOpenAiCompatibleLlmTransportLayer = (
  continuationStore: LlmProviderContinuationStore = LlmProviderContinuationStoreNone,
): Layer.Layer<LlmTransport, never, RefResolverService | HttpClientService> =>
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
          stream: (request, options) =>
            Stream.unwrap(
              Effect.gen(function* () {
                const resolved = yield* resolveOpenAiChatCompatibleRouteForTransport(request.route);
                return yield* withEffectAiLiveRoute(refs, request, resolved.route, (liveRoute) =>
                  Effect.succeed(
                    streamOpenAiChatCompatible(
                      httpClient,
                      liveRoute,
                      request,
                      continuationStore,
                      options,
                    ),
                  ),
                ).pipe(
                  Effect.mapError((cause) =>
                    cause instanceof UpstreamFailure ? cause : new UpstreamFailure({ cause }),
                  ),
                );
              }),
            ),
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
