import { Clock, Effect, Layer } from "effect";
import {
  BoundaryEvents,
  commitBoundaryEvent,
  recordLedgerPortEvent,
  runtimeStorageOrJsonError,
  type BoundaryCommitIdentity,
} from "@agent-os/runtime";
import type { BoundaryContract } from "@agent-os/kernel/boundary-contract";
import type { BackendProtocolEventIdentity } from "@agent-os/backend-protocol";
import { EventBus } from "./ledger";
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
            }),
          ),
      };
    }),
  );
