/**
 * LLM public barrel.
 *
 * Owns the Cloudflare DO composition point for the shared LlmTransport.
 * Provider protocol projection lives in @agent-os/llm-transport-effect-ai;
 * this barrel only exposes the backend's transport layer and shared LLM types.
 *
 * `ref-resolver.ts` deliberately stays at the src/ root: it's a
 * cross-cutting endpoint+credential lookup, not LLM-specific.
 */

export * from "./llm";
