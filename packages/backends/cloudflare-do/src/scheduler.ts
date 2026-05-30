import { Clock, Effect, Layer } from "effect";
import { SqlError } from "@agent-os/kernel/errors";
import { DurableTriggerRegistry, Scheduler, scheduledEventTrigger } from "@agent-os/runtime";
import { EventBus } from "./ledger";
import { fireLedgerEvents } from "./ledger/inserted-events";
import { enqueueScheduledEvent, ensureDueWorkSchema } from "./due-work";

export { Scheduler } from "@agent-os/runtime";

export const SchedulerLive = (
  ctx: DurableObjectState,
  scope: string,
): Layer.Layer<Scheduler, SqlError, EventBus | DurableTriggerRegistry> => {
  const sql = ctx.storage.sql;
  return Layer.scoped(
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
              scope,
              now,
              at,
              registry,
              scheduledEventTrigger.kind,
              eventKind,
              data,
            );
            yield* fireLedgerEvents(bus, [intent]);
            return { id: intent.id };
          }),
      };
    }),
  );
};
