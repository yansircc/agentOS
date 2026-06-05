import { Clock, Effect, Layer } from "effect";
import type { BackendProtocolTruthIdentity } from "@agent-os/backend-protocol";
import { DurableTriggerRegistry, Scheduler, scheduledEventTrigger } from "@agent-os/runtime";
import { inMemoryRuntimeEventIdentity, type InMemoryBackendState } from "./state";

export const InMemorySchedulerLive = (
  state: InMemoryBackendState,
  identity: BackendProtocolTruthIdentity,
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
              inMemoryRuntimeEventIdentity(identity),
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
