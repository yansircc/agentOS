import { Effect, Layer } from "effect";
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
import type { BackendProtocolTruthIdentity } from "@agent-os/core/backend-protocol";
import { RUNTIME_FACT_OWNER, type RuntimeEventCommitSpec } from "@agent-os/core/runtime-protocol";
import type { InMemoryBackendState } from "./state";

export const InMemoryBoundaryEventsLive = (
  state: InMemoryBackendState,
  fallbackIdentity: BackendProtocolTruthIdentity,
): Layer.Layer<BoundaryEvents> =>
  Layer.succeed(BoundaryEvents, {
    commit: (contract: BoundaryContract, event: string, payload: unknown) =>
      commitBoundaryEvent(contract, event, payload, (identity: BoundaryCommitIdentity) =>
        Effect.gen(function* () {
          const committed = yield* state
            .commitProtocolEvents([
              {
                kind: event,
                scopeRef: identity.scopeRef ?? fallbackIdentity.scopeRef,
                effectAuthorityRef:
                  identity.effectAuthorityRef ?? fallbackIdentity.effectAuthorityRef,
                factOwnerRef: identity.factOwnerRef,
                payload,
              },
            ])
            .pipe(Effect.mapError((cause) => runtimeStorageOrJsonError("boundary_event", cause)));
          return yield* recordLedgerPortEvent("boundary_event", committed[0]!);
        }).pipe(Effect.withSpan("agentos.in_memory.boundary_event.commit")),
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
        const committed = yield* state
          .commitProtocolPrepared((boundaryEventId) => [
            {
              kind: event,
              scopeRef: identity.scopeRef ?? fallbackIdentity.scopeRef,
              effectAuthorityRef:
                identity.effectAuthorityRef ?? fallbackIdentity.effectAuthorityRef,
              factOwnerRef: identity.factOwnerRef,
              payload,
            },
            ...runtimeEvents(boundaryEventId).map((runtimeEvent) => ({
              ts: runtimeEvent.ts,
              kind: runtimeEvent.kind,
              scopeRef: runtimeEvent.scopeRef,
              effectAuthorityRef: runtimeEvent.effectAuthorityRef,
              factOwnerRef: RUNTIME_FACT_OWNER,
              payload: runtimeEvent.payload,
            })),
          ])
          .pipe(Effect.mapError((cause) => runtimeStorageOrJsonError("boundary_event", cause)));
        const committedRejected = validateCommittedBoundaryEvent(
          contract,
          event,
          objectPayload,
          committed[0]!,
        );
        if (committedRejected !== null) {
          return yield* Effect.fail(committedRejected);
        }
        const recorded = yield* recordLedgerPortEvents("boundary_event", committed);
        const first = recorded[0];
        if (first === undefined) {
          return yield* Effect.fail(runtimeStorageError("boundary_event", "empty commit"));
        }
        return [first, ...recorded.slice(1)] as const;
      }).pipe(Effect.withSpan("agentos.in_memory.boundary_event.commit_with_runtime_events")),
  });
