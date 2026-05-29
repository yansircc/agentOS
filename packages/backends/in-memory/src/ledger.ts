import { Clock, Effect, Layer } from "effect";
import { Ledger } from "@agent-os/runtime";
import type { InMemoryBackendState } from "./state";

export const InMemoryLedgerLive = (state: InMemoryBackendState): Layer.Layer<Ledger> =>
  Layer.succeed(Ledger, {
    log: (kind, payload, scope) =>
      Effect.gen(function* () {
        const ts = yield* Clock.currentTimeMillis;
        const [event] = yield* state.commitEvents([{ ts, kind, scope, payload }]);
        return event!;
      }),
    events: (scope, opts = {}) => Effect.succeed(state.snapshot(scope, opts)),
    streamSnapshot: (scope, opts = {}) => Effect.succeed(state.streamSnapshot(scope, opts)),
  });
