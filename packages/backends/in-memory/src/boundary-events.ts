import { Effect, Layer } from "effect";
import {
  BoundaryEvents,
  commitBoundaryEvent,
  type BoundaryCommitIdentity,
} from "@agent-os/runtime";
import type { BoundaryContract } from "@agent-os/kernel/boundary-contract";
import type { BackendProtocolTruthIdentity } from "@agent-os/backend-protocol";
import type { InMemoryBackendState } from "./state";

export const InMemoryBoundaryEventsLive = (
  state: InMemoryBackendState,
  fallbackIdentity: BackendProtocolTruthIdentity,
): Layer.Layer<BoundaryEvents> =>
  Layer.succeed(BoundaryEvents, {
    commit: (contract: BoundaryContract, event: string, payload: unknown) =>
      commitBoundaryEvent(contract, event, payload, (identity: BoundaryCommitIdentity) =>
        Effect.gen(function* () {
          const committed = yield* state.commitProtocolEvents([
            {
              kind: event,
              scopeRef: identity.scopeRef ?? fallbackIdentity.scopeRef,
              effectAuthorityRef:
                identity.effectAuthorityRef ?? fallbackIdentity.effectAuthorityRef,
              factOwnerRef: identity.factOwnerRef,
              payload,
            },
          ]);
          return committed[0]!;
        }),
      ),
  });
