import { Effect } from "effect";
import { JsonStringifyError, SqlError, safeStringify } from "@agent-os/kernel/errors";
import type { LedgerEvent } from "@agent-os/kernel/types";
import {
  DUE_WORK_SCHEDULED_EVENT,
  DURABLE_TRIGGER_SCHEDULED_REQUESTED,
  durableTriggerDuePayload,
  isDueWorkKind,
  parseDueWorkPayload,
  scheduledEventIntentPayload,
  type DueWorkKind,
  type DueWorkPayload,
} from "@agent-os/backend-protocol";
import { insertLedgerEvent } from "./ledger/inserted-events";
import { sqlText } from "./storage/sql-row";

export interface DueWorkRow<K extends DueWorkKind = DueWorkKind> {
  readonly id: number;
  readonly fireAt: number;
  readonly kind: K;
  readonly payload: DueWorkPayload<K>;
}

export interface DueWorkInsertSpec<K extends DueWorkKind = DueWorkKind> {
  readonly fireAt: number;
  readonly kind: K;
  readonly payload: DueWorkPayload<K>;
}

export const ensureDueWorkSchema = (sql: SqlStorage): Effect.Effect<void, SqlError> =>
  Effect.try({
    try: () => {
      sql.exec(`
        CREATE TABLE IF NOT EXISTS due_work (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          fire_at INTEGER NOT NULL,
          kind TEXT NOT NULL,
          payload TEXT NOT NULL,
          completed_at INTEGER
        )
      `);
      sql.exec(`
        CREATE INDEX IF NOT EXISTS idx_due_work_pending
          ON due_work (fire_at)
          WHERE completed_at IS NULL
      `);
    },
    catch: (cause) => new SqlError({ cause }),
  }).pipe(Effect.asVoid);

export const findNextDue = (sql: SqlStorage): Effect.Effect<number | null, SqlError> =>
  Effect.try({
    try: () => {
      const row = sql
        .exec("SELECT MIN(fire_at) AS m FROM due_work WHERE completed_at IS NULL")
        .toArray()[0];
      const m = row?.m;
      return m === null || m === undefined ? null : Number(m);
    },
    catch: (cause) => new SqlError({ cause }),
  });

export const armBeforeDueCommit = <T>(
  ctx: DurableObjectState,
  sql: SqlStorage,
  fireAt: number,
  write: () => T,
): Effect.Effect<T, SqlError> =>
  Effect.gen(function* () {
    const existingNext = yield* findNextDue(sql);
    const target = existingNext === null ? fireAt : Math.min(existingNext, fireAt);
    yield* Effect.tryPromise({
      try: () => ctx.storage.setAlarm(target),
      catch: (cause) => new SqlError({ cause }),
    });
    return yield* Effect.try({
      try: () => ctx.storage.transactionSync(write),
      catch: (cause) => new SqlError({ cause }),
    });
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

export const insertDueWork = <K extends DueWorkKind>(
  sql: SqlStorage,
  spec: DueWorkInsertSpec<K>,
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

const ensureNoUnknownDueKind = (sql: SqlStorage, now: number): Effect.Effect<void, SqlError> =>
  Effect.gen(function* () {
    const kinds = yield* Effect.try({
      try: () =>
        sql
          .exec(
            `
          SELECT kind
          FROM due_work
          WHERE completed_at IS NULL
            AND fire_at <= ?
          ORDER BY fire_at, id
          `,
            now,
          )
          .toArray()
          .map((row) => sqlText(row.kind, "due_work.kind")),
      catch: (cause) => new SqlError({ cause }),
    });
    for (const kind of kinds) {
      if (!isDueWorkKind(kind)) {
        return yield* Effect.fail(
          new SqlError({ cause: new TypeError(`unknown due-work kind: ${kind}`) }),
        );
      }
    }
  });

export const selectDueWork = <K extends DueWorkKind>(
  sql: SqlStorage,
  kind: K,
  now: number,
): Effect.Effect<ReadonlyArray<DueWorkRow<K>>, SqlError> =>
  Effect.gen(function* () {
    yield* ensureNoUnknownDueKind(sql, now);
    const rows = yield* Effect.try({
      try: () =>
        sql
          .exec(
            `
          SELECT id, fire_at, kind, payload
          FROM due_work
          WHERE completed_at IS NULL
            AND kind = ?
            AND fire_at <= ?
          ORDER BY fire_at, id
        `,
            kind,
            now,
          )
          .toArray(),
      catch: (cause) => new SqlError({ cause }),
    });
    const out: DueWorkRow<K>[] = [];
    for (const row of rows) {
      const rowKindRaw = sqlText(row.kind, "due_work.kind");
      if (!isDueWorkKind(rowKindRaw)) {
        return yield* Effect.fail(
          new SqlError({ cause: new TypeError(`unknown due-work kind: ${rowKindRaw}`) }),
        );
      }
      const rowKind = rowKindRaw as K;
      const payloadStr = sqlText(row.payload, "due_work.payload");
      const parsed = yield* Effect.try({
        try: () => JSON.parse(payloadStr) as unknown,
        catch: (cause) => new SqlError({ cause }),
      });
      const payload = parseDueWorkPayload(rowKind, parsed);
      if (!payload.ok) {
        return yield* Effect.fail(new SqlError({ cause: payload.cause }));
      }
      out.push({
        id: Number(row.id),
        fireAt: Number(row.fire_at),
        kind: rowKind,
        payload: payload.payload,
      });
    }
    return out;
  });

export const insertDurableTriggerDueWork = <K extends DueWorkKind>(
  sql: SqlStorage,
  fireAt: number,
  kind: K,
  intentEventId: number,
): number => {
  const payload = durableTriggerDuePayload(intentEventId) as DueWorkPayload<K>;
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

export const commitDurableTriggerIntent = <K extends DueWorkKind>(
  ctx: DurableObjectState,
  sql: SqlStorage,
  fireAt: number,
  kind: K,
  writeIntent: () => LedgerEvent,
): Effect.Effect<LedgerEvent, SqlError> =>
  armBeforeDueCommit(ctx, sql, fireAt, () => {
    const intent = writeIntent();
    insertDurableTriggerDueWork(sql, fireAt, kind, intent.id);
    return intent;
  });

export const enqueueScheduledEvent = (
  ctx: DurableObjectState,
  sql: SqlStorage,
  scope: string,
  intentTs: number,
  at: number,
  eventKind: string,
  data: unknown,
): Effect.Effect<LedgerEvent, SqlError | JsonStringifyError> =>
  Effect.gen(function* () {
    const payload = scheduledEventIntentPayload(eventKind, data);
    const payloadStr = yield* safeStringify(payload);
    return yield* commitDurableTriggerIntent(ctx, sql, at, DUE_WORK_SCHEDULED_EVENT, () =>
      insertLedgerEvent(sql, {
        ts: intentTs,
        kind: DURABLE_TRIGGER_SCHEDULED_REQUESTED,
        scope,
        payloadStr,
        payload,
      }),
    );
  });
