import { Clock, Effect, Layer } from "effect";
import {
  AttachedStreamRegistry,
  AttachedStreams,
  makeAttachedStreamService,
  runSynchronousAttachedStreamCommit,
  type AttachedStreamTx,
} from "@agent-os/runtime";
import { SqlError } from "@agent-os/kernel/errors";
import type { LedgerEvent } from "@agent-os/kernel/types";
import { EventBus } from "./ledger/event-bus";
import { fireLedgerEvents, insertLedgerEvent } from "./ledger/inserted-events";
import { selectLedgerEvents } from "./ledger/ledger";

export const AttachedStreamsLive = (
  ctx: DurableObjectState,
  scope: string,
): Layer.Layer<AttachedStreams, SqlError, AttachedStreamRegistry | EventBus> => {
  let nextStreamId = 1;
  return Layer.effect(
    AttachedStreams,
    Effect.gen(function* () {
      const registry = yield* AttachedStreamRegistry;
      const bus = yield* EventBus;
      return makeAttachedStreamService({
        registry,
        scope,
        now: () => Clock.currentTimeMillis,
        makeStreamRef: () => `attached/${nextStreamId++}`,
        commitTerminal: ({ handler, ctx: streamCtx, terminal }) =>
          Effect.gen(function* () {
            const events = yield* Effect.try({
              try: () =>
                ctx.storage.transactionSync(() => {
                  const written: LedgerEvent[] = [];
                  const tx: AttachedStreamTx = {
                    scope,
                    streamRef: streamCtx.streamRef,
                    now: streamCtx.now,
                    signal: streamCtx.signal,
                    events: (opts = {}) => {
                      const afterId =
                        opts.afterId === undefined || !Number.isFinite(opts.afterId)
                          ? 0
                          : Math.max(0, Math.floor(opts.afterId));
                      const kinds =
                        opts.kinds === undefined
                          ? undefined
                          : new Set(
                              Array.from(new Set(opts.kinds)).filter((kind) => kind.length > 0),
                            );
                      return [
                        ...selectLedgerEvents(ctx.storage.sql, scope, opts),
                        ...written,
                      ].filter((event) => {
                        if (event.id <= afterId) return false;
                        if (kinds !== undefined && kinds.size > 0 && !kinds.has(event.kind)) {
                          return false;
                        }
                        return true;
                      });
                    },
                    insertEvent: (spec) => {
                      const payloadStr = JSON.stringify(spec.payload);
                      if (typeof payloadStr !== "string") {
                        throw new TypeError("ledger event payload must be JSON serializable");
                      }
                      const event = insertLedgerEvent(ctx.storage.sql, {
                        ts: spec.ts ?? streamCtx.now,
                        kind: spec.kind,
                        scope,
                        payloadStr,
                        payload: spec.payload,
                      });
                      written.push(event);
                      return event;
                    },
                  };
                  const failure = runSynchronousAttachedStreamCommit(scope, handler.kind, () =>
                    handler.commitTerminal(terminal, tx),
                  );
                  if (failure !== null) throw new TypeError(failure);
                  return written;
                }),
              catch: (cause) => new SqlError({ cause }),
            });
            yield* fireLedgerEvents(bus, events);
          }),
      });
    }),
  );
};
