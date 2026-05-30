import { Clock, Effect, Layer } from "effect";
import { Scheduler, scheduledEventTrigger } from "@agent-os/runtime";
import type { InMemoryBackendState } from "./state";

export const InMemorySchedulerLive = (
  state: InMemoryBackendState,
  scope: string,
): Layer.Layer<Scheduler> =>
  Layer.succeed(Scheduler, {
    schedule: (at, eventKind, data) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        return yield* state.schedule(scope, now, at, scheduledEventTrigger, eventKind, data);
      }),
  });
