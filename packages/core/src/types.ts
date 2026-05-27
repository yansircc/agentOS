/**
 * Plain shared types.
 *
 * LedgerEvent — internal canonical event row shape.
 * LedgerEventRpc — RPC-friendly variant (mutable + payload:any); the shape
 *   passed to user-defined `on()` handlers and returned by `events()`.
 * EventHandler — user-side reactive callback type.
 * ScheduledEventSpec — argument to AgentDOBase.scheduleEvent.
 */

import type { ScopeRef } from "./effect-claim";
import type { BindingMaterialRef } from "./material-ref";

export interface LedgerEvent {
  readonly id: number;
  readonly ts: number;
  readonly kind: string;
  readonly scope: string;
  readonly payload: unknown;
}

export interface LedgerEventRpc {
  id: number;
  ts: number;
  kind: string;
  scope: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload: any;
}

export type EventHandler = (event: LedgerEventRpc) => Promise<void>;

export interface EventQueryOptions {
  readonly afterId?: number;
  readonly limit?: number;
  readonly kinds?: ReadonlyArray<string>;
}

export interface StreamEventsOptions {
  readonly afterId?: number;
  readonly kinds?: ReadonlyArray<string>;
  readonly heartbeatMs?: number;
}

export interface ScheduledEventSpec {
  readonly at: number;
  readonly event: string;
  readonly data: unknown;
}

export interface DispatchTargetSpec {
  readonly bindingRef: BindingMaterialRef;
  readonly scope: string;
  readonly scopeRef: ScopeRef;
}

export interface TraceContext {
  readonly traceparent?: string;
  readonly tracestate?: string;
}

export interface DispatchToScopeSpec {
  readonly target: DispatchTargetSpec;
  readonly event: string;
  readonly data: unknown;
  readonly idempotencyKey: string;
  readonly traceContext?: TraceContext;
}

export interface DispatchToScopeResult {
  readonly outboundEventId: number;
}

export interface ResourceGrantSpec {
  readonly key: string;
  readonly amount: number;
  readonly ref: string;
}

export interface ResourceReserveSpec {
  readonly key: string;
  readonly amount: number;
  readonly ref: string;
  readonly idempotencyKey: string;
}

export interface ResourceReservationSpec {
  readonly reservationId: string;
  readonly ref: string;
}

export interface ResourceGrantResult {
  readonly eventId: number;
}

export interface ResourceReserveResult {
  readonly reservationId: string;
}

export interface RunTurn {
  readonly index: number;
  readonly at: number;
  readonly text: string;
  readonly usage?: unknown;
}

export interface RunToolCall {
  readonly at: number;
  readonly name: string;
  readonly args: unknown;
  readonly result: unknown;
}

export interface RunTerminal {
  readonly kind: "delivered" | "aborted";
  readonly at: number;
  readonly event: string;
  readonly payload: unknown;
}

export interface RunTrace {
  readonly runId: number;
  readonly startedAt: number;
  readonly turns: ReadonlyArray<RunTurn>;
  readonly toolCalls: ReadonlyArray<RunToolCall>;
  readonly terminal: RunTerminal | null;
}

export type RunStatus =
  | { readonly kind: "delivered"; readonly at: number; readonly event: string }
  | {
      readonly kind: "aborted";
      readonly at: number;
      readonly abortKind: string;
    }
  | { readonly kind: "open_without_terminal"; readonly startedAt: number }
  | {
      readonly kind: "orphaned";
      readonly startedAt: number;
      readonly evidence: string;
    };

export type RunStatusKind = RunStatus["kind"];

export interface RunSummary {
  readonly runId: number;
  readonly startedAt: number;
  readonly status: RunStatus;
  /** Only present when status.kind ∈ {delivered, aborted}. */
  readonly durationMs?: number;
}

export interface RunListSpec {
  /** Filter to a non-empty subset of RunStatus kinds. Empty/undefined = all. */
  readonly statuses?: ReadonlyArray<RunStatusKind>;
  /** Cursor: return runs strictly older than this runId (DESC pagination). */
  readonly afterRunId?: number;
  /** Page size cap. Caller enforces sane upper bound. */
  readonly limit: number;
}

export interface RunListPage {
  /** Sorted runId DESC (newest first). */
  readonly runs: ReadonlyArray<RunSummary>;
  /** Next afterRunId for continued paging; null when no more pages. */
  readonly nextCursor: number | null;
}

export interface QuotaStateSpec {
  readonly key: string;
  readonly windowMs: number;
  readonly limit: number;
}

export interface QuotaState {
  readonly consumed: number;
  readonly limit: number;
  readonly remaining: number;
  /** v0.3 quota has no refund lifecycle; resource reservations own refunds. */
  readonly refundable: number;
  readonly windowStart?: number;
}

export interface ResourceReservationView {
  readonly id: string;
  readonly amount: number;
}

export interface ResourceState {
  readonly granted: number;
  readonly reserved: number;
  readonly consumed: number;
  readonly available: number;
  readonly reservations: ReadonlyArray<ResourceReservationView>;
}
