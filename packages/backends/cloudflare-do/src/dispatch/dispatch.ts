/**
 * Dispatch service algebra — sender + receiver orchestration.
 *
 * SSoT split:
 *   - sender intent truth   : `events.kind = dispatch.outbound.requested`
 *   - receiver acceptance   : `events.kind = dispatch.inbound.accepted`
 *   - `dispatch_outbox`     : mechanical pending-delivery buffer; caches
 *                              attempts / last_error / delivered_event_id
 *
 */

import { Clock, Effect, Layer } from "effect";
import {
  CapabilityRejected,
  DispatchScopeMismatch,
  DispatchTargetNotFound,
  SqlError,
  UnsupportedScopeRef,
  isCoreClaimedEventKind,
} from "@agent-os/kernel/errors";
import { InvalidTraceContext, validateOptionalTraceContext } from "@agent-os/telemetry-protocol";
import { EventBus } from "../ledger";
import { materialRefKey } from "@agent-os/kernel/material-ref";
import {
  Dispatch,
  DurableTriggerRegistry,
  TriggerPump,
  triggerParseFail,
  triggerParseOk,
} from "@agent-os/runtime";
import type {
  DurableTrigger,
  DispatchDeliveryReceipt,
  DispatchDeliveryResult,
  DispatchEnvelope,
  DispatchReceiver,
  DispatchTargetAdapter,
} from "@agent-os/runtime";
import {
  makeOperationRef,
  makePreClaim,
  isAuthorityRef,
  isScopeRef,
} from "@agent-os/kernel/effect-claim";
import {
  DELIVERY_RETRY_TRIGGER_KIND,
  DISPATCH_EVENT_KINDS,
  DISPATCH_INBOUND_ACCEPTED,
  DISPATCH_RETRY_POLICY,
  copyTraceContext,
  describeDispatchCause,
  dispatchExternalDeliveryReceipt,
  dispatchLedgerDeliveryReceipt,
  durableTriggerBackoffMs,
  parseRequestedPayloadValue,
  settleDispatchInboundAccepted,
  settleDispatchOutboundDelivered,
  type DispatchRequestedPayload,
} from "@agent-os/backend-protocol";
import { ensureDispatchSchema, selectPendingOutboxByIntent } from "./outbox";
import { findAccepted, type InboundAcceptedPayload } from "./receiver";
import { commitDurableTriggerIntent, ensureDueWorkSchema } from "../due-work";
import { commitLedgerTransaction, type LedgerPayloadContext } from "../ledger/commit";
import { cloudflareRouteKeyFromScopeRef } from "../ledger/identity";
import type { BackendProtocolEventIdentity } from "@agent-os/backend-protocol";

// Re-export the receiver constant so callers that historically reached
// for it from "./dispatch" keep working.
export { DISPATCH_INBOUND_ACCEPTED } from "@agent-os/backend-protocol";

export interface DispatchTargetNamespace {
  readonly idFromName: (name: string) => DurableObjectId;
  readonly get: (id: DurableObjectId) => unknown;
}

export type DispatchTargetRegistry = Readonly<Record<string, DispatchTargetAdapter>>;

export interface QueueDispatchTargetBinding {
  readonly send: (message: unknown) => Promise<void> | void;
}

export interface HttpDispatchTargetSpec {
  readonly url: string;
  readonly fetch?: (input: string, init: RequestInit) => Promise<Response>;
  readonly headers?: Readonly<Record<string, string>>;
  readonly provider?: string;
}

export interface ProviderDispatchTargetSpec {
  readonly providerId: string;
  readonly invoke: (envelope: DispatchEnvelope) =>
    | Promise<{ readonly receiptId?: string }>
    | {
        readonly receiptId?: string;
      };
}

const externalReceiptFor = (
  targetKind: string,
  envelope: DispatchEnvelope,
  receiptId?: string,
): DispatchDeliveryResult => ({
  receipt:
    receiptId === undefined
      ? dispatchExternalDeliveryReceipt({
          targetKind,
          targetScope: envelope.targetScope,
          idempotencyKey: envelope.idempotencyKey,
        })
      : {
          anchorId: receiptId,
          anchorKind: "external_receipt",
        },
});

export const durableObjectDispatchTarget = (
  namespace: DispatchTargetNamespace,
): DispatchTargetAdapter => ({
  deliver: (envelope) => {
    const targetId = namespace.idFromName(envelope.targetScope);
    const receiver = namespace.get(targetId) as DispatchReceiver;
    return receiver.__agentosReceiveDispatch(envelope);
  },
});

export const queueDispatchTarget = (queue: QueueDispatchTargetBinding): DispatchTargetAdapter => ({
  deliver: (envelope) =>
    Promise.resolve(undefined)
      .then(() =>
        queue.send({
          sourceScope: envelope.sourceScope,
          targetScope: envelope.targetScope,
          event: envelope.event,
          data: envelope.data,
          idempotencyKey: envelope.idempotencyKey,
        }),
      )
      .then(
        () => externalReceiptFor("queue", envelope),
        () => Promise.reject("dispatch queue target failed"),
      ),
});

export const httpDispatchTarget = (spec: HttpDispatchTargetSpec): DispatchTargetAdapter => ({
  deliver: (envelope) => {
    const fetchFn = spec.fetch ?? fetch;
    return Promise.resolve(undefined)
      .then(() =>
        fetchFn(spec.url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...spec.headers,
          },
          body: JSON.stringify({
            sourceScope: envelope.sourceScope,
            targetScope: envelope.targetScope,
            event: envelope.event,
            data: envelope.data,
            idempotencyKey: envelope.idempotencyKey,
          }),
        }),
      )
      .then(
        (response) => {
          if (!response.ok) {
            return Promise.reject(`dispatch http target failed:${response.status}`);
          }
          return externalReceiptFor("http", envelope);
        },
        () => Promise.reject("dispatch http target failed"),
      );
  },
});

export const providerDispatchTarget = (
  spec: ProviderDispatchTargetSpec,
): DispatchTargetAdapter => ({
  deliver: (envelope) =>
    Promise.resolve(undefined)
      .then(() => spec.invoke(envelope))
      .then(
        (result) => externalReceiptFor(`provider.${spec.providerId}`, envelope, result.receiptId),
        () => Promise.reject(`dispatch provider target failed:${spec.providerId}`),
      ),
});

type DeliveryRetryOutcome =
  | {
      readonly _tag: "delivered";
      readonly outboundEventId: number;
      readonly requested: DispatchRequestedPayload;
      readonly deliveryReceipt: DispatchDeliveryReceipt;
    }
  | {
      readonly _tag: "failed";
      readonly outboundEventId: number;
      readonly requested: DispatchRequestedPayload;
      readonly cause: unknown;
    };

type CloudflareDispatchTriggerTx = {
  readonly afterLedgerInsert: (effect: () => void) => void;
};

export const deliveryRetryTrigger = (
  sql: SqlStorage,
  scope: string,
  targets: DispatchTargetRegistry,
): DurableTrigger<DispatchRequestedPayload, DeliveryRetryOutcome> => ({
  kind: DELIVERY_RETRY_TRIGGER_KIND,
  intentEventKind: DISPATCH_EVENT_KINDS.OUTBOUND_REQUESTED,
  cancellation: "ignored",
  parseIntent: (raw) => {
    const parsed = parseRequestedPayloadValue(raw);
    return parsed.ok ? triggerParseOk(parsed.value) : triggerParseFail(parsed.failure.reason);
  },
  acquire: (requested, acquireCtx) =>
    Effect.gen(function* () {
      const bindingKey = materialRefKey(requested.target.bindingRef);
      const target = targets[bindingKey];
      if (target === undefined) {
        return {
          _tag: "failed",
          outboundEventId: acquireCtx.intentEventId,
          requested,
          cause: new DispatchTargetNotFound({ bindingRef: bindingKey }),
        } as const;
      }

      const targetScope = cloudflareRouteKeyFromScopeRef(requested.target.scopeRef);
      const envelope: DispatchEnvelope = {
        sourceScope: scope,
        outboundEventId: acquireCtx.intentEventId,
        targetScope,
        event: requested.event,
        data: requested.data,
        idempotencyKey: requested.idempotencyKey,
        claim: requested.claim,
        ...(requested.traceContext === undefined ? {} : { traceContext: requested.traceContext }),
      };
      const delivered = yield* Effect.tryPromise({
        try: () => target.deliver(envelope),
        catch: (cause) => cause,
      }).pipe(Effect.either);
      if (delivered._tag === "Right") {
        return {
          _tag: "delivered",
          outboundEventId: acquireCtx.intentEventId,
          requested,
          deliveryReceipt: delivered.right.receipt,
        } as const;
      }
      return {
        _tag: "failed",
        outboundEventId: acquireCtx.intentEventId,
        requested,
        cause: delivered.left,
      } as const;
    }),
  commit: (outcome, tx) => {
    const row = selectPendingOutboxByIntent(sql, outcome.outboundEventId);
    if (row === null) return;
    const attempt = row.attempts + 1;

    if (outcome._tag === "delivered") {
      const bindingKey = materialRefKey(outcome.requested.target.bindingRef);
      const event = tx.insertEvent({
        kind: DISPATCH_EVENT_KINDS.OUTBOUND_DELIVERED,
        payload: {
          outboundEventId: outcome.outboundEventId,
          target: outcome.requested.target,
          event: outcome.requested.event,
          idempotencyKey: outcome.requested.idempotencyKey,
          deliveryReceipt: outcome.deliveryReceipt,
          attempt,
          ...(outcome.requested.claim === undefined
            ? {}
            : {
                claim: settleDispatchOutboundDelivered(outcome.requested.claim, {
                  bindingKey,
                  deliveryReceipt: outcome.deliveryReceipt,
                }),
              }),
          ...(outcome.requested.traceContext === undefined
            ? {}
            : { traceContext: outcome.requested.traceContext }),
        },
      });
      (tx as unknown as CloudflareDispatchTriggerTx).afterLedgerInsert(() => {
        sql.exec(
          "UPDATE dispatch_outbox SET delivered_event_id = ?, attempts = ?, last_error = NULL WHERE outbound_event_id = ?",
          event.id,
          attempt,
          outcome.outboundEventId,
        );
      });
      return;
    }

    const error = describeDispatchCause(outcome.cause);
    const terminal = attempt >= outcome.requested.retryPolicy.maxAttempts;
    const nextAttemptAt = terminal
      ? null
      : tx.now + durableTriggerBackoffMs(outcome.requested.retryPolicy, attempt);
    tx.insertEvent({
      kind: DISPATCH_EVENT_KINDS.OUTBOUND_FAILED,
      payload: {
        outboundEventId: outcome.outboundEventId,
        target: outcome.requested.target,
        event: outcome.requested.event,
        idempotencyKey: outcome.requested.idempotencyKey,
        attempt,
        error,
        terminal,
        ...(nextAttemptAt === null ? {} : { nextAttemptAt }),
        ...(outcome.requested.traceContext === undefined
          ? {}
          : { traceContext: outcome.requested.traceContext }),
      },
    });
    sql.exec(
      "UPDATE dispatch_outbox SET attempts = ?, last_error = ? WHERE outbound_event_id = ?",
      attempt,
      error,
      outcome.outboundEventId,
    );
    if (nextAttemptAt !== null) {
      tx.reschedule(nextAttemptAt, outcome.outboundEventId);
    }
  },
  commitCancelled: () => undefined,
});

export const DispatchLive = (
  ctx: DurableObjectState,
  scope: string,
  identity: BackendProtocolEventIdentity,
  targets: DispatchTargetRegistry,
): Layer.Layer<Dispatch, SqlError, EventBus | TriggerPump | DurableTriggerRegistry> => {
  const sql = ctx.storage.sql;

  return Layer.scoped(
    Dispatch,
    Effect.gen(function* () {
      yield* ensureDispatchSchema(sql);
      yield* ensureDueWorkSchema(sql);
      const bus = yield* EventBus;
      const triggerPump = yield* TriggerPump;
      const registry = yield* DurableTriggerRegistry;

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
            const traceContextResult = validateOptionalTraceContext(spec.traceContext);
            if (!traceContextResult.ok) {
              return yield* Effect.fail(
                new InvalidTraceContext({
                  position: "dispatch",
                  reason: traceContextResult.reason,
                }),
              );
            }
            const traceContext = copyTraceContext(traceContextResult.traceContext);
            if (
              !isScopeRef(spec.target.scopeRef) ||
              !isAuthorityRef(spec.target.effectAuthorityRef)
            ) {
              return yield* Effect.fail(
                new UnsupportedScopeRef({
                  scopeId: spec.target.scopeRef.scopeId,
                  position: "target",
                }),
              );
            }
            const targetScope = cloudflareRouteKeyFromScopeRef(spec.target.scopeRef);
            const claim = makePreClaim({
              operationRef: makeOperationRef("dispatch", [
                scope,
                bindingKey,
                targetScope,
                spec.idempotencyKey,
              ]),
              scopeRef: spec.target.scopeRef,
              effectAuthorityRef: spec.target.effectAuthorityRef,
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
              retryPolicy: DISPATCH_RETRY_POLICY,
              claim,
              ...(traceContext === undefined ? {} : { traceContext }),
            };
            const requestedEvent = yield* commitDurableTriggerIntent(
              ctx,
              sql,
              bus,
              identity,
              now,
              registry,
              DELIVERY_RETRY_TRIGGER_KIND,
              (tx, trigger) => {
                const outbound = tx.ref("dispatch.outbound.requested");
                tx.append(outbound, {
                  ts: now,
                  kind: trigger.intentEventKind,
                  scopeRef: identity.scopeRef,
                  effectAuthorityRef: identity.effectAuthorityRef,
                  payload: requestedPayload,
                });
                tx.afterInsert(({ id }) => {
                  sql.exec(
                    "INSERT INTO dispatch_outbox (outbound_event_id) VALUES (?)",
                    id(outbound),
                  );
                });
                return outbound;
              },
            );

            yield* triggerPump.drainDue(now);
            return { outboundEventId: requestedEvent.id };
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
            const traceContextResult = validateOptionalTraceContext(envelope.traceContext);
            if (!traceContextResult.ok) {
              return yield* Effect.fail(
                new InvalidTraceContext({
                  position: "dispatch",
                  reason: traceContextResult.reason,
                }),
              );
            }
            const traceContext = copyTraceContext(traceContextResult.traceContext);

            const result = yield* commitLedgerTransaction(
              ctx,
              bus,
              { factOwnerRef: identity.factOwnerRef },
              (tx) => {
                const acceptedResult = findAccepted(
                  sql,
                  identity,
                  envelope.sourceScope,
                  envelope.idempotencyKey,
                );
                if (!acceptedResult.ok) {
                  return {
                    duplicate: false as const,
                    deliveredEventId: 0,
                    failure: acceptedResult.failure,
                  };
                }
                const accepted = acceptedResult.value;
                if (accepted !== null) {
                  return {
                    duplicate: true as const,
                    deliveredEventId: accepted.deliveredEventId,
                    failure: null,
                  };
                }

                const inbound = tx.ref("dispatch.inbound.accepted");
                const delivered = tx.ref("dispatch.inbound.delivered");
                tx.append(inbound, {
                  ts: now,
                  kind: DISPATCH_INBOUND_ACCEPTED,
                  scopeRef: identity.scopeRef,
                  effectAuthorityRef: identity.effectAuthorityRef,
                  buildPayload: ({ id }: LedgerPayloadContext) => {
                    const deliveredEventId = id(delivered);
                    return {
                      sourceScope: envelope.sourceScope,
                      outboundEventId: envelope.outboundEventId,
                      idempotencyKey: envelope.idempotencyKey,
                      deliveredEventId,
                      claim: settleDispatchInboundAccepted(envelope.claim, {
                        sourceScope: envelope.sourceScope,
                        targetScope: scope,
                        deliveredEventId,
                      }),
                      ...(traceContext === undefined ? {} : { traceContext }),
                    } satisfies InboundAcceptedPayload;
                  },
                });
                tx.append(delivered, {
                  ts: now,
                  kind: envelope.event,
                  scopeRef: identity.scopeRef,
                  effectAuthorityRef: identity.effectAuthorityRef,
                  payload: envelope.data,
                });
                return {
                  duplicate: false as const,
                  delivered,
                  failure: null,
                };
              },
            );

            if (result.value.failure !== null) {
              return yield* Effect.fail(new SqlError({ cause: result.value.failure }));
            }
            const deliveredEventId = result.value.duplicate
              ? result.value.deliveredEventId
              : result.id(result.value.delivered);
            return {
              deliveredEventId,
              receipt: dispatchLedgerDeliveryReceipt({
                targetScope: scope,
                deliveredEventId,
              }),
            };
          }),
      };
    }),
  );
};
