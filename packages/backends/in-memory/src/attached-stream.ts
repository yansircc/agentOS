import { Clock, Effect, Layer } from "effect";
import {
  AttachedStreamRegistry,
  AttachedStreams,
  makeAttachedStreamService,
  runSynchronousAttachedStreamCommit,
} from "@agent-os/runtime";
import type { SqlError } from "@agent-os/kernel";
import type { InMemoryBackendState } from "./state";

export const InMemoryAttachedStreamsLive = (
  state: InMemoryBackendState,
  scope: string,
): Layer.Layer<AttachedStreams, SqlError, AttachedStreamRegistry> => {
  let nextStreamId = 1;
  return Layer.effect(
    AttachedStreams,
    Effect.gen(function* () {
      const registry = yield* AttachedStreamRegistry;
      return makeAttachedStreamService({
        registry,
        scope,
        now: () => Clock.currentTimeMillis,
        makeStreamRef: () => `attached/${nextStreamId++}`,
        commitTerminal: ({ handler, ctx, terminal }) =>
          state
            .commitAttachedStreamTerminal(
              scope,
              ctx.streamRef,
              handler.kind,
              ctx.now,
              ctx.signal,
              terminal,
              (value, tx) =>
                runSynchronousAttachedStreamCommit(scope, handler.kind, () =>
                  handler.commitTerminal(value, tx),
                ),
            )
            .pipe(Effect.map(({ events }) => ({ eventIds: events.map((event) => event.id) }))),
      });
    }),
  );
};
