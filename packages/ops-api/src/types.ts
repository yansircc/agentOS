/**
 * @agent-os/ops-api — types
 *
 * Spec: docs/specs/spec-35-ops-api-boundary.md §3
 *
 * All app-provided contracts (ScopeResolver, OpsAuth) live here.
 * ops-api ships no default implementation.
 */

import type {
  AttemptKey,
  RunStatus,
} from "@agent-os/core";

// ============================================================
// Scope resolution
// ============================================================

export type ScopeSurface = "agent-do/v0.3" | "opaque";

export interface ScopeSummary {
  readonly scope: string;
  readonly surface: ScopeSurface;
}

export interface ResolvedScope {
  readonly scope: string;
  readonly surface: ScopeSurface;
  /** DurableObjectNamespace for introspectable scopes. Absent when
   *  surface = "opaque" (ops-api will return 501 not_introspectable). */
  readonly namespace?: DurableObjectNamespace;
}

export interface ScopeListPage {
  readonly scopes: ReadonlyArray<ScopeSummary>;
  readonly nextCursor: string | null;
}

export interface ScopeResolver {
  list(filter: {
    prefix?: string;
    limit?: number;
  }): Promise<ScopeListPage>;
  resolve(scope: string): Promise<ResolvedScope | null>;
}

// ============================================================
// Authorization
// ============================================================

export type OpsAction = "read" | "stream";

export interface OpsPrincipal {
  readonly subject: string;
  readonly tenantId?: string;
  readonly claims: Readonly<Record<string, unknown>>;
}

export interface OpsAuth {
  authenticate(req: Request): Promise<OpsPrincipal | null>;
  authorize(
    principal: OpsPrincipal,
    scope: string,
    action: OpsAction,
  ): Promise<boolean>;
}

// ============================================================
// Run summary (spec-35 §3.4)
//   Lightweight projection over agent.run.* + agent.aborted.*.
//   Detail (turns / tool calls / tokens) requires /runs/:runId/trace.
// ============================================================

export interface RunSummary {
  readonly runId: number;
  readonly startedAt: number;
  readonly status: RunStatus;
  readonly durationMs?: number;
}

export interface RunListPage {
  readonly runs: ReadonlyArray<RunSummary>;
  readonly nextCursor: number | null;
}

export type { AttemptKey, RunStatus };
