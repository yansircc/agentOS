import { Clock, Effect, Layer } from "effect";
import { DurableTriggerRegistry, Scheduler, scheduledEventTrigger } from "@agent-os/runtime";
import type { InMemoryBackendState } from "./state";

export const InMemorySchedulerLive = (
  state: InMemoryBackendState,
  scope: string,
): Layer.Layer<Scheduler, never, DurableTriggerRegistry> =>
  Layer.effect(
    Scheduler,
    Effect.gen(function* () {
      const registry = yield* DurableTriggerRegistry;
      return {
        schedule: (at, eventKind, data) =>
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;
            return yield* state.schedule(
              scope,
              now,
              at,
              registry,
              scheduledEventTrigger.kind,
              eventKind,
              data,
            );
          }),
      };
    }),
  );
