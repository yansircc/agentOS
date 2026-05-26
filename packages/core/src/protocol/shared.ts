/**
 * Cross-wire helpers shared by all `LlmProtocolAdapter<K>` implementations.
 *
 * Leaf module: must not import from `./protocol-adapter` or any wire file.
 * Holds the version + forced-tool-name constants and the three pure helpers
 * (`validateAgainstSchema`, `unwrapErrorMessage`, `parseHttpStatus`) so that
 * wire files can read them at module-init time without entering a cycle
 * with the registry built in `./protocol-adapter`.
 */

import type { Outcome, JsonSchemaNode } from "../admission";

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

/** Local JSON Schema validator. Closed-dialect subset matching the
 *  `JsonSchemaNode` union: object (with required/additionalProperties),
 *  array (with items), string (with enum), number, boolean. Used by every
 *  wire adapter's `decodeStructured` to enforce the schema after the
 *  model's tool-call arguments parse. Adapters apply wire-specific
 *  stripping when ENCODING (e.g. Gemini strips `additionalProperties`),
 *  but DECODING validates the FULL schema locally so apps still get the
 *  contract they declared. */
export const validateAgainstSchema = (
  value: unknown,
  schema: JsonSchemaNode,
): string[] => {
  const violations: string[] = [];
  const walk = (v: unknown, s: JsonSchemaNode, path: string): void => {
    if (s.type === "object") {
      if (typeof v !== "object" || v === null || Array.isArray(v)) {
        violations.push(`${path}:not-object`);
        return;
      }
      const obj = v as Record<string, unknown>;
      for (const req of s.required ?? []) {
        if (!(req in obj)) violations.push(`${path}.${req}:missing`);
      }
      if (s.additionalProperties === false) {
        for (const k of Object.keys(obj)) {
          if (!(k in s.properties)) {
            violations.push(`${path}.${k}:unknown-property`);
          }
        }
      }
      for (const [k, sub] of Object.entries(s.properties)) {
        if (k in obj) walk(obj[k], sub, `${path}.${k}`);
      }
    } else if (s.type === "array") {
      if (!Array.isArray(v)) {
        violations.push(`${path}:not-array`);
        return;
      }
      v.forEach((item, i) => walk(item, s.items, `${path}[${i}]`));
    } else if (s.type === "string") {
      if (typeof v !== "string") violations.push(`${path}:not-string`);
      else if (s.enum && !s.enum.includes(v))
        violations.push(`${path}:not-in-enum`);
    } else if (s.type === "number") {
      if (typeof v !== "number") violations.push(`${path}:not-number`);
    } else if (s.type === "boolean") {
      if (typeof v !== "boolean") violations.push(`${path}:not-boolean`);
    }
  };
  walk(value, schema, "$");
  return violations;
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
    if (inner !== null && inner !== undefined) return String(inner);
  }
  return error instanceof Error ? error.message : String(error);
};

export const parseHttpStatus = (msg: string): number | undefined => {
  const m = /HTTP\s+(\d{3})\b/.exec(msg);
  return m ? Number(m[1]) : undefined;
};

// Re-export the Outcome type so wire files do not double-import it from
// admission.ts when constructing classify() return values.
export type { Outcome };
