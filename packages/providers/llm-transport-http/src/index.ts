import type { LlmRoute } from "@agent-os/core/llm-protocol";
import { credentialMaterialRef, endpointMaterialRef } from "@agent-os/core/material-ref";
import type { MaterialRef } from "@agent-os/core/material-ref";
import type { RefResolver } from "@agent-os/core/ref-resolver";
import type {
  TurnDoneFrame,
  TurnErrorFrame,
  TurnMetadataFrame,
  TurnStreamFrame,
  TurnTextDeltaFrame,
} from "@agent-os/turn-stream";
import { Result, Predicate, pipe } from "effect";

interface HttpStreamingRouteBase extends LlmRoute {
  readonly endpointRef: string;
  readonly credentialRef: string;
  readonly modelId: string;
}

interface OpenAiChatCompatibleRoute extends HttpStreamingRouteBase {
  readonly kind: "openai-chat-compatible";
}

interface AnthropicMessagesRoute extends HttpStreamingRouteBase {
  readonly kind: "anthropic-messages";
  readonly anthropicVersion?: string;
}

interface GeminiGenerateContentRoute extends HttpStreamingRouteBase {
  readonly kind: "gemini-generate-content";
}

export type HttpStreamingLlmRoute =
  | OpenAiChatCompatibleRoute
  | AnthropicMessagesRoute
  | GeminiGenerateContentRoute;

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

const isHttpStreamingLlmRoute = (route: LlmRoute): route is HttpStreamingLlmRoute =>
  hasRouteMaterial(route) &&
  (route.kind === "openai-chat-compatible" ||
    route.kind === "anthropic-messages" ||
    route.kind === "gemini-generate-content");

export interface LlmTransportToolCall {
  readonly id: string;
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly arguments: string;
  };
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface LlmTransportMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string | null;
  readonly tool_calls?: ReadonlyArray<LlmTransportToolCall>;
  readonly tool_call_id?: string;
  readonly name?: string;
}

export type LlmTransportFetch = (input: string, init: RequestInit) => Promise<Response>;

export interface StreamLlmTurnSpec {
  readonly route: LlmRoute;
  readonly resolver: RefResolver;
  readonly messages: ReadonlyArray<LlmTransportMessage>;
  readonly turnRef: string;
  readonly fetch: LlmTransportFetch;
  readonly signal?: AbortSignal;
}

export interface TurnStreamDeltaAdapterInput<TChunk = unknown> {
  readonly turnRef: string;
  /** Starting sequence number for the frames derived from this provider chunk. */
  readonly seq: number;
  readonly chunk: TChunk;
}

export interface OpenAiCompatibleDeltaChoice {
  readonly delta?: {
    readonly content?: unknown;
    readonly role?: unknown;
  };
  readonly finish_reason?: unknown;
}

export interface OpenAiCompatibleDeltaChunk {
  readonly choices?: ReadonlyArray<OpenAiCompatibleDeltaChoice>;
  readonly usage?: unknown;
  readonly error?: unknown;
}

export interface AnthropicDeltaChunk {
  readonly type?: unknown;
  readonly delta?: {
    readonly type?: unknown;
    readonly text?: unknown;
    readonly stop_reason?: unknown;
  };
  readonly usage?: unknown;
  readonly message?: {
    readonly usage?: unknown;
  };
  readonly error?: unknown;
}

export interface GeminiDeltaChunk {
  readonly candidates?: ReadonlyArray<{
    readonly content?: {
      readonly parts?: ReadonlyArray<{
        readonly text?: unknown;
      }>;
    };
    readonly finishReason?: unknown;
  }>;
  readonly usageMetadata?: unknown;
  readonly error?: unknown;
}

type Provider = "openai" | "anthropic" | "gemini";
type ProviderDeltaAdapter = "openai_compatible" | "anthropic" | "gemini";

type TurnStreamFrameBody =
  | Omit<TurnTextDeltaFrame, "turnRef" | "seq">
  | Omit<TurnMetadataFrame, "turnRef" | "seq">
  | Omit<TurnDoneFrame, "turnRef" | "seq">
  | Omit<TurnErrorFrame, "turnRef" | "seq">;

interface ProviderRequest {
  readonly provider: Provider;
  readonly url: string;
  readonly init: RequestInit;
}

interface ProviderError {
  readonly reason: string;
}

type ProviderRequestResult =
  | { readonly ok: true; readonly request: ProviderRequest }
  | { readonly ok: false; readonly error: ProviderError };

interface AnthropicContentBlockText {
  readonly type: "text";
  readonly text: string;
}

interface AnthropicContentBlockToolUse {
  readonly type: "tool_use";
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
}

interface AnthropicContentBlockToolResult {
  readonly type: "tool_result";
  readonly tool_use_id: string;
  readonly content: string;
}

type AnthropicContentBlock =
  | AnthropicContentBlockText
  | AnthropicContentBlockToolUse
  | AnthropicContentBlockToolResult;

interface AnthropicMessage {
  readonly role: "user" | "assistant";
  readonly content: string | ReadonlyArray<AnthropicContentBlock>;
}

type AnthropicMessagesResult =
  | {
      readonly ok: true;
      readonly value: {
        readonly system?: string;
        readonly messages: ReadonlyArray<AnthropicMessage>;
      };
    }
  | { readonly ok: false; readonly error: ProviderError };

interface GeminiPartText {
  readonly text: string;
}

interface GeminiPartFunctionCall {
  readonly functionCall: {
    readonly name: string;
    readonly args: unknown;
  };
  readonly thoughtSignature?: string;
}

interface GeminiPartFunctionResponse {
  readonly functionResponse: {
    readonly name: string;
    readonly response: unknown;
  };
}

type GeminiPart = GeminiPartText | GeminiPartFunctionCall | GeminiPartFunctionResponse;

interface GeminiContent {
  readonly role: "user" | "model";
  readonly parts: ReadonlyArray<GeminiPart>;
}

type GeminiContentsResult =
  | {
      readonly ok: true;
      readonly value: {
        readonly systemText?: string;
        readonly contents: ReadonlyArray<GeminiContent>;
      };
    }
  | { readonly ok: false; readonly error: ProviderError };

const ANTHROPIC_DEFAULT_VERSION = "2023-06-01";
const ANTHROPIC_DEFAULT_MAX_TOKENS = 4096;
const TEXT_EVENT_STREAM = "text/event-stream";

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

const errorFrame = (turnRef: string, seq: number, reason: string): TurnStreamFrame => ({
  kind: "error",
  turnRef,
  seq,
  reason,
});

const adapterErrorFrames = (
  turnRef: string,
  seq: number,
  reason: string,
): ReadonlyArray<TurnStreamFrame> => [errorFrame(turnRef, seq, reason)];

const providerErrorReason = (provider: ProviderDeltaAdapter): string =>
  `${provider}_provider_error`;

const malformedReason = (provider: ProviderDeltaAdapter): string => `${provider}_malformed_chunk`;

const unknownReason = (provider: ProviderDeltaAdapter): string => `${provider}_unknown_chunk`;

const unsupportedReason = (provider: ProviderDeltaAdapter): string =>
  `${provider}_unsupported_chunk`;

const numericMetadata = (value: unknown): unknown => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (!Predicate.isObject(value)) return undefined;

  const sanitized: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    const next = numericMetadata(entry);
    if (next !== undefined) sanitized[key] = next;
  }

  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
};

const appendFrame = (
  frames: TurnStreamFrame[],
  turnRef: string,
  seq: number,
  frame: TurnStreamFrameBody,
): number => {
  frames.push({ ...frame, turnRef, seq } as TurnStreamFrame);
  return seq + 1;
};

const appendUsageMetadata = (
  frames: TurnStreamFrame[],
  turnRef: string,
  seq: number,
  provider: ProviderDeltaAdapter,
  usage: unknown,
): number => {
  const sanitized = numericMetadata(usage);
  if (sanitized === undefined) return seq;
  return appendFrame(frames, turnRef, seq, {
    kind: "metadata",
    data: { provider, usage: sanitized },
  });
};

const appendFinishMetadata = (
  frames: TurnStreamFrame[],
  turnRef: string,
  seq: number,
  provider: ProviderDeltaAdapter,
  finishReason: unknown,
): number => {
  if (!isNonEmptyString(finishReason)) return seq;
  return appendFrame(frames, turnRef, seq, {
    kind: "metadata",
    data: { provider, finishReason },
  });
};

/**
 * Provider delta wire adapter semantics:
 * - adapters are structural; they do not import provider SDK types or preserve
 *   raw provider bodies.
 * - one provider chunk may produce zero or more TurnStreamFrame values, with
 *   sequence numbers assigned from `seq` in emitted order.
 * - unknown/malformed/unsupported chunks emit a terminal error frame with a
 *   package-owned reason string and no raw provider body.
 * - metadata frames contain only curated numeric usage or string finish reason.
 * - terminal frames are transport-level terminals: OpenAI-compatible `[DONE]`,
 *   Anthropic `message_stop`, Gemini `finishReason`, or provider error chunks.
 * - named provider no-ops are the only empty output: OpenAI-compatible role or
 *   empty text deltas, Anthropic ping/message-start/content-block boundary
 *   events, and Gemini empty text parts.
 */
export const adaptOpenAiCompatibleDeltaChunk = (
  input: TurnStreamDeltaAdapterInput<unknown>,
): ReadonlyArray<TurnStreamFrame> => {
  const provider: ProviderDeltaAdapter = "openai_compatible";
  if (input.chunk === "[DONE]") {
    return [{ kind: "done", turnRef: input.turnRef, seq: input.seq }];
  }
  if (!Predicate.isObject(input.chunk)) {
    return adapterErrorFrames(input.turnRef, input.seq, malformedReason(provider));
  }

  if ("error" in input.chunk) {
    return adapterErrorFrames(input.turnRef, input.seq, providerErrorReason(provider));
  }
  if ("choices" in input.chunk && !Array.isArray(input.chunk.choices)) {
    return adapterErrorFrames(input.turnRef, input.seq, malformedReason(provider));
  }

  const frames: TurnStreamFrame[] = [];
  let seq = input.seq;
  let recognized = false;
  const choices = Array.isArray(input.chunk.choices) ? input.chunk.choices : undefined;
  if (choices !== undefined) recognized = true;
  if ("usage" in input.chunk) recognized = true;

  if (choices !== undefined && choices.length === 0 && !("usage" in input.chunk)) {
    return adapterErrorFrames(input.turnRef, input.seq, unknownReason(provider));
  }

  for (const choice of choices ?? []) {
    let choiceRecognized = false;
    if (!Predicate.isObject(choice)) {
      return adapterErrorFrames(input.turnRef, input.seq, malformedReason(provider));
    }

    if ("delta" in choice) {
      if (!Predicate.isObject(choice.delta)) {
        return adapterErrorFrames(input.turnRef, input.seq, malformedReason(provider));
      }
      const allowedDeltaKeys = new Set(["content", "role"]);
      for (const key of Object.keys(choice.delta)) {
        if (!allowedDeltaKeys.has(key)) {
          return adapterErrorFrames(input.turnRef, input.seq, unsupportedReason(provider));
        }
      }

      if ("content" in choice.delta) {
        if (typeof choice.delta.content !== "string") {
          return adapterErrorFrames(input.turnRef, input.seq, malformedReason(provider));
        }
        choiceRecognized = true;
        if (choice.delta.content.length > 0) {
          seq = appendFrame(frames, input.turnRef, seq, {
            kind: "text_delta",
            text: choice.delta.content,
          });
        }
      }

      if ("role" in choice.delta) {
        if (typeof choice.delta.role !== "string") {
          return adapterErrorFrames(input.turnRef, input.seq, malformedReason(provider));
        }
        choiceRecognized = true;
      }

      if (Object.keys(choice.delta).length === 0) {
        choiceRecognized = true;
      }
    }

    if ("finish_reason" in choice) {
      if (choice.finish_reason !== null && typeof choice.finish_reason !== "string") {
        return adapterErrorFrames(input.turnRef, input.seq, malformedReason(provider));
      }
      choiceRecognized = true;
      seq = appendFinishMetadata(
        frames,
        input.turnRef,
        seq,
        "openai_compatible",
        choice.finish_reason,
      );
    }

    if (!choiceRecognized) {
      return adapterErrorFrames(input.turnRef, input.seq, unknownReason(provider));
    }
  }
  seq = appendUsageMetadata(frames, input.turnRef, seq, "openai_compatible", input.chunk.usage);

  if (!recognized) {
    return adapterErrorFrames(input.turnRef, input.seq, unknownReason(provider));
  }

  return frames;
};

export const adaptAnthropicDeltaChunk = (
  input: TurnStreamDeltaAdapterInput<unknown>,
): ReadonlyArray<TurnStreamFrame> => {
  const provider: ProviderDeltaAdapter = "anthropic";
  if (!Predicate.isObject(input.chunk)) {
    return adapterErrorFrames(input.turnRef, input.seq, malformedReason(provider));
  }

  if ("error" in input.chunk || input.chunk.type === "error") {
    return adapterErrorFrames(input.turnRef, input.seq, providerErrorReason(provider));
  }

  const frames: TurnStreamFrame[] = [];
  let seq = input.seq;
  switch (input.chunk.type) {
    case "ping":
    case "content_block_start":
    case "content_block_stop":
      break;
    case "message_start": {
      const usage = Predicate.isObject(input.chunk.message) ? input.chunk.message.usage : undefined;
      seq = appendUsageMetadata(frames, input.turnRef, seq, "anthropic", usage);
      break;
    }
    case "content_block_delta": {
      if (!Predicate.isObject(input.chunk.delta)) {
        return adapterErrorFrames(input.turnRef, input.seq, malformedReason(provider));
      }
      if (input.chunk.delta.type !== undefined && input.chunk.delta.type !== "text_delta") {
        return adapterErrorFrames(input.turnRef, input.seq, unsupportedReason(provider));
      }
      if (typeof input.chunk.delta.text !== "string") {
        return adapterErrorFrames(input.turnRef, input.seq, malformedReason(provider));
      }
      if (input.chunk.delta.text.length > 0) {
        seq = appendFrame(frames, input.turnRef, seq, {
          kind: "text_delta",
          text: input.chunk.delta.text,
        });
      }
      break;
    }
    case "message_delta": {
      if (input.chunk.delta !== undefined && !Predicate.isObject(input.chunk.delta)) {
        return adapterErrorFrames(input.turnRef, input.seq, malformedReason(provider));
      }
      seq = appendUsageMetadata(frames, input.turnRef, seq, "anthropic", input.chunk.usage);
      if (Predicate.isObject(input.chunk.delta)) {
        seq = appendFinishMetadata(
          frames,
          input.turnRef,
          seq,
          "anthropic",
          input.chunk.delta.stop_reason,
        );
      }
      break;
    }
    case "message_stop":
      seq = appendFrame(frames, input.turnRef, seq, { kind: "done" });
      break;
    default:
      return adapterErrorFrames(input.turnRef, input.seq, unknownReason(provider));
  }

  return frames;
};

export const adaptGeminiDeltaChunk = (
  input: TurnStreamDeltaAdapterInput<unknown>,
): ReadonlyArray<TurnStreamFrame> => {
  const provider: ProviderDeltaAdapter = "gemini";
  if (!Predicate.isObject(input.chunk)) {
    return adapterErrorFrames(input.turnRef, input.seq, malformedReason(provider));
  }

  if ("error" in input.chunk) {
    return adapterErrorFrames(input.turnRef, input.seq, providerErrorReason(provider));
  }
  if ("candidates" in input.chunk && !Array.isArray(input.chunk.candidates)) {
    return adapterErrorFrames(input.turnRef, input.seq, malformedReason(provider));
  }

  const frames: TurnStreamFrame[] = [];
  let seq = input.seq;
  let recognized = "usageMetadata" in input.chunk;
  let terminal = false;
  const candidates = Array.isArray(input.chunk.candidates) ? input.chunk.candidates : undefined;
  if (candidates !== undefined) recognized = true;
  if (candidates !== undefined && candidates.length === 0 && !("usageMetadata" in input.chunk)) {
    return adapterErrorFrames(input.turnRef, input.seq, unknownReason(provider));
  }

  for (const candidate of candidates ?? []) {
    if (!Predicate.isObject(candidate)) {
      return adapterErrorFrames(input.turnRef, input.seq, malformedReason(provider));
    }
    const content = candidate.content;
    if (content !== undefined && !Predicate.isObject(content)) {
      return adapterErrorFrames(input.turnRef, input.seq, malformedReason(provider));
    }
    const parts = content === undefined ? [] : content.parts;
    if (parts !== undefined && !Array.isArray(parts)) {
      return adapterErrorFrames(input.turnRef, input.seq, malformedReason(provider));
    }
    for (const part of parts ?? []) {
      if (!Predicate.isObject(part)) {
        return adapterErrorFrames(input.turnRef, input.seq, malformedReason(provider));
      }
      const allowedPartKeys = new Set(["text"]);
      for (const key of Object.keys(part)) {
        if (!allowedPartKeys.has(key)) {
          return adapterErrorFrames(input.turnRef, input.seq, unsupportedReason(provider));
        }
      }
      if (!("text" in part)) {
        return adapterErrorFrames(input.turnRef, input.seq, malformedReason(provider));
      }
      if (typeof part.text !== "string") {
        return adapterErrorFrames(input.turnRef, input.seq, malformedReason(provider));
      }
      if (isNonEmptyString(part.text)) {
        seq = appendFrame(frames, input.turnRef, seq, { kind: "text_delta", text: part.text });
      }
    }
    if (candidate.finishReason !== undefined && typeof candidate.finishReason !== "string") {
      return adapterErrorFrames(input.turnRef, input.seq, malformedReason(provider));
    }
    if (isNonEmptyString(candidate.finishReason)) {
      terminal = true;
      seq = appendFinishMetadata(frames, input.turnRef, seq, "gemini", candidate.finishReason);
    }
  }
  seq = appendUsageMetadata(frames, input.turnRef, seq, "gemini", input.chunk.usageMetadata);
  if (terminal) {
    appendFrame(frames, input.turnRef, seq, { kind: "done" });
  }

  if (!recognized) {
    return adapterErrorFrames(input.turnRef, input.seq, unknownReason(provider));
  }

  return frames;
};

interface StringMaterialLease {
  readonly ref: MaterialRef;
  readonly value: string;
  readonly release: () => void;
}

interface RouteMaterialLeases {
  readonly endpoint: StringMaterialLease;
  readonly credential: StringMaterialLease;
  readonly release: () => void;
}

const acquireStringMaterial = (
  resolver: RefResolver,
  ref: MaterialRef,
  reason: string,
):
  | { readonly ok: true; readonly lease: StringMaterialLease }
  | { readonly ok: false; readonly error: ProviderError } => {
  const resolved = Result.match(
    Result.try({ try: () => resolver.material(ref), catch: () => null }),
    {
      onFailure: () => null,
      onSuccess: (material) => material,
    },
  );
  if (!isNonEmptyString(resolved)) {
    if (resolved !== null && resolved !== undefined) {
      resolver.dispose?.({ ref, material: resolved });
    }
    return { ok: false, error: { reason } };
  }
  return {
    ok: true,
    lease: {
      ref,
      value: resolved,
      release: () => resolver.dispose?.({ ref, material: resolved }),
    },
  };
};

const acquireRouteMaterialLeases = (
  resolver: RefResolver,
  route: HttpStreamingLlmRoute,
):
  | { readonly ok: true; readonly leases: RouteMaterialLeases }
  | { readonly ok: false; readonly error: ProviderError } => {
  const endpoint = acquireStringMaterial(
    resolver,
    endpointMaterialRef(route.endpointRef),
    "llm_transport_http_missing_endpoint_material",
  );
  if (!endpoint.ok) return endpoint;
  const credential = acquireStringMaterial(
    resolver,
    credentialMaterialRef(route.credentialRef),
    "llm_transport_http_missing_credential_material",
  );
  if (!credential.ok) {
    endpoint.lease.release();
    return credential;
  }
  return {
    ok: true,
    leases: {
      endpoint: endpoint.lease,
      credential: credential.lease,
      release: () => {
        credential.lease.release();
        endpoint.lease.release();
      },
    },
  };
};

const withoutTrailingSlash = (value: string): string => value.replace(/\/$/, "");

type JsonParseResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly reason: string };

const parseJson = (value: string, reason: string): JsonParseResult =>
  pipe(
    Result.try({
      try: () => JSON.parse(value) as unknown,
      catch: () => reason,
    }),
    Result.match({
      onFailure: (failure) => ({ ok: false, reason: failure }),
      onSuccess: (parsed) => ({ ok: true, value: parsed }),
    }),
  );

const parseJsonForRequest = (
  value: string,
  reason: string,
):
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: ProviderError } => {
  const parsed = parseJson(value, reason);
  return parsed.ok
    ? { ok: true, value: parsed.value }
    : { ok: false, error: { reason: parsed.reason } };
};

const parseJsonChunk = (
  data: string,
): JsonParseResult | { readonly ok: true; readonly value: "[DONE]" } => {
  if (data === "[DONE]") return { ok: true, value: data };
  return parseJson(data, "llm_transport_http_chunk_json_invalid");
};

const encodeBody = (body: unknown): string | ProviderError => {
  const encoded = pipe(
    Result.try({
      try: () => JSON.stringify(body),
      catch: () => null,
    }),
    Result.match({
      onFailure: () => null,
      onSuccess: (right) => right,
    }),
  );
  return typeof encoded === "string"
    ? encoded
    : { reason: "llm_transport_http_request_encode_failed" };
};

const buildOpenAiRequest = (
  spec: StreamLlmTurnSpec,
  route: OpenAiChatCompatibleRoute,
  materials: RouteMaterialLeases,
): ProviderRequestResult => {
  const body = encodeBody({
    model: route.modelId,
    messages: spec.messages,
    stream: true,
    stream_options: { include_usage: true },
  });
  if (typeof body !== "string") return { ok: false, error: body };

  return {
    ok: true,
    request: {
      provider: "openai",
      url: `${withoutTrailingSlash(materials.endpoint.value)}/chat/completions`,
      init: {
        method: "POST",
        headers: {
          Authorization: `Bearer ${materials.credential.value}`,
          Accept: TEXT_EVENT_STREAM,
          "Content-Type": "application/json",
        },
        body,
        signal: spec.signal,
      },
    },
  };
};

const buildAnthropicMessages = (
  messages: ReadonlyArray<LlmTransportMessage>,
): AnthropicMessagesResult => {
  const system: string[] = [];
  const out: AnthropicMessage[] = [];
  let index = 0;

  while (index < messages.length) {
    const message = messages[index];
    if (message.role === "system") {
      if (isNonEmptyString(message.content)) system.push(message.content);
      index += 1;
      continue;
    }

    if (message.role === "user") {
      out.push({ role: "user", content: message.content ?? "" });
      index += 1;
      continue;
    }

    if (message.role === "assistant") {
      const blocks: AnthropicContentBlock[] = [];
      if (isNonEmptyString(message.content)) {
        blocks.push({ type: "text", text: message.content });
      }
      for (const call of message.tool_calls ?? []) {
        const input = parseJsonForRequest(
          call.function.arguments,
          "llm_transport_http_tool_arguments_json_invalid",
        );
        if (!input.ok) return { ok: false, error: input.error };
        blocks.push({
          type: "tool_use",
          id: call.id,
          name: call.function.name,
          input: input.value,
        });
      }
      out.push({ role: "assistant", content: blocks.length > 0 ? blocks : "" });
      index += 1;
      continue;
    }

    const toolBlocks: AnthropicContentBlock[] = [];
    while (index < messages.length && messages[index]?.role === "tool") {
      const toolMessage = messages[index];
      toolBlocks.push({
        type: "tool_result",
        tool_use_id: toolMessage.tool_call_id ?? "",
        content: toolMessage.content ?? "",
      });
      index += 1;
    }
    out.push({ role: "user", content: toolBlocks });
  }

  return {
    ok: true,
    value: {
      ...(system.length === 0 ? {} : { system: system.join("\n\n") }),
      messages: out,
    },
  };
};

const buildAnthropicRequest = (
  spec: StreamLlmTurnSpec,
  route: AnthropicMessagesRoute,
  materials: RouteMaterialLeases,
): ProviderRequestResult => {
  const messages = buildAnthropicMessages(spec.messages);
  if (!messages.ok) return { ok: false, error: messages.error };
  const body = encodeBody({
    model: route.modelId,
    ...messages.value,
    max_tokens: ANTHROPIC_DEFAULT_MAX_TOKENS,
    stream: true,
  });
  if (typeof body !== "string") return { ok: false, error: body };

  return {
    ok: true,
    request: {
      provider: "anthropic",
      url: `${withoutTrailingSlash(materials.endpoint.value)}/v1/messages`,
      init: {
        method: "POST",
        headers: {
          "x-api-key": materials.credential.value,
          "anthropic-version": route.anthropicVersion ?? ANTHROPIC_DEFAULT_VERSION,
          Accept: TEXT_EVENT_STREAM,
          "Content-Type": "application/json",
        },
        body,
        signal: spec.signal,
      },
    },
  };
};

const buildGeminiContents = (
  messages: ReadonlyArray<LlmTransportMessage>,
): GeminiContentsResult => {
  const system: string[] = [];
  const contents: GeminiContent[] = [];
  let index = 0;

  while (index < messages.length) {
    const message = messages[index];
    if (message.role === "system") {
      if (isNonEmptyString(message.content)) system.push(message.content);
      index += 1;
      continue;
    }

    if (message.role === "user") {
      contents.push({ role: "user", parts: [{ text: message.content ?? "" }] });
      index += 1;
      continue;
    }

    if (message.role === "assistant") {
      const parts: GeminiPart[] = [];
      if (isNonEmptyString(message.content)) {
        parts.push({ text: message.content });
      }
      for (const call of message.tool_calls ?? []) {
        const args = parseJsonForRequest(
          call.function.arguments,
          "llm_transport_http_tool_arguments_json_invalid",
        );
        if (!args.ok) return { ok: false, error: args.error };
        const signature =
          call.metadata !== undefined && typeof call.metadata.thoughtSignature === "string"
            ? call.metadata.thoughtSignature
            : undefined;
        parts.push({
          functionCall: {
            name: call.function.name,
            args: args.value,
          },
          ...(signature === undefined ? {} : { thoughtSignature: signature }),
        });
      }
      contents.push({ role: "model", parts: parts.length > 0 ? parts : [{ text: "" }] });
      index += 1;
      continue;
    }

    const parts: GeminiPart[] = [];
    while (index < messages.length && messages[index]?.role === "tool") {
      const toolMessage = messages[index];
      parts.push({
        functionResponse: {
          name: toolMessage.name ?? toolMessage.tool_call_id ?? "tool",
          response: { content: toolMessage.content ?? "" },
        },
      });
      index += 1;
    }
    contents.push({ role: "user", parts });
  }

  return {
    ok: true,
    value: {
      ...(system.length === 0 ? {} : { systemText: system.join("\n\n") }),
      contents,
    },
  };
};

const buildGeminiRequest = (
  spec: StreamLlmTurnSpec,
  route: GeminiGenerateContentRoute,
  materials: RouteMaterialLeases,
): ProviderRequestResult => {
  const geminiMessages = buildGeminiContents(spec.messages);
  if (!geminiMessages.ok) return { ok: false, error: geminiMessages.error };
  const { systemText, contents } = geminiMessages.value;
  const body = encodeBody({
    ...(systemText === undefined ? {} : { systemInstruction: { parts: [{ text: systemText }] } }),
    contents,
  });
  if (typeof body !== "string") return { ok: false, error: body };

  return {
    ok: true,
    request: {
      provider: "gemini",
      url: `${withoutTrailingSlash(materials.endpoint.value)}/v1beta/models/${route.modelId}:streamGenerateContent?alt=sse`,
      init: {
        method: "POST",
        headers: {
          "x-goog-api-key": materials.credential.value,
          Accept: TEXT_EVENT_STREAM,
          "Content-Type": "application/json",
        },
        body,
        signal: spec.signal,
      },
    },
  };
};

const buildProviderRequest = (
  spec: StreamLlmTurnSpec,
  materials: RouteMaterialLeases,
): ProviderRequestResult => {
  if (!isHttpStreamingLlmRoute(spec.route)) {
    return { ok: false, error: { reason: "llm_transport_http_unsupported_route" } };
  }
  switch (spec.route.kind) {
    case "openai-chat-compatible":
      return buildOpenAiRequest(spec, spec.route, materials);
    case "anthropic-messages":
      return buildAnthropicRequest(spec, spec.route, materials);
    case "gemini-generate-content":
      return buildGeminiRequest(spec, spec.route, materials);
  }
};

interface SseEvent {
  readonly data: ReadonlyArray<string>;
}

const findSseBoundary = (
  buffer: string,
): { readonly start: number; readonly end: number } | null => {
  const lf = buffer.indexOf("\n\n");
  const crlf = buffer.indexOf("\r\n\r\n");
  if (lf === -1 && crlf === -1) return null;
  if (lf !== -1 && (crlf === -1 || lf < crlf)) return { start: lf, end: lf + 2 };
  return { start: crlf, end: crlf + 4 };
};

const parseSseEvent = (eventText: string): SseEvent => {
  const data: string[] = [];
  for (const line of eventText.replace(/\r\n/g, "\n").split("\n")) {
    if (line.startsWith("data:")) {
      data.push(line.slice(5).replace(/^ /, ""));
    }
  }
  return { data };
};

function* drainSseEvents(buffer: string): Generator<SseEvent, string> {
  let rest = buffer;
  while (true) {
    const boundary = findSseBoundary(rest);
    if (boundary === null) return rest;
    const eventText = rest.slice(0, boundary.start);
    rest = rest.slice(boundary.end);
    yield parseSseEvent(eventText);
  }
}

const adaptProviderChunk = (
  provider: Provider,
  turnRef: string,
  seq: number,
  chunk: unknown,
): ReadonlyArray<TurnStreamFrame> => {
  switch (provider) {
    case "openai":
      return adaptOpenAiCompatibleDeltaChunk({ turnRef, seq, chunk });
    case "anthropic":
      return adaptAnthropicDeltaChunk({ turnRef, seq, chunk });
    case "gemini":
      return adaptGeminiDeltaChunk({ turnRef, seq, chunk });
  }
};

const nextSeq = (seq: number, frames: ReadonlyArray<TurnStreamFrame>): number =>
  frames.reduce((next, frame) => Math.max(next, frame.seq + 1), seq);

const hasTerminal = (frames: ReadonlyArray<TurnStreamFrame>): boolean =>
  frames.some((frame) => frame.kind === "done" || frame.kind === "error");

const responseIsSse = (response: Response): boolean =>
  response.headers.get("content-type")?.toLowerCase().includes(TEXT_EVENT_STREAM) ?? false;

const signalAborted = (signal: AbortSignal | undefined): boolean => signal?.aborted === true;

const fetchProviderResponse = (
  spec: StreamLlmTurnSpec,
  request: ProviderRequest,
): Promise<
  | { readonly ok: true; readonly response: Response }
  | { readonly ok: false; readonly reason: string }
> =>
  spec.fetch(request.url, request.init).then(
    (response) => ({ ok: true, response }) as const,
    () =>
      ({
        ok: false,
        reason: signalAborted(spec.signal)
          ? "llm_transport_http_aborted"
          : "llm_transport_http_fetch_failed",
      }) as const,
  );

const collectStreamReadFailure = (signal: AbortSignal | undefined): string =>
  signalAborted(signal) ? "llm_transport_http_aborted" : "llm_transport_http_stream_read_failed";

async function* emitStreamFrames(
  request: ProviderRequest,
  response: Response,
  turnRef: string,
  signal: AbortSignal | undefined,
): AsyncGenerator<TurnStreamFrame> {
  const iterator = streamSseFrames(request, response, turnRef)[Symbol.asyncIterator]();
  while (true) {
    const next = await iterator.next().then(
      (result) => ({ ok: true, result }) as const,
      () => ({ ok: false, reason: collectStreamReadFailure(signal) }) as const,
    );
    if (!next.ok) {
      yield errorFrame(turnRef, 0, next.reason);
      return;
    }
    if (next.result.done === true) return;
    yield next.result.value;
  }
}

async function* streamSseFrames(
  request: ProviderRequest,
  response: Response,
  turnRef: string,
): AsyncGenerator<TurnStreamFrame> {
  let seq = 0;
  const reader = response.body?.getReader();
  if (reader === undefined) {
    yield errorFrame(turnRef, seq, "llm_transport_http_missing_response_body");
    return;
  }

  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const read = await reader.read();
    if (read.done === true) break;
    buffer += decoder.decode(read.value, { stream: true });

    const events = drainSseEvents(buffer);
    while (true) {
      const next = events.next();
      if (next.done === true) {
        buffer = next.value;
        break;
      }

      const data = next.value.data.join("\n");
      if (data.length === 0) continue;

      const chunk = parseJsonChunk(data);
      if (!chunk.ok) {
        yield errorFrame(turnRef, seq, chunk.reason);
        return;
      }
      const frames = adaptProviderChunk(request.provider, turnRef, seq, chunk.value);
      for (const frame of frames) yield frame;
      seq = nextSeq(seq, frames);
      if (hasTerminal(frames)) return;
    }
  }

  const finalText = decoder.decode();
  if (finalText.length > 0) buffer += finalText;
  if (buffer.trim().length > 0) {
    const event = parseSseEvent(buffer);
    const data = event.data.join("\n");
    if (data.length > 0) {
      const chunk = parseJsonChunk(data);
      if (!chunk.ok) {
        yield errorFrame(turnRef, seq, chunk.reason);
        return;
      }
      const frames = adaptProviderChunk(request.provider, turnRef, seq, chunk.value);
      for (const frame of frames) yield frame;
      if (hasTerminal(frames)) return;
      seq = nextSeq(seq, frames);
    }
  }

  yield errorFrame(turnRef, seq, "llm_transport_http_stream_ended_without_terminal");
}

export async function* streamLlmTurn(spec: StreamLlmTurnSpec): AsyncGenerator<TurnStreamFrame> {
  if (signalAborted(spec.signal)) {
    yield errorFrame(spec.turnRef, 0, "llm_transport_http_aborted");
    return;
  }
  if (typeof spec.fetch !== "function") {
    yield errorFrame(spec.turnRef, 0, "llm_transport_http_missing_fetch");
    return;
  }

  if (!isHttpStreamingLlmRoute(spec.route)) {
    yield errorFrame(spec.turnRef, 0, "llm_transport_http_unsupported_route");
    return;
  }

  const leases = acquireRouteMaterialLeases(spec.resolver, spec.route);
  if (!leases.ok) {
    yield errorFrame(spec.turnRef, 0, leases.error.reason);
    return;
  }

  try {
    const request = buildProviderRequest(spec, leases.leases);
    if (!request.ok) {
      yield errorFrame(spec.turnRef, 0, request.error.reason);
      return;
    }

    const response = await fetchProviderResponse(spec, request.request);
    if (!response.ok) {
      yield errorFrame(spec.turnRef, 0, response.reason);
      return;
    }

    if (!response.response.ok) {
      yield errorFrame(
        spec.turnRef,
        0,
        `llm_transport_http_http_error_${response.response.status}`,
      );
      return;
    }

    if (!responseIsSse(response.response)) {
      yield errorFrame(spec.turnRef, 0, "llm_transport_http_response_not_sse");
      return;
    }

    yield* emitStreamFrames(request.request, response.response, spec.turnRef, spec.signal);
  } finally {
    leases.leases.release();
  }
}
