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
} from "../errors";
import type { EventQueryOptions, LedgerEvent, LedgerEventRpc } from "../types";
import { EventBus } from "./event-bus";

const DEFAULT_EVENT_LIMIT = 1000;
const MAX_EVENT_LIMIT = 1000;

const normalizeNonNegativeInteger = (
  value: number | undefined,
  fallback: number,
): number =>
  value === undefined || !Number.isFinite(value)
    ? fallback
    : Math.max(0, Math.floor(value));

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
      opts?: EventQueryOptions,
    ) => Effect.Effect<ReadonlyArray<LedgerEvent>, SqlError>;
    readonly streamSnapshot: (
      scope: string,
      opts?: Pick<EventQueryOptions, "afterId" | "kinds">,
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

const selectEvents = (
  sql: SqlStorage,
  scope: string,
  opts: Pick<EventQueryOptions, "afterId" | "kinds"> & {
    readonly limit?: number;
  },
): ReadonlyArray<LedgerEvent> => {
  const afterId = normalizeNonNegativeInteger(opts.afterId, 0);
  const kinds =
    opts.kinds === undefined
      ? []
      : Array.from(new Set(opts.kinds)).filter((kind) => kind.length > 0);
  const kindClause =
    kinds.length === 0
      ? ""
      : ` AND kind IN (${kinds.map(() => "?").join(", ")})`;
  const limitClause = opts.limit === undefined ? "" : " LIMIT ?";
  const args =
    opts.limit === undefined
      ? [scope, afterId, ...kinds]
      : [scope, afterId, ...kinds, opts.limit];
  return sql
    .exec(
      `SELECT * FROM events WHERE scope = ? AND id > ?${kindClause} ORDER BY id ASC${limitClause}`,
      ...args,
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
    );
};

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
        events: (scope, opts = {}) =>
          Effect.try({
            try: () => {
              const limit =
                opts.limit === undefined
                  ? DEFAULT_EVENT_LIMIT
                  : Math.max(
                      0,
                      Math.min(
                        MAX_EVENT_LIMIT,
                        normalizeNonNegativeInteger(
                          opts.limit,
                          DEFAULT_EVENT_LIMIT,
                        ),
                      ),
                    );
              return selectEvents(sql, scope, { ...opts, limit });
            },
            catch: (cause) => new SqlError({ cause }),
          }),
        streamSnapshot: (scope, opts = {}) =>
          Effect.try({
            try: () => selectEvents(sql, scope, opts),
            catch: (cause) => new SqlError({ cause }),
          }),
      };
    }),
  );

/** Pure helper shared by `AgentDOBase.events()` and the SSE stream
 *  encoder: project a stored LedgerEvent into the RPC-safe shape. Lives
 *  here so both façade callers and `./stream.ts` reach the same
 *  serialization without re-deriving it. */
export const eventToRpc = (
  event: LedgerEvent,
): LedgerEventRpc => ({
  id: event.id,
  ts: event.ts,
  kind: event.kind,
  scope: event.scope,
  payload: event.payload,
});
