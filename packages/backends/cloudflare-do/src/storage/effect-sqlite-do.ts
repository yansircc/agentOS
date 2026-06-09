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
import { ledgerEventFromRow, ledgerIdentityKeys, type LedgerEventSqlRow } from "../ledger/identity";
import type { BackendProtocolTruthIdentity } from "@agent-os/backend-protocol";
import { RUNTIME_FACT_OWNER } from "@agent-os/runtime-protocol";

interface EffectSqlLedgerEventRow {
  readonly id: number;
  readonly ts: number;
  readonly kind: string;
  readonly scope_ref: string;
  readonly scope_key: string;
  readonly fact_owner_ref: string;
  readonly fact_owner_key: string;
  readonly effect_authority_ref: string;
  readonly effect_authority_key: string;
  readonly event_identity_key: string;
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
  identity: BackendProtocolTruthIdentity,
  opts: Pick<EventQueryOptions, "afterId" | "limit"> = {},
): Effect.Effect<ReadonlyArray<LedgerEvent>, SqlError, SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const afterId = normalizeNonNegativeInteger(opts.afterId, 0);
    const limit = normalizeLimit(opts.limit);
    const keys = ledgerIdentityKeys({ ...identity, factOwnerRef: RUNTIME_FACT_OWNER });
    const rows = yield* sql<EffectSqlLedgerEventRow>`
      SELECT
        id,
        ts,
        kind,
        scope_ref,
        scope_key,
        fact_owner_ref,
        fact_owner_key,
        effect_authority_ref,
        effect_authority_key,
        event_identity_key,
        payload
      FROM events
      WHERE scope_key = ${keys.scopeKey}
        AND effect_authority_key = ${keys.effectAuthorityKey}
        AND id > ${afterId}
      ORDER BY id ASC
      LIMIT ${limit}
    `.pipe(Effect.mapError((cause) => new SqlError({ cause })));

    return yield* Effect.try({
      try: () => rows.map((row) => ledgerEventFromRow(row as unknown as LedgerEventSqlRow)),
      catch: (cause) => new SqlError({ cause }),
    });
  });
