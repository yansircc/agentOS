import { Clock, Effect, Layer } from "effect";
import { UnregisteredDurableTriggerKind } from "@agent-os/kernel/errors";
import { SCHEDULED_EVENT_TRIGGER_KIND } from "@agent-os/backend-protocol";
import {
  DurableTriggerRegistry,
  Scheduler,
  runtimeStorageError,
  runtimeStorageOrJsonError,
  type RuntimeStorageError,
} from "@agent-os/runtime";
import { EventBus } from "./ledger";
import { enqueueScheduledEvent, ensureDueWorkSchema } from "./due-work";
import type { BackendProtocolEventIdentity } from "@agent-os/backend-protocol";

export { Scheduler } from "@agent-os/runtime";

export const SchedulerLive = (
  ctx: DurableObjectState,
  scope: string,
  identity: BackendProtocolEventIdentity,
): Layer.Layer<Scheduler, RuntimeStorageError, EventBus | DurableTriggerRegistry> => {
  const sql = ctx.storage.sql;
  const schedulerError = (cause: unknown) =>
    cause instanceof UnregisteredDurableTriggerKind
      ? cause
      : runtimeStorageOrJsonError("scheduler", cause);
  return Layer.effect(
    Scheduler,
    Effect.gen(function* () {
      yield* ensureDueWorkSchema(sql).pipe(
        Effect.mapError((cause) => runtimeStorageError("scheduler", cause)),
      );
      const bus = yield* EventBus;
      const registry = yield* DurableTriggerRegistry;

      return {
        schedule: (at, eventKind, data) =>
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;
            const intent = yield* enqueueScheduledEvent(
              ctx,
              sql,
              bus,
              scope,
              identity,
              now,
              at,
              registry,
              SCHEDULED_EVENT_TRIGGER_KIND,
              eventKind,
              data,
            );
            return { id: intent.id };
          }).pipe(
            Effect.mapError(schedulerError),
            Effect.withSpan("agentos.cloudflare_do.scheduler.schedule"),
          ),
      };
    }),
  );
};
