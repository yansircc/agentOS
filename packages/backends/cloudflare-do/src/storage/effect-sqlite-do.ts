import type { LedgerEvent } from "@agent-os/kernel/types";
/**
 * Internal Cloudflare-only Effect SQL facade.
 *
 * Boundary: this layer may own read/query ergonomics and future migrations.
 * It must not replace the repo-owned `DurableObjectState.transactionSync`
 * blocks used for read-decide-write atomicity.
 */

import { SqlClient } from "@effect/sql/SqlClient";
import { layer as sqliteDoLayer } from "@effect/sql-sqlite-do/SqliteClient";
import { Effect } from "effect";
import { SqlError } from "@agent-os/kernel/errors";
import type { EventQueryOptions } from "@agent-os/kernel/types";
import { sqlText } from "./sql-row";

interface LedgerEventSqlRow {
  readonly id: number;
  readonly ts: number;
  readonly kind: string;
  readonly scope: string;
  readonly payload: string;
}

const DEFAULT_LIMIT = 1000;
const MAX_LIMIT = 1000;

const normalizeNonNegativeInteger = (value: number | undefined, fallback: number): number =>
  value === undefined || !Number.isFinite(value) ? fallback : Math.max(0, Math.floor(value));

const normalizeLimit = (limit: number | undefined): number =>
  Math.min(MAX_LIMIT, normalizeNonNegativeInteger(limit, DEFAULT_LIMIT));

export const EffectSqliteDoReadLive = (sql: SqlStorage) => sqliteDoLayer({ db: sql });

export const selectLedgerEventsWithEffectSql = (
  scope: string,
  opts: Pick<EventQueryOptions, "afterId" | "limit"> = {},
): Effect.Effect<ReadonlyArray<LedgerEvent>, SqlError, SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const afterId = normalizeNonNegativeInteger(opts.afterId, 0);
    const limit = normalizeLimit(opts.limit);
    const rows = yield* sql<LedgerEventSqlRow>`
      SELECT id, ts, kind, scope, payload
      FROM events
      WHERE scope = ${scope}
        AND id > ${afterId}
      ORDER BY id ASC
      LIMIT ${limit}
    `.pipe(Effect.mapError((cause) => new SqlError({ cause })));

    return yield* Effect.try({
      try: () =>
        rows.map((row) => ({
          id: Number(row.id),
          ts: Number(row.ts),
          kind: sqlText(row.kind, "events.kind"),
          scope: sqlText(row.scope, "events.scope"),
          payload: JSON.parse(sqlText(row.payload, "events.payload")) as unknown,
        })),
      catch: (cause) => new SqlError({ cause }),
    });
  });
