import { Effect, Layer } from "effect";
import { SqlError, UnregisteredDurableTriggerKind } from "@agent-os/kernel/errors";
import { DurableTriggerRegistry, TriggerPump } from "@agent-os/runtime";
import type { InMemoryBackendState } from "./state";

export const InMemoryTriggerPumpLive = (
  state: InMemoryBackendState,
  scope: string,
): Layer.Layer<TriggerPump, SqlError, DurableTriggerRegistry> =>
  Layer.effect(
    TriggerPump,
    Effect.gen(function* () {
      const registry = yield* DurableTriggerRegistry;
      return {
        drainDue: (now) =>
          Effect.gen(function* () {
            const pending = state.duePending(now);
            let drained = 0;
            for (const row of pending) {
              const trigger = registry.get(row.kind);
              if (trigger === undefined) {
                return yield* Effect.fail(new UnregisteredDurableTriggerKind({ kind: row.kind }));
              }
              const intentEvent = state.eventById(
                row.payload.intentEventId,
                trigger.intentEventKind,
              );
              if (intentEvent === null) {
                return yield* Effect.fail(
                  new SqlError({
                    cause: new TypeError(
                      `durable trigger intent event missing: ${row.payload.intentEventId}`,
                    ),
                  }),
                );
              }
              const parsedIntent = trigger.parseIntent(intentEvent.payload);
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
              const committed = yield* state.commitTrigger(
                scope,
                row,
                now,
                (kind) => registry.has(kind),
                (tx) => trigger.commit(outcome, tx),
              );
              if (committed.completed) drained += 1;
            }
            return { drained };
          }),
      };
    }),
  );
