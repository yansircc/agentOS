import { Clock, Effect, Layer } from "effect";
import { Scheduler } from "@agent-os/runtime";
import { parseScheduledEventIntentPayload } from "@agent-os/backend-protocol";
import { SqlError } from "@agent-os/kernel/errors";
import type { InMemoryBackendState } from "./state";

export const InMemorySchedulerLive = (
  state: InMemoryBackendState,
  scope: string,
): Layer.Layer<Scheduler> =>
  Layer.succeed(Scheduler, {
    schedule: (at, eventKind, data) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        return yield* state.schedule(scope, now, at, eventKind, data);
      }),
    fireDue: (now) =>
      Effect.gen(function* () {
        let fired = 0;
        for (const row of state.dueScheduled(now)) {
          const intent = state.scheduledIntent(row.payload.intentEventId);
          if (intent === null) {
            return yield* Effect.fail(
              new SqlError({
                cause: new TypeError(
                  `scheduled intent event missing: ${row.payload.intentEventId}`,
                ),
              }),
            );
          }
          const payload = parseScheduledEventIntentPayload(intent.payload);
          if (!payload.ok) {
            return yield* Effect.fail(new SqlError({ cause: payload.failure.reason }));
          }
          yield* state.commitEvents([
            { ts: now, kind: payload.value.eventKind, scope, payload: payload.value.data },
          ]);
          state.completeDueWork(row.id, now);
          fired += 1;
        }
        return { fired };
      }),
  });
