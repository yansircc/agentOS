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
import { Ledger, RUNTIME_FACT_OWNER } from "@agent-os/runtime";
import { EventBus } from "./event-bus";
import { commitLedgerTransaction, ensureLedgerSchema } from "./commit";
import {
  ledgerEventFromRow,
  ledgerIdentityKeys,
  truthIdentityFromCommitSpec,
  type LedgerEventSqlRow,
} from "./identity";
import type { BackendProtocolTruthIdentity } from "@agent-os/backend-protocol";

const DEFAULT_EVENT_LIMIT = 1000;
const MAX_EVENT_LIMIT = 1000;

const normalizeNonNegativeInteger = (value: number | undefined, fallback: number): number =>
  value === undefined || !Number.isFinite(value) ? fallback : Math.max(0, Math.floor(value));

const sameJson = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

const queryMatchesTruthIdentity = (
  identity: BackendProtocolTruthIdentity,
  opts: Pick<EventQueryOptions, "scopeRef" | "effectAuthorityRef">,
): boolean => {
  if (opts.scopeRef !== undefined && !sameJson(opts.scopeRef, identity.scopeRef)) return false;
  if (
    opts.effectAuthorityRef !== undefined &&
    !sameJson(opts.effectAuthorityRef, identity.effectAuthorityRef)
  ) {
    return false;
  }
  return true;
};

export const selectLedgerEvents = (
  sql: SqlStorage,
  identity: BackendProtocolTruthIdentity,
  opts: Pick<EventQueryOptions, "afterId" | "kinds"> & {
    readonly limit?: number;
    readonly factOwnerRefs?: EventQueryOptions["factOwnerRefs"];
    readonly scopeRef?: EventQueryOptions["scopeRef"];
    readonly effectAuthorityRef?: EventQueryOptions["effectAuthorityRef"];
  },
): ReadonlyArray<LedgerEvent> => {
  ensureLedgerSchema(sql);
  if (!queryMatchesTruthIdentity(identity, opts)) return [];
  const afterId = normalizeNonNegativeInteger(opts.afterId, 0);
  const kinds =
    opts.kinds === undefined
      ? []
      : Array.from(new Set(opts.kinds)).filter((kind) => kind.length > 0);
  const factOwnerRefs =
    opts.factOwnerRefs === undefined
      ? []
      : Array.from(new Set(opts.factOwnerRefs)).filter((factOwnerRef) => factOwnerRef.length > 0);
  const kindClause = kinds.length === 0 ? "" : ` AND kind IN (${kinds.map(() => "?").join(", ")})`;
  const ownerClause =
    factOwnerRefs.length === 0
      ? ""
      : ` AND fact_owner_ref IN (${factOwnerRefs.map(() => "?").join(", ")})`;
  const limitClause = opts.limit === undefined ? "" : " LIMIT ?";
  const keys = ledgerIdentityKeys({ ...identity, factOwnerRef: RUNTIME_FACT_OWNER });
  const args =
    opts.limit === undefined
      ? [keys.scopeKey, keys.effectAuthorityKey, afterId, ...kinds, ...factOwnerRefs]
      : [keys.scopeKey, keys.effectAuthorityKey, afterId, ...kinds, ...factOwnerRefs, opts.limit];
  return sql
    .exec(
      `
        SELECT *
        FROM events
        WHERE scope_key = ? AND effect_authority_key = ? AND id > ?
          ${kindClause}${ownerClause}
        ORDER BY id ASC${limitClause}
      `,
      ...args,
    )
    .toArray()
    .map((r): LedgerEvent => ledgerEventFromRow(r as unknown as LedgerEventSqlRow));
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
            const result = yield* commitLedgerTransaction(
              storage,
              bus,
              { factOwnerRef: RUNTIME_FACT_OWNER },
              (tx) => {
                for (const event of events) {
                  const identity = truthIdentityFromCommitSpec(
                    event,
                    "runtime ledger commit event",
                  );
                  tx.append({
                    ts: event.ts ?? now,
                    kind: event.kind,
                    scopeRef: identity.scopeRef,
                    effectAuthorityRef: identity.effectAuthorityRef,
                    payload: event.payload,
                  });
                }
              },
            );
            return result.events;
          }),
        events: (identity, opts = {}) =>
          Effect.try({
            try: () => {
              const truthIdentity = truthIdentityFromCommitSpec(identity, "ledger events query");
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
              return selectLedgerEvents(sql, truthIdentity, { ...opts, limit });
            },
            catch: (cause) => new SqlError({ cause }),
          }),
        streamSnapshot: (identity, opts = {}) =>
          Effect.try({
            try: () =>
              selectLedgerEvents(
                sql,
                truthIdentityFromCommitSpec(identity, "ledger stream query"),
                opts,
              ),
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
  scopeRef: event.scopeRef,
  factOwnerRef: event.factOwnerRef,
  effectAuthorityRef: event.effectAuthorityRef,
  payload: event.payload,
});
