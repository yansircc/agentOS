/**
 * Dispatch — cross-scope durable delivery between AgentDOBase ledgers.
 *
 * SSoT:
 *   - sender intent truth is `events.kind = dispatch.outbound.requested`.
 *   - receiver acceptance truth is `events.kind = dispatch.inbound.accepted`.
 *   - `dispatch_outbox` is only a pending delivery buffer derived from the
 *     outbound event id, same class as `scheduled_events`.
 *
 * Receiver idempotency is `(sourceScope, idempotencyKey)`. The sender's
 * `outboundEventId` is trace metadata only and must not decide duplicates.
 */

import { Clock, Context, Effect, Layer } from "effect";
import {
  DispatchScopeMismatch,
  DispatchTargetNotFound,
  JsonStringifyError,
  ReservedEventKindError,
  ScopeMissingError,
  SqlError,
  isReservedEventKind,
  safeStringify,
} from "./errors";
import { EventBus } from "./event-bus";
import type {
  DispatchTargetSpec,
  DispatchToScopeResult,
  DispatchToScopeSpec,
  LedgerEvent,
  TraceContext,
} from "./types";

export interface DispatchEnvelope {
  readonly sourceScope: string;
  readonly outboundEventId: number;
  readonly targetScope: string;
  readonly event: string;
  readonly data: unknown;
  readonly idempotencyKey: string;
  readonly traceContext?: TraceContext;
}

export interface DispatchReceiver {
  readonly __agentosReceiveDispatch: (
    envelope: DispatchEnvelope,
  ) => Promise<{ deliveredEventId: number }>;
}

export interface DispatchTargetNamespace {
  readonly idFromName: (name: string) => DurableObjectId;
  readonly get: (id: DurableObjectId) => unknown;
}

export type DispatchTargetRegistry = Readonly<
  Record<string, DispatchTargetNamespace>
>;

interface DispatchRequestedPayload {
  readonly target: DispatchTargetSpec;
  readonly event: string;
  readonly data: unknown;
  readonly idempotencyKey: string;
  readonly traceContext?: TraceContext;
}

interface DispatchOutboxRow {
  readonly outboundEventId: number;
  readonly attempts: number;
  readonly requestedPayload: string;
  readonly sourceScope: string;
}

interface InboundAcceptedPayload {
  readonly sourceScope: string;
  readonly outboundEventId: number;
  readonly idempotencyKey: string;
  readonly deliveredEventId: number;
  readonly traceContext?: TraceContext;
}

const DISPATCH_OUTBOUND_REQUESTED = "dispatch.outbound.requested";
const DISPATCH_OUTBOUND_DELIVERED = "dispatch.outbound.delivered";
const DISPATCH_OUTBOUND_FAILED = "dispatch.outbound.failed";
const DISPATCH_INBOUND_ACCEPTED = "dispatch.inbound.accepted";

export class Dispatch extends Context.Tag("@agent-os/Dispatch")<
  Dispatch,
  {
    readonly dispatchToScope: (
      spec: DispatchToScopeSpec,
    ) => Effect.Effect<
      DispatchToScopeResult,
      | SqlError
      | JsonStringifyError
      | DispatchTargetNotFound
      | ReservedEventKindError
    >;
    readonly receive: (
      envelope: DispatchEnvelope,
    ) => Effect.Effect<
      { deliveredEventId: number },
      | SqlError
      | JsonStringifyError
      | ReservedEventKindError
      | ScopeMissingError
      | DispatchScopeMismatch
    >;
    readonly drainDue: (
      now: number,
    ) => Effect.Effect<
      { delivered: number; failed: number; next: number | null },
      SqlError | JsonStringifyError
    >;
    readonly findNextPending: () => Effect.Effect<number | null, SqlError>;
  }
>() {}

const ensureSchema = (sql: SqlStorage): Effect.Effect<void, SqlError> =>
  Effect.try({
    try: () => {
      sql.exec(`
        CREATE TABLE IF NOT EXISTS events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ts INTEGER NOT NULL,
          kind TEXT NOT NULL,
          scope TEXT NOT NULL,
          payload TEXT NOT NULL
        )
      `);
      sql.exec(`
        CREATE TABLE IF NOT EXISTS dispatch_outbox (
          outbound_event_id INTEGER PRIMARY KEY REFERENCES events(id),
          delivered_event_id INTEGER REFERENCES events(id),
          attempts INTEGER NOT NULL DEFAULT 0,
          next_attempt_at INTEGER NOT NULL,
          last_error TEXT
        )
      `);
      sql.exec(`
        CREATE INDEX IF NOT EXISTS idx_dispatch_outbox_pending
          ON dispatch_outbox (next_attempt_at)
          WHERE delivered_event_id IS NULL
      `);
    },
    catch: (cause) => new SqlError({ cause }),
  }).pipe(Effect.asVoid);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const copyTraceContext = (
  traceContext: TraceContext | undefined,
): TraceContext | undefined => {
  if (traceContext === undefined) return undefined;
  return {
    ...(traceContext.traceparent === undefined
      ? {}
      : { traceparent: traceContext.traceparent }),
    ...(traceContext.tracestate === undefined
      ? {}
      : { tracestate: traceContext.tracestate }),
  };
};

const parseTraceContext = (value: unknown): TraceContext | undefined => {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new TypeError("traceContext must be object");
  }
  const traceparent = value.traceparent;
  const tracestate = value.tracestate;
  if (
    (traceparent !== undefined && typeof traceparent !== "string") ||
    (tracestate !== undefined && typeof tracestate !== "string")
  ) {
    throw new TypeError("traceContext fields must be strings");
  }
  return copyTraceContext({
    ...(traceparent === undefined ? {} : { traceparent }),
    ...(tracestate === undefined ? {} : { tracestate }),
  });
};

const parseRequestedPayload = (raw: string): DispatchRequestedPayload => {
  const value = JSON.parse(raw) as unknown;
  if (!isRecord(value)) {
    throw new TypeError("dispatch.outbound.requested payload must be object");
  }
  const target = value.target;
  if (!isRecord(target)) {
    throw new TypeError("dispatch target must be object");
  }
  if (
    typeof target.bindingRef !== "string" ||
    typeof target.scope !== "string" ||
    typeof value.event !== "string" ||
    typeof value.idempotencyKey !== "string"
  ) {
    throw new TypeError("dispatch.outbound.requested payload malformed");
  }
  const traceContext = parseTraceContext(value.traceContext);
  return {
    target: { bindingRef: target.bindingRef, scope: target.scope },
    event: value.event,
    data: value.data,
    idempotencyKey: value.idempotencyKey,
    ...(traceContext === undefined ? {} : { traceContext }),
  };
};

const parseInboundAcceptedPayload = (
  raw: string,
): InboundAcceptedPayload => {
  const value = JSON.parse(raw) as unknown;
  if (!isRecord(value)) {
    throw new TypeError("dispatch.inbound.accepted payload must be object");
  }
  if (
    typeof value.sourceScope !== "string" ||
    typeof value.outboundEventId !== "number" ||
    typeof value.idempotencyKey !== "string" ||
    typeof value.deliveredEventId !== "number"
  ) {
    throw new TypeError("dispatch.inbound.accepted payload malformed");
  }
  const traceContext = parseTraceContext(value.traceContext);
  return {
    sourceScope: value.sourceScope,
    outboundEventId: value.outboundEventId,
    idempotencyKey: value.idempotencyKey,
    deliveredEventId: value.deliveredEventId,
    ...(traceContext === undefined ? {} : { traceContext }),
  };
};

const describeCause = (cause: unknown): string => {
  if (cause instanceof Error) {
    return `${cause.name}: ${cause.message}`;
  }
  if (isRecord(cause) && typeof cause._tag === "string") {
    return cause._tag;
  }
  try {
    return JSON.stringify(cause);
  } catch {
    return String(cause);
  }
};

const retryDelayMs = (attempt: number): number =>
  Math.min(60_000, 1_000 * 2 ** Math.min(Math.max(attempt - 1, 0), 6));

const findNextPending = (
  sql: SqlStorage,
): Effect.Effect<number | null, SqlError> =>
  Effect.try({
    try: () => {
      const rows = sql
        .exec(
          "SELECT MIN(next_attempt_at) AS m FROM dispatch_outbox WHERE delivered_event_id IS NULL",
        )
        .toArray();
      const row = rows[0];
      if (row === undefined) return null;
      const m = row.m;
      return m === null || m === undefined ? null : Number(m);
    },
    catch: (cause) => new SqlError({ cause }),
  });

const selectDue = (
  sql: SqlStorage,
  now: number,
): Effect.Effect<ReadonlyArray<DispatchOutboxRow>, SqlError> =>
  Effect.try({
    try: () =>
      sql
        .exec(
          `
          SELECT
            o.outbound_event_id,
            o.attempts,
            e.payload AS requested_payload,
            e.scope AS source_scope
          FROM dispatch_outbox o
          JOIN events e ON e.id = o.outbound_event_id
          WHERE o.delivered_event_id IS NULL
            AND o.next_attempt_at <= ?
          ORDER BY o.next_attempt_at, o.outbound_event_id
        `,
          now,
        )
        .toArray()
        .map(
          (row): DispatchOutboxRow => ({
            outboundEventId: Number(row.outbound_event_id),
            attempts: Number(row.attempts),
            requestedPayload: String(row.requested_payload),
            sourceScope: String(row.source_scope),
          }),
        ),
    catch: (cause) => new SqlError({ cause }),
  });

const findAccepted = (
  sql: SqlStorage,
  scope: string,
  sourceScope: string,
  idempotencyKey: string,
): InboundAcceptedPayload | null => {
  const rows = sql
    .exec(
      "SELECT payload FROM events WHERE scope = ? AND kind = ? ORDER BY id",
      scope,
      DISPATCH_INBOUND_ACCEPTED,
    )
    .toArray();
  for (const row of rows) {
    const payload = parseInboundAcceptedPayload(String(row.payload));
    if (
      payload.sourceScope === sourceScope &&
      payload.idempotencyKey === idempotencyKey
    ) {
      return payload;
    }
  }
  return null;
};

export const DispatchLive = (
  ctx: DurableObjectState,
  scope: string,
  targets: DispatchTargetRegistry,
): Layer.Layer<Dispatch, SqlError, EventBus> => {
  const sql = ctx.storage.sql;

  return Layer.scoped(
    Dispatch,
    Effect.gen(function* () {
      yield* ensureSchema(sql);
      const bus = yield* EventBus;

      const markDelivered = (
        outboundEventId: number,
        requested: DispatchRequestedPayload,
        deliveredEventId: number,
        attempt: number,
        now: number,
      ): Effect.Effect<void, SqlError | JsonStringifyError> =>
        Effect.gen(function* () {
          const payloadStr = yield* safeStringify({
            outboundEventId,
            target: requested.target,
            event: requested.event,
            idempotencyKey: requested.idempotencyKey,
            deliveredEventId,
            attempt,
            ...(requested.traceContext === undefined
              ? {}
              : { traceContext: requested.traceContext }),
          });
          yield* Effect.try({
            try: () =>
              ctx.storage.transactionSync(() => {
                const pending = sql
                  .exec(
                    "SELECT outbound_event_id FROM dispatch_outbox WHERE outbound_event_id = ? AND delivered_event_id IS NULL",
                    outboundEventId,
                  )
                  .toArray();
                if (pending.length === 0) return;
                sql.exec(
                  "INSERT INTO events (ts, kind, scope, payload) VALUES (?, ?, ?, ?)",
                  now,
                  DISPATCH_OUTBOUND_DELIVERED,
                  scope,
                  payloadStr,
                );
                sql.exec(
                  "UPDATE dispatch_outbox SET delivered_event_id = ?, attempts = ?, last_error = NULL WHERE outbound_event_id = ?",
                  deliveredEventId,
                  attempt,
                  outboundEventId,
                );
              }),
            catch: (cause) => new SqlError({ cause }),
          });
        });

      const markFailed = (
        outboundEventId: number,
        requested: DispatchRequestedPayload,
        attempt: number,
        now: number,
        cause: unknown,
      ): Effect.Effect<void, SqlError | JsonStringifyError> =>
        Effect.gen(function* () {
          const error = describeCause(cause);
          const nextAttemptAt = now + retryDelayMs(attempt);
          const payloadStr = yield* safeStringify({
            outboundEventId,
            target: requested.target,
            event: requested.event,
            idempotencyKey: requested.idempotencyKey,
            attempt,
            nextAttemptAt,
            error,
            ...(requested.traceContext === undefined
              ? {}
              : { traceContext: requested.traceContext }),
          });
          yield* Effect.try({
            try: () =>
              ctx.storage.transactionSync(() => {
                const pending = sql
                  .exec(
                    "SELECT outbound_event_id FROM dispatch_outbox WHERE outbound_event_id = ? AND delivered_event_id IS NULL",
                    outboundEventId,
                  )
                  .toArray();
                if (pending.length === 0) return;
                sql.exec(
                  "INSERT INTO events (ts, kind, scope, payload) VALUES (?, ?, ?, ?)",
                  now,
                  DISPATCH_OUTBOUND_FAILED,
                  scope,
                  payloadStr,
                );
                sql.exec(
                  "UPDATE dispatch_outbox SET attempts = ?, next_attempt_at = ?, last_error = ? WHERE outbound_event_id = ?",
                  attempt,
                  nextAttemptAt,
                  error,
                  outboundEventId,
                );
              }),
            catch: (sqlCause) => new SqlError({ cause: sqlCause }),
          });
        });

      const deliverOne = (
        row: DispatchOutboxRow,
        now: number,
      ): Effect.Effect<"delivered" | "failed", SqlError | JsonStringifyError> =>
        Effect.gen(function* () {
          const requested = yield* Effect.try({
            try: () => parseRequestedPayload(row.requestedPayload),
            catch: (cause) => new SqlError({ cause }),
          });
          const attempt = row.attempts + 1;
          const targetNs = targets[requested.target.bindingRef];
          if (targetNs === undefined) {
            yield* markFailed(
              row.outboundEventId,
              requested,
              attempt,
              now,
              new DispatchTargetNotFound({
                bindingRef: requested.target.bindingRef,
              }),
            );
            return "failed";
          }

          const targetId = targetNs.idFromName(requested.target.scope);
          const receiver = targetNs.get(targetId) as DispatchReceiver;
          const envelope: DispatchEnvelope = {
            sourceScope: row.sourceScope,
            outboundEventId: row.outboundEventId,
            targetScope: requested.target.scope,
            event: requested.event,
            data: requested.data,
            idempotencyKey: requested.idempotencyKey,
            ...(requested.traceContext === undefined
              ? {}
              : { traceContext: requested.traceContext }),
          };

          const delivered = yield* Effect.tryPromise({
            try: () => receiver.__agentosReceiveDispatch(envelope),
            catch: (cause) => cause,
          }).pipe(Effect.either);

          if (delivered._tag === "Right") {
            yield* markDelivered(
              row.outboundEventId,
              requested,
              delivered.right.deliveredEventId,
              attempt,
              now,
            );
            return "delivered";
          }

          yield* markFailed(
            row.outboundEventId,
            requested,
            attempt,
            now,
            delivered.left,
          );
          return "failed";
        });

      const drainDue = (
        now: number,
      ): Effect.Effect<
        { delivered: number; failed: number; next: number | null },
        SqlError | JsonStringifyError
      > =>
        Effect.gen(function* () {
          const rows = yield* selectDue(sql, now);
          let delivered = 0;
          let failed = 0;
          for (const row of rows) {
            const outcome = yield* deliverOne(row, now);
            if (outcome === "delivered") delivered += 1;
            else failed += 1;
          }
          const next = yield* findNextPending(sql);
          return { delivered, failed, next };
        });

      return {
        dispatchToScope: (spec) =>
          Effect.gen(function* () {
            if (isReservedEventKind(spec.event)) {
              return yield* Effect.fail(
                new ReservedEventKindError({ event: spec.event }),
              );
            }
            const targetNs = targets[spec.target.bindingRef];
            if (targetNs === undefined) {
              return yield* Effect.fail(
                new DispatchTargetNotFound({
                  bindingRef: spec.target.bindingRef,
                }),
              );
            }

            const now = yield* Clock.currentTimeMillis;
            const traceContext = copyTraceContext(spec.traceContext);
            const requestedPayload: DispatchRequestedPayload = {
              target: spec.target,
              event: spec.event,
              data: spec.data,
              idempotencyKey: spec.idempotencyKey,
              ...(traceContext === undefined ? {} : { traceContext }),
            };
            const requestedPayloadStr = yield* safeStringify(requestedPayload);

            const outboundEventId = yield* Effect.try({
              try: () =>
                ctx.storage.transactionSync(() => {
                  const cursor = sql.exec(
                    "INSERT INTO events (ts, kind, scope, payload) VALUES (?, ?, ?, ?) RETURNING id",
                    now,
                    DISPATCH_OUTBOUND_REQUESTED,
                    scope,
                    requestedPayloadStr,
                  );
                  const id = Number(cursor.one().id);
                  sql.exec(
                    "INSERT INTO dispatch_outbox (outbound_event_id, next_attempt_at) VALUES (?, ?)",
                    id,
                    now,
                  );
                  return id;
                }),
              catch: (cause) => new SqlError({ cause }),
            });

            const { next } = yield* drainDue(now);
            if (next !== null) {
              yield* Effect.tryPromise({
                try: () => ctx.storage.setAlarm(next),
                catch: (cause) => new SqlError({ cause }),
              });
            }
            return { outboundEventId };
          }),

        receive: (envelope) =>
          Effect.gen(function* () {
            if (envelope.targetScope !== scope) {
              return yield* Effect.fail(
                new DispatchScopeMismatch({
                  expected: scope,
                  actual: envelope.targetScope,
                }),
              );
            }
            if (isReservedEventKind(envelope.event)) {
              return yield* Effect.fail(
                new ReservedEventKindError({ event: envelope.event }),
              );
            }

            const now = yield* Clock.currentTimeMillis;
            const appPayloadStr = yield* safeStringify(envelope.data);

            const result = yield* Effect.try({
              try: () =>
                ctx.storage.transactionSync(() => {
                  const accepted = findAccepted(
                    sql,
                    scope,
                    envelope.sourceScope,
                    envelope.idempotencyKey,
                  );
                  if (accepted !== null) {
                    return {
                      duplicate: true,
                      deliveredEventId: accepted.deliveredEventId,
                      event: null,
                    };
                  }

                  const inboundCursor = sql.exec(
                    "INSERT INTO events (ts, kind, scope, payload) VALUES (?, ?, ?, ?) RETURNING id",
                    now,
                    DISPATCH_INBOUND_ACCEPTED,
                    scope,
                    "{}",
                  );
                  const inboundEventId = Number(inboundCursor.one().id);

                  const appCursor = sql.exec(
                    "INSERT INTO events (ts, kind, scope, payload) VALUES (?, ?, ?, ?) RETURNING id",
                    now,
                    envelope.event,
                    scope,
                    appPayloadStr,
                  );
                  const deliveredEventId = Number(appCursor.one().id);
                  const traceContext = copyTraceContext(envelope.traceContext);
                  const inboundPayload = JSON.stringify({
                    sourceScope: envelope.sourceScope,
                    outboundEventId: envelope.outboundEventId,
                    idempotencyKey: envelope.idempotencyKey,
                    deliveredEventId,
                    ...(traceContext === undefined ? {} : { traceContext }),
                  } satisfies InboundAcceptedPayload);
                  sql.exec(
                    "UPDATE events SET payload = ? WHERE id = ?",
                    inboundPayload,
                    inboundEventId,
                  );

                  const event: LedgerEvent = {
                    id: deliveredEventId,
                    ts: now,
                    kind: envelope.event,
                    scope,
                    payload: envelope.data,
                  };
                  return { duplicate: false, deliveredEventId, event };
                }),
              catch: (cause) => new SqlError({ cause }),
            });

            if (!result.duplicate && result.event !== null) {
              yield* bus.fire(result.event);
            }
            return { deliveredEventId: result.deliveredEventId };
          }),

        drainDue,
        findNextPending: () => findNextPending(sql),
      };
    }),
  );
};
