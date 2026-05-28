/**
 * Quota — pre-grant + consume guard for tool dispatch.
 *
 * v0.2.8 semantics (per codex review):
 *   - amount is STATIC (or function of args — not result). Default 1.
 *   - Pre-grant is atomic with consume: a single ctx.storage.transactionSync
 *     reads consumed-in-window and writes EITHER dispatch.consumed (grant)
 *     OR dispatch.rate_limited (deny). No await window between read and
 *     write — concurrent submits cannot both observe the same stale state.
 *   - Per-attempt: grant happens inside the retry loop, so each retry
 *     consumes a slot. Carrier rate-limit semantics, not "successful
 *     completion" semantics.
 *
 * Deferred to later versions:
 *   - Dynamic key (function of intent / args)
 *   - Dynamic limit (computed from project view, e.g. credit balance)
 *   - Result-dependent measure + settle/refund (billing semantics)
 *   - Cross-scope quota (currently DO scope is the partition key)
 */

import type { Tool } from "@agent-os/kernel/tools";

export interface QuotaSpec {
  /** Identifier within the DO scope. Default: tool definition's function name. */
  readonly key?: string;
  /** Window duration in ms. Use Number.POSITIVE_INFINITY for unbounded (billing). */
  readonly windowMs: number;
  /** Max sum of amounts allowed in window. Must be finite non-negative. */
  readonly limit: number;
  /** Amount consumed per call. Default 1. Must be finite non-negative.
   *  v0.2.8 only supports static amount — result-dependent measure deferred. */
  readonly amount?: number;
}

/** Attach a QuotaSpec to a tool. Returns a new Tool with `quota` metadata. */
export function withQuota<A, R>(tool: Tool<A, R>, spec: QuotaSpec): Tool<A, R> {
  return { ...tool, quota: spec };
}
