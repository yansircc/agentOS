/**
 * Tagged errors + abort taxonomy + JSON safe-stringify.
 *
 * Single source of truth: ABORT kind strings drive both Data.TaggedError tags
 * and ledger event kind strings AND SubmitResult.reason (via reasonOf).
 *
 * Irrecoverable (escape Promise boundary):
 *   SqlError, JsonStringifyError, ScopeMissingError
 *
 * Recoverable (caught in submitAgentEffect, logged then -> SubmitResult.fail):
 *   UpstreamFailure, ToolError
 */

import { Data, Effect } from "effect";
import { ABORT } from "./abort";

// ============================================================
//          ABORT TAXONOMY (re-exported from ./abort)
//          SSoT lives in ./abort.ts so ops-api / ops-react can
//          import the vocabulary without pulling backend code.
// ============================================================

export { ABORT, type AbortKind, reasonOf } from "./abort";

// ============================================================
//                     TAGGED ERRORS
// ============================================================

export class SqlError extends Data.TaggedError("agent_os.sql_error")<{
  readonly cause: unknown;
}> {}

export class JsonStringifyError extends Data.TaggedError("agent_os.json_stringify_error")<{
  readonly cause: unknown;
}> {}

export class ScopeMissingError extends Data.TaggedError("agent_os.scope_missing")<{}> {}

export class UnsupportedScopeRef extends Data.TaggedError("agent_os.unsupported_scope_ref")<{
  readonly scopeId: string;
  readonly position: "source" | "target";
}> {}

export class InvalidScheduleAt extends Data.TaggedError("agent_os.invalid_schedule_at")<{
  readonly at: unknown;
}> {}

export class UnregisteredDurableTriggerKind extends Data.TaggedError(
  "agent_os.unregistered_durable_trigger_kind",
)<{
  readonly kind: string;
}> {}

export class DurableTriggerDrainLimitExceeded extends Data.TaggedError(
  "agent_os.durable_trigger_drain_limit_exceeded",
)<{
  readonly maxIterations: number;
  readonly drained: number;
}> {}

export class TriggerFactoryError extends Data.TaggedError("agent_os.trigger_factory_error")<{
  readonly scope: string;
  readonly cause: unknown;
}> {}

export class DurableTriggerCommitReturnedThenable extends Data.TaggedError(
  "agent_os.durable_trigger_commit_returned_thenable",
)<{
  readonly scope: string;
  readonly kind: string;
}> {}

export class DurableTriggerAcquireCancelled extends Data.TaggedError(
  "agent_os.durable_trigger_acquire_cancelled",
)<{
  readonly scope: string;
  readonly kind: string;
  readonly dueWorkId: number;
  readonly intentEventId: number;
  readonly reason?: string;
}> {}

export class CapabilityRejected extends Data.TaggedError("agent_os.capability_rejected")<{
  readonly event: string;
  readonly capability: string;
}> {}

export class DispatchTargetNotFound extends Data.TaggedError("agent_os.dispatch_target_not_found")<{
  readonly bindingRef: string;
}> {}

export class DispatchBindingRefMalformed extends Data.TaggedError(
  "agent_os.dispatch_binding_ref_malformed",
)<{
  readonly position: "target";
}> {}

export class DispatchScopeMismatch extends Data.TaggedError("agent_os.dispatch_scope_mismatch")<{
  readonly expected: string;
  readonly actual: string;
}> {}

export class InvalidResourceAmount extends Data.TaggedError("agent_os.invalid_resource_amount")<{
  readonly amount: number;
}> {}

export class ResourceInsufficient extends Data.TaggedError("agent_os.resource_insufficient")<{
  readonly key: string;
  readonly requested: number;
  readonly available: number;
}> {}

export class ResourceReservationNotFound extends Data.TaggedError(
  "agent_os.resource_reservation_not_found",
)<{
  readonly reservationId: string;
}> {}

export class ResourceReservationClosed extends Data.TaggedError(
  "agent_os.resource_reservation_closed",
)<{
  readonly reservationId: string;
  readonly status: "consumed" | "released";
}> {}

export interface CoreClaimedEventNamespace {
  readonly packageId: string;
  readonly kindPrefixes: ReadonlyArray<string>;
}

/** Event kind prefixes owned by substrate capabilities. App-facing write
 *  paths (`emitEvent`, `scheduleEvent`, `submit.deliver.event`,
 *  `dispatchToScope.event`) cannot write to these. */
export const CORE_CLAIMED_EVENT_NAMESPACES = [
  {
    packageId: "@agent-os/runtime-protocol",
    kindPrefixes: ["agent.", "chat.", "llm.", "runtime.", "tool."],
  },
  {
    packageId: "@agent-os/backend-protocol",
    kindPrefixes: ["dispatch.", "durable_trigger.", "quota.", "resource_pool."],
  },
] as const satisfies ReadonlyArray<CoreClaimedEventNamespace>;

export const CORE_CLAIMED_PREFIXES = CORE_CLAIMED_EVENT_NAMESPACES.flatMap(
  (namespace) => namespace.kindPrefixes,
);

export const coreClaimedEventNamespacePrefixes = (packageId: string): ReadonlyArray<string> =>
  CORE_CLAIMED_EVENT_NAMESPACES.find((namespace) => namespace.packageId === packageId)
    ?.kindPrefixes ?? [];

export const isCoreClaimedEventKind = (event: string): boolean =>
  CORE_CLAIMED_PREFIXES.some((p) => event.startsWith(p));

export const isClaimedEventKind = (
  event: string,
  extensionPrefixes: ReadonlyArray<string> = [],
): boolean => isCoreClaimedEventKind(event) || extensionPrefixes.some((p) => event.startsWith(p));

export class UpstreamFailure extends Data.TaggedError(ABORT.UPSTREAM_FAILURE)<{
  readonly cause: unknown;
}> {}

export type ProviderFailureFlag = "auth" | "rate_limited" | "schema" | "overloaded" | "unavailable";

export class ProviderHttpFailure extends Data.TaggedError("agent_os.provider_http_failure")<{
  readonly provider: string;
  readonly status: number;
  readonly code?: string;
  readonly type?: string;
  readonly flags: ReadonlyArray<ProviderFailureFlag>;
}> {}

export class ProviderOutputDecodeError extends Data.TaggedError(
  "agent_os.provider_output_decode_error",
)<{
  readonly field: string;
  readonly reason: "missing_or_invalid_usage" | "missing_or_invalid_field";
}> {}

export class ToolError extends Data.TaggedError(ABORT.TOOL_ERROR)<{
  readonly toolName: string;
  readonly cause: unknown;
}> {
  constructor(args: { readonly toolName: string; readonly cause: unknown }) {
    super(args);
  }
}

// ============================================================
//                     JSON SAFE-STRINGIFY
// ============================================================

export const safeStringify = (value: unknown): Effect.Effect<string, JsonStringifyError> =>
  Effect.try({
    try: () => JSON.stringify(value),
    catch: (cause) => new JsonStringifyError({ cause }),
  });

export const safeStringifyPretty = (value: unknown): Effect.Effect<string, JsonStringifyError> =>
  Effect.try({
    try: () => JSON.stringify(value, null, 2),
    catch: (cause) => new JsonStringifyError({ cause }),
  });
