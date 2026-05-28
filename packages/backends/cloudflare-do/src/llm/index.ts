/**
 * LLM public barrel.
 *
 * Replaces the former root-level `packages/backends/cloudflare-do/src/llm.ts` plus the
 * top-level `protocol/` subtree. Dir-as-module means all existing
 * imports `from "./llm"` / `from "../src/llm"` resolve here.
 *
 *   llm.ts                Transport seam — callLlm + dispatchProvider +
 *                         route/body/message types (LlmRoute,
 *                         ChatCompletionsBody, etc.)
 *   protocol/             Per-wire LlmProtocolAdapter implementations +
 *                         registry. Both the structured-output path
 *                         (admission) and the free-text turn path
 *                         (callLlm) consume the same adapter per route.
 *
 * `ref-resolver.ts` deliberately stays at the src/ root: it's a
 * cross-cutting endpoint+credential lookup, not LLM-specific — image
 * and any future external-provider services consume the same surface.
 */

export * from "./llm";
