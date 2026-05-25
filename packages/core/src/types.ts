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
