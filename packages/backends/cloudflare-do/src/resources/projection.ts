/**
 * Pure projection over `events.kind = resource_pool.*` rows.
 *
 * Reads the ledger event stream and rebuilds:
 *   - per-(scope, key) balance: available / reserved / consumed
 *   - per-reservationId state machine (active / consumed / released)
 *   - per-idempotencyKey index (for reserve dedupe)
 *
 * No IO inside `projectRows` — pure folder. `loadState` is the IO
 * boundary: one SQL SELECT followed by `projectRows`. Both
 * `ResourcesLive.{reserve,consume,release}` call `loadState` INSIDE
 * the same `transactionSync` that writes the next resource event, so
 * the read is consistent with the write (SQLite's DO read-after-write
 * within a transaction guarantees this).
 */

import {
  decodeGrantPayloadSync,
  decodeReservePayloadSync,
  decodeReserveRejectedPayloadSync,
  decodeTerminalPayloadSync,
} from "./payload";
import { sqlText } from "../storage/sql-row";
import { eventIdentity, eventIdentityColumns } from "../ledger/identity";
import type { FactOwnerRef } from "@agent-os/kernel/effect-claim";
import type { LedgerTruthIdentity } from "@agent-os/runtime";

export interface ResourceProjection {
  readonly available: number;
  readonly reserved: number;
  readonly consumed: number;
}

export type TerminalStatus = "active" | "consumed" | "released";

export interface ReservationState {
  readonly reservationId: string;
  readonly key: string;
  readonly amount: number;
  readonly ref: string;
  readonly idempotencyKey: string;
  readonly status: TerminalStatus;
}

export interface ProjectedState {
  readonly byId: Map<string, ReservationState>;
  readonly byIdempotencyKey: Map<string, ReservationState>;
  readonly byKey: Map<string, ResourceProjection>;
}

export interface ResourceEventRow {
  readonly kind: unknown;
  readonly payload: unknown;
}

export const emptyProjection = (): ResourceProjection => ({
  available: 0,
  reserved: 0,
  consumed: 0,
});

const addProjection = (
  map: Map<string, ResourceProjection>,
  key: string,
  delta: Partial<ResourceProjection>,
): void => {
  const current = map.get(key) ?? emptyProjection();
  map.set(key, {
    available: current.available + (delta.available ?? 0),
    reserved: current.reserved + (delta.reserved ?? 0),
    consumed: current.consumed + (delta.consumed ?? 0),
  });
};

export const projectRows = (rows: ReadonlyArray<ResourceEventRow>): ProjectedState => {
  const grants: Array<{ key: string; amount: number }> = [];
  const reservations = new Map<string, ReservationState>();
  const byIdempotencyKey = new Map<string, ReservationState>();

  for (const row of rows) {
    const kind = sqlText(row.kind, "events.kind");
    const payload = JSON.parse(sqlText(row.payload, "events.payload"));
    switch (kind) {
      case "resource_pool.granted": {
        const p = decodeGrantPayloadSync(payload);
        grants.push({ key: p.key, amount: p.amount });
        break;
      }
      case "resource_pool.reserved": {
        const p = decodeReservePayloadSync(payload);
        const reservation: ReservationState = {
          reservationId: p.reservationId,
          key: p.key,
          amount: p.amount,
          ref: p.ref,
          idempotencyKey: p.idempotencyKey,
          status: "active",
        };
        reservations.set(p.reservationId, reservation);
        byIdempotencyKey.set(p.idempotencyKey, reservation);
        break;
      }
      case "resource_pool.reserve_rejected": {
        decodeReserveRejectedPayloadSync(payload);
        break;
      }
      case "resource_pool.consumed":
      case "resource_pool.released": {
        const p = decodeTerminalPayloadSync(payload);
        const existing = reservations.get(p.reservationId);
        if (existing !== undefined) {
          const status = kind === "resource_pool.consumed" ? "consumed" : "released";
          const next = { ...existing, status } satisfies ReservationState;
          reservations.set(p.reservationId, next);
          byIdempotencyKey.set(next.idempotencyKey, next);
        }
        break;
      }
      default:
        break;
    }
  }

  const byKey = new Map<string, ResourceProjection>();
  for (const grant of grants) {
    addProjection(byKey, grant.key, { available: grant.amount });
  }
  for (const reservation of reservations.values()) {
    if (reservation.status === "active") {
      addProjection(byKey, reservation.key, {
        available: -reservation.amount,
        reserved: reservation.amount,
      });
    } else if (reservation.status === "consumed") {
      addProjection(byKey, reservation.key, {
        available: -reservation.amount,
        consumed: reservation.amount,
      });
    }
  }

  return { byId: reservations, byIdempotencyKey, byKey };
};

/** Synchronous load — one SELECT + projectRows. Designed to be called
 *  INSIDE `transactionSync`; the read is consistent with subsequent
 *  writes in the same transaction. */
export const loadState = (
  sql: SqlStorage,
  identity: LedgerTruthIdentity,
  factOwnerRef: FactOwnerRef,
): ProjectedState => {
  const columns = eventIdentityColumns(eventIdentity(identity, factOwnerRef));
  const rows = sql
    .exec(
      "SELECT kind, payload FROM events WHERE event_identity_key = ? AND kind LIKE 'resource_pool.%' ORDER BY id",
      columns.event_identity_key,
    )
    .toArray() as unknown as ResourceEventRow[];
  return projectRows(rows);
};
