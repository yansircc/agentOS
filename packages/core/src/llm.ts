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

const callViaCfAiBinding = (
  route: CfAiBindingRoute,
  request: LlmRequest,
): Effect.Effect<LlmResponse, UpstreamFailure, AiBinding> =>
  Effect.gen(function* () {
    const ai = yield* AiBinding;
    const raw = yield* Effect.tryPromise({
      try: () =>
        (ai as { run: (m: string, p: unknown) => Promise<unknown> }).run(
          route.modelId,
          {
            messages: request.messages,
            tools: request.tools,
            tool_choice: request.tool_choice,
          },
        ),
      catch: (cause) => new UpstreamFailure({ cause }),
    });
    return yield* decodeResponse(raw);
  });

const callViaOpenAIChatCompatible = (
  route: OpenAIChatCompatibleRoute,
  request: LlmRequest,
): Effect.Effect<
  LlmResponse,
  UpstreamFailure | EndpointNotFound | CredentialNotFound,
  ProviderRegistry
> =>
  Effect.gen(function* () {
    const registry = yield* ProviderRegistry;
    const endpoint = yield* registry.resolveEndpoint(route.endpointRef);
    const apiKey = yield* registry.resolveCredential(route.credentialRef);

    const url = `${endpoint.replace(/\/$/, "")}/chat/completions`;
    const body = {
      model: route.modelId,
      messages: request.messages,
      tools: request.tools,
      tool_choice: request.tool_choice,
    };

    const raw = yield* Effect.tryPromise({
      try: async () => {
        const res = await fetch(url, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
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
    return yield* decodeResponse(raw);
  });

export const callLlm = (
  request: LlmRequest,
): Effect.Effect<
  LlmResponse,
  UpstreamFailure | EndpointNotFound | CredentialNotFound,
  AiBinding | ProviderRegistry
> => {
  switch (request.route.kind) {
    case "cf-ai-binding":
      return callViaCfAiBinding(request.route, request);
    case "openai-chat-compatible":
      return callViaOpenAIChatCompatible(request.route, request);
  }
};
