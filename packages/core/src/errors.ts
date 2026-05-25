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

// ============================================================
//          ABORT TAXONOMY (single source of truth)
// ============================================================

export const ABORT = {
  BUDGET_TOKENS: "agent.aborted.budget_tokens",
  BUDGET_TIME: "agent.aborted.budget_time",
  TOOL_ERROR: "agent.aborted.tool_error",
  UPSTREAM_FAILURE: "agent.aborted.upstream_failure",
  RETRIES: "agent.aborted.retries",
} as const;

export type AbortKind = (typeof ABORT)[keyof typeof ABORT];

export const reasonOf = (kind: AbortKind): string =>
  kind.replace(/^agent\.aborted\./, "");

// ============================================================
//                     TAGGED ERRORS
// ============================================================

export class SqlError extends Data.TaggedError("agent_os.sql_error")<{
  readonly cause: unknown;
}> {}

export class JsonStringifyError extends Data.TaggedError(
  "agent_os.json_stringify_error",
)<{
  readonly cause: unknown;
}> {}

export class ScopeMissingError extends Data.TaggedError(
  "agent_os.scope_missing",
)<{}> {}

export class UpstreamFailure extends Data.TaggedError(
  ABORT.UPSTREAM_FAILURE,
)<{
  readonly cause: unknown;
}> {}

export class ToolError extends Data.TaggedError(ABORT.TOOL_ERROR)<{
  readonly toolName: string;
  readonly cause: unknown;
}> {}

// ============================================================
//                     JSON SAFE-STRINGIFY
// ============================================================

export const safeStringify = (
  value: unknown,
): Effect.Effect<string, JsonStringifyError> =>
  Effect.try({
    try: () => JSON.stringify(value),
    catch: (cause) => new JsonStringifyError({ cause }),
  });

export const safeStringifyPretty = (
  value: unknown,
): Effect.Effect<string, JsonStringifyError> =>
  Effect.try({
    try: () => JSON.stringify(value, null, 2),
    catch: (cause) => new JsonStringifyError({ cause }),
  });
