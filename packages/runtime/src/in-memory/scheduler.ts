import { Clock, Effect, Layer } from "effect";
import {
  SCHEDULED_EVENT_TRIGGER_KIND,
  type BackendProtocolTruthIdentity,
} from "@agent-os/core/backend-protocol";
import { DurableTriggerRegistry, Scheduler, runtimeStorageOrJsonError } from "@agent-os/runtime";
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
            return yield* state
              .schedule(
                inMemoryRuntimeEventIdentity(identity),
                now,
                at,
                registry,
                SCHEDULED_EVENT_TRIGGER_KIND,
                eventKind,
                data,
              )
              .pipe(Effect.mapError((cause) => runtimeStorageOrJsonError("scheduler", cause)));
          }).pipe(Effect.withSpan("agentos.in_memory.scheduler.schedule")),
      };
    }),
  );
