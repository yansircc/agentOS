/**
 * Plain shared types.
 *
 * LedgerEvent — internal canonical event row shape.
 * LedgerEventRpc — RPC-friendly variant (mutable + payload:any); the shape
 *   passed to user-defined `on()` handlers and returned by `events()`.
 * EventHandler — user-side reactive callback type.
 * ScheduledEventSpec — argument to AgentDOBase.scheduleEvent.
 */

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

export interface ScheduledEventSpec {
  readonly at: number;
  readonly event: string;
  readonly data: unknown;
}

export interface DispatchTargetSpec {
  readonly bindingRef: string;
  readonly scope: string;
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
