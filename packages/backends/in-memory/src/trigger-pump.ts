import { Cause, Clock, Effect, Exit, Layer, Option } from "effect";
import {
  DurableTriggerAcquireCancelled,
  SqlError,
  UnregisteredDurableTriggerKind,
} from "@agent-os/kernel/errors";
import {
  DEFAULT_TRIGGER_ACQUIRE_DEADLINE_MS,
  DurableTriggerRegistry,
  TriggerPump,
  drainTriggerPumpUntilQuiet,
  runSynchronousTriggerCommit,
  type AnyDurableTrigger,
  type TriggerCancellation,
} from "@agent-os/runtime";
import type {
  BackendProtocolEventIdentity,
  BackendProtocolTruthIdentity,
} from "@agent-os/backend-protocol";
import { inMemoryRuntimeEventIdentity, type InMemoryBackendState } from "./state";

const claimToken = (): string => crypto.randomUUID();

const cancellationFor = (row: {
  readonly cancelReason: string | null;
  readonly cancelRequestedAt: number | null;
}): TriggerCancellation => ({
  ...(row.cancelReason === null ? {} : { reason: row.cancelReason }),
  ...(row.cancelRequestedAt === null ? {} : { requestedAt: row.cancelRequestedAt }),
});

export const InMemoryTriggerPumpLive = (
  state: InMemoryBackendState,
  truthIdentity: BackendProtocolTruthIdentity,
  scopeLabel: string,
): Layer.Layer<TriggerPump, SqlError, DurableTriggerRegistry> =>
  Layer.effect(
    TriggerPump,
    Effect.gen(function* () {
      const registry = yield* DurableTriggerRegistry;
      const identity = inMemoryRuntimeEventIdentity(truthIdentity);
      const activeClaims = new Map<
        number,
        { readonly token: string; readonly controller: AbortController }
      >();
      const parseIntent = (
        trigger: AnyDurableTrigger,
        row: {
          readonly identity: BackendProtocolEventIdentity;
          readonly payload: { readonly intentEventId: number };
        },
      ) => {
        const intentEvent = state.eventById(
          row.identity,
          row.payload.intentEventId,
          trigger.intentEventKind,
        );
        if (intentEvent === null) {
          return Effect.fail(
            new SqlError({
              cause: new TypeError(
                `durable trigger intent event missing: ${row.payload.intentEventId}`,
              ),
            }),
          );
        }
        const parsedIntent = trigger.parseIntent(intentEvent.payload);
        return parsedIntent.ok
          ? Effect.succeed(parsedIntent.intent)
          : Effect.fail(new SqlError({ cause: parsedIntent.reason }));
      };
      const drainDue = (now: number) =>
        Effect.gen(function* () {
          const pending = state.dueClaimable(identity, now);
          let drained = 0;
          for (const row of pending) {
            const trigger = registry.get(row.kind);
            if (trigger === undefined) {
              return yield* Effect.fail(new UnregisteredDurableTriggerKind({ kind: row.kind }));
            }
            const intent = yield* parseIntent(trigger, row);
            const token = claimToken();
            const deadlineMs = trigger.acquireDeadlineMs ?? DEFAULT_TRIGGER_ACQUIRE_DEADLINE_MS;
            const claimed = state.claimDueWork(row, now, token, now + deadlineMs);
            if (claimed === null) continue;
            const controller = new AbortController();
            activeClaims.set(row.id, { token, controller });
            if (claimed.cancelRequestedAt !== null) {
              controller.abort(claimed.cancelReason ?? "durable trigger cancelled");
            }
            const acquireMode = claimed.redriveCount > 0 ? "redrive" : "normal";
            const exit = yield* Effect.exit(
              trigger.acquire(intent, {
                scope: scopeLabel,
                now,
                dueWorkId: row.id,
                intentEventId: row.payload.intentEventId,
                signal: controller.signal,
                acquireMode,
              }),
            );
            const active = activeClaims.get(row.id);
            if (active?.token === token) activeClaims.delete(row.id);
            const committed = Exit.isSuccess(exit)
              ? yield* state.commitTrigger(
                  scopeLabel,
                  row,
                  now,
                  (kind) => registry.has(kind),
                  (tx) =>
                    runSynchronousTriggerCommit(scopeLabel, row.kind, () =>
                      trigger.commit(exit.value, tx),
                    ),
                  { claimToken: token, signal: controller.signal, acquireMode },
                )
              : yield* Effect.gen(function* () {
                  const failure = Cause.failureOption(exit.cause);
                  if (Option.isNone(failure)) {
                    return yield* Effect.fail(new SqlError({ cause: exit.cause }));
                  }
                  if (!(failure.value instanceof DurableTriggerAcquireCancelled)) {
                    return yield* Effect.fail(new SqlError({ cause: failure.value }));
                  }
                  if (failure.value.reason !== undefined && row.cancelReason === null) {
                    row.cancelReason = failure.value.reason;
                    row.cancelRequestedAt ??= now;
                  }
                  return yield* state.commitTrigger(
                    scopeLabel,
                    row,
                    now,
                    (kind) => registry.has(kind),
                    (tx) =>
                      runSynchronousTriggerCommit(scopeLabel, row.kind, () =>
                        trigger.commitCancelled(intent, cancellationFor(row), tx),
                      ),
                    { claimToken: token, cancelled: true, signal: controller.signal, acquireMode },
                  );
                });
            if (committed.completed) drained += 1;
          }
          return { drained };
        });
      const cancelTrigger = (spec: {
        readonly triggerKind: string;
        readonly intentEventId: number;
        readonly reason?: string;
      }) =>
        Effect.gen(function* () {
          const trigger = registry.get(spec.triggerKind);
          if (trigger === undefined) {
            return yield* Effect.fail(
              new UnregisteredDurableTriggerKind({ kind: spec.triggerKind }),
            );
          }
          if (trigger.cancellation === "ignored") return { status: "ignored" as const };
          const now = yield* Clock.currentTimeMillis;
          const rows = state.dueByTriggerIntent(identity, spec.triggerKind, spec.intentEventId);
          if (rows.length === 0) return { status: "not_found" as const, cancelled: 0 as const };
          let cancelled = 0;
          let requested = 0;
          for (const row of rows) {
            const intent = yield* parseIntent(trigger, row);
            if (row.claimToken === null) {
              state.requestCancellation(row, now, spec.reason);
              const committed = yield* state.commitTrigger(
                scopeLabel,
                row,
                now,
                (kind) => registry.has(kind),
                (tx) =>
                  runSynchronousTriggerCommit(scopeLabel, row.kind, () =>
                    trigger.commitCancelled(intent, cancellationFor(row), tx),
                  ),
                { requireUnclaimed: true, cancelled: true },
              );
              if (committed.completed) cancelled += 1;
            } else if (state.requestCancellation(row, now, spec.reason)) {
              requested += 1;
              const active = activeClaims.get(row.id);
              if (active?.token === row.claimToken) {
                active.controller.abort(spec.reason ?? "durable trigger cancelled");
              }
            }
          }
          if (cancelled > 0) return { status: "cancelled" as const, cancelled };
          if (requested > 0) return { status: "requested" as const, requested };
          return { status: "already_completed" as const, cancelled: 0 as const };
        });
      return {
        drainDue,
        drainUntilQuiet: (now, options) => drainTriggerPumpUntilQuiet(drainDue, now, options),
        cancelTrigger,
        stuckTriggers: (now) => Effect.succeed({ stuck: state.stuckDueWork(identity, now) }),
      };
    }),
  );
