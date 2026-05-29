/**
 * LLM carrier — module-private.
 *
 * Two responsibilities only:
 *
 *   1. `dispatchProvider(route, body)` — transport seam. Per `route.kind`,
 *      shapes the upstream call (env.AI.run vs fetch with auth header)
 *      and returns the raw upstream response without decoding.
 *
 *   2. `callLlm(request)` — free-text agent turn. Looks up the protocol
 *      adapter for the route (`getProtocolAdapter`) and pipes:
 *      `adapter.encodeTurn → dispatchProvider → adapter.decodeTurn`.
 *
 * All wire-shape knowledge (encode body / decode response / classify
 * errors) lives in `protocol/`. `callLlm` and
 * `attemptStructured` (admission.ts) share that registry so a route's
 * turn behavior and structured behavior are evidence about the SAME
 * wire (contract §1 C-2).
 *
 * Why the route indirection (vs. the previous `agent: {provider, model}`
 * shape): see contract INV-8 revision and contract §3. Capability is
 * evidence on `(route, schemaContract, strategy, adapterVersion)`, not
 * a model-id property. The route taxonomy is what makes admission's
 * fingerprint stable across credential rotation.
 */

import { Context, Effect, Layer } from "effect";
import { LlmTransport } from "@agent-os/runtime";
import {
  ProviderHttpFailure,
  UpstreamFailure,
  type ProviderFailureFlag,
} from "@agent-os/kernel/errors";
import {
  credentialMaterialRef,
  endpointMaterialRef,
  type MaterialRef,
} from "@agent-os/kernel/material-ref";
import {
  RefResolutionFailed,
  RefResolverService,
  resolveStringMaterial,
} from "@agent-os/kernel/ref-resolver";
import { getProtocolAdapter } from "./protocol/protocol-adapter";

export class AiBinding extends Context.Tag("@agent-os/AiBinding")<AiBinding, Ai>() {}

// ============================================================
//   LlmRoute — tagged union of transport protocols (contract §3)
// ============================================================

export interface CfAiBindingRoute {
  readonly kind: "cf-ai-binding";
  readonly modelId: string;
  readonly gatewayRef?: string;
}

export interface OpenAIChatCompatibleRoute {
  readonly kind: "openai-chat-compatible";
  readonly endpointRef: string;
  readonly credentialRef: string;
  readonly modelId: string;
}

export interface AnthropicMessagesRoute {
  readonly kind: "anthropic-messages";
  readonly endpointRef: string;
  readonly credentialRef: string;
  readonly modelId: string;
  /** Anthropic requires the `anthropic-version` header. Default applied at
   *  transport time is `"2023-06-01"`. Routes that need a different version
   *  pin it here; the pinned value enters `routeFingerprint`, isolating
   *  evidence per pinned version. Routes omitting this field share a
   *  fingerprint and pool evidence at the substrate's current default. */
  readonly anthropicVersion?: string;
}

export interface GeminiGenerateContentRoute {
  readonly kind: "gemini-generate-content";
  readonly endpointRef: string;
  readonly credentialRef: string;
  readonly modelId: string;
}

export type LlmRoute =
  | CfAiBindingRoute
  | OpenAIChatCompatibleRoute
  | AnthropicMessagesRoute
  | GeminiGenerateContentRoute;

export const llmRouteMaterialRefs = (route: LlmRoute): ReadonlyArray<MaterialRef> => {
  switch (route.kind) {
    case "cf-ai-binding":
      return [];
    case "openai-chat-compatible":
    case "anthropic-messages":
    case "gemini-generate-content":
      return [endpointMaterialRef(route.endpointRef), credentialMaterialRef(route.credentialRef)];
  }
};

// ============================================================
//   Unified message / tool-call / response types
//   (used across adapters; native protocol blocks fold into these)
// ============================================================

export interface LlmToolCall {
  readonly id: string;
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly arguments: string; // JSON-stringified args, unified across wires
  };
  /** Protocol-opaque metadata round-tripped between decodeTurn → message
   *  accumulation in submit-agent.ts → encodeTurn. Gemini requires
   *  `thoughtSignature` to be echoed back unmodified on subsequent turns
   *  (gemini-3.1+ thought signatures, see
   *  https://ai.google.dev/gemini-api/docs/thought-signatures). Other
   *  protocols leave this undefined. */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface LlmMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string | null;
  readonly tool_calls?: ReadonlyArray<LlmToolCall>;
  readonly tool_call_id?: string;
  /** Tool name on role:"tool" messages. Optional in OpenAI / Anthropic
   *  wires (matched by tool_call_id / tool_use_id) but REQUIRED by
   *  Gemini's `functionResponse.name`. submit-agent.ts populates this
   *  from `call.function.name` when constructing the tool reply message
   *  so Gemini's adapter can produce a well-formed contents[]. */
  readonly name?: string;
}

export interface LlmResponse {
  readonly text: string;
  readonly toolCalls: ReadonlyArray<LlmToolCall>;
  readonly usage: LlmUsage;
}

export interface LlmUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}

export interface ToolDefinition {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: object;
  };
}

export interface LlmRequest {
  readonly route: LlmRoute;
  readonly messages: ReadonlyArray<LlmMessage>;
  readonly tools?: ReadonlyArray<ToolDefinition>;
  /** Forces the model to call the named function. Used by admission's
   *  structured-output strategy (contract §6). Free-text agent loops leave
   *  this undefined. */
  readonly tool_choice?: {
    readonly type: "function";
    readonly function: { readonly name: string };
  };
}

// ============================================================
//   Transport seam
// ============================================================
//   `dispatchProvider` is the ONLY transport. Adapter-produced body goes
//   in, raw upstream response comes out. Both `callLlm` (this file) and
//   `attemptStructured` (admission.ts) consume it.
//
//   Sharing the seam guarantees that a route always uses the transport
//   its routeFingerprint claims, so capability evidence cannot lie about
//   which endpoint actually served the request.
// ============================================================

/** Adapter-shape request body for Chat Completions wires. cf-ai-binding
 *  and openai-chat-compatible share this shape. `modelId` is on `route`,
 *  not on the body — the dispatcher inserts it where the protocol
 *  requires (env.AI.run arg vs body merge). */
export interface ChatCompletionsBody {
  readonly messages: ReadonlyArray<LlmMessage>;
  readonly tools?: ReadonlyArray<ToolDefinition>;
  readonly tool_choice?: LlmRequest["tool_choice"];
  readonly max_tokens?: number;
  readonly stream?: boolean;
  readonly stream_options?: { readonly include_usage: boolean };
}

/** Anthropic Messages API body. Differs from Chat Completions in:
 *  - `system` is a TOP-LEVEL string (NOT a message role)
 *  - `messages[]` carries only "user" / "assistant" roles
 *  - `tool_use` / `tool_result` are CONTENT BLOCKS within messages
 *  - `tools[].input_schema` (NOT `function.parameters`)
 *  - `tool_choice: {type:"tool", name}` for forced (NOT
 *    `{type:"function", function:{name}}`)
 *  - `max_tokens` is REQUIRED.
 */
export type AnthropicContentBlock =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "tool_use";
      readonly id: string;
      readonly name: string;
      readonly input: unknown;
    }
  | {
      readonly type: "tool_result";
      readonly tool_use_id: string;
      readonly content: string;
      readonly is_error?: boolean;
    };

export interface AnthropicMessage {
  readonly role: "user" | "assistant";
  readonly content: string | ReadonlyArray<AnthropicContentBlock>;
}

export interface AnthropicTool {
  readonly name: string;
  readonly description?: string;
  readonly input_schema: object;
}

export interface AnthropicMessagesBody {
  readonly system?: string;
  readonly messages: ReadonlyArray<AnthropicMessage>;
  readonly tools?: ReadonlyArray<AnthropicTool>;
  readonly tool_choice?: { readonly type: "tool"; readonly name: string };
  readonly max_tokens: number;
  readonly stream?: boolean;
}

/** Google Gemini `generateContent` body. Differs from both Chat
 *  Completions and Anthropic in:
 *  - `contents[]` instead of `messages[]`
 *  - assistant role name is `"model"` (NOT `"assistant"`)
 *  - system goes into top-level `systemInstruction` (parts-of-text)
 *  - tools wrap into `tools[].functionDeclarations[]` (an array of arrays
 *    — outer is "tool group", inner is declarations within that group)
 *  - forced tool: `toolConfig.functionCallingConfig.mode = "ANY"` plus
 *    `allowedFunctionNames: [name]`
 *  - assistant tool calls appear as `functionCall: {name, args}` (args
 *    already an object) within content parts
 *  - tool results sent back as `functionResponse: {name, response}` parts
 *    inside a "user"-role content
 */
export type GeminiPart =
  | { readonly text: string }
  | {
      readonly functionCall: {
        readonly name: string;
        readonly args: unknown;
      };
      /** gemini-3.1+ requires this signature to be echoed back unchanged
       *  on subsequent turns when re-emitting an assistant functionCall.
       *  Missing → HTTP 400 INVALID_ARGUMENT. The adapter round-trips
       *  this through `LlmToolCall.metadata.thoughtSignature`. */
      readonly thoughtSignature?: string;
    }
  | {
      readonly functionResponse: {
        readonly name: string;
        readonly response: unknown;
      };
    };

export interface GeminiContent {
  readonly role: "user" | "model";
  readonly parts: ReadonlyArray<GeminiPart>;
}

export interface GeminiFunctionDeclaration {
  readonly name: string;
  readonly description?: string;
  readonly parameters: object;
}

export interface GeminiToolGroup {
  readonly functionDeclarations: ReadonlyArray<GeminiFunctionDeclaration>;
}

export interface GeminiToolConfig {
  readonly functionCallingConfig: {
    readonly mode: "AUTO" | "ANY" | "NONE";
    readonly allowedFunctionNames?: ReadonlyArray<string>;
  };
}

export interface GeminiGenerateContentBody {
  readonly systemInstruction?: { readonly parts: ReadonlyArray<{ readonly text: string }> };
  readonly contents: ReadonlyArray<GeminiContent>;
  readonly tools?: ReadonlyArray<GeminiToolGroup>;
  readonly toolConfig?: GeminiToolConfig;
}

/** Per-kind body type. Each adapter's `encodeTurn` / `encodeStructured`
 *  is typed to produce the body for its own `K`; `dispatchProvider`
 *  consumes the per-kind body in the matching switch branch. */
export type ProviderRequestBodyMap = {
  readonly "cf-ai-binding": ChatCompletionsBody;
  readonly "openai-chat-compatible": ChatCompletionsBody;
  readonly "anthropic-messages": AnthropicMessagesBody;
  readonly "gemini-generate-content": GeminiGenerateContentBody;
};

export type ProviderRequestBodyFor<K extends LlmRoute["kind"]> = ProviderRequestBodyMap[K];

/** Union of all per-kind bodies. `dispatchProvider` and `attemptStructured`
 *  receive this; the per-kind narrowing happens at the switch on
 *  `route.kind`. */
export type ProviderRequestBody = ProviderRequestBodyMap[LlmRoute["kind"]];

const DEFAULT_ANTHROPIC_VERSION = "2023-06-01";

/** Default headers per wire. Exported for admission's
 *  `normalizeRouteForFingerprint` (admission.ts) so unpinned routes
 *  enter the canonical fingerprint with the substrate's CURRENT default
 *  baked in. Bumping this constant invalidates existing unpinned-route
 *  leases by construction — that is the intended behavior: a different
 *  Anthropic API version is a different wire surface, and lease
 *  evidence collected against the old version must NOT roll forward to
 *  the new one. See contract §7. */
export const DEFAULTS = {
  anthropicVersion: DEFAULT_ANTHROPIC_VERSION,
} as const;

type HttpProvider = Exclude<LlmRoute["kind"], "cf-ai-binding">;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const sanitizedToken = (value: unknown): string | undefined =>
  typeof value === "string" && /^[A-Za-z0-9_.:-]{1,96}$/.test(value) ? value : undefined;

const providerErrorEnvelope = (body: string): Effect.Effect<Record<string, unknown> | null> =>
  Effect.gen(function* () {
    const parsedEither = yield* Effect.either(
      Effect.try({
        try: () => JSON.parse(body) as unknown,
        catch: () => null,
      }),
    );
    if (parsedEither._tag === "Left") return null;
    const parsed = parsedEither.right;
    if (!isRecord(parsed)) return null;
    const error = parsed.error;
    return isRecord(error) ? error : parsed;
  });

const providerFailureFlags = (
  status: number,
  body: string,
  envelope: Record<string, unknown> | null,
): ReadonlyArray<ProviderFailureFlag> => {
  const flags = new Set<ProviderFailureFlag>();
  const lower = body.toLowerCase();
  const statusToken =
    typeof envelope?.status === "string" ? envelope.status.toLowerCase() : undefined;
  const reasonTokens =
    Array.isArray(envelope?.details) && envelope.details.every(isRecord)
      ? envelope.details
          .map((detail) => (typeof detail.reason === "string" ? detail.reason.toLowerCase() : ""))
          .join(" ")
      : "";
  const typeToken = typeof envelope?.type === "string" ? envelope.type.toLowerCase() : "";
  const codeToken = typeof envelope?.code === "string" ? envelope.code.toLowerCase() : "";
  const haystack = `${lower} ${statusToken ?? ""} ${reasonTokens} ${typeToken} ${codeToken}`;

  if (status === 401 || status === 403) flags.add("auth");
  if (
    haystack.includes("api_key_invalid") ||
    haystack.includes("permission_denied") ||
    haystack.includes("authentication_error")
  ) {
    flags.add("auth");
  }
  if (status === 429 || haystack.includes("rate") || haystack.includes("resource_exhausted")) {
    flags.add("rate_limited");
  }
  if (
    haystack.includes("schema") ||
    haystack.includes("input_schema") ||
    haystack.includes("parameter") ||
    haystack.includes("function") ||
    haystack.includes("tool")
  ) {
    flags.add("schema");
  }
  if (status === 529 || haystack.includes("overloaded")) flags.add("overloaded");
  if (status === 503 || haystack.includes("unavailable")) flags.add("unavailable");
  return Array.from(flags);
};

const providerHttpFailure = (
  provider: HttpProvider,
  response: Response,
): Effect.Effect<ProviderHttpFailure> =>
  Effect.gen(function* () {
    const bodyEither = yield* Effect.either(
      Effect.tryPromise({
        try: () => response.text(),
        catch: () => null,
      }),
    );
    const body = bodyEither._tag === "Right" ? bodyEither.right : "";
    const envelope = yield* providerErrorEnvelope(body);
    const code = sanitizedToken(envelope?.code);
    const type = sanitizedToken(envelope?.type);
    return new ProviderHttpFailure({
      provider,
      status: response.status,
      ...(code === undefined ? {} : { code }),
      ...(type === undefined ? {} : { type }),
      flags: providerFailureFlags(response.status, body, envelope),
    });
  });

const fetchProviderJson = (
  provider: HttpProvider,
  input: RequestInfo | URL,
  init: RequestInit,
): Effect.Effect<unknown, UpstreamFailure> =>
  Effect.gen(function* () {
    const res = yield* Effect.tryPromise({
      try: () => fetch(input, init),
      catch: (cause) => new UpstreamFailure({ cause }),
    });
    if (!res.ok) {
      const failure = yield* providerHttpFailure(provider, res);
      return yield* Effect.fail(new UpstreamFailure({ cause: failure }));
    }
    return yield* Effect.tryPromise({
      try: () => res.json() as Promise<unknown>,
      catch: (cause) => new UpstreamFailure({ cause }),
    });
  });

export const dispatchProvider = (
  route: LlmRoute,
  body: ProviderRequestBody,
): Effect.Effect<
  unknown,
  UpstreamFailure | RefResolutionFailed,
  AiBinding | RefResolverService
> => {
  switch (route.kind) {
    case "cf-ai-binding":
      return Effect.gen(function* () {
        const ai = yield* AiBinding;
        const options =
          route.gatewayRef === undefined ? undefined : { gateway: { id: route.gatewayRef } };
        return yield* Effect.tryPromise({
          try: () =>
            (
              ai as {
                run: (m: string, p: unknown, o?: unknown) => Promise<unknown>;
              }
            ).run(route.modelId, body as ChatCompletionsBody, options),
          catch: (cause) => new UpstreamFailure({ cause }),
        });
      });
    case "openai-chat-compatible":
      return Effect.gen(function* () {
        const refs = yield* RefResolverService;
        const endpoint = yield* resolveStringMaterial(refs, endpointMaterialRef(route.endpointRef));
        const apiKey = yield* resolveStringMaterial(
          refs,
          credentialMaterialRef(route.credentialRef),
        );
        const url = `${endpoint.replace(/\/$/, "")}/chat/completions`;
        const fullBody = {
          model: route.modelId,
          ...(body as ChatCompletionsBody),
        };
        return yield* fetchProviderJson(route.kind, url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(fullBody),
        });
      });
    case "anthropic-messages":
      return Effect.gen(function* () {
        const refs = yield* RefResolverService;
        const endpoint = yield* resolveStringMaterial(refs, endpointMaterialRef(route.endpointRef));
        const apiKey = yield* resolveStringMaterial(
          refs,
          credentialMaterialRef(route.credentialRef),
        );
        const url = `${endpoint.replace(/\/$/, "")}/v1/messages`;
        const fullBody = {
          model: route.modelId,
          ...(body as AnthropicMessagesBody),
        };
        const versionHeader = route.anthropicVersion ?? DEFAULT_ANTHROPIC_VERSION;
        return yield* fetchProviderJson(route.kind, url, {
          method: "POST",
          headers: {
            "x-api-key": apiKey,
            "anthropic-version": versionHeader,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(fullBody),
        });
      });
    case "gemini-generate-content":
      return Effect.gen(function* () {
        const refs = yield* RefResolverService;
        const endpoint = yield* resolveStringMaterial(refs, endpointMaterialRef(route.endpointRef));
        const apiKey = yield* resolveStringMaterial(
          refs,
          credentialMaterialRef(route.credentialRef),
        );
        const url = `${endpoint.replace(/\/$/, "")}/v1beta/models/${route.modelId}:generateContent`;
        return yield* fetchProviderJson(route.kind, url, {
          method: "POST",
          headers: {
            "x-goog-api-key": apiKey,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body as GeminiGenerateContentBody),
        });
      });
  }
};

// ============================================================
//   callLlm — free-text agent turn
// ============================================================
//   Pipeline: adapter.encodeTurn → dispatchProvider → adapter.decodeTurn.
//   Errors from decodeTurn (protocol-level malformedness) are rethrown
//   as UpstreamFailure so submit-agent's existing abort taxonomy applies.
// ============================================================

export const callLlm = (
  request: LlmRequest,
): Effect.Effect<
  LlmResponse,
  UpstreamFailure | RefResolutionFailed,
  AiBinding | RefResolverService
> =>
  Effect.gen(function* () {
    const adapter = getProtocolAdapter(request.route.kind);
    // `getProtocolAdapter` preserves the K binding but TS cannot relate
    // `request.route` to the same K through the runtime kind value, so
    // the encode call needs `as any`-equivalent narrowing — express via
    // a typed local that re-pairs them.
    const body = adapter.encodeTurn(request.route as never, {
      messages: request.messages,
      tools: request.tools,
      tool_choice: request.tool_choice,
    });
    const raw = yield* dispatchProvider(request.route, body);
    return yield* Effect.try({
      try: () => adapter.decodeTurn(raw),
      catch: (cause) => new UpstreamFailure({ cause }),
    });
  });

export const LlmTransportLive: Layer.Layer<LlmTransport, never, AiBinding | RefResolverService> =
  Layer.effect(
    LlmTransport,
    Effect.gen(function* () {
      const ai = yield* AiBinding;
      const refs = yield* RefResolverService;
      return {
        call: (request) =>
          callLlm(request).pipe(
            Effect.provideService(AiBinding, ai),
            Effect.provideService(RefResolverService, refs),
          ),
      };
    }),
  );
