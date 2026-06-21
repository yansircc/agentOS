import { Cause, Clock, Effect, Exit, Layer, Option } from "effect";
import {
  DurableTriggerAcquireCancelled,
  DurableTriggerCommitReturnedThenable,
  JsonStringifyError,
  SqlError,
  UnregisteredDurableTriggerKind,
} from "@agent-os/core/errors";
import type { EventQueryOptions, LedgerEvent } from "@agent-os/core/types";
import {
  DEFAULT_TRIGGER_ACQUIRE_DEADLINE_MS,
  DurableTriggerRegistry,
  RuntimeStorageError,
  TriggerPump,
  drainTriggerPumpUntilQuiet,
  runtimeStorageError,
  runSynchronousTriggerCommit,
  type AnyDurableTrigger,
  type TriggerCancelResult,
  type TriggerCancellation,
  type TriggerTx,
} from "@agent-os/runtime";
import { selectLedgerEvents } from "./ledger/ledger";
import { EventBus } from "./ledger";
import {
  armNextDue,
  claimDueWork,
  completeClaimedDueWork,
  ensureDueWorkSchema,
  insertDurableTriggerDueWork,
  listStuckDueWork,
  requestDueWorkCancellation,
  selectDuePending,
  selectDueByTriggerIntent,
  type ClaimedDueWorkRow,
  type DueWorkRow,
} from "./due-work";
import {
  canonicalLedgerPayload,
  commitLedgerTransaction,
  type LedgerTransactionBuilder,
} from "./ledger/commit";
import { ledgerEventFromRow, type LedgerEventSqlRow } from "./ledger/identity";
import type { BackendProtocolEventIdentity } from "@agent-os/core/backend-protocol";

const failTriggerTransaction = (kind: string): never => {
  throw new UnregisteredDurableTriggerKind({ kind });
};

const triggerTransactionError = (
  cause: unknown,
): UnregisteredDurableTriggerKind | DurableTriggerCommitReturnedThenable | null =>
  cause instanceof UnregisteredDurableTriggerKind ||
  cause instanceof DurableTriggerCommitReturnedThenable
    ? cause
    : null;

const acquireFailure = (cause: unknown): DurableTriggerAcquireCancelled | SqlError =>
  cause instanceof DurableTriggerAcquireCancelled ? cause : new SqlError({ cause });

const claimToken = (): string => crypto.randomUUID();

const cancellationFor = (row: DueWorkRow): TriggerCancellation => ({
  ...(row.cancelReason === null ? {} : { reason: row.cancelReason }),
  ...(row.cancelRequestedAt === null ? {} : { requestedAt: row.cancelRequestedAt }),
});

const readIntentEvent = (
  sql: SqlStorage,
  intentEventId: number,
  intentEventKind: string,
): Effect.Effect<LedgerEvent, SqlError> =>
  Effect.gen(function* () {
    const row = yield* Effect.try({
      try: () =>
        sql
          .exec("SELECT * FROM events WHERE id = ? AND kind = ?", intentEventId, intentEventKind)
          .toArray()[0],
      catch: (cause) => new SqlError({ cause }),
    });
    if (row === undefined) {
      return yield* Effect.fail(
        new SqlError({ cause: `durable trigger intent event missing: ${intentEventId}` }),
      );
    }
    return yield* Effect.try({
      try: () => ledgerEventFromRow(row as unknown as LedgerEventSqlRow),
      catch: (cause) => new SqlError({ cause }),
    });
  });

export const TriggerPumpLive = (
  ctx: DurableObjectState,
  scope: string,
): Layer.Layer<TriggerPump, RuntimeStorageError, EventBus | DurableTriggerRegistry> => {
  const sql = ctx.storage.sql;
  const triggerError = (
    cause: unknown,
  ):
    | RuntimeStorageError
    | JsonStringifyError
    | UnregisteredDurableTriggerKind
    | DurableTriggerCommitReturnedThenable =>
    cause instanceof JsonStringifyError ||
    cause instanceof UnregisteredDurableTriggerKind ||
    cause instanceof DurableTriggerCommitReturnedThenable ||
    cause instanceof RuntimeStorageError
      ? cause
      : runtimeStorageError("trigger", cause);
  return Layer.effect(
    TriggerPump,
    Effect.gen(function* () {
      yield* ensureDueWorkSchema(sql).pipe(
        Effect.mapError((cause) => runtimeStorageError("trigger", cause)),
      );
      const bus = yield* EventBus;
      const registry = yield* DurableTriggerRegistry;
      const activeClaims = new Map<
        number,
        { readonly token: string; readonly controller: AbortController }
      >();

      const eventsFor =
        (identity: BackendProtocolEventIdentity) =>
        (opts: Pick<EventQueryOptions, "afterId" | "kinds"> = {}): ReadonlyArray<LedgerEvent> => {
          const afterId =
            opts.afterId === undefined || !Number.isFinite(opts.afterId)
              ? 0
              : Math.max(0, Math.floor(opts.afterId));
          const kinds =
            opts.kinds === undefined
              ? undefined
              : new Set(Array.from(new Set(opts.kinds)).filter((kind) => kind.length > 0));
          return selectLedgerEvents(sql, identity, opts).filter((event) => {
            if (event.id <= afterId) return false;
            if (kinds !== undefined && kinds.size > 0 && !kinds.has(event.kind)) return false;
            return true;
          });
        };

      const txFor = (
        row: DueWorkRow,
        now: number,
        builder: LedgerTransactionBuilder,
        written: LedgerEvent[],
        acquireMode: "normal" | "redrive",
        identity: BackendProtocolEventIdentity,
      ): TriggerTx =>
        ({
          scope,
          now,
          dueWorkId: row.id,
          intentEventId: row.payload.intentEventId,
          acquireMode,
          insertEvent: (spec) => {
            const payload = canonicalLedgerPayload(spec.payload).payload;
            const ref = builder.append({
              ts: spec.ts ?? now,
              kind: spec.kind,
              scopeRef: identity.scopeRef,
              effectAuthorityRef: identity.effectAuthorityRef,
              payload,
            });
            const event = {
              id: builder.id(ref),
              ts: spec.ts ?? now,
              kind: spec.kind,
              scopeRef: identity.scopeRef,
              factOwnerRef: identity.factOwnerRef,
              effectAuthorityRef: identity.effectAuthorityRef,
              payload,
            };
            written.push(event);
            return event;
          },
          enqueue: (spec) => {
            if (!registry.has(spec.triggerKind)) {
              return failTriggerTransaction(spec.triggerKind);
            }
            const payload = canonicalLedgerPayload(spec.payload).payload;
            const ref = builder.append({
              ts: spec.ts ?? now,
              kind: spec.intentEventKind,
              scopeRef: identity.scopeRef,
              effectAuthorityRef: identity.effectAuthorityRef,
              payload,
            });
            const event = {
              id: builder.id(ref),
              ts: spec.ts ?? now,
              kind: spec.intentEventKind,
              scopeRef: identity.scopeRef,
              factOwnerRef: identity.factOwnerRef,
              effectAuthorityRef: identity.effectAuthorityRef,
              payload,
            };
            builder.afterInsert(() => {
              insertDurableTriggerDueWork(sql, spec.fireAt, spec.triggerKind, event.id);
            });
            written.push(event);
            return event;
          },
          reschedule: (fireAt, intentEventId = row.payload.intentEventId) => {
            builder.afterInsert(() => {
              insertDurableTriggerDueWork(sql, fireAt, row.kind, intentEventId);
            });
          },
        }) satisfies TriggerTx;

      const parseIntent = (
        trigger: AnyDurableTrigger,
        row: DueWorkRow,
      ): Effect.Effect<
        { readonly intent: unknown; readonly identity: BackendProtocolEventIdentity },
        SqlError
      > =>
        Effect.gen(function* () {
          const intentEvent = yield* readIntentEvent(
            sql,
            row.payload.intentEventId,
            trigger.intentEventKind,
          );
          const parsedIntent = trigger.parseIntent(intentEvent.payload);
          if (!parsedIntent.ok) {
            return yield* Effect.fail(new SqlError({ cause: parsedIntent.reason }));
          }
          return {
            intent: parsedIntent.intent,
            identity: {
              scopeRef: intentEvent.scopeRef,
              effectAuthorityRef: intentEvent.effectAuthorityRef,
              factOwnerRef: intentEvent.factOwnerRef,
            },
          };
        });

      const commitNormal = (
        trigger: AnyDurableTrigger,
        row: ClaimedDueWorkRow,
        now: number,
        outcome: unknown,
        acquireMode: "normal" | "redrive",
        identity: BackendProtocolEventIdentity,
      ): Effect.Effect<
        ReadonlyArray<LedgerEvent> | null,
        | SqlError
        | JsonStringifyError
        | UnregisteredDurableTriggerKind
        | DurableTriggerCommitReturnedThenable
      > =>
        Effect.gen(function* () {
          const committed = yield* commitLedgerTransaction(
            ctx,
            bus,
            { factOwnerRef: identity.factOwnerRef },
            (builder) => {
              const stillOwned = sql
                .exec(
                  `
                    SELECT id
                    FROM due_work
                    WHERE id = ?
                      AND claim_token = ?
                      AND completed_at IS NULL
                  `,
                  row.id,
                  row.claimToken,
                )
                .toArray();
              if (stillOwned.length === 0) return { owned: false as const };
              const written: LedgerEvent[] = [];
              const tx = txFor(row, now, builder, written, acquireMode, identity);
              const commitFailure = runSynchronousTriggerCommit(scope, row.kind, () =>
                trigger.commit(outcome, tx),
              );
              if (commitFailure !== null) throw commitFailure;
              completeClaimedDueWork(sql, row.id, now, row.claimToken);
              return { owned: true as const };
            },
            triggerTransactionError,
          );
          return committed.value.owned ? committed.events : null;
        });

      const commitCancelled = (
        trigger: AnyDurableTrigger,
        row: DueWorkRow,
        now: number,
        intent: unknown,
        identity: BackendProtocolEventIdentity,
        mode: {
          readonly claimToken?: string;
          readonly requireUnclaimed?: boolean;
          readonly acquireMode: "normal" | "redrive";
        },
      ): Effect.Effect<
        ReadonlyArray<LedgerEvent> | null,
        | SqlError
        | JsonStringifyError
        | UnregisteredDurableTriggerKind
        | DurableTriggerCommitReturnedThenable
      > =>
        Effect.gen(function* () {
          const committed = yield* commitLedgerTransaction(
            ctx,
            bus,
            { factOwnerRef: identity.factOwnerRef },
            (builder) => {
              const predicate =
                mode.claimToken === undefined
                  ? mode.requireUnclaimed === true
                    ? "AND claim_token IS NULL"
                    : ""
                  : "AND claim_token = ?";
              const params = mode.claimToken === undefined ? [row.id] : [row.id, mode.claimToken];
              const stillOwned = sql
                .exec(
                  `
                    SELECT id
                    FROM due_work
                    WHERE id = ?
                      AND completed_at IS NULL
                      ${predicate}
                  `,
                  ...params,
                )
                .toArray();
              if (stillOwned.length === 0) return { owned: false as const };
              const written: LedgerEvent[] = [];
              const tx = txFor(row, now, builder, written, mode.acquireMode, identity);
              const commitFailure = runSynchronousTriggerCommit(scope, row.kind, () =>
                trigger.commitCancelled(intent, cancellationFor(row), tx),
              );
              if (commitFailure !== null) throw commitFailure;
              sql.exec(
                `
                  UPDATE due_work
                  SET cancel_requested_at = COALESCE(cancel_requested_at, ?),
                      cancel_reason = COALESCE(cancel_reason, ?),
                      cancelled_at = ?,
                      completed_at = ?
                  WHERE id = ?
                    AND completed_at IS NULL
                    ${predicate}
                `,
                now,
                row.cancelReason,
                now,
                now,
                ...params,
              );
              return { owned: true as const };
            },
            triggerTransactionError,
          );
          return committed.value.owned ? committed.events : null;
        });

      const runOne = (
        row: DueWorkRow,
        now: number,
      ): Effect.Effect<
        boolean,
        | SqlError
        | JsonStringifyError
        | UnregisteredDurableTriggerKind
        | DurableTriggerCommitReturnedThenable
      > =>
        Effect.gen(function* () {
          const trigger = registry.get(row.kind);
          if (trigger === undefined) {
            return yield* Effect.fail(new UnregisteredDurableTriggerKind({ kind: row.kind }));
          }
          const parsed = yield* parseIntent(trigger, row);
          const token = claimToken();
          const deadlineMs = trigger.acquireDeadlineMs ?? DEFAULT_TRIGGER_ACQUIRE_DEADLINE_MS;
          const claimed = yield* claimDueWork(sql, row.id, now, token, now + deadlineMs);
          if (claimed === null) return false;
          const controller = new AbortController();
          activeClaims.set(row.id, { token: claimed.claimToken, controller });
          if (claimed.cancelRequestedAt !== null) {
            controller.abort(claimed.cancelReason ?? "durable trigger cancelled");
          }
          const exit = yield* Effect.exit(
            trigger.acquire(parsed.intent, {
              scope,
              now,
              dueWorkId: claimed.id,
              intentEventId: claimed.payload.intentEventId,
              signal: controller.signal,
              acquireMode: claimed.redriveCount > 0 ? "redrive" : "normal",
              events: eventsFor(parsed.identity),
            }),
          );
          const active = activeClaims.get(row.id);
          if (active?.token === claimed.claimToken) {
            activeClaims.delete(row.id);
          }
          const acquireMode = claimed.redriveCount > 0 ? "redrive" : "normal";
          const events = Exit.isSuccess(exit)
            ? yield* commitNormal(trigger, claimed, now, exit.value, acquireMode, parsed.identity)
            : yield* Effect.gen(function* () {
                const failure = Cause.findErrorOption(exit.cause);
                if (Option.isNone(failure)) {
                  return yield* Effect.fail(new SqlError({ cause: exit.cause }));
                }
                const cause = acquireFailure(failure.value);
                if (cause instanceof SqlError) {
                  return yield* Effect.fail(cause);
                }
                const cancelledRow =
                  cause.reason === undefined || claimed.cancelReason !== null
                    ? claimed
                    : {
                        ...claimed,
                        cancelReason: cause.reason,
                        cancelRequestedAt: claimed.cancelRequestedAt ?? now,
                      };
                return yield* commitCancelled(
                  trigger,
                  cancelledRow,
                  now,
                  parsed.intent,
                  parsed.identity,
                  {
                    claimToken: claimed.claimToken,
                    acquireMode,
                  },
                );
              });
          if (events === null) return false;
          return true;
        });

      const cancelTrigger = (spec: {
        readonly triggerKind: string;
        readonly intentEventId: number;
        readonly reason?: string;
      }): Effect.Effect<
        TriggerCancelResult,
        | SqlError
        | JsonStringifyError
        | UnregisteredDurableTriggerKind
        | DurableTriggerCommitReturnedThenable
      > =>
        Effect.gen(function* () {
          const trigger = registry.get(spec.triggerKind);
          if (trigger === undefined) {
            return yield* Effect.fail(
              new UnregisteredDurableTriggerKind({ kind: spec.triggerKind }),
            );
          }
          if (trigger.cancellation === "ignored") return { status: "ignored" };
          const now = yield* Clock.currentTimeMillis;
          const rows = yield* selectDueByTriggerIntent(sql, spec.triggerKind, spec.intentEventId);
          if (rows.length === 0) {
            return { status: "not_found", cancelled: 0 };
          }
          let cancelled = 0;
          let requested = 0;
          for (const row of rows) {
            const parsed = yield* parseIntent(trigger, row);
            if (row.claimToken === null) {
              const refreshed = {
                ...row,
                cancelRequestedAt: row.cancelRequestedAt ?? now,
                cancelReason: row.cancelReason ?? spec.reason ?? null,
              };
              const events = yield* commitCancelled(
                trigger,
                refreshed,
                now,
                parsed.intent,
                parsed.identity,
                {
                  requireUnclaimed: true,
                  acquireMode: row.redriveCount > 0 ? "redrive" : "normal",
                },
              );
              if (events !== null) {
                cancelled += 1;
              }
            } else {
              const updated = requestDueWorkCancellation(sql, row.id, now, spec.reason);
              if (updated > 0) {
                requested += 1;
                const active = activeClaims.get(row.id);
                if (active?.token === row.claimToken) {
                  active.controller.abort(spec.reason ?? "durable trigger cancelled");
                }
              }
            }
          }
          yield* armNextDue(ctx, sql);
          if (cancelled > 0) return { status: "cancelled", cancelled };
          if (requested > 0) return { status: "requested", requested };
          return { status: "already_completed", cancelled: 0 };
        });

      const drainDue = (now: number) =>
        Effect.gen(function* () {
          const rows = yield* selectDuePending(sql, now);
          let drained = 0;
          for (const row of rows) {
            const completed = yield* runOne(row, now);
            if (completed) drained += 1;
          }
          yield* armNextDue(ctx, sql);
          return { drained };
        });
      const drainDueService = (now: number) => drainDue(now).pipe(Effect.mapError(triggerError));
      return {
        drainDue: drainDueService,
        drainUntilQuiet: (now, options) =>
          drainTriggerPumpUntilQuiet(drainDueService, now, options),
        cancelTrigger: (spec) => cancelTrigger(spec).pipe(Effect.mapError(triggerError)),
        stuckTriggers: (now) =>
          Effect.gen(function* () {
            const stuck = yield* listStuckDueWork(sql, now);
            return { stuck };
          }).pipe(Effect.mapError((cause) => runtimeStorageError("trigger", cause))),
      };
    }),
  );
};
