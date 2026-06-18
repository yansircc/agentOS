import { Clock, Effect, Layer } from "effect";
import { SqlError } from "@agent-os/kernel/errors";
import { SCHEDULED_EVENT_TRIGGER_KIND } from "@agent-os/backend-protocol";
import { DurableTriggerRegistry, Scheduler } from "@agent-os/runtime";
import { EventBus } from "./ledger";
import { enqueueScheduledEvent, ensureDueWorkSchema } from "./due-work";
import type { BackendProtocolEventIdentity } from "@agent-os/backend-protocol";

export { Scheduler } from "@agent-os/runtime";

export const SchedulerLive = (
  ctx: DurableObjectState,
  scope: string,
  identity: BackendProtocolEventIdentity,
): Layer.Layer<Scheduler, SqlError, EventBus | DurableTriggerRegistry> => {
  const sql = ctx.storage.sql;
  return Layer.effect(
    Scheduler,
    Effect.gen(function* () {
      yield* ensureDueWorkSchema(sql);
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
          }),
      };
    }),
  );
};
