/**
 * Canonical route/schema fingerprint algebra (contract §4.1).
 *
 * Schema fingerprints are owned by AgentSchema. Runtime only packages an
 * AgentSchema into the admission contract and keeps route normalization here.
 */

import { Effect } from "effect";
import {
  AGENT_SCHEMA_FINGERPRINT_VERSION,
  ensureAgentSchema,
  isAgentSchema,
  makeAgentSchemaSpec,
  type AgentSchemaSource,
  type AgentSchemaSpec,
} from "@agent-os/kernel/agent-schema";
import { DEFAULTS as LLM_DEFAULTS, type LlmRoute } from "@agent-os/kernel/llm";

export const FINGERPRINT_ALGO_VERSION = AGENT_SCHEMA_FINGERPRINT_VERSION;

const canonicalize = (node: unknown): unknown => {
  if (node === null || typeof node !== "object") return node;
  if (Array.isArray(node)) {
    return node.map((item) => canonicalize(item));
  }
  const obj = node as Record<string, unknown>;
  const sortedKeys = Object.keys(obj).sort();
  const out: Record<string, unknown> = {};
  for (const k of sortedKeys) out[k] = canonicalize(obj[k]);
  return out;
};

const canonicalJsonString = (node: unknown): string => JSON.stringify(canonicalize(node));

/** Build an AgentSchemaSpec from an AgentSchema source. */
export const makeAdmissionSchemaSpec = <A, I>(
  schema: AgentSchemaSource<A, I>,
): Effect.Effect<AgentSchemaSpec<A>> =>
  makeAgentSchemaSpec(isAgentSchema(schema) ? schema : ensureAgentSchema(schema));

/** Per-kind route normalizer applied BEFORE canonical JSON. Fills in
 *  the substrate's current defaults so the fingerprint reflects the
 *  effective wire surface, not just the literal route object.
 *
 *  Why this matters (contract §7): a route field like `anthropicVersion`
 *  that has a transport-time default must enter the fingerprint via its
 *  effective value. Otherwise unpinned routes get a fingerprint that
 *  doesn't change when the substrate later bumps its default — and old
 *  lease evidence would silently project forward onto a different wire
 *  surface (different feature set, different error semantics). That
 *  violates contract's "capability evidence is keyed by the actual wire"
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
        anthropicVersion: route.anthropicVersion ?? LLM_DEFAULTS.anthropicVersion,
      };
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
  const canon = canonicalJsonString(normalizeRouteForFingerprint(route) as unknown);
  return `route-json-v1:${canon}`;
};
