import { Effect, Layer } from "effect";
import { JsonStringifyError, SqlError } from "@agent-os/kernel/errors";
import type { LedgerEvent } from "@agent-os/kernel/types";
import {
  makeDurableTriggerRegistry,
  TriggerPump,
  type AnyDurableTrigger,
  type TriggerTx,
} from "@agent-os/runtime";
import { fireLedgerEvents, insertLedgerEvent } from "./ledger/inserted-events";
import { EventBus } from "./ledger";
import {
  armNextDue,
  completeDueWork,
  ensureDueWorkSchema,
  insertDurableTriggerDueWork,
  selectDuePending,
  type DueWorkRow,
} from "./due-work";
import { sqlText } from "./storage/sql-row";

const failTriggerTransaction = (cause: string): never => {
  throw new SqlError({ cause });
};

const readIntentPayload = (
  sql: SqlStorage,
  intentEventId: number,
  intentEventKind: string,
): Effect.Effect<unknown, SqlError> =>
  Effect.gen(function* () {
    const row = yield* Effect.try({
      try: () =>
        sql
          .exec(
            "SELECT payload FROM events WHERE id = ? AND kind = ?",
            intentEventId,
            intentEventKind,
          )
          .toArray()[0],
      catch: (cause) => new SqlError({ cause }),
    });
    if (row === undefined) {
      return yield* Effect.fail(
        new SqlError({ cause: `durable trigger intent event missing: ${intentEventId}` }),
      );
    }
    return yield* Effect.try({
      try: () => JSON.parse(sqlText(row.payload, "events.payload")) as unknown,
      catch: (cause) => new SqlError({ cause }),
    });
  });

export const TriggerPumpLive = (
  ctx: DurableObjectState,
  scope: string,
  triggers: Iterable<AnyDurableTrigger>,
): Layer.Layer<TriggerPump, SqlError, EventBus> => {
  const sql = ctx.storage.sql;
  return Layer.scoped(
    TriggerPump,
    Effect.gen(function* () {
      yield* ensureDueWorkSchema(sql);
      const bus = yield* EventBus;
      const registry = yield* makeDurableTriggerRegistry(triggers).pipe(
        Effect.mapError((cause) => new SqlError({ cause })),
      );

      const runOne = (
        row: DueWorkRow,
        now: number,
      ): Effect.Effect<boolean, SqlError | JsonStringifyError> =>
        Effect.gen(function* () {
          const trigger = registry.get(row.kind);
          if (trigger === undefined) {
            return yield* Effect.fail(
              new SqlError({ cause: new TypeError(`unknown durable trigger kind: ${row.kind}`) }),
            );
          }
          const rawIntent = yield* readIntentPayload(
            sql,
            row.payload.intentEventId,
            trigger.intentEventKind,
          );
          const parsedIntent = trigger.parseIntent(rawIntent);
          if (!parsedIntent.ok) {
            return yield* Effect.fail(new SqlError({ cause: parsedIntent.reason }));
          }
          const intent = parsedIntent.intent;
          const outcome = yield* trigger.acquire(intent, {
            scope,
            now,
            dueWorkId: row.id,
            intentEventId: row.payload.intentEventId,
          });
          const events = yield* Effect.try({
            try: () =>
              ctx.storage.transactionSync((): ReadonlyArray<LedgerEvent> | null => {
                const stillPending = sql
                  .exec("SELECT id FROM due_work WHERE id = ? AND completed_at IS NULL", row.id)
                  .toArray();
                if (stillPending.length === 0) return null;
                const written: LedgerEvent[] = [];
                const tx: TriggerTx = {
                  scope,
                  now,
                  dueWorkId: row.id,
                  intentEventId: row.payload.intentEventId,
                  insertEvent: (spec) => {
                    const payloadStr = JSON.stringify(spec.payload);
                    const event = insertLedgerEvent(sql, {
                      ts: spec.ts ?? now,
                      kind: spec.kind,
                      scope,
                      payloadStr,
                      payload: spec.payload,
                    });
                    written.push(event);
                    return event;
                  },
                  enqueue: (spec) => {
                    if (!registry.has(spec.triggerKind)) {
                      return failTriggerTransaction(
                        `unregistered durable trigger kind: ${spec.triggerKind}`,
                      );
                    }
                    const payloadStr = JSON.stringify(spec.payload);
                    const event = insertLedgerEvent(sql, {
                      ts: spec.ts ?? now,
                      kind: spec.intentEventKind,
                      scope,
                      payloadStr,
                      payload: spec.payload,
                    });
                    insertDurableTriggerDueWork(sql, spec.fireAt, spec.triggerKind, event.id);
                    written.push(event);
                    return event;
                  },
                  reschedule: (fireAt, intentEventId = row.payload.intentEventId) => {
                    insertDurableTriggerDueWork(sql, fireAt, row.kind, intentEventId);
                  },
                };
                trigger.commit(outcome, tx);
                completeDueWork(sql, row.id, now);
                return written;
              }),
            catch: (cause) => new SqlError({ cause }),
          });
          if (events === null) return false;
          yield* fireLedgerEvents(bus, events);
          return true;
        });

      return {
        drainDue: (now) =>
          Effect.gen(function* () {
            const rows = yield* selectDuePending(sql, now);
            let drained = 0;
            for (const row of rows) {
              const completed = yield* runOne(row, now);
              if (completed) drained += 1;
            }
            yield* armNextDue(ctx, sql);
            return { drained };
          }),
      };
    }),
  );
};
