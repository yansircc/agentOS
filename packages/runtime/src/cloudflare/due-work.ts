import { Effect } from "effect";
import {
  JsonStringifyError,
  SqlError,
  UnregisteredDurableTriggerKind,
} from "@agent-os/core/errors";
import type { LedgerEvent } from "@agent-os/core/types";
import {
  durableProcessLifecycleState,
  durableTriggerDuePayload,
  parseIntentPointerDuePayload,
  scheduledEventIntentPayload,
  type DurableProcessLifecycleState,
  type IntentPointerDuePayload,
} from "@agent-os/core/backend-protocol";
import { getDurableTrigger, type TriggerRegistry } from "@agent-os/runtime";
import {
  commitLedgerTransaction,
  type LedgerEventRef,
  type LedgerTransactionBuilder,
} from "./ledger/commit";
import type { EventBusService } from "./ledger/event-bus";
import { sqlText } from "./storage/sql-row";
import type { BackendProtocolEventIdentity } from "@agent-os/core/backend-protocol";

export interface DueWorkRow {
  readonly id: number;
  readonly fireAt: number;
  readonly kind: string;
  readonly payload: IntentPointerDuePayload;
  readonly claimedAt: number | null;
  readonly claimToken: string | null;
  readonly claimDeadlineAt: number | null;
  readonly redriveCount: number;
  readonly cancelRequestedAt: number | null;
  readonly cancelReason: string | null;
  readonly cancelledAt: number | null;
}

export interface DueWorkInsertSpec {
  readonly fireAt: number;
  readonly kind: string;
  readonly payload: IntentPointerDuePayload;
}

export interface ClaimedDueWorkRow extends DueWorkRow {
  readonly claimToken: string;
  readonly claimDeadlineAt: number;
}

export interface StuckDueWorkRow {
  readonly dueWorkId: number;
  readonly triggerKind: string;
  readonly intentEventId: number;
  readonly claimDeadlineAt: number;
  readonly redriveCount: number;
}

type DueWorkParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly cause: unknown };

const dueRowPayload = (row: {
  readonly payload: unknown;
}): DueWorkParseResult<IntentPointerDuePayload> => {
  const payloadStr = sqlText(row.payload, "due_work.payload");
  const parsed = JSON.parse(payloadStr) as unknown;
  const payload = parseIntentPointerDuePayload(parsed);
  if (!payload.ok) {
    return { ok: false, cause: payload.cause };
  }
  return { ok: true, value: payload.payload };
};

const dueWorkRowFromSql = (row: Record<string, unknown>): DueWorkParseResult<DueWorkRow> => {
  const payload = dueRowPayload(row as { readonly payload: unknown });
  if (!payload.ok) return payload;
  return {
    ok: true,
    value: {
      id: Number(row.id),
      fireAt: Number(row.fire_at),
      kind: sqlText(row.kind, "due_work.kind"),
      payload: payload.value,
      claimedAt:
        row.claimed_at === null || row.claimed_at === undefined ? null : Number(row.claimed_at),
      claimToken:
        row.claim_token === null || row.claim_token === undefined
          ? null
          : sqlText(row.claim_token, "due_work.claim_token"),
      claimDeadlineAt:
        row.claim_deadline_at === null || row.claim_deadline_at === undefined
          ? null
          : Number(row.claim_deadline_at),
      redriveCount:
        row.redrive_count === null || row.redrive_count === undefined
          ? 0
          : Number(row.redrive_count),
      cancelRequestedAt:
        row.cancel_requested_at === null || row.cancel_requested_at === undefined
          ? null
          : Number(row.cancel_requested_at),
      cancelReason:
        row.cancel_reason === null || row.cancel_reason === undefined
          ? null
          : sqlText(row.cancel_reason, "due_work.cancel_reason"),
      cancelledAt:
        row.cancelled_at === null || row.cancelled_at === undefined
          ? null
          : Number(row.cancelled_at),
    },
  };
};

const ensureDueWorkColumn = (sql: SqlStorage, name: string, ddl: string): void => {
  const exists = sql
    .exec("PRAGMA table_info(due_work)")
    .toArray()
    .some((row) => row.name === name);
  if (!exists) {
    sql.exec(`ALTER TABLE due_work ADD COLUMN ${ddl}`);
  }
};

export const ensureDueWorkSchema = (sql: SqlStorage): Effect.Effect<void, SqlError> =>
  Effect.try({
    try: () => {
      sql.exec(`
        CREATE TABLE IF NOT EXISTS due_work (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          fire_at INTEGER NOT NULL,
          kind TEXT NOT NULL,
          payload TEXT NOT NULL,
          completed_at INTEGER,
          claimed_at INTEGER,
          claim_token TEXT,
          claim_deadline_at INTEGER,
          redrive_count INTEGER NOT NULL DEFAULT 0,
          cancel_requested_at INTEGER,
          cancel_reason TEXT,
          cancelled_at INTEGER
        )
      `);
      ensureDueWorkColumn(sql, "claimed_at", "claimed_at INTEGER");
      ensureDueWorkColumn(sql, "claim_token", "claim_token TEXT");
      ensureDueWorkColumn(sql, "claim_deadline_at", "claim_deadline_at INTEGER");
      ensureDueWorkColumn(sql, "redrive_count", "redrive_count INTEGER NOT NULL DEFAULT 0");
      ensureDueWorkColumn(sql, "cancel_requested_at", "cancel_requested_at INTEGER");
      ensureDueWorkColumn(sql, "cancel_reason", "cancel_reason TEXT");
      ensureDueWorkColumn(sql, "cancelled_at", "cancelled_at INTEGER");
      sql.exec(`
        CREATE INDEX IF NOT EXISTS idx_due_work_pending
          ON due_work (fire_at)
          WHERE completed_at IS NULL
      `);
      sql.exec(`
        CREATE INDEX IF NOT EXISTS idx_due_work_claim_deadline
          ON due_work (claim_deadline_at)
          WHERE completed_at IS NULL AND claim_token IS NOT NULL
      `);
    },
    catch: (cause) => new SqlError({ cause }),
  }).pipe(Effect.asVoid);

export const findNextDue = (sql: SqlStorage): Effect.Effect<number | null, SqlError> =>
  Effect.try({
    try: () => {
      const row = sql
        .exec(`
          SELECT MIN(next_at) AS m
          FROM (
            SELECT fire_at AS next_at
            FROM due_work
            WHERE completed_at IS NULL
              AND claim_token IS NULL
            UNION ALL
            SELECT claim_deadline_at AS next_at
            FROM due_work
            WHERE completed_at IS NULL
              AND claim_token IS NOT NULL
              AND claim_deadline_at IS NOT NULL
          )
        `)
        .toArray()[0];
      const m = row?.m;
      return m === null || m === undefined ? null : Number(m);
    },
    catch: (cause) => new SqlError({ cause }),
  });

export const armNextDue = (
  ctx: DurableObjectState,
  sql: SqlStorage,
): Effect.Effect<void, SqlError> =>
  Effect.gen(function* () {
    const next = yield* findNextDue(sql);
    if (next !== null) {
      yield* Effect.tryPromise({
        try: () => ctx.storage.setAlarm(next),
        catch: (cause) => new SqlError({ cause }),
      });
    }
  });

export const insertDueWork = (
  sql: SqlStorage,
  spec: DueWorkInsertSpec,
  payloadStr: string,
): number =>
  Number(
    sql
      .exec(
        "INSERT INTO due_work (fire_at, kind, payload) VALUES (?, ?, ?) RETURNING id",
        spec.fireAt,
        spec.kind,
        payloadStr,
      )
      .one().id,
  );

export const completeDueWork = (sql: SqlStorage, id: number, completedAt: number): void => {
  sql.exec(
    "UPDATE due_work SET completed_at = ? WHERE id = ? AND completed_at IS NULL",
    completedAt,
    id,
  );
};

export const completeClaimedDueWork = (
  sql: SqlStorage,
  id: number,
  completedAt: number,
  claimToken: string,
): number =>
  Number(
    sql
      .exec(
        `
          UPDATE due_work
          SET completed_at = ?
          WHERE id = ?
            AND claim_token = ?
            AND completed_at IS NULL
          RETURNING id
        `,
        completedAt,
        id,
        claimToken,
      )
      .toArray().length,
  );

export const selectDuePending = (
  sql: SqlStorage,
  now: number,
): Effect.Effect<ReadonlyArray<DueWorkRow>, SqlError> =>
  Effect.gen(function* () {
    const rows = yield* Effect.try({
      try: () =>
        sql
          .exec(
            `
          SELECT id, fire_at, kind, payload
               , claimed_at, claim_token, claim_deadline_at, redrive_count
               , cancel_requested_at, cancel_reason, cancelled_at
          FROM due_work
          WHERE completed_at IS NULL
            AND fire_at <= ?
            AND (
              claim_token IS NULL
              OR claim_deadline_at <= ?
            )
          ORDER BY fire_at, id
        `,
            now,
            now,
          )
          .toArray(),
      catch: (cause) => new SqlError({ cause }),
    });
    const out: DueWorkRow[] = [];
    for (const row of rows) {
      const parsed = dueWorkRowFromSql(row as Record<string, unknown>);
      if (!parsed.ok) return yield* Effect.fail(new SqlError({ cause: parsed.cause }));
      out.push(parsed.value);
    }
    return out;
  });

export const claimDueWork = (
  sql: SqlStorage,
  id: number,
  now: number,
  claimToken: string,
  claimDeadlineAt: number,
): Effect.Effect<ClaimedDueWorkRow | null, SqlError> =>
  Effect.gen(function* () {
    const rows = yield* Effect.try({
      try: () =>
        sql
          .exec(
            `
            UPDATE due_work
            SET claimed_at = ?,
                claim_token = ?,
                claim_deadline_at = ?,
                redrive_count = redrive_count + CASE
                  WHEN claim_token IS NULL THEN 0
                  ELSE 1
                END
            WHERE id = ?
              AND completed_at IS NULL
              AND fire_at <= ?
              AND (
                claim_token IS NULL
                OR claim_deadline_at <= ?
              )
            RETURNING id, fire_at, kind, payload,
                      claimed_at, claim_token, claim_deadline_at, redrive_count,
                      cancel_requested_at, cancel_reason, cancelled_at
          `,
            now,
            claimToken,
            claimDeadlineAt,
            id,
            now,
            now,
          )
          .toArray(),
      catch: (cause) => new SqlError({ cause }),
    });
    const row = rows[0];
    if (row === undefined) return null;
    const parsed = dueWorkRowFromSql(row as Record<string, unknown>);
    if (!parsed.ok) return yield* Effect.fail(new SqlError({ cause: parsed.cause }));
    const due = parsed.value;
    if (due.claimToken === null || due.claimDeadlineAt === null) return null;
    return {
      ...due,
      claimToken: due.claimToken,
      claimDeadlineAt: due.claimDeadlineAt,
    };
  });

export const listStuckDueWork = (
  sql: SqlStorage,
  now: number,
): Effect.Effect<ReadonlyArray<StuckDueWorkRow>, SqlError> =>
  Effect.gen(function* () {
    const rows = yield* Effect.try({
      try: () =>
        sql
          .exec(
            `
            SELECT id, kind, payload, claim_deadline_at, redrive_count
            FROM due_work
            WHERE completed_at IS NULL
              AND claim_token IS NOT NULL
              AND claim_deadline_at IS NOT NULL
              AND claim_deadline_at <= ?
            ORDER BY claim_deadline_at, id
          `,
            now,
          )
          .toArray(),
      catch: (cause) => new SqlError({ cause }),
    });
    const out: StuckDueWorkRow[] = [];
    for (const row of rows) {
      const payload = dueRowPayload(row as { readonly payload: unknown });
      if (!payload.ok) return yield* Effect.fail(new SqlError({ cause: payload.cause }));
      out.push({
        dueWorkId: Number(row.id),
        triggerKind: sqlText(row.kind, "due_work.kind"),
        intentEventId: payload.value.intentEventId,
        claimDeadlineAt: Number(row.claim_deadline_at),
        redriveCount:
          row.redrive_count === null || row.redrive_count === undefined
            ? 0
            : Number(row.redrive_count),
      });
    }
    return out;
  });

export const selectDurableProcessLifecycle = (
  sql: SqlStorage,
): Effect.Effect<ReadonlyArray<DurableProcessLifecycleState>, SqlError> =>
  Effect.gen(function* () {
    const rows = yield* Effect.try({
      try: () =>
        sql
          .exec(
            `
            SELECT id, fire_at, kind, payload, completed_at,
                   claimed_at, claim_token, claim_deadline_at, redrive_count,
                   cancel_requested_at, cancel_reason, cancelled_at
            FROM due_work
            ORDER BY id
          `,
          )
          .toArray(),
      catch: (cause) => new SqlError({ cause }),
    });
    const out: DurableProcessLifecycleState[] = [];
    for (const row of rows) {
      const payload = dueRowPayload(row as { readonly payload: unknown });
      if (!payload.ok) return yield* Effect.fail(new SqlError({ cause: payload.cause }));
      const result = durableProcessLifecycleState({
        id: Number(row.id),
        fireAt: Number(row.fire_at),
        kind: sqlText(row.kind, "due_work.kind"),
        intentEventId: payload.value.intentEventId,
        completedAt:
          row.completed_at === null || row.completed_at === undefined
            ? null
            : Number(row.completed_at),
        claimedAt:
          row.claimed_at === null || row.claimed_at === undefined ? null : Number(row.claimed_at),
        claimToken:
          row.claim_token === null || row.claim_token === undefined
            ? null
            : sqlText(row.claim_token, "due_work.claim_token"),
        claimDeadlineAt:
          row.claim_deadline_at === null || row.claim_deadline_at === undefined
            ? null
            : Number(row.claim_deadline_at),
        redriveCount:
          row.redrive_count === null || row.redrive_count === undefined
            ? 0
            : Number(row.redrive_count),
        cancelRequestedAt:
          row.cancel_requested_at === null || row.cancel_requested_at === undefined
            ? null
            : Number(row.cancel_requested_at),
        cancelReason:
          row.cancel_reason === null || row.cancel_reason === undefined
            ? null
            : sqlText(row.cancel_reason, "due_work.cancel_reason"),
        cancelledAt:
          row.cancelled_at === null || row.cancelled_at === undefined
            ? null
            : Number(row.cancelled_at),
      });
      if (!result.ok) return yield* Effect.fail(new SqlError({ cause: result.cause }));
      out.push(result.state);
    }
    return out;
  });

export const selectDueByTriggerIntent = (
  sql: SqlStorage,
  kind: string,
  intentEventId: number,
): Effect.Effect<ReadonlyArray<DueWorkRow>, SqlError> =>
  Effect.gen(function* () {
    const rows = yield* Effect.try({
      try: () =>
        sql
          .exec(
            `
            SELECT id, fire_at, kind, payload,
                   claimed_at, claim_token, claim_deadline_at, redrive_count,
                   cancel_requested_at, cancel_reason, cancelled_at
            FROM due_work
            WHERE completed_at IS NULL
              AND kind = ?
            ORDER BY fire_at, id
          `,
            kind,
          )
          .toArray(),
      catch: (cause) => new SqlError({ cause }),
    });
    const out: DueWorkRow[] = [];
    for (const row of rows) {
      const parsed = dueWorkRowFromSql(row as Record<string, unknown>);
      if (!parsed.ok) return yield* Effect.fail(new SqlError({ cause: parsed.cause }));
      if (parsed.value.payload.intentEventId === intentEventId) out.push(parsed.value);
    }
    return out;
  });

export const requestDueWorkCancellation = (
  sql: SqlStorage,
  id: number,
  now: number,
  reason: string | undefined,
): number =>
  sql
    .exec(
      `
        UPDATE due_work
        SET cancel_requested_at = COALESCE(cancel_requested_at, ?),
            cancel_reason = COALESCE(cancel_reason, ?),
            claim_deadline_at = CASE
              WHEN claim_token IS NULL THEN claim_deadline_at
              WHEN claim_deadline_at IS NULL THEN ?
              WHEN claim_deadline_at > ? THEN ?
              ELSE claim_deadline_at
            END
        WHERE id = ?
          AND completed_at IS NULL
        RETURNING id
      `,
      now,
      reason ?? null,
      now,
      now,
      now,
      id,
    )
    .toArray().length;

export const insertDurableTriggerDueWork = (
  sql: SqlStorage,
  fireAt: number,
  kind: string,
  intentEventId: number,
): number => {
  const payload = durableTriggerDuePayload(intentEventId);
  return insertDueWork(
    sql,
    {
      fireAt,
      kind,
      payload,
    },
    JSON.stringify(payload),
  );
};

export const commitDurableTriggerIntent = (
  ctx: DurableObjectState,
  sql: SqlStorage,
  bus: EventBusService,
  identity: BackendProtocolEventIdentity,
  fireAt: number,
  registry: TriggerRegistry,
  triggerKind: string,
  writeIntent: (
    tx: LedgerTransactionBuilder,
    trigger: {
      readonly kind: string;
      readonly intentEventKind: string;
    },
  ) => LedgerEventRef,
): Effect.Effect<LedgerEvent, SqlError | JsonStringifyError | UnregisteredDurableTriggerKind> =>
  Effect.gen(function* () {
    const trigger = yield* getDurableTrigger(registry, triggerKind);
    const existingNext = yield* findNextDue(sql);
    const target = existingNext === null ? fireAt : Math.min(existingNext, fireAt);
    yield* Effect.tryPromise({
      try: () => ctx.storage.setAlarm(target),
      catch: (cause) => new SqlError({ cause }),
    });
    const committed = yield* commitLedgerTransaction(
      ctx,
      bus,
      { factOwnerRef: identity.factOwnerRef },
      (tx) => {
        const intent = writeIntent(tx, trigger);
        tx.afterInsert(({ id }) => {
          insertDurableTriggerDueWork(sql, fireAt, trigger.kind, id(intent));
        });
        return intent;
      },
    );
    return committed.event(committed.value);
  });

export const enqueueScheduledEvent = (
  ctx: DurableObjectState,
  sql: SqlStorage,
  bus: EventBusService,
  scope: string,
  identity: BackendProtocolEventIdentity,
  intentTs: number,
  at: number,
  registry: TriggerRegistry,
  triggerKind: string,
  eventKind: string,
  data: unknown,
): Effect.Effect<LedgerEvent, SqlError | JsonStringifyError | UnregisteredDurableTriggerKind> =>
  Effect.gen(function* () {
    const payload = scheduledEventIntentPayload(eventKind, data);
    return yield* commitDurableTriggerIntent(
      ctx,
      sql,
      bus,
      identity,
      at,
      registry,
      triggerKind,
      (tx, trigger) =>
        tx.append({
          ts: intentTs,
          kind: trigger.intentEventKind,
          scopeRef: identity.scopeRef,
          effectAuthorityRef: identity.effectAuthorityRef,
          payload,
        }),
    );
  });
