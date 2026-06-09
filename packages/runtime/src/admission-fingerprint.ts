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
import type { LlmRoute } from "@agent-os/llm-protocol";

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
  const canon = canonicalJsonString(route);
  return `route-json-v1:${canon}`;
};
