import type { LlmRoute, ToolDefinition } from "@agent-os/core";
import { credentialMaterialRef, endpointMaterialRef } from "@agent-os/core/material-ref";
import type { MaterialRef } from "@agent-os/core/material-ref";
import type { RefResolver } from "@agent-os/core/ref-resolver";
import {
  adaptAnthropicDeltaChunk,
  adaptGeminiDeltaChunk,
  adaptOpenAiCompatibleDeltaChunk,
  type TurnStreamFrame,
} from "@agent-os/turn-stream";
import { Either, pipe } from "effect";

export type HttpStreamingLlmRoute = Extract<
  LlmRoute,
  { readonly kind: "openai-chat-compatible" | "anthropic-messages" | "gemini-generate-content" }
>;

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
  readonly tools?: ReadonlyArray<ToolDefinition>;
  readonly turnRef: string;
  readonly fetch: LlmTransportFetch;
  readonly signal?: AbortSignal;
}

type Provider = "openai" | "anthropic" | "gemini";

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

const hasToolDefinitions = (tools: ReadonlyArray<ToolDefinition> | undefined): boolean =>
  tools !== undefined && tools.length > 0;

const resolvedStringMaterial = (resolver: RefResolver, ref: MaterialRef): string | null => {
  const value = resolver.material(ref);
  return isNonEmptyString(value) ? value : null;
};

const endpointFor = (
  resolver: RefResolver,
  route: HttpStreamingLlmRoute,
): string | ProviderError => {
  const endpoint = resolvedStringMaterial(
    resolver,
    endpointMaterialRef(route.endpointRef, { protocol: route.kind }),
  );
  return endpoint ?? { reason: "llm_transport_http_missing_endpoint_material" };
};

const credentialFor = (
  resolver: RefResolver,
  route: HttpStreamingLlmRoute,
): string | ProviderError => {
  const credential = resolvedStringMaterial(
    resolver,
    credentialMaterialRef(route.credentialRef, {
      provider: route.kind,
      purpose: "llm_transport",
    }),
  );
  return credential ?? { reason: "llm_transport_http_missing_credential_material" };
};

const withoutTrailingSlash = (value: string): string => value.replace(/\/$/, "");

type JsonParseResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly reason: string };

const parseJson = (value: string, reason: string): JsonParseResult =>
  pipe(
    Either.try({
      try: () => JSON.parse(value) as unknown,
      catch: () => reason,
    }),
    Either.match({
      onLeft: (failure) => ({ ok: false, reason: failure }),
      onRight: (parsed) => ({ ok: true, value: parsed }),
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
    Either.try({
      try: () => JSON.stringify(body),
      catch: () => null,
    }),
    Either.match({
      onLeft: () => null,
      onRight: (right) => right,
    }),
  );
  return typeof encoded === "string"
    ? encoded
    : { reason: "llm_transport_http_request_encode_failed" };
};

const buildOpenAiRequest = (
  spec: StreamLlmTurnSpec,
  route: Extract<LlmRoute, { readonly kind: "openai-chat-compatible" }>,
): ProviderRequestResult => {
  const endpoint = endpointFor(spec.resolver, route);
  if (typeof endpoint !== "string") return { ok: false, error: endpoint };
  const credential = credentialFor(spec.resolver, route);
  if (typeof credential !== "string") return { ok: false, error: credential };

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
      url: `${withoutTrailingSlash(endpoint)}/chat/completions`,
      init: {
        method: "POST",
        headers: {
          Authorization: `Bearer ${credential}`,
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
  route: Extract<LlmRoute, { readonly kind: "anthropic-messages" }>,
): ProviderRequestResult => {
  const endpoint = endpointFor(spec.resolver, route);
  if (typeof endpoint !== "string") return { ok: false, error: endpoint };
  const credential = credentialFor(spec.resolver, route);
  if (typeof credential !== "string") return { ok: false, error: credential };

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
      url: `${withoutTrailingSlash(endpoint)}/v1/messages`,
      init: {
        method: "POST",
        headers: {
          "x-api-key": credential,
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
  route: Extract<LlmRoute, { readonly kind: "gemini-generate-content" }>,
): ProviderRequestResult => {
  const endpoint = endpointFor(spec.resolver, route);
  if (typeof endpoint !== "string") return { ok: false, error: endpoint };
  const credential = credentialFor(spec.resolver, route);
  if (typeof credential !== "string") return { ok: false, error: credential };

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
      url: `${withoutTrailingSlash(endpoint)}/v1beta/models/${route.modelId}:streamGenerateContent?alt=sse`,
      init: {
        method: "POST",
        headers: {
          "x-goog-api-key": credential,
          Accept: TEXT_EVENT_STREAM,
          "Content-Type": "application/json",
        },
        body,
        signal: spec.signal,
      },
    },
  };
};

const buildProviderRequest = (spec: StreamLlmTurnSpec): ProviderRequestResult => {
  switch (spec.route.kind) {
    case "openai-chat-compatible":
      return buildOpenAiRequest(spec, spec.route);
    case "anthropic-messages":
      return buildAnthropicRequest(spec, spec.route);
    case "gemini-generate-content":
      return buildGeminiRequest(spec, spec.route);
    case "cf-ai-binding":
      return {
        ok: false,
        error: { reason: "llm_transport_http_unsupported_route" },
      };
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
  if (hasToolDefinitions(spec.tools)) {
    yield errorFrame(spec.turnRef, 0, "llm_transport_http_stream_tools_unsupported");
    return;
  }
  if (typeof spec.fetch !== "function") {
    yield errorFrame(spec.turnRef, 0, "llm_transport_http_missing_fetch");
    return;
  }

  const request = buildProviderRequest(spec);
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
    yield errorFrame(spec.turnRef, 0, `llm_transport_http_http_error_${response.response.status}`);
    return;
  }

  if (!responseIsSse(response.response)) {
    yield errorFrame(spec.turnRef, 0, "llm_transport_http_response_not_sse");
    return;
  }

  yield* emitStreamFrames(request.request, response.response, spec.turnRef, spec.signal);
}
