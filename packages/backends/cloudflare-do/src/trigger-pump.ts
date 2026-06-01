import { Cause, Clock, Effect, Exit, Layer, Option } from "effect";
import {
  DurableTriggerAcquireCancelled,
  DurableTriggerCommitReturnedThenable,
  JsonStringifyError,
  SqlError,
  UnregisteredDurableTriggerKind,
} from "@agent-os/kernel/errors";
import type { LedgerEvent } from "@agent-os/kernel/types";
import {
  DEFAULT_TRIGGER_ACQUIRE_DEADLINE_MS,
  DURABLE_TRIGGER_CANCELLED,
  DurableTriggerRegistry,
  TriggerPump,
  drainTriggerPumpUntilQuiet,
  runSynchronousTriggerCommit,
  type AnyDurableTrigger,
  type TriggerCancelResult,
  type TriggerCancellation,
  type TriggerTx,
} from "@agent-os/runtime";
import { fireLedgerEvents, insertLedgerEvent } from "./ledger/inserted-events";
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
import { sqlText } from "./storage/sql-row";

const failTriggerTransaction = (kind: string): never => {
  throw new UnregisteredDurableTriggerKind({ kind });
};

const triggerTransactionError = (
  cause: unknown,
): SqlError | UnregisteredDurableTriggerKind | DurableTriggerCommitReturnedThenable =>
  cause instanceof UnregisteredDurableTriggerKind ||
  cause instanceof DurableTriggerCommitReturnedThenable
    ? cause
    : new SqlError({ cause });

const acquireFailure = (cause: unknown): DurableTriggerAcquireCancelled | SqlError =>
  cause instanceof DurableTriggerAcquireCancelled ? cause : new SqlError({ cause });

const claimToken = (): string => crypto.randomUUID();

const cancellationFor = (row: DueWorkRow): TriggerCancellation => ({
  ...(row.cancelReason === null ? {} : { reason: row.cancelReason }),
  ...(row.cancelRequestedAt === null ? {} : { requestedAt: row.cancelRequestedAt }),
});

const genericCancelledPayload = (
  row: DueWorkRow,
): {
  readonly triggerKind: string;
  readonly intentEventId: number;
  readonly dueWorkId: number;
  readonly reason?: string;
} => ({
  triggerKind: row.kind,
  intentEventId: row.payload.intentEventId,
  dueWorkId: row.id,
  ...(row.cancelReason === null ? {} : { reason: row.cancelReason }),
});

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
): Layer.Layer<TriggerPump, SqlError, EventBus | DurableTriggerRegistry> => {
  const sql = ctx.storage.sql;
  return Layer.scoped(
    TriggerPump,
    Effect.gen(function* () {
      yield* ensureDueWorkSchema(sql);
      const bus = yield* EventBus;
      const registry = yield* DurableTriggerRegistry;
      const activeClaims = new Map<
        number,
        { readonly token: string; readonly controller: AbortController }
      >();

      const txFor = (
        row: DueWorkRow,
        now: number,
        written: LedgerEvent[],
        signal: AbortSignal,
        acquireMode: "normal" | "redrive",
      ): TriggerTx => ({
        scope,
        now,
        dueWorkId: row.id,
        intentEventId: row.payload.intentEventId,
        signal,
        acquireMode,
        events: (opts = {}) => selectLedgerEvents(sql, scope, opts),
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
            return failTriggerTransaction(spec.triggerKind);
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
      });

      const parseIntent = (
        trigger: AnyDurableTrigger,
        row: DueWorkRow,
      ): Effect.Effect<unknown, SqlError> =>
        Effect.gen(function* () {
          const rawIntent = yield* readIntentPayload(
            sql,
            row.payload.intentEventId,
            trigger.intentEventKind,
          );
          const parsedIntent = trigger.parseIntent(rawIntent);
          if (!parsedIntent.ok) {
            return yield* Effect.fail(new SqlError({ cause: parsedIntent.reason }));
          }
          return parsedIntent.intent;
        });

      const commitNormal = (
        trigger: AnyDurableTrigger,
        row: ClaimedDueWorkRow,
        now: number,
        outcome: unknown,
        signal: AbortSignal,
        acquireMode: "normal" | "redrive",
      ): Effect.Effect<
        ReadonlyArray<LedgerEvent> | null,
        SqlError | UnregisteredDurableTriggerKind | DurableTriggerCommitReturnedThenable
      > =>
        Effect.try({
          try: () =>
            ctx.storage.transactionSync((): ReadonlyArray<LedgerEvent> | null => {
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
              if (stillOwned.length === 0) return null;
              const written: LedgerEvent[] = [];
              const tx = txFor(row, now, written, signal, acquireMode);
              const commitFailure = runSynchronousTriggerCommit(scope, row.kind, () =>
                trigger.commit(outcome, tx),
              );
              if (commitFailure !== null) throw commitFailure;
              completeClaimedDueWork(sql, row.id, now, row.claimToken);
              return written;
            }),
          catch: triggerTransactionError,
        });

      const commitCancelled = (
        trigger: AnyDurableTrigger,
        row: DueWorkRow,
        now: number,
        intent: unknown,
        mode: {
          readonly claimToken?: string;
          readonly requireUnclaimed?: boolean;
          readonly signal: AbortSignal;
          readonly acquireMode: "normal" | "redrive";
        },
      ): Effect.Effect<
        ReadonlyArray<LedgerEvent> | null,
        SqlError | UnregisteredDurableTriggerKind | DurableTriggerCommitReturnedThenable
      > =>
        Effect.try({
          try: () =>
            ctx.storage.transactionSync((): ReadonlyArray<LedgerEvent> | null => {
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
              if (stillOwned.length === 0) return null;
              const written: LedgerEvent[] = [];
              const tx = txFor(row, now, written, mode.signal, mode.acquireMode);
              if (trigger.commitCancelled === undefined) {
                tx.insertEvent({
                  kind: DURABLE_TRIGGER_CANCELLED,
                  payload: genericCancelledPayload(row),
                });
              } else {
                const commitFailure = runSynchronousTriggerCommit(scope, row.kind, () =>
                  trigger.commitCancelled?.(intent, cancellationFor(row), tx),
                );
                if (commitFailure !== null) throw commitFailure;
              }
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
              return written;
            }),
          catch: triggerTransactionError,
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
          const intent = yield* parseIntent(trigger, row);
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
            trigger.acquire(intent, {
              scope,
              now,
              dueWorkId: claimed.id,
              intentEventId: claimed.payload.intentEventId,
              signal: controller.signal,
              acquireMode: claimed.redriveCount > 0 ? "redrive" : "normal",
            }),
          );
          const active = activeClaims.get(row.id);
          if (active?.token === claimed.claimToken) {
            activeClaims.delete(row.id);
          }
          const acquireMode = claimed.redriveCount > 0 ? "redrive" : "normal";
          const events = Exit.isSuccess(exit)
            ? yield* commitNormal(trigger, claimed, now, exit.value, controller.signal, acquireMode)
            : yield* Effect.gen(function* () {
                const failure = Cause.failureOption(exit.cause);
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
                return yield* commitCancelled(trigger, cancelledRow, now, intent, {
                  claimToken: claimed.claimToken,
                  signal: controller.signal,
                  acquireMode,
                });
              });
          if (events === null) return false;
          yield* fireLedgerEvents(bus, events);
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
          const now = yield* Clock.currentTimeMillis;
          const rows = yield* selectDueByTriggerIntent(sql, spec.triggerKind, spec.intentEventId);
          if (rows.length === 0) {
            return { status: "not_found", cancelled: 0 };
          }
          let cancelled = 0;
          let requested = 0;
          for (const row of rows) {
            const intent = yield* parseIntent(trigger, row);
            if (row.claimToken === null) {
              requestDueWorkCancellation(sql, row.id, now, spec.reason);
              const refreshed = {
                ...row,
                cancelRequestedAt: row.cancelRequestedAt ?? now,
                cancelReason: row.cancelReason ?? spec.reason ?? null,
              };
              const events = yield* commitCancelled(trigger, refreshed, now, intent, {
                requireUnclaimed: true,
                signal: new AbortController().signal,
                acquireMode: row.redriveCount > 0 ? "redrive" : "normal",
              });
              if (events !== null) {
                cancelled += 1;
                yield* fireLedgerEvents(bus, events);
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
      return {
        drainDue,
        drainUntilQuiet: (now, options) => drainTriggerPumpUntilQuiet(drainDue, now, options),
        cancelTrigger,
        stuckTriggers: (now) =>
          Effect.gen(function* () {
            const stuck = yield* listStuckDueWork(sql, now);
            return { stuck };
          }),
      };
    }),
  );
};
