import { Clock, Effect, Layer } from "effect";
import { Ledger } from "@agent-os/runtime";
import { RUNTIME_FACT_OWNER } from "@agent-os/runtime-protocol";
import type { InMemoryBackendState } from "./state";

export const InMemoryLedgerLive = (state: InMemoryBackendState): Layer.Layer<Ledger> =>
  Layer.succeed(Ledger, {
    commit: (events) =>
      Effect.gen(function* () {
        const ts = yield* Clock.currentTimeMillis;
        return yield* state.commitProtocolEvents(
          events.map((event) => ({
            ts,
            kind: event.kind,
            scopeRef: event.scopeRef,
            effectAuthorityRef: event.effectAuthorityRef,
            factOwnerRef: RUNTIME_FACT_OWNER,
            payload: event.payload,
          })),
        );
      }),
    events: (identity, opts = {}) => Effect.succeed(state.snapshot(identity, opts)),
    streamSnapshot: (identity, opts = {}) => Effect.succeed(state.streamSnapshot(identity, opts)),
  });
