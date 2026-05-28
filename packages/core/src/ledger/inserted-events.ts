import type { Effect } from "effect";
import type { LedgerEvent } from "../types";
import type { EventBusService } from "./event-bus";

export interface InsertLedgerEventSpec {
  readonly ts: number;
  readonly kind: string;
  readonly scope: string;
  readonly payloadStr: string;
  readonly payload: unknown;
}

export const insertLedgerEvent = (
  sql: SqlStorage,
  spec: InsertLedgerEventSpec,
): LedgerEvent => {
  const cursor = sql.exec(
    "INSERT INTO events (ts, kind, scope, payload) VALUES (?, ?, ?, ?) RETURNING id",
    spec.ts,
    spec.kind,
    spec.scope,
    spec.payloadStr,
  );
  return {
    id: Number(cursor.one().id),
    ts: spec.ts,
    kind: spec.kind,
    scope: spec.scope,
    payload: spec.payload,
  };
};

export const fireLedgerEvents = (
  bus: EventBusService,
  events: Iterable<LedgerEvent>,
): Effect.Effect<void> => bus.fireMany(Array.from(events));
