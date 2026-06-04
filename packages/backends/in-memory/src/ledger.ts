import { Clock, Effect, Layer } from "effect";
import { Ledger } from "@agent-os/runtime";
import type { InMemoryBackendState } from "./state";

export const InMemoryLedgerLive = (state: InMemoryBackendState): Layer.Layer<Ledger> =>
  Layer.succeed(Ledger, {
    commit: (events) =>
      Effect.gen(function* () {
        const ts = yield* Clock.currentTimeMillis;
        return yield* state.commitEvents(events.map((event) => ({ ts, ...event })));
      }),
    events: (scope, opts = {}) => Effect.succeed(state.snapshot(scope, opts)),
    streamSnapshot: (scope, opts = {}) => Effect.succeed(state.streamSnapshot(scope, opts)),
  });
