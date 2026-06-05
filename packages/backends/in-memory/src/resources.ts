import { Clock, Effect, Layer } from "effect";
import {
  InvalidResourceAmount,
  ResourceInsufficient,
  ResourceReservationClosed,
  ResourceReservationNotFound,
  SqlError,
} from "@agent-os/kernel/errors";
import type { LedgerEvent } from "@agent-os/kernel/types";
import { Resources, type LedgerTruthIdentity, type ResourceProjection } from "@agent-os/runtime";
import {
  inMemoryRuntimeEventIdentity,
  type InMemoryBackendState,
} from "./state";
import { decodeOk, finiteNumberField, recordOf, stringField, type DecodeResult } from "./decode";

interface ReservationState {
  readonly reservationId: string;
  readonly key: string;
  readonly amount: number;
  readonly idempotencyKey: string;
  readonly status: "active" | "consumed" | "released";
}

interface ProjectedResourceState {
  readonly byId: Map<string, ReservationState>;
  readonly byIdempotencyKey: Map<string, ReservationState>;
  readonly byKey: Map<string, ResourceProjection>;
}

const emptyResourceProjection = (): ResourceProjection => ({
  available: 0,
  reserved: 0,
  consumed: 0,
});

const positiveAmount = (amount: number): Effect.Effect<void, InvalidResourceAmount> =>
  Number.isFinite(amount) && amount > 0
    ? Effect.void
    : Effect.fail(new InvalidResourceAmount({ amount }));

const addResourceProjection = (
  map: Map<string, ResourceProjection>,
  key: string,
  delta: Partial<ResourceProjection>,
): void => {
  const current = map.get(key) ?? emptyResourceProjection();
  map.set(key, {
    available: current.available + (delta.available ?? 0),
    reserved: current.reserved + (delta.reserved ?? 0),
    consumed: current.consumed + (delta.consumed ?? 0),
  });
};

const projectResources = (
  events: ReadonlyArray<LedgerEvent>,
): DecodeResult<ProjectedResourceState> => {
  const grants: Array<{ readonly key: string; readonly amount: number }> = [];
  const reservations = new Map<string, ReservationState>();
  const byIdempotencyKey = new Map<string, ReservationState>();

  for (const event of events) {
    if (!event.kind.startsWith("resource_pool.")) continue;
    const payloadResult = recordOf(event.payload, event.kind);
    if (!payloadResult.ok) return payloadResult;
    const payload = payloadResult.value;
    switch (event.kind) {
      case "resource_pool.granted": {
        const key = stringField(payload, "key");
        if (!key.ok) return key;
        const amount = finiteNumberField(payload, "amount");
        if (!amount.ok) return amount;
        grants.push({
          key: key.value,
          amount: amount.value,
        });
        break;
      }
      case "resource_pool.reserved": {
        const reservationId = stringField(payload, "reservationId");
        if (!reservationId.ok) return reservationId;
        const key = stringField(payload, "key");
        if (!key.ok) return key;
        const amount = finiteNumberField(payload, "amount");
        if (!amount.ok) return amount;
        const idempotencyKey = stringField(payload, "idempotencyKey");
        if (!idempotencyKey.ok) return idempotencyKey;
        const reservation: ReservationState = {
          reservationId: reservationId.value,
          key: key.value,
          amount: amount.value,
          idempotencyKey: idempotencyKey.value,
          status: "active",
        };
        reservations.set(reservation.reservationId, reservation);
        byIdempotencyKey.set(reservation.idempotencyKey, reservation);
        break;
      }
      case "resource_pool.reserve_rejected": {
        const key = stringField(payload, "key");
        if (!key.ok) return key;
        const amount = finiteNumberField(payload, "amount");
        if (!amount.ok) return amount;
        const idempotencyKey = stringField(payload, "idempotencyKey");
        if (!idempotencyKey.ok) return idempotencyKey;
        const available = finiteNumberField(payload, "available");
        if (!available.ok) return available;
        break;
      }
      case "resource_pool.consumed":
      case "resource_pool.released": {
        const reservationId = stringField(payload, "reservationId");
        if (!reservationId.ok) return reservationId;
        const existing = reservations.get(reservationId.value);
        if (existing !== undefined) {
          const next = {
            ...existing,
            status: event.kind === "resource_pool.consumed" ? "consumed" : "released",
          } satisfies ReservationState;
          reservations.set(reservationId.value, next);
          byIdempotencyKey.set(next.idempotencyKey, next);
        }
        break;
      }
    }
  }

  const byKey = new Map<string, ResourceProjection>();
  for (const grant of grants) {
    addResourceProjection(byKey, grant.key, { available: grant.amount });
  }
  for (const reservation of reservations.values()) {
    if (reservation.status === "active") {
      addResourceProjection(byKey, reservation.key, {
        available: -reservation.amount,
        reserved: reservation.amount,
      });
    } else if (reservation.status === "consumed") {
      addResourceProjection(byKey, reservation.key, {
        available: -reservation.amount,
        consumed: reservation.amount,
      });
    }
  }

  return decodeOk({ byId: reservations, byIdempotencyKey, byKey });
};

const loadResourceState = (
  state: InMemoryBackendState,
  identity: LedgerTruthIdentity,
): Effect.Effect<ProjectedResourceState, SqlError> =>
  Effect.sync(() => projectResources(state.eventSnapshot(inMemoryRuntimeEventIdentity(identity)))).pipe(
    Effect.flatMap((result) =>
      result.ok ? Effect.succeed(result.value) : Effect.fail(new SqlError({ cause: result.cause })),
    ),
  );

export const InMemoryResourcesLive = (state: InMemoryBackendState): Layer.Layer<Resources> =>
  Layer.succeed(Resources, {
    grant: (identity, spec) =>
      Effect.gen(function* () {
        yield* positiveAmount(spec.amount);
        const ts = yield* Clock.currentTimeMillis;
        const [event] = yield* state.commitEvents([
          {
            ts,
            kind: "resource_pool.granted",
            ...identity,
            payload: { key: spec.key, amount: spec.amount, ref: spec.ref },
          },
        ]);
        return { eventId: event!.id };
      }),

    reserve: (identity, spec) =>
      Effect.gen(function* () {
        yield* positiveAmount(spec.amount);
        const ts = yield* Clock.currentTimeMillis;
        const projected = yield* loadResourceState(state, identity);
        const existing = projected.byIdempotencyKey.get(spec.idempotencyKey);
        if (existing !== undefined) return { reservationId: existing.reservationId };

        const current = projected.byKey.get(spec.key) ?? emptyResourceProjection();
        if (current.available < spec.amount) {
          yield* state.commitEvents([
            {
              ts,
              kind: "resource_pool.reserve_rejected",
              ...identity,
              payload: {
                key: spec.key,
                amount: spec.amount,
                ref: spec.ref,
                idempotencyKey: spec.idempotencyKey,
                available: current.available,
              },
            },
          ]);
          return yield* Effect.fail(
            new ResourceInsufficient({
              key: spec.key,
              requested: spec.amount,
              available: current.available,
            }),
          );
        }

        const reservationId = crypto.randomUUID();
        yield* state.commitEvents([
          {
            ts,
            kind: "resource_pool.reserved",
            ...identity,
            payload: {
              key: spec.key,
              amount: spec.amount,
              ref: spec.ref,
              idempotencyKey: spec.idempotencyKey,
              reservationId,
            },
          },
        ]);
        return { reservationId };
      }),

    consume: (identity, spec) =>
      Effect.gen(function* () {
        const ts = yield* Clock.currentTimeMillis;
        const projected = yield* loadResourceState(state, identity);
        const reservation = projected.byId.get(spec.reservationId);
        if (reservation === undefined) {
          return yield* Effect.fail(
            new ResourceReservationNotFound({ reservationId: spec.reservationId }),
          );
        }
        if (reservation.status === "consumed") return;
        if (reservation.status === "released") {
          return yield* Effect.fail(
            new ResourceReservationClosed({
              reservationId: spec.reservationId,
              status: "released",
            }),
          );
        }
        yield* state.commitEvents([
          {
            ts,
            kind: "resource_pool.consumed",
            ...identity,
            payload: { reservationId: spec.reservationId, ref: spec.ref },
          },
        ]);
      }),

    release: (identity, spec) =>
      Effect.gen(function* () {
        const ts = yield* Clock.currentTimeMillis;
        const projected = yield* loadResourceState(state, identity);
        const reservation = projected.byId.get(spec.reservationId);
        if (reservation === undefined) {
          return yield* Effect.fail(
            new ResourceReservationNotFound({ reservationId: spec.reservationId }),
          );
        }
        if (reservation.status === "released") return;
        if (reservation.status === "consumed") {
          return yield* Effect.fail(
            new ResourceReservationClosed({
              reservationId: spec.reservationId,
              status: "consumed",
            }),
          );
        }
        yield* state.commitEvents([
          {
            ts,
            kind: "resource_pool.released",
            ...identity,
            payload: { reservationId: spec.reservationId, ref: spec.ref },
          },
        ]);
      }),

    project: (identity, key) =>
      Effect.map(
        loadResourceState(state, identity),
        (projected) => projected.byKey.get(key) ?? emptyResourceProjection(),
      ),
  });
