/**
 * @agent-os/core — public barrel.
 *
 * Only public surface is re-exported. Service Tags, Layers, and internal
 * effect/Schema helpers live in sibling modules but are not exposed here,
 * so apps importing `@agent-os/core` cannot bypass AgentDOBase to forge a
 * runtime with arbitrary scope.
 *
 * Internal modules (not re-exported, but visible to each other within the
 * package): errors.ts / types.ts / event-bus.ts / ledger.ts / scheduler.ts /
 * llm.ts / tools.ts / submit-agent.ts.
 *
 * Spec: ../../docs/spec-24-invariants-and-surface.md
 */

// ===== AgentDOBase + env interface =====
export { AgentDOBase, type AgentDOEnv } from "./agent-do";

// ===== Public types =====
export type {
  LedgerEventRpc,
  EventHandler,
  ScheduledEventSpec,
} from "./types";

export type { SubmitSpec, SubmitResult } from "./submit-agent";

export type { Tool } from "./tools";
export type { ToolDefinition } from "./llm";
export { withQuota, type QuotaSpec } from "./quota";

// ===== Abort taxonomy =====
export { ABORT, type AbortKind } from "./errors";

// ===== Tagged errors (apps need these to handle Promise rejection / on()
//        events keyed by abort kinds) =====
export {
  SqlError,
  JsonStringifyError,
  ScopeMissingError,
  InvalidScheduleAt,
  ReservedEventKindError,
  UpstreamFailure,
  ToolError,
} from "./errors";

// ===== Spec-25 structured-output types (apps may inspect lease / outcome
//        via on('llm.structured.evidence') handlers, and may build a
//        JsonSchemaObject to pass as submitSpec.outputSchema). =====
export type {
  LlmRoute,
  Strategy,
  JsonSchemaObject,
  JsonSchemaNode,
  SchemaContract,
  Outcome,
  OutcomeClass,
  CapabilityLease,
  AttemptKey,
  AdmissionImpact,
} from "./admission";
