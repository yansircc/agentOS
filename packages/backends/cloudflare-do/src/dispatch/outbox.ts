/**
 * `dispatch_outbox` schema + read projections + retry timing.
 *
 * State ownership:
 *   - `events` is the SSoT for sender intent (`dispatch.outbound.requested`)
 *     and delivery transitions (`dispatch.outbound.{delivered,failed}`).
 *   - `dispatch_outbox` is a pending-delivery buffer derived from those
 *     events; same class as `scheduled_events`. Not a second writer of
 *     truth.
 *
 * ensureDispatchSchema runs at DispatchLive init only. The events table
 * is created here too because DispatchLive can be the first service to
 * boot in a fresh DO; the IF NOT EXISTS clause makes other Layers'
 * matching CREATE statements idempotent.
 */

import { Effect } from "effect";
import { SqlError } from "@agent-os/kernel/errors";
import { sqlText } from "../storage/sql-row";

export interface DispatchOutboxRow {
  readonly outboundEventId: number;
  readonly attempts: number;
  readonly requestedPayload: string;
  readonly sourceScope: string;
}

export const ensureDispatchSchema = (sql: SqlStorage): Effect.Effect<void, SqlError> =>
  Effect.try({
    try: () => {
      sql.exec(`
        CREATE TABLE IF NOT EXISTS events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ts INTEGER NOT NULL,
          kind TEXT NOT NULL,
          scope TEXT NOT NULL,
          payload TEXT NOT NULL
        )
      `);
      sql.exec(`
        CREATE TABLE IF NOT EXISTS dispatch_outbox (
          outbound_event_id INTEGER PRIMARY KEY REFERENCES events(id),
          delivered_event_id INTEGER REFERENCES events(id),
          attempts INTEGER NOT NULL DEFAULT 0,
          next_attempt_at INTEGER NOT NULL,
          last_error TEXT
        )
      `);
      sql.exec(`
        CREATE INDEX IF NOT EXISTS idx_dispatch_outbox_pending
          ON dispatch_outbox (next_attempt_at)
          WHERE delivered_event_id IS NULL
      `);
    },
    catch: (cause) => new SqlError({ cause }),
  }).pipe(Effect.asVoid);

/** Capped exponential backoff: 1s, 2s, 4s, 8s, 16s, 32s, 60s, then plateau.
 *  `attempt` is the count AFTER the current failure (1-indexed). */
export const retryDelayMs = (attempt: number): number =>
  Math.min(60_000, 1_000 * 2 ** Math.min(Math.max(attempt - 1, 0), 6));

export const findNextPending = (sql: SqlStorage): Effect.Effect<number | null, SqlError> =>
  Effect.try({
    try: () => {
      const rows = sql
        .exec(
          "SELECT MIN(next_attempt_at) AS m FROM dispatch_outbox WHERE delivered_event_id IS NULL",
        )
        .toArray();
      const row = rows[0];
      if (row === undefined) return null;
      const m = row.m;
      return m === null || m === undefined ? null : Number(m);
    },
    catch: (cause) => new SqlError({ cause }),
  });

export const selectDue = (
  sql: SqlStorage,
  now: number,
): Effect.Effect<ReadonlyArray<DispatchOutboxRow>, SqlError> =>
  Effect.try({
    try: () =>
      sql
        .exec(
          `
          SELECT
            o.outbound_event_id,
            o.attempts,
            e.payload AS requested_payload,
            e.scope AS source_scope
          FROM dispatch_outbox o
          JOIN events e ON e.id = o.outbound_event_id
          WHERE o.delivered_event_id IS NULL
            AND o.next_attempt_at <= ?
          ORDER BY o.next_attempt_at, o.outbound_event_id
        `,
          now,
        )
        .toArray()
        .map(
          (row): DispatchOutboxRow => ({
            outboundEventId: Number(row.outbound_event_id),
            attempts: Number(row.attempts),
            requestedPayload: sqlText(row.requested_payload, "events.payload"),
            sourceScope: sqlText(row.source_scope, "events.scope"),
          }),
        ),
    catch: (cause) => new SqlError({ cause }),
  });
