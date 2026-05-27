/**
 * Scheduler — module-private deferred event service.
 *
 * scheduled_events rows are pending intents, NOT ledger truth. A row only
 * becomes truth when fireDue commits a ledger event row AND marks
 * scheduled_events.fired_event_id within one ctx.storage.transactionSync.
 *
 * Exactly-once by construction: the pre-check happens INSIDE the transaction.
 * If guard false (row already fired), the transaction commits zero writes.
 * Alarm at-least-once retries cannot produce duplicate ledger events.
 *
 * Scope is captured by SchedulerLive at Layer build time (SSoT — single
 * source per DO instance). schedule(at, event, data) does not accept scope.
 */

import { Clock, Context, Effect, Layer } from "effect";
import { JsonStringifyError, SqlError, safeStringify } from "./errors";
import type { LedgerEvent } from "./types";
import { EventBus } from "./ledger";
import { sqlText } from "./storage/sql-row";

export class Scheduler extends Context.Tag("@agent-os/Scheduler")<
  Scheduler,
  {
    readonly findNextPending: () => Effect.Effect<number | null, SqlError>;
    readonly schedule: (
      at: number,
      eventKind: string,
      data: unknown,
    ) => Effect.Effect<{ id: number }, SqlError | JsonStringifyError>;
    readonly fireDue: (
      now: number,
    ) => Effect.Effect<{ next: number | null; fired: number }, SqlError | JsonStringifyError>;
  }
>() {}

const ensureSchedulerSchema = (sql: SqlStorage): Effect.Effect<void, SqlError> =>
  Effect.try({
    try: () => {
      sql.exec(`
        CREATE TABLE IF NOT EXISTS scheduled_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          fire_at INTEGER NOT NULL,
          event_kind TEXT NOT NULL,
          data TEXT NOT NULL,
          fired_event_id INTEGER REFERENCES events(id)
        )
      `);
      sql.exec(`
        CREATE INDEX IF NOT EXISTS idx_scheduled_pending
          ON scheduled_events (fire_at)
          WHERE fired_event_id IS NULL
      `);
    },
    catch: (cause) => new SqlError({ cause }),
  }).pipe(Effect.asVoid);

const findNextPending = (sql: SqlStorage): Effect.Effect<number | null, SqlError> =>
  Effect.try({
    try: () => {
      const rows = sql
        .exec("SELECT MIN(fire_at) AS m FROM scheduled_events WHERE fired_event_id IS NULL")
        .toArray();
      const row = rows[0];
      if (row === undefined) return null;
      const m = row.m;
      return m === null || m === undefined ? null : Number(m);
    },
    catch: (cause) => new SqlError({ cause }),
  });

export const SchedulerLive = (
  ctx: DurableObjectState,
  scope: string,
): Layer.Layer<Scheduler, SqlError, EventBus> => {
  const sql = ctx.storage.sql;
  return Layer.scoped(
    Scheduler,
    Effect.gen(function* () {
      yield* ensureSchedulerSchema(sql);
      const bus = yield* EventBus;

      return {
        findNextPending: () => findNextPending(sql),

        schedule: (at, eventKind, data) =>
          Effect.gen(function* () {
            const dataStr = yield* safeStringify(data);
            const id = yield* Effect.try({
              try: () => {
                const cursor = sql.exec(
                  "INSERT INTO scheduled_events (fire_at, event_kind, data) VALUES (?, ?, ?) RETURNING id",
                  at,
                  eventKind,
                  dataStr,
                );
                return Number(cursor.one().id);
              },
              catch: (cause) => new SqlError({ cause }),
            });
            return { id };
          }),

        fireDue: (now) =>
          Effect.gen(function* () {
            const pending = yield* Effect.try({
              try: () =>
                sql
                  .exec(
                    "SELECT id, fire_at, event_kind, data FROM scheduled_events WHERE fired_event_id IS NULL AND fire_at <= ? ORDER BY fire_at, id",
                    now,
                  )
                  .toArray(),
              catch: (cause) => new SqlError({ cause }),
            });

            let fired = 0;
            for (const row of pending) {
              const schedId = Number(row.id);
              const kind = sqlText(row.event_kind, "scheduled_events.event_kind");
              const dataStr = sqlText(row.data, "scheduled_events.data");

              const dataValue = yield* Effect.try({
                try: () => JSON.parse(dataStr) as unknown,
                catch: (cause) => new SqlError({ cause }),
              });

              const ts = yield* Clock.currentTimeMillis;

              // Exactly-once by construction: pre-check guard INSIDE the
              // transaction, BEFORE INSERT events. If the row is already
              // fired, return null and the transaction commits zero writes.
              const eventOrNull = yield* Effect.try({
                try: () =>
                  ctx.storage.transactionSync(() => {
                    const stillPending = sql
                      .exec(
                        "SELECT id FROM scheduled_events WHERE id = ? AND fired_event_id IS NULL",
                        schedId,
                      )
                      .toArray();
                    if (stillPending.length === 0) {
                      return null;
                    }
                    const insertCursor = sql.exec(
                      "INSERT INTO events (ts, kind, scope, payload) VALUES (?, ?, ?, ?) RETURNING id",
                      ts,
                      kind,
                      scope,
                      dataStr,
                    );
                    const eventId = Number(insertCursor.one().id);
                    sql.exec(
                      "UPDATE scheduled_events SET fired_event_id = ? WHERE id = ?",
                      eventId,
                      schedId,
                    );
                    return {
                      id: eventId,
                      ts,
                      kind,
                      scope,
                      payload: dataValue,
                    } satisfies LedgerEvent;
                  }),
                catch: (cause) => new SqlError({ cause }),
              });

              if (eventOrNull !== null) {
                yield* bus.fire(eventOrNull);
                fired += 1;
              }
            }

            const next = yield* findNextPending(sql);
            return { next, fired };
          }),
      };
    }),
  );
};
