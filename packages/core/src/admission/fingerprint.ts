/**
 * Canonical fingerprint algebra (spec-25 §4.1).
 *
 * Two pure functions: `makeSchemaContract` for `(schema → SchemaContract)`
 * and `routeFingerprint` for `(LlmRoute → string)`. Both reach for the
 * same canonical-JSON serializer so equivalent inputs hash to the same
 * fingerprint across implementations.
 *
 * Rules (in order):
 *   a. sort object keys recursively
 *   c'. sort set-semantics arrays (`required`, `enum`) — discovered
 *       during admission validation; see spec-25 §4.1
 *   d. strip non-semantic annotations (title, description, examples,
 *      $comment, x-*)
 *
 * Algorithm version is embedded in the fingerprint prefix so a future
 * canonicalization change auto-invalidates old leases by construction
 * (no migration needed).
 */

import { Effect } from "effect";
import { type JsonSchemaObject, type SchemaContract } from "./json-schema";
import { DEFAULTS as LLM_DEFAULTS, type LlmRoute } from "../llm";

export const FINGERPRINT_ALGO_VERSION = "effect-json-schema-v1";

const SET_SEMANTICS_ARRAYS = new Set(["required", "enum"]);
const STRIP_KEYS = new Set(["title", "description", "examples", "$comment"]);

const canonicalize = (node: unknown, parentKey?: string): unknown => {
  if (node === null || typeof node !== "object") return node;
  if (Array.isArray(node)) {
    const mapped = node.map((item) => canonicalize(item));
    if (parentKey !== undefined && SET_SEMANTICS_ARRAYS.has(parentKey)) {
      return [...mapped].sort((a, b) => {
        const sa = typeof a === "string" ? a : JSON.stringify(a);
        const sb = typeof b === "string" ? b : JSON.stringify(b);
        return sa < sb ? -1 : sa > sb ? 1 : 0;
      });
    }
    return mapped;
  }
  const obj = node as Record<string, unknown>;
  const sortedKeys = Object.keys(obj)
    .filter((k) => !STRIP_KEYS.has(k) && !k.startsWith("x-"))
    .sort();
  const out: Record<string, unknown> = {};
  for (const k of sortedKeys) out[k] = canonicalize(obj[k], k);
  return out;
};

const canonicalJsonString = (node: unknown): string =>
  JSON.stringify(canonicalize(node));

const sha256Hex = async (input: string): Promise<string> => {
  const bytes = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
};

/** Build a SchemaContract from a JSON Schema object.
 *
 *  Deterministic across implementations: same canonicalization rules yield
 *  byte-equal canonical JSON, then SHA-256, then identical fingerprint string.
 *  Algorithm version is embedded in the fingerprint prefix so future
 *  canonicalization changes auto-invalidate old leases. */
export const makeSchemaContract = (
  schema: JsonSchemaObject,
): Effect.Effect<SchemaContract> =>
  Effect.gen(function* () {
    const canon = canonicalJsonString(schema);
    const hex = yield* Effect.promise(() => sha256Hex(canon));
    return {
      schema,
      fingerprint: `${FINGERPRINT_ALGO_VERSION}:sha256:${hex}`,
    };
  });

/** Per-kind route normalizer applied BEFORE canonical JSON. Fills in
 *  the substrate's current defaults so the fingerprint reflects the
 *  effective wire surface, not just the literal route object.
 *
 *  Why this matters (spec-27 §7): a route field like `anthropicVersion`
 *  that has a transport-time default must enter the fingerprint via its
 *  effective value. Otherwise unpinned routes get a fingerprint that
 *  doesn't change when the substrate later bumps its default — and old
 *  lease evidence would silently project forward onto a different wire
 *  surface (different feature set, different error semantics). That
 *  violates spec-25's "capability evidence is keyed by the actual wire"
 *  rule.
 *
 *  Pinned values are unchanged; only `undefined` fields get filled.
 *  Bumping `LLM_DEFAULTS.anthropicVersion` in code → unpinned-route
 *  fingerprints change → existing leases no longer match → routes
 *  re-admit against the new wire by construction.
 */
const normalizeRouteForFingerprint = (route: LlmRoute): LlmRoute => {
  switch (route.kind) {
    case "anthropic-messages":
      return {
        ...route,
        anthropicVersion:
          route.anthropicVersion ?? LLM_DEFAULTS.anthropicVersion,
      };
    case "cf-ai-binding":
    case "openai-chat-compatible":
    case "gemini-generate-content":
      return route;
  }
};

/** Route key is the canonical JSON of the route, prefixed with an algorithm
 *  version tag. We deliberately do NOT hash it.
 *
 *  Earlier this used a 32-bit FNV-1a hash — a real collision was caught
 *  (`@cf/3hwlz7pq9l` and `@cf/x3qxkshczh` both mapping to `fnv1a:b307092e`),
 *  which would alias an unsupported lease for one model onto another model.
 *  The hash space is large in absolute terms but the SSoT key cannot be a
 *  probabilistic identity. Canonical JSON is deterministic, collision-free
 *  by construction, and only ~80 chars in practice. The `route-json-v1:`
 *  prefix lets a future canonicalization change auto-invalidate stored
 *  keys without an adapter version bump. */
export const routeFingerprint = (route: LlmRoute): string => {
  const canon = canonicalJsonString(
    normalizeRouteForFingerprint(route) as unknown,
  );
  return `route-json-v1:${canon}`;
};
