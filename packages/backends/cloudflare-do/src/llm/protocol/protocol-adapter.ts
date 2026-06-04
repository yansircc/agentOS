/**
 * @agent-os/backend-cloudflare-do protocol adapter algebra — interface + registry only.
 *
 *
 * Cross-wire helpers live in `./shared` (validateAgainstSchema,
 * unwrapErrorMessage, parseHttpStatus, ADAPTER_VERSION,
 * CHAT_COMPLETIONS_FORCED_TOOL_NAME). Per-wire implementations live in
 * `./openai-chat`, `./anthropic-messages`, `./gemini-generate-content`.
 *
 * This module:
 *   - declares the per-wire `LlmProtocolAdapter<K>` algebra and shared
 *     turn / structured ADTs (TurnRequest / TurnResponse /
 *     AdapterStimulus / DecodedOutput / DecodeStructuredResult)
 *   - re-exports ADAPTER_VERSION for callers that historically imported it
 *     from the protocol module
 *   - holds the per-kind registry and the type-narrowed
 *     `getProtocolAdapter` lookup
 *
 * Cycle invariant: this module is the only one in `protocol/` that
 * imports the three wire-adapter object values. Each wire file imports
 * its TYPES from here (`import type` only) and its VALUES from `./shared`
 * (a leaf). That keeps the wire adapters' object literals out of the
 * cyclic init path between this file and `./openai-chat` etc.
 *
 * State ownership: nothing. Pure (modulo adapter object literals built
 * at module init). All IO is in `dispatchProvider` (llm.ts).
 */

import type { LlmRoute, LlmUsage, ProviderRequestBodyFor, LlmToolCall, LlmMessage } from "../llm";
import type { LiveInput, Outcome, ProbeInput, SchemaContract, Strategy } from "../../admission";

import { cfAiBindingAdapter, openaiChatCompatibleAdapter } from "./openai-chat";
import { anthropicMessagesAdapter } from "./anthropic-messages";
import { geminiGenerateContentAdapter } from "./gemini-generate-content";

export { ADAPTER_VERSION } from "./shared";

// ============================================================
// Section B — Turn vs Structured ADTs
// ============================================================

/** Input to encodeTurn. Same shape as the free-text portion of LlmRequest
 *  in llm.ts (LlmRequest = TurnRequest & { route }). Caller fills in
 *  messages / optional tools / optional forced tool_choice. */
export interface TurnRequest {
  readonly messages: ReadonlyArray<LlmMessage>;
  readonly tools?: ReadonlyArray<import("../llm").ToolDefinition>;
  readonly tool_choice?: {
    readonly type: "function";
    readonly function: { readonly name: string };
  };
}

/** Output of decodeTurn. Unified across protocols — submit-agent.ts's
 *  tool-loop logic stays protocol-agnostic. Each adapter is responsible
 *  for folding native blocks (Chat Completions `tool_calls[]`,
 *  Anthropic `content[].tool_use`, Gemini `parts[].functionCall`) into
 *  this shape. */
export interface TurnResponse {
  readonly text: string;
  readonly toolCalls: ReadonlyArray<LlmToolCall>;
  readonly usage: LlmUsage;
}

/** Stimulus shape passed to encodeStructured. Variant `live` carries the
 *  user text only — the deliver function lives on `attemptStructured`'s
 *  spec, not the adapter (the adapter does not write to the ledger). */
export type AdapterStimulus =
  | { readonly kind: "probe"; readonly synthetic: ProbeInput }
  | { readonly kind: "live"; readonly userInput: LiveInput };

export type DecodedOutput = Record<string, unknown>;

export type DecodeStructuredResult =
  | {
      readonly ok: true;
      readonly decoded: DecodedOutput;
      /** Per-call token usage. Surfaced by the adapter so admission.ts
       *  does NOT parse usage out of the raw upstream response (whose
       *  shape varies per wire — OpenAI: `usage.total_tokens`, Anthropic:
       *  `usage.{input_tokens,output_tokens}`, Gemini:
       *  `usageMetadata.totalTokenCount`). The adapter is the only entity
       *  that knows the protocol's usage shape. */
      readonly tokensUsed: number;
    }
  | { readonly ok: false; readonly outcome: Outcome };

// ============================================================
// Section C — LlmProtocolAdapter<K> interface
// ============================================================

/** The per-wire protocol algebra. One per `LlmRoute["kind"]`. Pure
 *  functions only — no IO, no clock, no secrets. Transport lives in
 *  `dispatchProvider` (llm.ts); secrets are resolved there from
 *  `RefResolver`. The adapter never sees credential values.
 *
 *  Asymmetry (contract §4):
 *    - `decodeTurn` is permissive: zero tool calls in the response is
 *      valid (assistant chose a text-only answer).
 *    - `decodeStructured` is strict: exactly one matching forced tool call
 *      MUST be present; anything else returns `{ok:false, outcome:
 *      BehaviorFailed}`.
 *
 *  Shared:
 *    - `classify` maps transport / HTTP / protocol errors into the closed
 *      `FailureClass` set. **v0 runtime scope (contract §3.0.1):** the
 *      only consumer is `attemptStructured` (structured path). `callLlm`
 *      does NOT invoke classify — dispatch errors propagate as raw
 *      `UpstreamFailure` to submit-agent's abort taxonomy. The function
 *      lives on the adapter so future adapters / a typed-turn-failure
 *      design (§11 OQ 6) can consume it without an interface change.
 *    - `version` governs both halves; any change to wire behavior on
 *      either half requires a major bump.
 */
export interface LlmProtocolAdapter<K extends LlmRoute["kind"]> {
  readonly kind: K;
  readonly version: string;

  // ── Free-text turn ────────────────────────────────────────
  encodeTurn(
    route: Extract<LlmRoute, { kind: K }>,
    request: TurnRequest,
  ): ProviderRequestBodyFor<K>;

  decodeTurn(raw: unknown): TurnResponse;

  // ── Structured-output admission ───────────────────────────
  encodeStructured(
    route: Extract<LlmRoute, { kind: K }>,
    schema: SchemaContract,
    stimulus: AdapterStimulus,
    strategy: Strategy,
  ): ProviderRequestBodyFor<K>;

  decodeStructured(
    response: { readonly raw: unknown },
    schema: SchemaContract,
    strategy: Strategy,
  ): DecodeStructuredResult;

  // ── Shared error classification ───────────────────────────
  classify(error: unknown): Outcome;
}

// ============================================================
// Section F — Registry
// ============================================================

/** Per-kind adapter map. Mapped type so each entry is statically typed to
 *  the matching `LlmProtocolAdapter<K>`. Use `getProtocolAdapter` for
 *  type-narrowed lookup at runtime. */
export type LlmProtocolAdapterRegistry = {
  readonly [K in LlmRoute["kind"]]: LlmProtocolAdapter<K>;
};

export const llmProtocolAdapters: LlmProtocolAdapterRegistry = {
  "cf-ai-binding": cfAiBindingAdapter,
  "openai-chat-compatible": openaiChatCompatibleAdapter,
  "anthropic-messages": anthropicMessagesAdapter,
  "gemini-generate-content": geminiGenerateContentAdapter,
};

/** Type-narrowed adapter lookup. TS cannot directly narrow
 *  `registry[route.kind]` because the indexed access loses the binding
 *  between `kind` and the adapter's `K`. This helper re-establishes it. */
export const getProtocolAdapter = <K extends LlmRoute["kind"]>(kind: K): LlmProtocolAdapter<K> =>
  llmProtocolAdapters[kind];
