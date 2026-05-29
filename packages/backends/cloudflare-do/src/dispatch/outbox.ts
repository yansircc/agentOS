import { Effect } from "effect";
import { SqlError } from "@agent-os/kernel/errors";
import { DUE_WORK_DISPATCH_RETRY } from "@agent-os/backend-protocol";
import { selectDueWork } from "../due-work";
import { sqlText } from "../storage/sql-row";

export interface DispatchOutboxRow {
  readonly dueWorkId: number;
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
          last_error TEXT
        )
      `);
    },
    catch: (cause) => new SqlError({ cause }),
  }).pipe(Effect.asVoid);

export const selectDue = (
  sql: SqlStorage,
  now: number,
): Effect.Effect<ReadonlyArray<DispatchOutboxRow>, SqlError> =>
  Effect.gen(function* () {
    const due = yield* selectDueWork(sql, DUE_WORK_DISPATCH_RETRY, now);
    return yield* Effect.try({
      try: () =>
        due
          .map((work): DispatchOutboxRow | null => {
            const row = sql
              .exec(
                `
                SELECT
                  o.outbound_event_id,
                  o.attempts,
                  e.payload AS requested_payload,
                  e.scope AS source_scope
                FROM dispatch_outbox o
                JOIN events e ON e.id = o.outbound_event_id
                WHERE o.outbound_event_id = ?
                  AND o.delivered_event_id IS NULL
              `,
                work.payload.outboundEventId,
              )
              .toArray()[0];
            if (row === undefined) return null;
            return {
              dueWorkId: work.id,
              outboundEventId: Number(row.outbound_event_id),
              attempts: Number(row.attempts),
              requestedPayload: sqlText(row.requested_payload, "events.payload"),
              sourceScope: sqlText(row.source_scope, "events.scope"),
            };
          })
          .filter((row): row is DispatchOutboxRow => row !== null),
      catch: (cause) => new SqlError({ cause }),
    });
  });
