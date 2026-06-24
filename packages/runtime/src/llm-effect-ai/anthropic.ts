import { AnthropicClient, make as makeAnthropicClient } from "@effect/ai-anthropic/AnthropicClient";
import { make as makeAnthropicLanguageModel } from "@effect/ai-anthropic/AnthropicLanguageModel";
import { Effect, Layer } from "effect";
import * as Redacted from "effect/Redacted";
import type * as Scope from "effect/Scope";
import { FetchHttpClient } from "effect/unstable/http";
import type { HttpClient as HttpClientService } from "effect/unstable/http/HttpClient";
import { LlmTransport } from "@agent-os/core/llm-protocol";
import type { RefResolverService } from "@agent-os/core/ref-resolver";
import { type EffectAiLanguageModelFactory, makeEffectAiLlmTransportLayer } from "./index";

const ANTHROPIC_DEFAULT_VERSION = "2023-06-01";

/**
 * Anthropic provider factory for the provider-neutral Effect AI transport.
 *
 * @public
 */
export const defaultEffectAiLanguageModelFactory: EffectAiLanguageModelFactory<
  HttpClientService | Scope.Scope
> = (input) =>
  Effect.withSpan("agentos.llm_transport.effect_ai.anthropic_model_factory")(
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

/**
 * Anthropic-backed Effect AI transport layer. Importing this subpath is the
 * explicit package boundary that requires `@effect/ai-anthropic`.
 *
 * @public
 */
export const makeAnthropicEffectAiLlmTransportLayer = (): Layer.Layer<
  LlmTransport,
  never,
  RefResolverService | HttpClientService | Scope.Scope
> => makeEffectAiLlmTransportLayer(defaultEffectAiLanguageModelFactory);

/**
 * Fetch-runtime Anthropic Effect AI transport layer.
 *
 * @public
 */
export const AnthropicEffectAiLlmTransportLive: Layer.Layer<
  LlmTransport,
  never,
  RefResolverService | Scope.Scope
> = makeAnthropicEffectAiLlmTransportLayer().pipe(Layer.provide(FetchHttpClient.layer));
