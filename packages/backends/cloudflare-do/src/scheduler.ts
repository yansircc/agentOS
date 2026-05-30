import type { LedgerEvent } from "@agent-os/kernel/types";
import { Clock, Effect, Layer } from "effect";
import { SqlError, safeStringify } from "@agent-os/kernel/errors";
import { Scheduler } from "@agent-os/runtime";
import {
  DUE_WORK_SCHEDULED_EVENT,
  DURABLE_TRIGGER_SCHEDULED_REQUESTED,
  parseScheduledEventIntentPayload,
} from "@agent-os/backend-protocol";
import { EventBus } from "./ledger";
import { fireLedgerEvents, insertLedgerEvent } from "./ledger/inserted-events";
import {
  completeDueWork,
  enqueueScheduledEvent,
  ensureDueWorkSchema,
  selectDueWork,
} from "./due-work";
import { sqlText } from "./storage/sql-row";

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
        schedule: (at, eventKind, data) =>
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;
            const intent = yield* enqueueScheduledEvent(ctx, sql, scope, now, at, eventKind, data);
            yield* fireLedgerEvents(bus, [intent]);
            return { id: intent.id };
          }),

        fireDue: (now) =>
          Effect.gen(function* () {
            const pending = yield* selectDueWork(sql, DUE_WORK_SCHEDULED_EVENT, now);

            let fired = 0;
            for (const row of pending) {
              const intent = yield* Effect.try({
                try: () =>
                  sql
                    .exec(
                      "SELECT payload FROM events WHERE id = ? AND kind = ?",
                      row.payload.intentEventId,
                      DURABLE_TRIGGER_SCHEDULED_REQUESTED,
                    )
                    .toArray()[0],
                catch: (cause) => new SqlError({ cause }),
              });
              if (intent === undefined) {
                return yield* Effect.fail(
                  new SqlError({
                    cause: new TypeError(
                      `scheduled intent event missing: ${row.payload.intentEventId}`,
                    ),
                  }),
                );
              }
              const intentPayload = yield* Effect.try({
                try: () =>
                  parseScheduledEventIntentPayload(
                    JSON.parse(sqlText(intent.payload, "events.payload")) as unknown,
                  ),
                catch: (cause) => new SqlError({ cause }),
              });
              if (!intentPayload.ok) {
                return yield* Effect.fail(new SqlError({ cause: intentPayload.failure.reason }));
              }
              const payloadStr = yield* safeStringify(intentPayload.value.data);
              const dataValue = intentPayload.value.data;
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
                      kind: intentPayload.value.eventKind,
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
