import { Clock, Effect, Layer } from "effect";
import { Ledger, recordLedgerPortEvents, runtimeStorageOrJsonError } from "@agent-os/runtime";
import { RUNTIME_FACT_OWNER } from "@agent-os/runtime-protocol";
import type { InMemoryBackendState } from "./state";

export const InMemoryLedgerLive = (state: InMemoryBackendState): Layer.Layer<Ledger> =>
  Layer.succeed(Ledger, {
    commit: (events) =>
      Effect.gen(function* () {
        const ts = yield* Clock.currentTimeMillis;
        const committed = yield* state
          .commitProtocolEvents(
            events.map((event) => ({
              ts,
              kind: event.kind,
              scopeRef: event.scopeRef,
              effectAuthorityRef: event.effectAuthorityRef,
              factOwnerRef: RUNTIME_FACT_OWNER,
              payload: event.payload,
            })),
          )
          .pipe(Effect.mapError((cause) => runtimeStorageOrJsonError("ledger_commit", cause)));
        return yield* recordLedgerPortEvents("ledger_commit", committed);
      }),
    events: (identity, opts = {}) =>
      recordLedgerPortEvents("ledger_events", state.snapshot(identity, opts)),
    streamSnapshot: (identity, opts = {}) =>
      recordLedgerPortEvents("ledger_stream_snapshot", state.streamSnapshot(identity, opts)),
  });
