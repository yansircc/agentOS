/**
 * Quota service (module-private).
 *
 * Atomic pre-grant + consume on the same DO SQLite via transactionSync.
 * Concurrent submits in the same scope cannot both observe stale consumption
 * because the read-modify-write happens in a single transaction.
 *
 * Writes either:
 *   - quota.consumed (grant) — counts toward future quota checks
 *   - quota.rate_limited (deny) — observation only
 *
 * Both writes go through raw sql.exec inside transactionSync (so they're
 * atomic with the read). The service then fires EventBus.fire(event) AFTER
 * commit, so `on(kind, handler)` subscribers still see the event.
 */

import { Clock, Effect, Layer } from "effect";
import { Quota } from "@agent-os/runtime";
import {
  decodeQuotaConsumedPayloadSync,
  QUOTA_EVENT_KIND,
  type GrantResult,
} from "@agent-os/backend-protocol";
import { EventBus } from "../ledger";
import { sqlText } from "../storage/sql-row";
import { commitLedgerTransaction } from "../ledger/commit";
import { eventIdentity, eventIdentityColumns } from "../ledger/identity";
import type { BackendProtocolEventIdentity } from "@agent-os/backend-protocol";

/** Protocol-owned schema for events.kind = 'quota.consumed' payload.
 *  Any shape mismatch read back is infra corruption: the protocol decoder
 *  throws, transactionSync rolls back, and Effect.try wraps it as SqlError. */
export const QuotaLive = (
  ctx: DurableObjectState,
  ownerIdentity: BackendProtocolEventIdentity,
): Layer.Layer<Quota, never, EventBus> =>
  Layer.effect(
    Quota,
    Effect.gen(function* () {
      const sql = ctx.storage.sql;
      const bus = yield* EventBus;

      return {
        tryGrant: (identity, key, amount, windowMs, limit, toolName, operationRef) =>
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;
            const windowStart = windowMs === Number.POSITIVE_INFINITY ? 0 : now - windowMs;
            const columns = eventIdentityColumns(
              eventIdentity(identity, ownerIdentity.factOwnerRef),
            );

            const consumedPayload = {
              key,
              amount,
              toolName,
              operationRef,
            };

            const txResult = yield* commitLedgerTransaction(
              ctx,
              bus,
              { factOwnerRef: ownerIdentity.factOwnerRef },
              (tx) => {
                const rows = sql
                  .exec(
                    "SELECT payload FROM events WHERE event_identity_key = ? AND kind = ? AND ts >= ?",
                    columns.event_identity_key,
                    QUOTA_EVENT_KIND.CONSUMED,
                    windowStart,
                  )
                  .toArray();
                let consumed = 0;
                for (const r of rows) {
                  // Decode through owned schema. JSON.parse failure OR
                  // shape mismatch both throw → tx rolls back → Effect.try
                  // wraps as SqlError. Single owned failure path; no
                  // silent skip, no NaN propagation, no undercount.
                  const p = decodeQuotaConsumedPayloadSync(
                    JSON.parse(sqlText(r.payload, "events.payload")),
                  );
                  if (p.key === key && p.operationRef === operationRef) {
                    return {
                      granted: true as const,
                      consumed,
                    };
                  }
                  if (p.key === key) {
                    consumed += p.amount;
                  }
                }

                if (consumed + amount > limit) {
                  const rateLimitedPayload = {
                    key,
                    attempted: amount,
                    consumed,
                    limit,
                    windowMs,
                    toolName,
                  };
                  tx.append({
                    ts: now,
                    kind: QUOTA_EVENT_KIND.RATE_LIMITED,
                    scopeRef: identity.scopeRef,
                    effectAuthorityRef: identity.effectAuthorityRef,
                    payload: rateLimitedPayload,
                  });
                  return {
                    granted: false as const,
                    consumed,
                  };
                }

                tx.append({
                  ts: now,
                  kind: QUOTA_EVENT_KIND.CONSUMED,
                  scopeRef: identity.scopeRef,
                  effectAuthorityRef: identity.effectAuthorityRef,
                  payload: consumedPayload,
                });
                return {
                  granted: true as const,
                  consumed,
                };
              },
            );

            return {
              granted: txResult.value.granted,
              consumed: txResult.value.consumed,
              limit,
            } satisfies GrantResult;
          }),
      };
    }),
  );
