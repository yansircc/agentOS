/**
 * Resources — business resource reservation over ledger facts.
 *
 * This is deliberately not Quota. Quota is dispatch/rate consumption.
 * Resources owns reserve-now, consume-or-release-later state for app
 * resources such as img-gen credits.
 *
 * SSoT: only `events.kind = resource.*`. There is no account table and no
 * reservation table. Projection (`./projection.ts`) rebuilds balance from
 * ledger rows inside the same `transactionSync` that writes the next
 * resource event.
 */

import { Clock, Context, Effect, Layer } from "effect";
import {
  InvalidResourceAmount,
  JsonStringifyError,
  ResourceInsufficient,
  ResourceReservationClosed,
  ResourceReservationNotFound,
  SqlError,
  safeStringify,
} from "../errors";
import { EventBus } from "../ledger";
import type {
  LedgerEvent,
  ResourceGrantResult,
  ResourceGrantSpec,
  ResourceReservationSpec,
  ResourceReserveResult,
  ResourceReserveSpec,
} from "../types";

import {
  emptyProjection,
  loadState,
  type ResourceProjection,
} from "./projection";

// Re-export the projection shape so callers that historically imported
// it from "./resources" keep working.
export type { ResourceProjection } from "./projection";

export class Resources extends Context.Tag("@agent-os/Resources")<
  Resources,
  {
    readonly grant: (
      scope: string,
      spec: ResourceGrantSpec,
    ) => Effect.Effect<
      ResourceGrantResult,
      SqlError | JsonStringifyError | InvalidResourceAmount
    >;
    readonly reserve: (
      scope: string,
      spec: ResourceReserveSpec,
    ) => Effect.Effect<
      ResourceReserveResult,
      | SqlError
      | JsonStringifyError
      | InvalidResourceAmount
      | ResourceInsufficient
    >;
    readonly consume: (
      scope: string,
      spec: ResourceReservationSpec,
    ) => Effect.Effect<
      void,
      | SqlError
      | JsonStringifyError
      | ResourceReservationNotFound
      | ResourceReservationClosed
    >;
    readonly release: (
      scope: string,
      spec: ResourceReservationSpec,
    ) => Effect.Effect<
      void,
      | SqlError
      | JsonStringifyError
      | ResourceReservationNotFound
      | ResourceReservationClosed
    >;
    readonly project: (
      scope: string,
      key: string,
    ) => Effect.Effect<ResourceProjection, SqlError>;
  }
>() {}

const ensureEventsSchema = (sql: SqlStorage): Effect.Effect<void, SqlError> =>
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

const assertPositiveAmount = (
  amount: number,
): Effect.Effect<void, InvalidResourceAmount> =>
  Number.isFinite(amount) && amount > 0
    ? Effect.void
    : Effect.fail(new InvalidResourceAmount({ amount }));

export const ResourcesLive = (
  ctx: DurableObjectState,
): Layer.Layer<Resources, SqlError, EventBus> => {
  const sql = ctx.storage.sql;
  return Layer.scoped(
    Resources,
    Effect.gen(function* () {
      yield* ensureEventsSchema(sql);
      const bus = yield* EventBus;

      const insertEvent = (
        now: number,
        kind: string,
        scope: string,
        payloadStr: string,
        payload: unknown,
      ): LedgerEvent => {
        const cursor = sql.exec(
          "INSERT INTO events (ts, kind, scope, payload) VALUES (?, ?, ?, ?) RETURNING id",
          now,
          kind,
          scope,
          payloadStr,
        );
        return {
          id: Number(cursor.one().id),
          ts: now,
          kind,
          scope,
          payload,
        };
      };

      return {
        grant: (scope, spec) =>
          Effect.gen(function* () {
            yield* assertPositiveAmount(spec.amount);
            const now = yield* Clock.currentTimeMillis;
            const payload = {
              key: spec.key,
              amount: spec.amount,
              ref: spec.ref,
            };
            const payloadStr = yield* safeStringify(payload);
            const event = yield* Effect.try({
              try: () =>
                ctx.storage.transactionSync(() =>
                  insertEvent(now, "resource.granted", scope, payloadStr, payload),
                ),
              catch: (cause) => new SqlError({ cause }),
            });
            yield* bus.fire(event);
            return { eventId: event.id };
          }),

        reserve: (scope, spec) =>
          Effect.gen(function* () {
            yield* assertPositiveAmount(spec.amount);
            const now = yield* Clock.currentTimeMillis;
            const reservationId = crypto.randomUUID();

            const tx = yield* Effect.try({
              try: () =>
                ctx.storage.transactionSync(() => {
                  const projected = loadState(sql, scope);
                  const existing = projected.byIdempotencyKey.get(
                    spec.idempotencyKey,
                  );
                  if (existing !== undefined) {
                    return {
                      status: "existing" as const,
                      reservationId: existing.reservationId,
                      event: null,
                    };
                  }

                  const current =
                    projected.byKey.get(spec.key) ?? emptyProjection();
                  if (current.available < spec.amount) {
                    const rejectedPayload = {
                      key: spec.key,
                      amount: spec.amount,
                      ref: spec.ref,
                      idempotencyKey: spec.idempotencyKey,
                      available: current.available,
                    };
                    const event = insertEvent(
                      now,
                      "resource.reserve_rejected",
                      scope,
                      JSON.stringify(rejectedPayload),
                      rejectedPayload,
                    );
                    return {
                      status: "insufficient" as const,
                      available: current.available,
                      event,
                    };
                  }

                  const reservedPayload = {
                    key: spec.key,
                    amount: spec.amount,
                    ref: spec.ref,
                    idempotencyKey: spec.idempotencyKey,
                    reservationId,
                  };
                  const event = insertEvent(
                    now,
                    "resource.reserved",
                    scope,
                    JSON.stringify(reservedPayload),
                    reservedPayload,
                  );
                  return {
                    status: "reserved" as const,
                    reservationId,
                    event,
                  };
                }),
              catch: (cause) => new SqlError({ cause }),
            });

            if (tx.event !== null) {
              yield* bus.fire(tx.event);
            }
            if (tx.status === "insufficient") {
              return yield* Effect.fail(
                new ResourceInsufficient({
                  key: spec.key,
                  requested: spec.amount,
                  available: tx.available,
                }),
              );
            }
            return { reservationId: tx.reservationId };
          }),

        consume: (scope, spec) =>
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;
            const tx = yield* Effect.try({
              try: () =>
                ctx.storage.transactionSync(() => {
                  const projected = loadState(sql, scope);
                  const reservation = projected.byId.get(spec.reservationId);
                  if (reservation === undefined) {
                    return { status: "missing" as const, event: null };
                  }
                  if (reservation.status === "consumed") {
                    return { status: "noop" as const, event: null };
                  }
                  if (reservation.status === "released") {
                    return { status: "closed" as const, closed: "released" as const, event: null };
                  }
                  const payload = {
                    reservationId: spec.reservationId,
                    ref: spec.ref,
                  };
                  const event = insertEvent(
                    now,
                    "resource.consumed",
                    scope,
                    JSON.stringify(payload),
                    payload,
                  );
                  return { status: "written" as const, event };
                }),
              catch: (cause) => new SqlError({ cause }),
            });
            if (tx.status === "missing") {
              return yield* Effect.fail(
                new ResourceReservationNotFound({
                  reservationId: spec.reservationId,
                }),
              );
            }
            if (tx.status === "closed") {
              return yield* Effect.fail(
                new ResourceReservationClosed({
                  reservationId: spec.reservationId,
                  status: tx.closed,
                }),
              );
            }
            if (tx.event !== null) {
              yield* bus.fire(tx.event);
            }
          }),

        release: (scope, spec) =>
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;
            const tx = yield* Effect.try({
              try: () =>
                ctx.storage.transactionSync(() => {
                  const projected = loadState(sql, scope);
                  const reservation = projected.byId.get(spec.reservationId);
                  if (reservation === undefined) {
                    return { status: "missing" as const, event: null };
                  }
                  if (reservation.status === "released") {
                    return { status: "noop" as const, event: null };
                  }
                  if (reservation.status === "consumed") {
                    return { status: "closed" as const, closed: "consumed" as const, event: null };
                  }
                  const payload = {
                    reservationId: spec.reservationId,
                    ref: spec.ref,
                  };
                  const event = insertEvent(
                    now,
                    "resource.released",
                    scope,
                    JSON.stringify(payload),
                    payload,
                  );
                  return { status: "written" as const, event };
                }),
              catch: (cause) => new SqlError({ cause }),
            });
            if (tx.status === "missing") {
              return yield* Effect.fail(
                new ResourceReservationNotFound({
                  reservationId: spec.reservationId,
                }),
              );
            }
            if (tx.status === "closed") {
              return yield* Effect.fail(
                new ResourceReservationClosed({
                  reservationId: spec.reservationId,
                  status: tx.closed,
                }),
              );
            }
            if (tx.event !== null) {
              yield* bus.fire(tx.event);
            }
          }),

        project: (scope, key) =>
          Effect.try({
            try: () => loadState(sql, scope).byKey.get(key) ?? emptyProjection(),
            catch: (cause) => new SqlError({ cause }),
          }),
      };
    }),
  );
};
