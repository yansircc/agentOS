import { Clock, Effect, Layer } from "effect";
import {
  AttachedStreamRegistry,
  AttachedStreams,
  makeAttachedStreamService,
  runtimeStorageOrJsonError,
  runSynchronousAttachedStreamCommit,
  type AttachedStreamTx,
} from "@agent-os/runtime";
import type { LedgerEvent } from "@agent-os/kernel/types";
import { EventBus } from "./ledger/event-bus";
import { selectLedgerEvents } from "./ledger/ledger";
import { canonicalLedgerPayload, commitLedgerTransaction } from "./ledger/commit";
import type { BackendProtocolEventIdentity } from "@agent-os/backend-protocol";

export const AttachedStreamsLive = (
  ctx: DurableObjectState,
  scope: string,
  identity: BackendProtocolEventIdentity,
): Layer.Layer<AttachedStreams, never, AttachedStreamRegistry | EventBus> => {
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
            const committed = yield* commitLedgerTransaction(
              ctx,
              bus,
              { factOwnerRef: identity.factOwnerRef },
              (builder) => {
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
                      ...selectLedgerEvents(ctx.storage.sql, identity, opts),
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
                    const payload = canonicalLedgerPayload(spec.payload).payload;
                    const ref = builder.append({
                      ts: spec.ts ?? streamCtx.now,
                      kind: spec.kind,
                      scopeRef: identity.scopeRef,
                      effectAuthorityRef: identity.effectAuthorityRef,
                      payload,
                    });
                    const event = {
                      id: builder.id(ref),
                      ts: spec.ts ?? streamCtx.now,
                      kind: spec.kind,
                      scopeRef: identity.scopeRef,
                      factOwnerRef: identity.factOwnerRef,
                      effectAuthorityRef: identity.effectAuthorityRef,
                      payload,
                    };
                    written.push(event);
                    return event;
                  },
                };
                const failure = runSynchronousAttachedStreamCommit(scope, handler.kind, () =>
                  handler.commitTerminal(terminal, tx),
                );
                if (failure !== null) throw failure;
              },
              (cause) => (typeof cause === "string" ? cause : null),
            );
            return { eventIds: committed.events.map((event) => event.id) };
          }).pipe(Effect.mapError((cause) => runtimeStorageOrJsonError("attached_stream", cause))),
      });
    }),
  );
};
