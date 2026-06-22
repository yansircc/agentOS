import { Clock, Effect, Layer } from "effect";
import {
  BoundaryEvents,
  boundaryCommitIdentity,
  commitBoundaryEvent,
  recordLedgerPortEvent,
  recordLedgerPortEvents,
  runtimeStorageError,
  runtimeStorageOrJsonError,
  validateBoundaryEventPayload,
  validateCommittedBoundaryEvent,
  type BoundaryCommitIdentity,
} from "@agent-os/runtime";
import type { BoundaryContract } from "@agent-os/core/boundary-contract";
import type { BackendProtocolEventIdentity } from "@agent-os/core/backend-protocol";
import { RUNTIME_FACT_OWNER, type RuntimeEventCommitSpec } from "@agent-os/core/runtime-protocol";
import { EventBus } from "./ledger/event-bus";
import { commitLedgerTransaction } from "./ledger/commit";

export const BoundaryEventsLive = (
  ctx: DurableObjectState,
  fallbackIdentity: BackendProtocolEventIdentity,
): Layer.Layer<BoundaryEvents, never, EventBus> =>
  Layer.effect(
    BoundaryEvents,
    Effect.gen(function* () {
      const bus = yield* EventBus;
      return {
        commit: (contract: BoundaryContract, event: string, payload: unknown) =>
          commitBoundaryEvent(contract, event, payload, (identity: BoundaryCommitIdentity) =>
            Effect.gen(function* () {
              const now = yield* Clock.currentTimeMillis;
              const committed = yield* commitLedgerTransaction(
                ctx,
                bus,
                { factOwnerRef: identity.factOwnerRef },
                (tx) =>
                  tx.append({
                    ts: now,
                    kind: event,
                    scopeRef: identity.scopeRef ?? fallbackIdentity.scopeRef,
                    effectAuthorityRef:
                      identity.effectAuthorityRef ?? fallbackIdentity.effectAuthorityRef,
                    payload,
                  }),
              ).pipe(
                Effect.mapError((cause) => runtimeStorageOrJsonError("boundary_event", cause)),
              );
              return yield* recordLedgerPortEvent(
                "boundary_event",
                committed.event(committed.value),
              );
            }).pipe(Effect.withSpan("agentos.cloudflare_do.boundary_event.commit")),
          ),
        commitWithRuntimeEvents: (
          contract: BoundaryContract,
          event: string,
          payload: unknown,
          runtimeEvents: (
            boundaryEventId: number,
          ) => readonly [RuntimeEventCommitSpec, ...RuntimeEventCommitSpec[]],
        ) =>
          Effect.gen(function* () {
            const rejected = validateBoundaryEventPayload(contract, event, payload);
            if (rejected !== null) {
              return yield* Effect.fail(rejected);
            }
            const objectPayload = payload as Readonly<Record<string, unknown>>;
            const identity = boundaryCommitIdentity(contract, event, objectPayload);
            const now = yield* Clock.currentTimeMillis;
            const committed = yield* commitLedgerTransaction(
              ctx,
              bus,
              { factOwnerRef: RUNTIME_FACT_OWNER },
              (tx) => {
                const boundaryRef = tx.append({
                  ts: now,
                  kind: event,
                  scopeRef: identity.scopeRef ?? fallbackIdentity.scopeRef,
                  effectAuthorityRef:
                    identity.effectAuthorityRef ?? fallbackIdentity.effectAuthorityRef,
                  factOwnerRef: identity.factOwnerRef,
                  payload,
                });
                const runtimeRefs = runtimeEvents(tx.id(boundaryRef)).map((runtimeEvent) =>
                  tx.append({
                    ts: runtimeEvent.ts ?? now,
                    kind: runtimeEvent.kind,
                    scopeRef: runtimeEvent.scopeRef,
                    effectAuthorityRef: runtimeEvent.effectAuthorityRef,
                    payload: runtimeEvent.payload,
                  }),
                );
                return [boundaryRef, ...runtimeRefs] as const;
              },
            ).pipe(Effect.mapError((cause) => runtimeStorageOrJsonError("boundary_event", cause)));
            const events = committed.value.map((ref) => committed.event(ref));
            const boundaryEvent = events[0]!;
            const committedRejected = validateCommittedBoundaryEvent(
              contract,
              event,
              objectPayload,
              boundaryEvent,
            );
            if (committedRejected !== null) {
              return yield* Effect.fail(committedRejected);
            }
            const recorded = yield* recordLedgerPortEvents("boundary_event", events);
            const first = recorded[0];
            if (first === undefined) {
              return yield* Effect.fail(runtimeStorageError("boundary_event", "empty commit"));
            }
            return [first, ...recorded.slice(1)] as const;
          }).pipe(
            Effect.withSpan("agentos.cloudflare_do.boundary_event.commit_with_runtime_events"),
          ),
      };
    }),
  );
