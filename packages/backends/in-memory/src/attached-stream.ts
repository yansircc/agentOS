import { Clock, Effect, Layer } from "effect";
import {
  AttachedStreamRegistry,
  AttachedStreams,
  makeAttachedStreamService,
  runSynchronousAttachedStreamCommit,
} from "@agent-os/runtime";
import type { SqlError } from "@agent-os/kernel";
import type { BackendProtocolTruthIdentity } from "@agent-os/backend-protocol";
import { inMemoryRuntimeEventIdentity, type InMemoryBackendState } from "./state";

export const InMemoryAttachedStreamsLive = (
  state: InMemoryBackendState,
  identity: BackendProtocolTruthIdentity,
  scopeLabel: string,
): Layer.Layer<AttachedStreams, SqlError, AttachedStreamRegistry> => {
  let nextStreamId = 1;
  return Layer.effect(
    AttachedStreams,
    Effect.gen(function* () {
      const registry = yield* AttachedStreamRegistry;
      return makeAttachedStreamService({
        registry,
        scope: scopeLabel,
        now: () => Clock.currentTimeMillis,
        makeStreamRef: () => `attached/${nextStreamId++}`,
        commitTerminal: ({ handler, ctx, terminal }) =>
          state
            .commitAttachedStreamTerminal(
              inMemoryRuntimeEventIdentity(identity),
              scopeLabel,
              ctx.streamRef,
              handler.kind,
              ctx.now,
              ctx.signal,
              terminal,
              (value, tx) =>
                runSynchronousAttachedStreamCommit(scopeLabel, handler.kind, () =>
                  handler.commitTerminal(value, tx),
                ),
            )
            .pipe(Effect.map(({ events }) => ({ eventIds: events.map((event) => event.id) }))),
      });
    }),
  );
};
