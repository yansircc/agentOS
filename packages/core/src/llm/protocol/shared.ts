/**
 * Cross-wire helpers shared by all `LlmProtocolAdapter<K>` implementations.
 *
 * Leaf module: must not import from `./protocol-adapter` or any wire file.
 * Holds the version + forced-tool-name constants and the two pure error
 * helpers so that wire files can read them at module-init time without
 * entering a cycle with the registry built in `./protocol-adapter`.
 *
 * `validateAgainstSchema` lives next to the JSON Schema type union in
 * `../admission/json-schema` (which is itself a leaf — no admission
 * sibling imports). Wire files reach it directly via that path; reaching
 * through the admission barrel would walk back into protocol/ and trip
 * the registry cycle.
 */

import type { Outcome } from "../../admission/lease";

/** Single coherence dial for an adapter's complete behavior. Bumping the
 *  major invalidates structured-output lease evidence (spec-25 §9). Any
 *  observable change to encode/decode/classify on EITHER half (turn or
 *  structured) requires a major bump (spec-27 §5). */
export const ADAPTER_VERSION = "1.0.0";

/** Synthesized tool name used by every structured-output adapter to force
 *  the model into emitting a single tool call whose arguments ARE the
 *  result. Identical across wires by design — the substrate uses one
 *  symbolic name so admission.ts can fold all three protocols through a
 *  single decode invariant. */
export const CHAT_COMPLETIONS_FORCED_TOOL_NAME = "_submit_structured";

const renderUnknown = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (typeof value === "symbol") return value.description ?? "symbol";
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  try {
    return JSON.stringify(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
};

/** Unwrap a tagged-error / wrapped error one level to surface the real
 *  upstream Error message. `dispatchProvider` always wraps fetch failures
 *  as `UpstreamFailure{cause: Error("HTTP N ...")}`; without this unwrap
 *  classify would see only the tag name ("UpstreamFailure") and route
 *  everything to the default ProviderRejected branch. */
export const unwrapErrorMessage = (error: unknown): string => {
  if (error !== null && typeof error === "object" && "cause" in error) {
    const inner = (error as { cause: unknown }).cause;
    if (inner instanceof Error) return inner.message;
    if (typeof inner === "string") return inner;
    if (inner !== null && inner !== undefined) return renderUnknown(inner);
  }
  return error instanceof Error ? error.message : renderUnknown(error);
};

export const parseHttpStatus = (msg: string): number | undefined => {
  const m = /HTTP\s+(\d{3})\b/.exec(msg);
  return m ? Number(m[1]) : undefined;
};

// Re-export Outcome (sourced from admission/lease.ts — leaf, no cycle)
// so wire files can name it without a second import statement.
export type { Outcome };
