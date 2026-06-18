/**
 * Canonical route/schema fingerprint algebra (contract §4.1).
 *
 * Schema fingerprints are owned by AgentSchema. Runtime only packages an
 * AgentSchema into the admission contract. LLM route/wire fingerprints are
 * owned by @agent-os/llm-protocol after provider resolution.
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

export const FINGERPRINT_ALGO_VERSION = AGENT_SCHEMA_FINGERPRINT_VERSION;

/** Build an AgentSchemaSpec from an AgentSchema source. */
export const makeAdmissionSchemaSpec = <A>(
  schema: AgentSchemaSource<A>,
): Effect.Effect<AgentSchemaSpec<A>> =>
  makeAgentSchemaSpec(isAgentSchema(schema) ? schema : ensureAgentSchema(schema));
