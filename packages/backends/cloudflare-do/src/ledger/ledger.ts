import type { EventQueryOptions, LedgerEvent, LedgerEventRpc } from "@agent-os/kernel/types";
/**
 * Ledger — module-private append-only event log on DO SQLite.
 *
 * Ledger.commit writes final rows then fires the EventBus (reactive subscribers).
 * Ledger.events queries rows for a given scope.
 *
 * LedgerLive depends on EventBus (Layer.provide composition).
 */

import { Clock, Effect, Layer } from "effect";
import { SqlError } from "@agent-os/kernel/errors";
import { Ledger } from "@agent-os/runtime";
import { sqlText } from "../storage/sql-row";
import { EventBus } from "./event-bus";
import { commitLedgerTransaction, ensureLedgerSchema } from "./commit";

const DEFAULT_EVENT_LIMIT = 1000;
const MAX_EVENT_LIMIT = 1000;

const normalizeNonNegativeInteger = (value: number | undefined, fallback: number): number =>
  value === undefined || !Number.isFinite(value) ? fallback : Math.max(0, Math.floor(value));

export const selectLedgerEvents = (
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
  const kindClause = kinds.length === 0 ? "" : ` AND kind IN (${kinds.map(() => "?").join(", ")})`;
  const limitClause = opts.limit === undefined ? "" : " LIMIT ?";
  const args =
    opts.limit === undefined ? [scope, afterId, ...kinds] : [scope, afterId, ...kinds, opts.limit];
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
        kind: sqlText(r.kind, "events.kind"),
        scope: sqlText(r.scope, "events.scope"),
        payload: JSON.parse(sqlText(r.payload, "events.payload")) as unknown,
      }),
    );
};

export const LedgerLive = (storage: DurableObjectState): Layer.Layer<Ledger, SqlError, EventBus> =>
  Layer.scoped(
    Ledger,
    Effect.gen(function* () {
      const sql = storage.storage.sql;
      yield* Effect.try({
        try: () => ensureLedgerSchema(sql),
        catch: (cause) => new SqlError({ cause }),
      });
      const bus = yield* EventBus;

      return {
        commit: (events) =>
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;
            const result = yield* commitLedgerTransaction(storage, bus, (tx) => {
              for (const event of events) {
                tx.append({
                  ts: event.ts ?? now,
                  kind: event.kind,
                  scope: event.scope,
                  payload: event.payload,
                });
              }
            });
            return result.events;
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
                        normalizeNonNegativeInteger(opts.limit, DEFAULT_EVENT_LIMIT),
                      ),
                    );
              return selectLedgerEvents(sql, scope, { ...opts, limit });
            },
            catch: (cause) => new SqlError({ cause }),
          }),
        streamSnapshot: (scope, opts = {}) =>
          Effect.try({
            try: () => selectLedgerEvents(sql, scope, opts),
            catch: (cause) => new SqlError({ cause }),
          }),
      };
    }),
  );

/** Pure helper shared by `Cloudflare backend.events()` and the SSE stream
 *  encoder: project a stored LedgerEvent into the RPC-safe shape. Lives
 *  here so both façade callers and `./stream.ts` reach the same
 *  serialization without re-deriving it. */
export const eventToRpc = (event: LedgerEvent): LedgerEventRpc => ({
  id: event.id,
  ts: event.ts,
  kind: event.kind,
  scope: event.scope,
  payload: event.payload,
});
