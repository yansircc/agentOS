/**
 * LLM carrier — module-private.
 *
 * `callLlm` dispatches on `LlmRoute.kind`:
 *
 *   - `cf-ai-binding`         → env.AI.run via the AiBinding service Tag
 *   - `openai-chat-compatible` → fetch the route's endpoint with Bearer
 *                                auth resolved via ProviderRegistry
 *
 * Both adapters decode the same `LlmResponseSchema` (OpenAI Chat
 * Completions shape). Workers-AI-native shape models (Llama, etc.)
 * cannot use either adapter today; a third adapter for that shape is
 * a separate spec-25 follow-up if and when an app needs it.
 *
 * Why the indirection (vs. the previous `agent: {provider, model}`
 * shape): see spec-24 INV-8 revision and spec-25 §3. Capability is
 * evidence on `(route, schemaContract, strategy, adapterVersion)`, not
 * a model-id property. The route taxonomy is what makes admission's
 * fingerprint stable across credential rotation.
 */

import { Context, Effect, Schema } from "effect";
import { UpstreamFailure } from "./errors";
import {
  CredentialNotFound,
  EndpointNotFound,
  ProviderRegistry,
} from "./provider-registry";

export class AiBinding extends Context.Tag("@agent-os/AiBinding")<
  AiBinding,
  Ai
>() {}

// ============================================================
//   LlmRoute — tagged union of transport protocols (spec-25 §3)
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

export type LlmRoute = CfAiBindingRoute | OpenAIChatCompatibleRoute;

// ============================================================
//   Response schemas (Chat Completions shape — shared by both adapters)
// ============================================================

const LlmToolCallSchema = Schema.Struct({
  id: Schema.String,
  type: Schema.Literal("function"),
  function: Schema.Struct({
    name: Schema.String,
    arguments: Schema.String,
  }),
});

const LlmMessageOutputSchema = Schema.Struct({
  content: Schema.NullishOr(Schema.String),
  tool_calls: Schema.optional(Schema.Array(LlmToolCallSchema)),
});

const LlmChoiceSchema = Schema.Struct({
  message: LlmMessageOutputSchema,
});

const LlmUsageSchema = Schema.Struct({
  prompt_tokens: Schema.optional(Schema.Number),
  completion_tokens: Schema.optional(Schema.Number),
  total_tokens: Schema.optional(Schema.Number),
});

const LlmResponseSchema = Schema.Struct({
  choices: Schema.Array(LlmChoiceSchema),
  usage: Schema.optional(LlmUsageSchema),
});

export type LlmToolCall = Schema.Schema.Type<typeof LlmToolCallSchema>;

export interface LlmMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string | null;
  readonly tool_calls?: ReadonlyArray<LlmToolCall>;
  readonly tool_call_id?: string;
}

export interface LlmResponse {
  readonly text: string;
  readonly toolCalls: ReadonlyArray<LlmToolCall>;
  readonly usage: {
    readonly promptTokens: number;
    readonly completionTokens: number;
    readonly totalTokens: number;
  };
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
  /** Forces the model to call the named function (OpenAI / Workers AI
   *  forced-tool-call). Used by admission's structured-output strategy
   *  (spec-25 §6). Free-text agent loops leave this undefined. */
  readonly tool_choice?: {
    readonly type: "function";
    readonly function: { readonly name: string };
  };
}

// ============================================================
//   Adapter dispatch
// ============================================================
//   Transport — raw provider IO, returned WITHOUT decoding.
//
//   `dispatchProvider` is the single transport seam: encode-shape goes in,
//   raw upstream response comes out. Both `callLlm` (free-text agent loop,
//   wraps in LlmResponseSchema decode) AND admission's `attemptStructured`
//   (does its own adapter decode against tool_call args) consume it.
//
//   Sharing this is load-bearing: it guarantees a route always uses the
//   transport its routeFingerprint claims, so capability evidence in
//   `llm.structured.evidence` cannot lie about which endpoint actually
//   served the request.
// ============================================================

/** Adapter-shape request body: encode-side picks `messages` / `tools` /
 *  `tool_choice`. The route variant decides where the body goes (env.AI.run
 *  vs fetch). `modelId` is on `route`, not on the body — the dispatcher
 *  inserts it where the protocol requires. */
export interface ProviderRequestBody {
  readonly messages: ReadonlyArray<LlmMessage>;
  readonly tools?: ReadonlyArray<ToolDefinition>;
  readonly tool_choice?: LlmRequest["tool_choice"];
  readonly max_tokens?: number;
}

export const dispatchProvider = (
  route: LlmRoute,
  body: ProviderRequestBody,
): Effect.Effect<
  unknown,
  UpstreamFailure | EndpointNotFound | CredentialNotFound,
  AiBinding | ProviderRegistry
> => {
  switch (route.kind) {
    case "cf-ai-binding":
      return Effect.gen(function* () {
        const ai = yield* AiBinding;
        return yield* Effect.tryPromise({
          try: () =>
            (ai as { run: (m: string, p: unknown) => Promise<unknown> }).run(
              route.modelId,
              body,
            ),
          catch: (cause) => new UpstreamFailure({ cause }),
        });
      });
    case "openai-chat-compatible":
      return Effect.gen(function* () {
        const registry = yield* ProviderRegistry;
        const endpoint = yield* registry.resolveEndpoint(route.endpointRef);
        const apiKey = yield* registry.resolveCredential(route.credentialRef);
        const url = `${endpoint.replace(/\/$/, "")}/chat/completions`;
        const fullBody = { model: route.modelId, ...body };
        return yield* Effect.tryPromise({
          try: async () => {
            const res = await fetch(url, {
              method: "POST",
              headers: {
                "Authorization": `Bearer ${apiKey}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify(fullBody),
            });
            if (!res.ok) {
              const text = await res.text().catch(() => "");
              throw new Error(
                `HTTP ${res.status} ${res.statusText}: ${text.slice(0, 500)}`,
              );
            }
            return (await res.json()) as unknown;
          },
          catch: (cause) => new UpstreamFailure({ cause }),
        });
      });
  }
};

// ============================================================
//   callLlm — free-text path. Dispatches transport via dispatchProvider,
//   decodes through LlmResponseSchema.
// ============================================================

const decodeResponse = (
  raw: unknown,
): Effect.Effect<LlmResponse, UpstreamFailure> =>
  Effect.gen(function* () {
    const decoded = yield* Schema.decodeUnknown(LlmResponseSchema)(raw).pipe(
      Effect.mapError(
        (parseError) => new UpstreamFailure({ cause: parseError }),
      ),
    );
    const firstChoice = decoded.choices[0];
    if (firstChoice === undefined) {
      return yield* new UpstreamFailure({
        cause: "empty choices array in upstream response",
      });
    }
    const text = firstChoice.message.content ?? "";
    const toolCalls = firstChoice.message.tool_calls ?? [];
    const usage = {
      promptTokens: decoded.usage?.prompt_tokens ?? 0,
      completionTokens: decoded.usage?.completion_tokens ?? 0,
      totalTokens: decoded.usage?.total_tokens ?? 0,
    };
    return { text, toolCalls, usage } satisfies LlmResponse;
  });

export const callLlm = (
  request: LlmRequest,
): Effect.Effect<
  LlmResponse,
  UpstreamFailure | EndpointNotFound | CredentialNotFound,
  AiBinding | ProviderRegistry
> =>
  Effect.gen(function* () {
    const raw = yield* dispatchProvider(request.route, {
      messages: request.messages,
      tools: request.tools,
      tool_choice: request.tool_choice,
    });
    return yield* decodeResponse(raw);
  });
