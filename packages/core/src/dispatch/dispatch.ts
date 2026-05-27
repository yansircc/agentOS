/**
 * Dispatch service algebra — sender + receiver orchestration.
 *
 * SSoT split:
 *   - sender intent truth   : `events.kind = dispatch.outbound.requested`
 *   - receiver acceptance   : `events.kind = dispatch.inbound.accepted`
 *   - `dispatch_outbox`     : pending-delivery buffer (derived; not truth)
 *
 * Spec: docs/specs/spec-24-invariants-and-surface.md
 */

import { Clock, Context, Effect, Layer } from "effect";
import {
  CapabilityRejected,
  DispatchScopeMismatch,
  DispatchTargetNotFound,
  JsonStringifyError,
  ScopeMissingError,
  SqlError,
  UnsupportedScopeRef,
  isCoreClaimedEventKind,
  safeStringify,
} from "../errors";
import { EventBus } from "../ledger";
import { materialRefKey } from "../material-ref";
import type { LedgerEvent } from "../types";
import type { DispatchToScopeResult, DispatchToScopeSpec } from "../types";
import {
  makeOperationRef,
  makePreClaim,
  isScopeRef,
  settleLivedClaim,
  type PreClaim,
} from "../effect-claim";

import {
  copyTraceContext,
  describeCause,
  parseRequestedPayload,
  type DispatchRequestedPayload,
} from "./payload";
import {
  ensureDispatchSchema,
  findNextPending,
  retryDelayMs,
  selectDue,
  type DispatchOutboxRow,
} from "./outbox";
import { DISPATCH_INBOUND_ACCEPTED, findAccepted, type InboundAcceptedPayload } from "./receiver";

import type { TraceContext } from "../types";

// Re-export the receiver constant so callers that historically reached
// for it from "./dispatch" keep working.
export { DISPATCH_INBOUND_ACCEPTED } from "./receiver";

export interface DispatchEnvelope {
  readonly sourceScope: string;
  readonly outboundEventId: number;
  readonly targetScope: string;
  readonly event: string;
  readonly data: unknown;
  readonly idempotencyKey: string;
  readonly claim: PreClaim;
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

export type DispatchTargetRegistry = Readonly<Record<string, DispatchTargetNamespace>>;

const DISPATCH_OUTBOUND_REQUESTED = "dispatch.outbound.requested";
const DISPATCH_OUTBOUND_DELIVERED = "dispatch.outbound.delivered";
const DISPATCH_OUTBOUND_FAILED = "dispatch.outbound.failed";

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
      | CapabilityRejected
      | UnsupportedScopeRef
    >;
    readonly receive: (
      envelope: DispatchEnvelope,
    ) => Effect.Effect<
      { deliveredEventId: number },
      SqlError | JsonStringifyError | CapabilityRejected | ScopeMissingError | DispatchScopeMismatch
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

export const DispatchLive = (
  ctx: DurableObjectState,
  scope: string,
  targets: DispatchTargetRegistry,
): Layer.Layer<Dispatch, SqlError, EventBus> => {
  const sql = ctx.storage.sql;

  return Layer.scoped(
    Dispatch,
    Effect.gen(function* () {
      yield* ensureDispatchSchema(sql);
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
            ...(requested.claim === undefined
              ? {}
              : {
                  claim: settleLivedClaim(requested.claim, {
                    anchorId: `${requested.target.scope}:${deliveredEventId}`,
                    anchorKind: "ledger_event",
                    carrierRef: `dispatch:${materialRefKey(requested.target.bindingRef)}`,
                  }),
                }),
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
                const deliveredCursor = sql.exec(
                  "INSERT INTO events (ts, kind, scope, payload) VALUES (?, ?, ?, ?) RETURNING id",
                  now,
                  DISPATCH_OUTBOUND_DELIVERED,
                  scope,
                  payloadStr,
                );
                const localDeliveredEventId = Number(deliveredCursor.one().id);
                sql.exec(
                  "UPDATE dispatch_outbox SET delivered_event_id = ?, attempts = ?, last_error = NULL WHERE outbound_event_id = ?",
                  localDeliveredEventId,
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
          const requestedResult = yield* Effect.try({
            try: () => parseRequestedPayload(row.requestedPayload),
            catch: (cause) => new SqlError({ cause }),
          });
          if (!requestedResult.ok) {
            return yield* Effect.fail(new SqlError({ cause: requestedResult.failure }));
          }
          const requested = requestedResult.value;
          const attempt = row.attempts + 1;
          const bindingKey = materialRefKey(requested.target.bindingRef);
          const targetNs = targets[bindingKey];
          if (targetNs === undefined) {
            yield* markFailed(
              row.outboundEventId,
              requested,
              attempt,
              now,
              new DispatchTargetNotFound({
                bindingRef: bindingKey,
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
            claim: requested.claim,
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

          yield* markFailed(row.outboundEventId, requested, attempt, now, delivered.left);
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
            if (isCoreClaimedEventKind(spec.event)) {
              return yield* Effect.fail(
                new CapabilityRejected({
                  event: spec.event,
                  capability: "cap_app",
                }),
              );
            }
            const bindingKey = materialRefKey(spec.target.bindingRef);
            const targetNs = targets[bindingKey];
            if (targetNs === undefined) {
              return yield* Effect.fail(
                new DispatchTargetNotFound({
                  bindingRef: bindingKey,
                }),
              );
            }

            const now = yield* Clock.currentTimeMillis;
            const traceContext = copyTraceContext(spec.traceContext);
            if (!isScopeRef(spec.target.scopeRef)) {
              return yield* Effect.fail(
                new UnsupportedScopeRef({
                  scopeId: spec.target.scope,
                  position: "target",
                }),
              );
            }
            const claim = makePreClaim({
              operationRef: makeOperationRef("dispatch", [
                scope,
                bindingKey,
                spec.target.scope,
                spec.idempotencyKey,
              ]),
              scopeRef: spec.target.scopeRef,
              authorityRef: {
                authorityId: "cap_dispatch",
                authorityClass: "effect",
              },
              originRef: {
                originId: scope,
                originKind: "agent_do",
              },
            });
            const requestedPayload: DispatchRequestedPayload = {
              target: spec.target,
              event: spec.event,
              data: spec.data,
              idempotencyKey: spec.idempotencyKey,
              claim,
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
            if (isCoreClaimedEventKind(envelope.event)) {
              return yield* Effect.fail(
                new CapabilityRejected({
                  event: envelope.event,
                  capability: "cap_app",
                }),
              );
            }

            const now = yield* Clock.currentTimeMillis;
            const appPayloadStr = yield* safeStringify(envelope.data);

            const result = yield* Effect.try({
              try: () =>
                ctx.storage.transactionSync(() => {
                  const acceptedResult = findAccepted(
                    sql,
                    scope,
                    envelope.sourceScope,
                    envelope.idempotencyKey,
                  );
                  if (!acceptedResult.ok) {
                    return {
                      duplicate: false,
                      deliveredEventId: 0,
                      event: null,
                      failure: acceptedResult.failure,
                    };
                  }
                  const accepted = acceptedResult.value;
                  if (accepted !== null) {
                    return {
                      duplicate: true,
                      deliveredEventId: accepted.deliveredEventId,
                      event: null,
                      failure: null,
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
                  const claim = settleLivedClaim(envelope.claim, {
                    anchorId: `${scope}:${deliveredEventId}`,
                    anchorKind: "ledger_event",
                    carrierRef: `dispatch:${envelope.sourceScope}`,
                  });
                  const inboundPayload = JSON.stringify({
                    sourceScope: envelope.sourceScope,
                    outboundEventId: envelope.outboundEventId,
                    idempotencyKey: envelope.idempotencyKey,
                    deliveredEventId,
                    claim,
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
                  return { duplicate: false, deliveredEventId, event, failure: null };
                }),
              catch: (cause) => new SqlError({ cause }),
            });

            if (result.failure !== null) {
              return yield* Effect.fail(new SqlError({ cause: result.failure }));
            }
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
