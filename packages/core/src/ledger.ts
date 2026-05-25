/**
 * Ledger — module-private append-only event log on DO SQLite.
 *
 * Ledger.log writes a row then fires the EventBus (reactive subscribers).
 * Ledger.events queries rows for a given scope.
 *
 * LedgerLive depends on EventBus (Layer.provide composition).
 */

import { Clock, Context, Effect, Layer } from "effect";
import {
  JsonStringifyError,
  SqlError,
  safeStringify,
} from "./errors";
import type { LedgerEvent } from "./types";
import { EventBus } from "./event-bus";

export class Ledger extends Context.Tag("@agent-os/Ledger")<
  Ledger,
  {
    readonly log: (
      kind: string,
      payload: unknown,
      scope: string,
    ) => Effect.Effect<LedgerEvent, SqlError | JsonStringifyError>;
    readonly events: (
      scope: string,
    ) => Effect.Effect<ReadonlyArray<LedgerEvent>, SqlError>;
  }
>() {}

const ensureSchema = (sql: SqlStorage): Effect.Effect<void, SqlError> =>
  Effect.try({
    try: () =>
      sql.exec(`
        CREATE TABLE IF NOT EXISTS events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ts INTEGER NOT NULL,
          kind TEXT NOT NULL,
          scope TEXT NOT NULL,
          payload TEXT NOT NULL
        )
      `),
    catch: (cause) => new SqlError({ cause }),
  }).pipe(Effect.asVoid);

export const LedgerLive = (
  sql: SqlStorage,
): Layer.Layer<Ledger, SqlError, EventBus> =>
  Layer.scoped(
    Ledger,
    Effect.gen(function* () {
      yield* ensureSchema(sql);
      const bus = yield* EventBus;

      return {
        log: (kind, payload, scope) =>
          Effect.gen(function* () {
            const ts = yield* Clock.currentTimeMillis;
            const payloadStr = yield* safeStringify(payload);
            const cursor = yield* Effect.try({
              try: () =>
                sql.exec(
                  "INSERT INTO events (ts, kind, scope, payload) VALUES (?, ?, ?, ?) RETURNING id",
                  ts,
                  kind,
                  scope,
                  payloadStr,
                ),
              catch: (cause) => new SqlError({ cause }),
            });
            const id = Number(cursor.one().id);
            const event: LedgerEvent = { id, ts, kind, scope, payload };
            yield* bus.fire(event);
            return event;
          }),
        events: (scope) =>
          Effect.try({
            try: () =>
              sql
                .exec(
                  "SELECT * FROM events WHERE scope = ? ORDER BY id",
                  scope,
                )
                .toArray()
                .map(
                  (r): LedgerEvent => ({
                    id: Number(r.id),
                    ts: Number(r.ts),
                    kind: String(r.kind),
                    scope: String(r.scope),
                    payload: JSON.parse(String(r.payload)) as unknown,
                  }),
                ),
            catch: (cause) => new SqlError({ cause }),
          }),
      };
    }),
  );
