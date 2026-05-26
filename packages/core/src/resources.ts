/**
 * Resources — business resource reservation over ledger facts.
 *
 * This is deliberately not Quota. Quota is dispatch/rate consumption.
 * Resources owns reserve-now, consume-or-release-later state for app
 * resources such as img-gen credits.
 *
 * SSoT: only `events.kind = resource.*`. There is no account table and no
 * reservation table. Projection rebuilds balance from ledger rows inside the
 * same `transactionSync` that writes the next resource event.
 */

import { Clock, Context, Effect, Layer, Schema } from "effect";
import {
  InvalidResourceAmount,
  JsonStringifyError,
  ResourceInsufficient,
  ResourceReservationClosed,
  ResourceReservationNotFound,
  SqlError,
  safeStringify,
} from "./errors";
import { EventBus } from "./ledger";
import type {
  LedgerEvent,
  ResourceGrantResult,
  ResourceGrantSpec,
  ResourceReservationSpec,
  ResourceReserveResult,
  ResourceReserveSpec,
} from "./types";

export interface ResourceProjection {
  readonly available: number;
  readonly reserved: number;
  readonly consumed: number;
}

type TerminalStatus = "active" | "consumed" | "released";

interface ReservationState {
  readonly reservationId: string;
  readonly key: string;
  readonly amount: number;
  readonly ref: string;
  readonly idempotencyKey: string;
  readonly status: TerminalStatus;
}

interface ProjectedState {
  readonly byId: Map<string, ReservationState>;
  readonly byIdempotencyKey: Map<string, ReservationState>;
  readonly byKey: Map<string, ResourceProjection>;
}

interface ResourceEventRow {
  readonly kind: unknown;
  readonly payload: unknown;
}

const GrantPayloadSchema = Schema.Struct({
  key: Schema.String,
  amount: Schema.Number.pipe(Schema.finite()),
  ref: Schema.String,
});
const ReservePayloadSchema = Schema.Struct({
  key: Schema.String,
  amount: Schema.Number.pipe(Schema.finite()),
  ref: Schema.String,
  idempotencyKey: Schema.String,
  reservationId: Schema.String,
});
const ReserveRejectedPayloadSchema = Schema.Struct({
  key: Schema.String,
  amount: Schema.Number.pipe(Schema.finite()),
  ref: Schema.String,
  idempotencyKey: Schema.String,
  available: Schema.Number.pipe(Schema.finite()),
});
const TerminalPayloadSchema = Schema.Struct({
  reservationId: Schema.String,
  ref: Schema.String,
});

const decodeGrantPayloadSync = Schema.decodeUnknownSync(GrantPayloadSchema);
const decodeReservePayloadSync = Schema.decodeUnknownSync(
  ReservePayloadSchema,
);
const decodeReserveRejectedPayloadSync = Schema.decodeUnknownSync(
  ReserveRejectedPayloadSchema,
);
const decodeTerminalPayloadSync = Schema.decodeUnknownSync(
  TerminalPayloadSchema,
);

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

const emptyProjection = (): ResourceProjection => ({
  available: 0,
  reserved: 0,
  consumed: 0,
});

const addProjection = (
  map: Map<string, ResourceProjection>,
  key: string,
  delta: Partial<ResourceProjection>,
): void => {
  const current = map.get(key) ?? emptyProjection();
  map.set(key, {
    available: current.available + (delta.available ?? 0),
    reserved: current.reserved + (delta.reserved ?? 0),
    consumed: current.consumed + (delta.consumed ?? 0),
  });
};

const projectRows = (
  rows: ReadonlyArray<ResourceEventRow>,
): ProjectedState => {
  const grants: Array<{ key: string; amount: number }> = [];
  const reservations = new Map<string, ReservationState>();
  const byIdempotencyKey = new Map<string, ReservationState>();

  for (const row of rows) {
    const kind = String(row.kind);
    const payload = JSON.parse(String(row.payload));
    switch (kind) {
      case "resource.granted": {
        const p = decodeGrantPayloadSync(payload);
        grants.push({ key: p.key, amount: p.amount });
        break;
      }
      case "resource.reserved": {
        const p = decodeReservePayloadSync(payload);
        const reservation: ReservationState = {
          reservationId: p.reservationId,
          key: p.key,
          amount: p.amount,
          ref: p.ref,
          idempotencyKey: p.idempotencyKey,
          status: "active",
        };
        reservations.set(p.reservationId, reservation);
        byIdempotencyKey.set(p.idempotencyKey, reservation);
        break;
      }
      case "resource.reserve_rejected": {
        decodeReserveRejectedPayloadSync(payload);
        break;
      }
      case "resource.consumed":
      case "resource.released": {
        const p = decodeTerminalPayloadSync(payload);
        const existing = reservations.get(p.reservationId);
        if (existing !== undefined) {
          const status = kind === "resource.consumed" ? "consumed" : "released";
          const next = { ...existing, status } satisfies ReservationState;
          reservations.set(p.reservationId, next);
          byIdempotencyKey.set(next.idempotencyKey, next);
        }
        break;
      }
      default:
        break;
    }
  }

  const byKey = new Map<string, ResourceProjection>();
  for (const grant of grants) {
    addProjection(byKey, grant.key, { available: grant.amount });
  }
  for (const reservation of reservations.values()) {
    if (reservation.status === "active") {
      addProjection(byKey, reservation.key, {
        available: -reservation.amount,
        reserved: reservation.amount,
      });
    } else if (reservation.status === "consumed") {
      addProjection(byKey, reservation.key, {
        available: -reservation.amount,
        consumed: reservation.amount,
      });
    }
  }

  return { byId: reservations, byIdempotencyKey, byKey };
};

const loadState = (
  sql: SqlStorage,
  scope: string,
): ProjectedState => {
  const rows = sql
    .exec(
      "SELECT kind, payload FROM events WHERE scope = ? AND kind LIKE 'resource.%' ORDER BY id",
      scope,
    )
        .toArray() as unknown as ResourceEventRow[];
  return projectRows(rows);
};

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
