import { Effect, Layer } from "effect";
import { Scheduler } from "@agent-os/runtime";
import type { InMemoryBackendState } from "./state";

export const InMemorySchedulerLive = (
  state: InMemoryBackendState,
  scope: string,
): Layer.Layer<Scheduler> =>
  Layer.succeed(Scheduler, {
    schedule: (at, eventKind, data) => state.schedule(at, eventKind, data),
    fireDue: (now) =>
      Effect.gen(function* () {
        let fired = 0;
        for (const row of state.dueScheduled(now)) {
          yield* state.commitEvents([
            { ts: now, kind: row.payload.eventKind, scope, payload: row.payload.data },
          ]);
          state.completeDueWork(row.id, now);
          fired += 1;
        }
        return { fired };
      }),
  });
