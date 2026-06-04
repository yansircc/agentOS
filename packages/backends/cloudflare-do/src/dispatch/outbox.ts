import { Effect } from "effect";
import { SqlError } from "@agent-os/kernel/errors";
import { ensureLedgerSchema } from "../ledger/commit";

export interface DispatchOutboxRow {
  readonly outboundEventId: number;
  readonly attempts: number;
}

export const ensureDispatchSchema = (sql: SqlStorage): Effect.Effect<void, SqlError> =>
  Effect.try({
    try: () => {
      ensureLedgerSchema(sql);
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

export const selectPendingOutboxByIntent = (
  sql: SqlStorage,
  intentEventId: number,
): DispatchOutboxRow | null => {
  const row = sql
    .exec(
      `
          SELECT
            o.outbound_event_id,
            o.attempts
          FROM dispatch_outbox o
          WHERE o.outbound_event_id = ?
            AND o.delivered_event_id IS NULL
        `,
      intentEventId,
    )
    .toArray()[0];
  if (row === undefined) return null;
  return {
    outboundEventId: Number(row.outbound_event_id),
    attempts: Number(row.attempts),
  };
};
