/**
 * @agent-os/image — image protocol algebra.
 *
 * This package owns image provider route encoding/decoding and image-specific
 * pure helpers. It does not own ledger writes, resource ledgers, blob storage,
 * R2 key policy, retention, public URLs, or provider fallback.
 */

export type {
  CfAiBindingImageRoute,
  GenerateImageSpec,
  ImageArtifact,
  ImageOutcome,
  ImageProtocolAdapter,
  ImageProtocolAdapterRegistry,
  ImageRequest,
  ImageResult,
  ImageRoute,
  OpenAIChatCompatibleImageRoute,
} from "./types";
export * from "./services";
export * from "./adapters/openai-chat-compatible";
export * from "./adapters/cf-ai-binding";
export { generateImageEffect } from "./provider";
export * from "./extension";
export * from "./events";
export * from "./idempotency";
export * from "./settlement";
