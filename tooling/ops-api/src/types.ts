/**
 * @agent-os/ops-api — types
 *
 *
 * All app-provided contracts (ScopeResolver, OpsAuth) live here.
 * ops-api ships no default implementation.
 */

import type { AttemptKey } from "@agent-os/core/runtime-protocol";
import type { RunListPage, RunListSpec, RunStatus, RunSummary } from "@agent-os/core/types";

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
}

/**
 * Resolver returns the full set of scopes the principal can see in one call.
 * v0 has no cursor: filtering by auth runs in ops-api after resolution, so
 * a resolver page that returns mixed authorized/unauthorized rows would let
 * unreachable allowed scopes hide behind the page boundary. If a deployment
 * needs scale-out, the resolver should accept the principal and pre-filter.
 */
export interface ScopeResolver {
  list(filter: { prefix?: string; limit?: number }): Promise<ReadonlyArray<ScopeSummary>>;
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
  authorize(principal: OpsPrincipal, scope: string, action: OpsAction): Promise<boolean>;
}

// ============================================================
// Run summary / list — re-exported from kernel/runtime-protocol so apps
// using ops-api type the response correctly without two imports.
// ============================================================

export type { AttemptKey, RunStatus, RunSummary, RunListSpec, RunListPage };
