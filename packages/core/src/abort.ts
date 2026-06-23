/**
 * Abort taxonomy — zero-dep extraction so non-backend contexts
 * (e.g. ops-api, ops-react) can import this vocabulary without pulling
 * a Cloudflare Worker module via a backend barrel.
 *
 * SSoT: this file. `./errors.ts` re-exports both symbols.
 *
 * Subpath: `@agent-os/kernel/abort`.
 */

export const ABORT = {
  BUDGET_TOKENS: "agent.aborted.budget_tokens",
  BUDGET_TIME: "agent.aborted.budget_time",
  TOOL_ERROR: "agent.aborted.tool_error",
  UPSTREAM_FAILURE: "agent.aborted.upstream_failure",
  RETRIES: "agent.aborted.retries",
  CLIENT_DISCONNECT: "agent.aborted.client_disconnect",
  DECISION_REJECTED: "agent.aborted.rejected",
  DECISION_CANCELLED: "agent.aborted.cancelled",
  DECISION_EXPIRED: "agent.aborted.expired",
} as const;

export type AbortKind = (typeof ABORT)[keyof typeof ABORT];

export const reasonOf = (kind: AbortKind): string => kind.replace(/^agent\.aborted\./, "");
