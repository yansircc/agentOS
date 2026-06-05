import { Clock, Effect, Layer } from "effect";
import {
  CapabilityRejected,
  DispatchScopeMismatch,
  DispatchTargetNotFound,
  InvalidTraceContext,
  SqlError,
  UnsupportedScopeRef,
  isCoreClaimedEventKind,
} from "@agent-os/kernel/errors";
import { validateOptionalTraceContext } from "@agent-os/kernel/trace-context";
import { isScopeRef, makeOperationRef, makePreClaim } from "@agent-os/kernel/effect-claim";
import { materialRefKey } from "@agent-os/kernel/material-ref";
import {
  Dispatch,
  DurableTriggerRegistry,
  TriggerPump,
  triggerParseFail,
  triggerParseOk,
  type DispatchDeliveryReceipt,
  type DispatchEnvelope,
  type DispatchTargetAdapter,
  type DurableTrigger,
} from "@agent-os/runtime";
import {
  DELIVERY_RETRY_TRIGGER_KIND,
  DISPATCH_EVENT_KINDS,
  DISPATCH_INBOUND_ACCEPTED,
  DISPATCH_RETRY_POLICY,
  copyTraceContext,
  describeDispatchCause,
  dispatchLedgerDeliveryReceipt,
  durableTriggerBackoffMs,
  parseRequestedPayloadValue,
  parseDispatchLivedClaim,
  settleDispatchInboundAccepted,
  settleDispatchOutboundDelivered,
  type DispatchRequestedPayload as ProtocolDispatchRequestedPayload,
} from "@agent-os/backend-protocol";
import type { InMemoryBackendState } from "./state";
import { decodeOk, finiteNumberField, recordOf, type DecodeResult } from "./decode";
import type { DispatchRequestedPayload, InMemoryDispatchTargetRegistry } from "./dispatch-types";

type InMemoryDispatchTriggerTx = {
  readonly markOutboxDelivered: (spec: {
    readonly outboundEventId: number;
    readonly deliveredEventId: number;
    readonly attempts: number;
  }) => void;
  readonly markOutboxFailed: (spec: {
    readonly outboundEventId: number;
    readonly attempts: number;
    readonly lastError: string;
  }) => void;
};

const targetFor = (
  targets: InMemoryDispatchTargetRegistry,
  bindingKey: string,
): DispatchTargetAdapter | undefined => targets[bindingKey];

const findAcceptedDeliveryId = (
  state: InMemoryBackendState,
  scope: string,
  envelope: DispatchEnvelope,
): DecodeResult<number | null> => {
  for (const event of state.streamSnapshot(scope, { kinds: [DISPATCH_INBOUND_ACCEPTED] })) {
    const payload = recordOf(event.payload, DISPATCH_INBOUND_ACCEPTED);
    if (!payload.ok) return payload;
    if (
      payload.value.sourceScope === envelope.sourceScope &&
      payload.value.idempotencyKey === envelope.idempotencyKey
    ) {
      const deliveredEventId = finiteNumberField(payload.value, "deliveredEventId");
      if (!deliveredEventId.ok) return deliveredEventId;
      const claim = parseDispatchLivedClaim(payload.value.claim, DISPATCH_INBOUND_ACCEPTED);
      if (!claim.ok) return { ok: false, cause: claim.failure.reason };
      return decodeOk(deliveredEventId.value);
    }
  }
  return decodeOk(null);
};

type DeliveryRetryOutcome =
  | { readonly _tag: "skipped" }
  | {
      readonly _tag: "delivered";
      readonly outboundEventId: number;
      readonly requested: ProtocolDispatchRequestedPayload;
      readonly receipt: DispatchDeliveryReceipt;
      readonly attempt: number;
    }
  | {
      readonly _tag: "failed";
      readonly outboundEventId: number;
      readonly requested: ProtocolDispatchRequestedPayload;
      readonly attempt: number;
      readonly cause: unknown;
    };

export const deliveryRetryTrigger = (
  state: InMemoryBackendState,
  targets: InMemoryDispatchTargetRegistry,
): DurableTrigger<ProtocolDispatchRequestedPayload, DeliveryRetryOutcome> => ({
  kind: DELIVERY_RETRY_TRIGGER_KIND,
  intentEventKind: DISPATCH_EVENT_KINDS.OUTBOUND_REQUESTED,
  cancellation: "ignored",
  parseIntent: (raw) => {
    const parsed = parseRequestedPayloadValue(raw);
    return parsed.ok ? triggerParseOk(parsed.value) : triggerParseFail(parsed.failure.reason);
  },
  acquire: (requested, ctx) =>
    Effect.gen(function* () {
      const row = state.pendingOutboxByIntent(ctx.intentEventId);
      if (row === null) return { _tag: "skipped" } as const;
      const attempt = row.attempts + 1;
      const bindingKey = materialRefKey(requested.target.bindingRef);
      const target = targetFor(targets, bindingKey);
      if (target === undefined) {
        return {
          _tag: "failed",
          outboundEventId: row.outboundEventId,
          requested,
          attempt,
          cause: "agent_os.dispatch_target_not_found",
        } as const;
      }
      const envelope: DispatchEnvelope = {
        sourceScope: row.sourceScope,
        outboundEventId: row.outboundEventId,
        targetScope: requested.target.scope,
        event: requested.event,
        data: requested.data,
        idempotencyKey: requested.idempotencyKey,
        claim: requested.claim,
        ...(requested.traceContext === undefined ? {} : { traceContext: requested.traceContext }),
      };
      const result = yield* Effect.tryPromise({
        try: () => target.deliver(envelope),
        catch: (cause) => cause,
      }).pipe(Effect.either);
      if (result._tag === "Right") {
        return {
          _tag: "delivered",
          outboundEventId: row.outboundEventId,
          requested,
          receipt: result.right.receipt,
          attempt,
        } as const;
      }
      return {
        _tag: "failed",
        outboundEventId: row.outboundEventId,
        requested,
        attempt,
        cause: result.left,
      } as const;
    }),
  commit: (outcome, tx) => {
    if (outcome._tag === "skipped") return;
    if (outcome._tag === "delivered") {
      const bindingKey = materialRefKey(outcome.requested.target.bindingRef);
      const event = tx.insertEvent({
        kind: DISPATCH_EVENT_KINDS.OUTBOUND_DELIVERED,
        payload: {
          outboundEventId: outcome.outboundEventId,
          target: outcome.requested.target,
          event: outcome.requested.event,
          idempotencyKey: outcome.requested.idempotencyKey,
          deliveryReceipt: outcome.receipt,
          attempt: outcome.attempt,
          claim: settleDispatchOutboundDelivered(outcome.requested.claim, {
            bindingKey,
            deliveryReceipt: outcome.receipt,
          }),
          ...(outcome.requested.traceContext === undefined
            ? {}
            : { traceContext: outcome.requested.traceContext }),
        },
      });
      (tx as unknown as InMemoryDispatchTriggerTx).markOutboxDelivered({
        outboundEventId: outcome.outboundEventId,
        deliveredEventId: event.id,
        attempts: outcome.attempt,
      });
      return;
    }

    const terminal = outcome.attempt >= outcome.requested.retryPolicy.maxAttempts;
    const nextAttemptAt = terminal
      ? null
      : tx.now + durableTriggerBackoffMs(outcome.requested.retryPolicy, outcome.attempt);
    const error = describeDispatchCause(outcome.cause);
    tx.insertEvent({
      kind: DISPATCH_EVENT_KINDS.OUTBOUND_FAILED,
      payload: {
        outboundEventId: outcome.outboundEventId,
        target: outcome.requested.target,
        event: outcome.requested.event,
        idempotencyKey: outcome.requested.idempotencyKey,
        attempt: outcome.attempt,
        error,
        terminal,
        ...(nextAttemptAt === null ? {} : { nextAttemptAt }),
      },
    });
    (tx as unknown as InMemoryDispatchTriggerTx).markOutboxFailed({
      outboundEventId: outcome.outboundEventId,
      attempts: outcome.attempt,
      lastError: error,
    });
    if (nextAttemptAt !== null) tx.reschedule(nextAttemptAt, outcome.outboundEventId);
  },
  commitCancelled: () => undefined,
});

export const InMemoryDispatchLive = (
  state: InMemoryBackendState,
  scope: string,
  targets: InMemoryDispatchTargetRegistry = {},
): Layer.Layer<Dispatch, never, TriggerPump | DurableTriggerRegistry> =>
  Layer.effect(
    Dispatch,
    Effect.gen(function* () {
      const triggerPump = yield* TriggerPump;
      const registry = yield* DurableTriggerRegistry;
      return {
        dispatchToScope: (spec) =>
          Effect.gen(function* () {
            if (isCoreClaimedEventKind(spec.event)) {
              return yield* Effect.fail(
                new CapabilityRejected({ event: spec.event, capability: "cap_app" }),
              );
            }
            const bindingKey = materialRefKey(spec.target.bindingRef);
            if (targetFor(targets, bindingKey) === undefined) {
              return yield* Effect.fail(new DispatchTargetNotFound({ bindingRef: bindingKey }));
            }
            if (!isScopeRef(spec.target.scopeRef)) {
              return yield* Effect.fail(
                new UnsupportedScopeRef({
                  scopeId: spec.target.scope,
                  position: "target",
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
            const claim = makePreClaim({
              operationRef: makeOperationRef("dispatch", [
                scope,
                bindingKey,
                spec.target.scope,
                spec.idempotencyKey,
              ]),
              scopeRef: spec.target.scopeRef,
              effectAuthorityRef: {
                authorityId: "cap_dispatch",
                authorityClass: "effect",
              },
              originRef: {
                originId: scope,
                originKind: "agent_do",
              },
            });
            const requested: DispatchRequestedPayload = {
              target: spec.target,
              event: spec.event,
              data: spec.data,
              idempotencyKey: spec.idempotencyKey,
              retryPolicy: DISPATCH_RETRY_POLICY,
              claim,
              ...(traceContext === undefined ? {} : { traceContext }),
            };
            const event = yield* state.commitTriggerIntent(
              scope,
              now,
              registry,
              DELIVERY_RETRY_TRIGGER_KIND,
              (trigger) => ({
                ts: now,
                kind: trigger.intentEventKind,
                scope,
                payload: requested,
              }),
              (event) => ({
                outboundEventId: event.id,
                sourceScope: scope,
                requested,
                attempts: 0,
                deliveredEventId: null,
                lastError: null,
              }),
            );
            yield* triggerPump.drainDue(now);
            return { outboundEventId: event.id };
          }),

        receive: (envelope) =>
          Effect.gen(function* () {
            if (envelope.targetScope !== scope) {
              return yield* Effect.fail(
                new DispatchScopeMismatch({ expected: scope, actual: envelope.targetScope }),
              );
            }
            if (isCoreClaimedEventKind(envelope.event)) {
              return yield* Effect.fail(
                new CapabilityRejected({ event: envelope.event, capability: "cap_app" }),
              );
            }

            const accepted = findAcceptedDeliveryId(state, scope, envelope);
            if (!accepted.ok) {
              return yield* Effect.fail(new SqlError({ cause: accepted.cause }));
            }
            if (accepted.value !== null) {
              return {
                deliveredEventId: accepted.value,
                receipt: dispatchLedgerDeliveryReceipt({
                  targetScope: scope,
                  deliveredEventId: accepted.value,
                }),
              };
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
            const events = yield* state.commitPrepared((nextId) => {
              const deliveredEventId = nextId + 1;
              const claim = settleDispatchInboundAccepted(envelope.claim, {
                sourceScope: envelope.sourceScope,
                targetScope: scope,
                deliveredEventId,
              });
              return [
                {
                  ts: now,
                  kind: DISPATCH_INBOUND_ACCEPTED,
                  scope,
                  payload: {
                    sourceScope: envelope.sourceScope,
                    outboundEventId: envelope.outboundEventId,
                    idempotencyKey: envelope.idempotencyKey,
                    deliveredEventId,
                    claim,
                    ...(traceContext === undefined ? {} : { traceContext }),
                  },
                },
                { ts: now, kind: envelope.event, scope, payload: envelope.data },
              ];
            });
            return {
              deliveredEventId: events[1]!.id,
              receipt: dispatchLedgerDeliveryReceipt({
                targetScope: scope,
                deliveredEventId: events[1]!.id,
              }),
            };
          }),
      };
    }),
  );
