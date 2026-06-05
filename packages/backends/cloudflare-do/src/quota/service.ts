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
import { Quota, type GrantResult } from "@agent-os/runtime";
import { EventBus } from "../ledger";
import { sqlText } from "../storage/sql-row";
import { decodeConsumedPayloadSync } from "./payload";
import { commitLedgerTransaction } from "../ledger/commit";

/** Owned schema for events.kind = 'quota.consumed' payload. We are the
 *  sole writer (consumedPayload below), so any shape mismatch read back is
 *  infra corruption — let Schema.decodeUnknownSync throw, transactionSync
 *  rolls back, and Effect.try wraps it as SqlError. This is the same
 *  failure path as JSON.parse failure, by construction. */
export const QuotaLive = (ctx: DurableObjectState): Layer.Layer<Quota, never, EventBus> =>
  Layer.scoped(
    Quota,
    Effect.gen(function* () {
      const sql = ctx.storage.sql;
      const bus = yield* EventBus;

      return {
        tryGrant: (scope, key, amount, windowMs, limit, toolName, operationRef) =>
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;
            const windowStart = windowMs === Number.POSITIVE_INFINITY ? 0 : now - windowMs;

            const consumedPayload = {
              key,
              amount,
              toolName,
              operationRef,
            };

            const txResult = yield* commitLedgerTransaction(ctx, bus, (tx) => {
              const rows = sql
                .exec(
                  "SELECT payload FROM events WHERE scope = ? AND kind = 'quota.consumed' AND ts >= ?",
                  scope,
                  windowStart,
                )
                .toArray();
              let consumed = 0;
              for (const r of rows) {
                // Decode through owned schema. JSON.parse failure OR
                // shape mismatch both throw → tx rolls back → Effect.try
                // wraps as SqlError. Single owned failure path; no
                // silent skip, no NaN propagation, no undercount.
                const p = decodeConsumedPayloadSync(
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
                  kind: "quota.rate_limited",
                  scope,
                  payload: rateLimitedPayload,
                });
                return {
                  granted: false as const,
                  consumed,
                };
              }

              tx.append({
                ts: now,
                kind: "quota.consumed",
                scope,
                payload: consumedPayload,
              });
              return {
                granted: true as const,
                consumed,
              };
            });

            return {
              granted: txResult.value.granted,
              consumed: txResult.value.consumed,
              limit,
            } satisfies GrantResult;
          }),
      };
    }),
  );
