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
    if (inner !== null && inner !== undefined) return String(inner);
  }
  return error instanceof Error ? error.message : String(error);
};

export const parseHttpStatus = (msg: string): number | undefined => {
  const m = /HTTP\s+(\d{3})\b/.exec(msg);
  return m ? Number(m[1]) : undefined;
};

/** Decode Server-Sent Events into non-empty `data:` payloads.
 *
 * OpenAI Chat Completions, Anthropic Messages, and Gemini
 * streamGenerateContent all use SSE framing but differ in the JSON
 * payload. Keep frame splitting here so each wire adapter owns only
 * its protocol JSON algebra.
 */
export async function* decodeSseData(
  stream: ReadableStream<Uint8Array>,
): AsyncIterable<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const read = await reader.read();
      if (read.done) break;
      buffer += decoder
        .decode(read.value, { stream: true })
        .replace(/\r\n/g, "\n");
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const raw = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = raw
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (data.length > 0) yield data;
        boundary = buffer.indexOf("\n\n");
      }
    }
    const tail = buffer.trim();
    if (tail.length > 0) {
      const data = tail
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (data.length > 0) yield data;
    }
  } finally {
    reader.releaseLock();
  }
}

// Re-export Outcome (sourced from admission/lease.ts — leaf, no cycle)
// so wire files can name it without a second import statement.
export type { Outcome };
