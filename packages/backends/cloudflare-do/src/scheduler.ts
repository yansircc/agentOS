import type { LedgerEvent } from "@agent-os/kernel/types";
import { Clock, Effect, Layer } from "effect";
import { SqlError, safeStringify } from "@agent-os/kernel/errors";
import { Scheduler } from "@agent-os/runtime";
import { DUE_WORK_SCHEDULED_EVENT } from "@agent-os/backend-protocol";
import { EventBus } from "./ledger";
import { fireLedgerEvents, insertLedgerEvent } from "./ledger/inserted-events";
import {
  completeDueWork,
  enqueueScheduledEvent,
  ensureDueWorkSchema,
  selectDueWork,
} from "./due-work";

export { Scheduler } from "@agent-os/runtime";

export const SchedulerLive = (
  ctx: DurableObjectState,
  scope: string,
): Layer.Layer<Scheduler, SqlError, EventBus> => {
  const sql = ctx.storage.sql;
  return Layer.scoped(
    Scheduler,
    Effect.gen(function* () {
      yield* ensureDueWorkSchema(sql);
      const bus = yield* EventBus;

      return {
        schedule: (at, eventKind, data) => enqueueScheduledEvent(ctx, sql, at, eventKind, data),

        fireDue: (now) =>
          Effect.gen(function* () {
            const pending = yield* selectDueWork(sql, DUE_WORK_SCHEDULED_EVENT, now);

            let fired = 0;
            for (const row of pending) {
              const payloadStr = yield* safeStringify(row.payload.data);
              const dataValue = row.payload.data;
              const ts = yield* Clock.currentTimeMillis;
              const eventOrNull = yield* Effect.try({
                try: () =>
                  ctx.storage.transactionSync(() => {
                    const stillPending = sql
                      .exec("SELECT id FROM due_work WHERE id = ? AND completed_at IS NULL", row.id)
                      .toArray();
                    if (stillPending.length === 0) return null;
                    const event = insertLedgerEvent(sql, {
                      ts,
                      kind: row.payload.eventKind,
                      scope,
                      payloadStr,
                      payload: dataValue,
                    });
                    completeDueWork(sql, row.id, ts);
                    return event satisfies LedgerEvent;
                  }),
                catch: (cause) => new SqlError({ cause }),
              });

              if (eventOrNull !== null) {
                yield* fireLedgerEvents(bus, [eventOrNull]);
                fired += 1;
              }
            }

            return { fired };
          }),
      };
    }),
  );
};
