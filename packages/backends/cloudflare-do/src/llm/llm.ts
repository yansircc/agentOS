/**
 * Cloudflare LLM transport layer.
 *
 * Provider protocol projection is owned by @agent-os/llm-transport-effect-ai.
 * Cloudflare DO only composes the transport with the DO ref resolver and a
 * fetch-backed Effect Platform HTTP client.
 */

import { layer as FetchHttpClientLive } from "@effect/platform/FetchHttpClient";
import { Layer } from "effect";
import {
  defaultEffectAiLanguageModelFactory,
  makeEffectAiLlmTransportLayer,
} from "@agent-os/llm-transport-effect-ai";
import { LlmTransport } from "@agent-os/runtime";
import { RefResolverService } from "@agent-os/kernel/ref-resolver";

export type {
  LlmMessage,
  LlmOutputItem,
  LlmRequest,
  LlmResponse,
  LlmRoute,
  LlmToolCall,
  LlmUsage,
  ToolDefinition,
} from "@agent-os/kernel/llm";
export {
  DEFAULTS,
  llmOutputItemsFromTextAndToolCalls,
  textFromLlmOutputItems,
  toolCallsFromLlmOutputItems,
} from "@agent-os/kernel/llm";

export const LlmTransportLive: Layer.Layer<LlmTransport, never, RefResolverService> =
  makeEffectAiLlmTransportLayer(defaultEffectAiLanguageModelFactory).pipe(
    Layer.provide(Layer.mergeAll(FetchHttpClientLive, Layer.scope)),
  );
