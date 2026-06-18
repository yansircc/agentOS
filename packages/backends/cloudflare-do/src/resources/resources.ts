/**
 * Resources — business resource reservation over ledger facts.
 *
 * This is deliberately not Quota. Quota is dispatch/rate consumption.
 * Resources owns reserve-now, consume-or-release-later state for app
 * resources such as img-gen credits.
 *
 * SSoT: only `events.kind = resource_pool.*`. There is no account table and no
 * reservation table. Projection (`./projection.ts`) rebuilds balance from
 * ledger rows inside the same `transactionSync` that writes the next
 * resource event.
 */

import { Clock, Effect, Layer } from "effect";
import {
  InvalidResourceAmount,
  ResourceInsufficient,
  ResourceReservationClosed,
  ResourceReservationNotFound,
  SqlError,
} from "@agent-os/kernel/errors";
import { EventBus } from "../ledger";
import { Resources } from "@agent-os/runtime";
import { commitLedgerTransaction } from "../ledger/commit";
import { RESOURCE_EVENT_KIND, type BackendProtocolEventIdentity } from "@agent-os/backend-protocol";

import { emptyProjection, loadState } from "./projection";

// Re-export the projection shape so callers that historically imported
// it from "./resources" keep working.
export type { ResourceProjection } from "@agent-os/backend-protocol";

const assertPositiveAmount = (amount: number): Effect.Effect<void, InvalidResourceAmount> =>
  Number.isFinite(amount) && amount > 0
    ? Effect.void
    : Effect.fail(new InvalidResourceAmount({ amount }));

export const ResourcesLive = (
  ctx: DurableObjectState,
  ownerIdentity: BackendProtocolEventIdentity,
): Layer.Layer<Resources, SqlError, EventBus> => {
  const sql = ctx.storage.sql;
  return Layer.effect(
    Resources,
    Effect.gen(function* () {
      const bus = yield* EventBus;

      return {
        grant: (identity, spec) =>
          Effect.gen(function* () {
            yield* assertPositiveAmount(spec.amount);
            const now = yield* Clock.currentTimeMillis;
            const payload = {
              key: spec.key,
              amount: spec.amount,
              ref: spec.ref,
            };
            const committed = yield* commitLedgerTransaction(
              ctx,
              bus,
              { factOwnerRef: ownerIdentity.factOwnerRef },
              (tx) => {
                const granted = tx.append({
                  ts: now,
                  kind: RESOURCE_EVENT_KIND.GRANTED,
                  scopeRef: identity.scopeRef,
                  effectAuthorityRef: identity.effectAuthorityRef,
                  payload,
                });
                return granted;
              },
            );
            return { eventId: committed.id(committed.value) };
          }),

        reserve: (identity, spec) =>
          Effect.gen(function* () {
            yield* assertPositiveAmount(spec.amount);
            const now = yield* Clock.currentTimeMillis;
            const reservationId = crypto.randomUUID();

            const tx = yield* commitLedgerTransaction(
              ctx,
              bus,
              { factOwnerRef: ownerIdentity.factOwnerRef },
              (ledgerTx) => {
                const projected = loadState(sql, identity, ownerIdentity.factOwnerRef);
                const existing = projected.byIdempotencyKey.get(spec.idempotencyKey);
                if (existing !== undefined) {
                  return {
                    status: "existing" as const,
                    reservationId: existing.reservationId,
                  };
                }

                const current = projected.byKey.get(spec.key) ?? emptyProjection();
                if (current.available < spec.amount) {
                  const rejectedPayload = {
                    key: spec.key,
                    amount: spec.amount,
                    ref: spec.ref,
                    idempotencyKey: spec.idempotencyKey,
                    available: current.available,
                  };
                  ledgerTx.append({
                    ts: now,
                    kind: RESOURCE_EVENT_KIND.RESERVE_REJECTED,
                    scopeRef: identity.scopeRef,
                    effectAuthorityRef: identity.effectAuthorityRef,
                    payload: rejectedPayload,
                  });
                  return {
                    status: "insufficient" as const,
                    available: current.available,
                  };
                }

                const reservedPayload = {
                  key: spec.key,
                  amount: spec.amount,
                  ref: spec.ref,
                  idempotencyKey: spec.idempotencyKey,
                  reservationId,
                };
                ledgerTx.append({
                  ts: now,
                  kind: RESOURCE_EVENT_KIND.RESERVED,
                  scopeRef: identity.scopeRef,
                  effectAuthorityRef: identity.effectAuthorityRef,
                  payload: reservedPayload,
                });
                return {
                  status: "reserved" as const,
                  reservationId,
                };
              },
            );

            if (tx.value.status === "insufficient") {
              return yield* Effect.fail(
                new ResourceInsufficient({
                  key: spec.key,
                  requested: spec.amount,
                  available: tx.value.available,
                }),
              );
            }
            return { reservationId: tx.value.reservationId };
          }),

        consume: (identity, spec) =>
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;
            const tx = yield* commitLedgerTransaction(
              ctx,
              bus,
              { factOwnerRef: ownerIdentity.factOwnerRef },
              (ledgerTx) => {
                const projected = loadState(sql, identity, ownerIdentity.factOwnerRef);
                const reservation = projected.byId.get(spec.reservationId);
                if (reservation === undefined) return { status: "missing" as const };
                if (reservation.status === "consumed") return { status: "noop" as const };
                if (reservation.status === "released") {
                  return { status: "closed" as const, closed: "released" as const };
                }
                const payload = {
                  reservationId: spec.reservationId,
                  ref: spec.ref,
                };
                ledgerTx.append({
                  ts: now,
                  kind: RESOURCE_EVENT_KIND.CONSUMED,
                  scopeRef: identity.scopeRef,
                  effectAuthorityRef: identity.effectAuthorityRef,
                  payload,
                });
                return { status: "written" as const };
              },
            );
            if (tx.value.status === "missing") {
              return yield* Effect.fail(
                new ResourceReservationNotFound({
                  reservationId: spec.reservationId,
                }),
              );
            }
            if (tx.value.status === "closed") {
              return yield* Effect.fail(
                new ResourceReservationClosed({
                  reservationId: spec.reservationId,
                  status: tx.value.closed,
                }),
              );
            }
          }),

        release: (identity, spec) =>
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;
            const tx = yield* commitLedgerTransaction(
              ctx,
              bus,
              { factOwnerRef: ownerIdentity.factOwnerRef },
              (ledgerTx) => {
                const projected = loadState(sql, identity, ownerIdentity.factOwnerRef);
                const reservation = projected.byId.get(spec.reservationId);
                if (reservation === undefined) return { status: "missing" as const };
                if (reservation.status === "released") return { status: "noop" as const };
                if (reservation.status === "consumed") {
                  return { status: "closed" as const, closed: "consumed" as const };
                }
                const payload = {
                  reservationId: spec.reservationId,
                  ref: spec.ref,
                };
                ledgerTx.append({
                  ts: now,
                  kind: RESOURCE_EVENT_KIND.RELEASED,
                  scopeRef: identity.scopeRef,
                  effectAuthorityRef: identity.effectAuthorityRef,
                  payload,
                });
                return { status: "written" as const };
              },
            );
            if (tx.value.status === "missing") {
              return yield* Effect.fail(
                new ResourceReservationNotFound({
                  reservationId: spec.reservationId,
                }),
              );
            }
            if (tx.value.status === "closed") {
              return yield* Effect.fail(
                new ResourceReservationClosed({
                  reservationId: spec.reservationId,
                  status: tx.value.closed,
                }),
              );
            }
          }),

        project: (identity, key) =>
          Effect.try({
            try: () =>
              loadState(sql, identity, ownerIdentity.factOwnerRef).byKey.get(key) ??
              emptyProjection(),
            catch: (cause) => new SqlError({ cause }),
          }),
      };
    }),
  );
};
