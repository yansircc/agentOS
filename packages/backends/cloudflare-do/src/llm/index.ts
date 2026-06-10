/**
 * LLM public barrel.
 *
 * Re-exports provider-neutral LlmTransport types and the fail-closed backend
 * service used when no explicit provider binding is configured.
 *
 * `ref-resolver.ts` deliberately stays at the src/ root: it's a
 * cross-cutting endpoint+credential lookup, not LLM-specific.
 */

export * from "./llm";
