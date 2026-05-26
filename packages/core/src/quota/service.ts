/**
 * Quota service (module-private).
 *
 * Atomic pre-grant + consume on the same DO SQLite via transactionSync.
 * Concurrent submits in the same scope cannot both observe stale consumption
 * because the read-modify-write happens in a single transaction.
 *
 * Writes either:
 *   - dispatch.consumed (grant) — counts toward future quota checks
 *   - dispatch.rate_limited (deny) — observation only
 *
 * Both writes go through raw sql.exec inside transactionSync (so they're
 * atomic with the read). The service then fires EventBus.fire(event) AFTER
 * commit, so `on(kind, handler)` subscribers still see the event.
 */

import { Clock, Context, Effect, Layer } from "effect";
import { EventBus } from "../ledger";
import { JsonStringifyError, SqlError, safeStringify } from "../errors";
import type { LedgerEvent } from "../types";
import { decodeConsumedPayloadSync } from "./payload";

export interface GrantResult {
  readonly granted: boolean;
  readonly consumed: number;
  readonly limit: number;
}

/** Owned schema for events.kind = 'dispatch.consumed' payload. We are the
 *  sole writer (consumedPayload below), so any shape mismatch read back is
 *  infra corruption — let Schema.decodeUnknownSync throw, transactionSync
 *  rolls back, and Effect.try wraps it as SqlError. This is the same
 *  failure path as JSON.parse failure, by construction. */
export class Quota extends Context.Tag("@agent-os/Quota")<
  Quota,
  {
    readonly tryGrant: (
      scope: string,
      key: string,
      amount: number,
      windowMs: number,
      limit: number,
      toolName: string,
    ) => Effect.Effect<GrantResult, SqlError | JsonStringifyError>;
  }
>() {}

export const QuotaLive = (
  ctx: DurableObjectState,
): Layer.Layer<Quota, never, EventBus> =>
  Layer.scoped(
    Quota,
    Effect.gen(function* () {
      const sql = ctx.storage.sql;
      const bus = yield* EventBus;

      return {
        tryGrant: (scope, key, amount, windowMs, limit, toolName) =>
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;
            const windowStart =
              windowMs === Number.POSITIVE_INFINITY ? 0 : now - windowMs;

            // Pre-stringify payloads outside transaction (transactionSync
            // callback is synchronous; we can't yield* inside).
            const consumedPayload = {
              key,
              amount,
              toolName,
            };
            const consumedStr = yield* safeStringify(consumedPayload);

            const txResult = yield* Effect.try({
              try: () =>
                ctx.storage.transactionSync(() => {
                  const rows = sql
                    .exec(
                      "SELECT payload FROM events WHERE scope = ? AND kind = 'dispatch.consumed' AND ts >= ?",
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
                      JSON.parse(String(r.payload)),
                    );
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
                    const rateLimitedStr = JSON.stringify(rateLimitedPayload);
                    const cursor = sql.exec(
                      "INSERT INTO events (ts, kind, scope, payload) VALUES (?, ?, ?, ?) RETURNING id",
                      now,
                      "dispatch.rate_limited",
                      scope,
                      rateLimitedStr,
                    );
                    const id = Number(cursor.one().id);
                    return {
                      granted: false as const,
                      consumed,
                      event: {
                        id,
                        ts: now,
                        kind: "dispatch.rate_limited",
                        scope,
                        payload: rateLimitedPayload,
                      } satisfies LedgerEvent,
                    };
                  }

                  const cursor = sql.exec(
                    "INSERT INTO events (ts, kind, scope, payload) VALUES (?, ?, ?, ?) RETURNING id",
                    now,
                    "dispatch.consumed",
                    scope,
                    consumedStr,
                  );
                  const id = Number(cursor.one().id);
                  return {
                    granted: true as const,
                    consumed,
                    event: {
                      id,
                      ts: now,
                      kind: "dispatch.consumed",
                      scope,
                      payload: consumedPayload,
                    } satisfies LedgerEvent,
                  };
                }),
              catch: (cause) => new SqlError({ cause }),
            });

            // Fire EventBus AFTER commit (sql.exec inside transactionSync
            // bypassed Ledger.log, which normally fires the bus).
            yield* bus.fire(txResult.event);

            return {
              granted: txResult.granted,
              consumed: txResult.consumed,
              limit,
            } satisfies GrantResult;
          }),
      };
    }),
  );
