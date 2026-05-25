/**
 * Quota — pre-grant + consume guard for tool dispatch.
 *
 * v0.2.7 minimal cut:
 *   - Per-tool quota, attached via withQuota(tool, spec)
 *   - Key defaults to the tool's function name (within DO scope)
 *   - Pre-check: sum prior dispatch.consumed events for {key, windowMs};
 *     if sum >= limit, log dispatch.rate_limited and raise ToolError
 *     (caught by submitAgentEffect → finalAbort → SubmitResult.fail)
 *   - Post: log dispatch.consumed with measure(result)
 *
 * Deferred to later versions:
 *   - Dynamic key (function of intent / args)
 *   - Dynamic limit (computed from project view, e.g. credit balance)
 *   - Refund on failure
 *   - Rate-limit recovery within a single agent run (graceful continuation)
 */

import type { Tool } from "./tools";

export interface QuotaSpec {
  /** Identifier within the DO scope. Default: tool definition's function name. */
  readonly key?: string;
  /** Window duration in ms. Use Number.POSITIVE_INFINITY for unbounded (billing). */
  readonly windowMs: number;
  /** Max measure in window. */
  readonly limit: number;
  /** Measure per call. Default: () => 1 (count). */
  readonly measure?: (result: unknown) => number;
}

/** Attach a QuotaSpec to a tool. Returns a new Tool with `quota` metadata. */
export function withQuota<A, R>(
  tool: Tool<A, R>,
  spec: QuotaSpec,
): Tool<A, R> {
  return { ...tool, quota: spec };
}
