import { Clock, Effect, Layer } from "effect";
import {
  InvalidResourceAmount,
  ResourceInsufficient,
  ResourceReservationClosed,
  ResourceReservationNotFound,
  SqlError,
} from "@agent-os/kernel/errors";
import { Resources } from "@agent-os/runtime";
import type { LedgerTruthIdentity } from "@agent-os/runtime-protocol";
import {
  emptyResourceProjection,
  projectResourceEvents,
  RESOURCE_EVENT_KIND,
  type ProjectedResourceState,
} from "@agent-os/backend-protocol";
import { inMemoryRuntimeEventIdentity, type InMemoryBackendState } from "./state";

const positiveAmount = (amount: number): Effect.Effect<void, InvalidResourceAmount> =>
  Number.isFinite(amount) && amount > 0
    ? Effect.void
    : Effect.fail(new InvalidResourceAmount({ amount }));

const loadResourceState = (
  state: InMemoryBackendState,
  identity: LedgerTruthIdentity,
): Effect.Effect<ProjectedResourceState, SqlError> =>
  Effect.try({
    try: () => projectResourceEvents(state.eventSnapshot(inMemoryRuntimeEventIdentity(identity))),
    catch: (cause) => new SqlError({ cause }),
  });

export const InMemoryResourcesLive = (state: InMemoryBackendState): Layer.Layer<Resources> =>
  Layer.succeed(Resources, {
    grant: (identity, spec) =>
      Effect.gen(function* () {
        yield* positiveAmount(spec.amount);
        const ts = yield* Clock.currentTimeMillis;
        const [event] = yield* state.commitEvents([
          {
            ts,
            kind: RESOURCE_EVENT_KIND.GRANTED,
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
              kind: RESOURCE_EVENT_KIND.RESERVE_REJECTED,
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
            kind: RESOURCE_EVENT_KIND.RESERVED,
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
            kind: RESOURCE_EVENT_KIND.CONSUMED,
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
            kind: RESOURCE_EVENT_KIND.RELEASED,
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
