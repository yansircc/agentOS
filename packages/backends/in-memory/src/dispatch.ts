import { Clock, Effect, Layer } from "effect";
import {
  CapabilityRejected,
  DurableTriggerCommitReturnedThenable,
  DispatchScopeMismatch,
  DispatchTargetNotFound,
  JsonStringifyError,
  UnregisteredDurableTriggerKind,
  UnsupportedScopeRef,
  isCoreClaimedEventKind,
} from "@agent-os/kernel/errors";
import { InvalidTraceContext, validateOptionalTraceContext } from "@agent-os/telemetry-protocol";
import {
  isAuthorityRef,
  isScopeRef,
  makeOperationRef,
  makePreClaim,
} from "@agent-os/kernel/effect-claim";
import { materialRefKey } from "@agent-os/kernel/material-ref";
import {
  Dispatch,
  DurableTriggerRegistry,
  TriggerPump,
  runtimeStorageError,
  runtimeStorageOrJsonError,
  triggerParseFail,
  triggerParseOk,
  type DurableTrigger,
  type RuntimeStorageError,
} from "@agent-os/runtime";
import {
  DELIVERY_RETRY_TRIGGER_KIND,
  DISPATCH_EVENT_KINDS,
  DISPATCH_INBOUND_ACCEPTED,
  DISPATCH_RETRY_POLICY,
  backendProtocolTruthIdentityKey,
  copyTraceContext,
  describeDispatchCause,
  dispatchDeliveryHistoryState,
  dispatchLedgerDeliveryReceipt,
  durableTriggerBackoffMs,
  parseRequestedPayloadValue,
  parseDispatchLivedClaim,
  settleDispatchInboundAccepted,
  settleDispatchOutboundEnqueued,
  settleDispatchOutboundDelivered,
  settleDispatchOutboundRetryPending,
  type BackendProtocolDispatchTarget,
  type BackendProtocolTruthIdentity,
  type DispatchDeliveryReceipt,
  type DispatchEnqueueAcknowledgement,
  type DispatchEnvelope,
  type DispatchRequestedPayload as ProtocolDispatchRequestedPayload,
  type DispatchTargetAdapter,
} from "@agent-os/backend-protocol";
import { inMemoryRuntimeEventIdentity, type InMemoryBackendState } from "./state";
import { decodeOk, finiteNumberField, recordOf, type DecodeResult } from "./decode";
import type { DispatchRequestedPayload, InMemoryDispatchTargetRegistry } from "./dispatch-types";

const targetFor = (
  targets: InMemoryDispatchTargetRegistry,
  bindingKey: string,
): DispatchTargetAdapter | undefined => targets[bindingKey];

const targetScopeLabel = (target: BackendProtocolDispatchTarget): string =>
  backendProtocolTruthIdentityKey(target);

const dispatchStorageError = (
  cause: unknown,
):
  | RuntimeStorageError
  | JsonStringifyError
  | UnregisteredDurableTriggerKind
  | DurableTriggerCommitReturnedThenable => {
  if (cause instanceof UnregisteredDurableTriggerKind) return cause;
  if (cause instanceof DurableTriggerCommitReturnedThenable) return cause;
  return runtimeStorageOrJsonError("dispatch", cause);
};

const findAcceptedDeliveryId = (
  state: InMemoryBackendState,
  identity: ReturnType<typeof inMemoryRuntimeEventIdentity>,
  envelope: DispatchEnvelope,
): DecodeResult<number | null> => {
  for (const event of state.eventSnapshot(identity, { kinds: [DISPATCH_INBOUND_ACCEPTED] })) {
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
      readonly _tag: "enqueued";
      readonly outboundEventId: number;
      readonly requested: ProtocolDispatchRequestedPayload;
      readonly acknowledgement: DispatchEnqueueAcknowledgement;
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
      const history = dispatchDeliveryHistoryState(
        ctx.events({
          kinds: [
            DISPATCH_EVENT_KINDS.OUTBOUND_DELIVERED,
            DISPATCH_EVENT_KINDS.OUTBOUND_ENQUEUED,
            DISPATCH_EVENT_KINDS.OUTBOUND_FAILED,
          ],
        }),
        ctx.intentEventId,
      );
      if (history.successCount > 0) return { _tag: "skipped" } as const;
      const attempt = history.attemptCount + 1;
      const bindingKey = materialRefKey(requested.target.bindingRef);
      const target = targetFor(targets, bindingKey);
      if (target === undefined) {
        return {
          _tag: "failed",
          outboundEventId: ctx.intentEventId,
          requested,
          attempt,
          cause: "agent_os.dispatch_target_not_found",
        } as const;
      }
      const envelope: DispatchEnvelope = {
        sourceScope: ctx.scope,
        outboundEventId: ctx.intentEventId,
        targetScope: targetScopeLabel(requested.target),
        event: requested.event,
        data: requested.data,
        idempotencyKey: requested.idempotencyKey,
        claim: requested.claim,
        ...(requested.traceContext === undefined ? {} : { traceContext: requested.traceContext }),
      };
      const result = yield* Effect.tryPromise({
        try: () => target.deliver(envelope),
        catch: (cause) => cause,
      }).pipe(Effect.result);
      if (result._tag === "Success") {
        if (result.success._tag === "delivered") {
          return {
            _tag: "delivered",
            outboundEventId: ctx.intentEventId,
            requested,
            receipt: result.success.receipt,
            attempt,
          } as const;
        }
        return {
          _tag: "enqueued",
          outboundEventId: ctx.intentEventId,
          requested,
          acknowledgement: result.success.acknowledgement,
          attempt,
        } as const;
      }
      return {
        _tag: "failed",
        outboundEventId: ctx.intentEventId,
        requested,
        attempt,
        cause: result.failure,
      } as const;
    }),
  commit: (outcome, tx) => {
    if (outcome._tag === "skipped") return;
    if (outcome._tag === "delivered") {
      const bindingKey = materialRefKey(outcome.requested.target.bindingRef);
      tx.insertEvent({
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
      return;
    }

    if (outcome._tag === "enqueued") {
      const bindingKey = materialRefKey(outcome.requested.target.bindingRef);
      tx.insertEvent({
        kind: DISPATCH_EVENT_KINDS.OUTBOUND_ENQUEUED,
        payload: {
          outboundEventId: outcome.outboundEventId,
          target: outcome.requested.target,
          event: outcome.requested.event,
          idempotencyKey: outcome.requested.idempotencyKey,
          enqueueAcknowledgement: outcome.acknowledgement,
          attempt: outcome.attempt,
          claim: settleDispatchOutboundEnqueued(outcome.requested.claim, {
            bindingKey,
            acknowledgement: outcome.acknowledgement,
          }),
          ...(outcome.requested.traceContext === undefined
            ? {}
            : { traceContext: outcome.requested.traceContext }),
        },
      });
      return;
    }

    const terminal = outcome.attempt >= outcome.requested.retryPolicy.maxAttempts;
    const nextAttemptAt = terminal
      ? null
      : tx.now + durableTriggerBackoffMs(outcome.requested.retryPolicy, outcome.attempt);
    const error = describeDispatchCause(outcome.cause);
    const bindingKey = materialRefKey(outcome.requested.target.bindingRef);
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
        ...(terminal
          ? {}
          : {
              claim: settleDispatchOutboundRetryPending(outcome.requested.claim, {
                bindingKey,
                outboundEventId: outcome.outboundEventId,
                attempt: outcome.attempt,
              }),
            }),
      },
    });
    if (nextAttemptAt !== null) tx.reschedule(nextAttemptAt, outcome.outboundEventId);
  },
  commitCancelled: () => undefined,
});

export const InMemoryDispatchLive = (
  state: InMemoryBackendState,
  identity: BackendProtocolTruthIdentity,
  scopeLabel: string,
  targets: InMemoryDispatchTargetRegistry = {},
): Layer.Layer<Dispatch, never, TriggerPump | DurableTriggerRegistry> =>
  Layer.effect(
    Dispatch,
    Effect.gen(function* () {
      const triggerPump = yield* TriggerPump;
      const registry = yield* DurableTriggerRegistry;
      const eventIdentity = inMemoryRuntimeEventIdentity(identity);
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
                  scopeId: "malformed",
                  position: "target",
                }),
              );
            }
            if (!isAuthorityRef(spec.target.effectAuthorityRef)) {
              return yield* Effect.fail(
                runtimeStorageError("dispatch", "dispatch target effectAuthorityRef malformed"),
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
                scopeLabel,
                bindingKey,
                targetScopeLabel(spec.target),
                spec.idempotencyKey,
              ]),
              scopeRef: spec.target.scopeRef,
              effectAuthorityRef: {
                authorityId: "cap_dispatch",
                authorityClass: "effect",
              },
              originRef: {
                originId: scopeLabel,
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
            const event = yield* state
              .commitTriggerIntent(
                eventIdentity,
                now,
                registry,
                DELIVERY_RETRY_TRIGGER_KIND,
                (trigger) => ({
                  ts: now,
                  kind: trigger.intentEventKind,
                  payload: requested,
                }),
              )
              .pipe(Effect.mapError(dispatchStorageError));
            yield* triggerPump.drainDue(now);
            return { outboundEventId: event.id };
          }),

        receive: (envelope) =>
          Effect.gen(function* () {
            if (envelope.targetScope !== scopeLabel) {
              return yield* Effect.fail(
                new DispatchScopeMismatch({ expected: scopeLabel, actual: envelope.targetScope }),
              );
            }
            if (isCoreClaimedEventKind(envelope.event)) {
              return yield* Effect.fail(
                new CapabilityRejected({ event: envelope.event, capability: "cap_app" }),
              );
            }

            const accepted = findAcceptedDeliveryId(state, eventIdentity, envelope);
            if (!accepted.ok) {
              return yield* Effect.fail(runtimeStorageError("dispatch", accepted.cause));
            }
            if (accepted.value !== null) {
              return {
                deliveredEventId: accepted.value,
                receipt: dispatchLedgerDeliveryReceipt({
                  targetScope: scopeLabel,
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
            const events = yield* state
              .commitPrepared((nextId) => {
                const deliveredEventId = nextId + 1;
                const claim = settleDispatchInboundAccepted(envelope.claim, {
                  sourceScope: envelope.sourceScope,
                  targetScope: scopeLabel,
                  deliveredEventId,
                });
                return [
                  {
                    ts: now,
                    kind: DISPATCH_INBOUND_ACCEPTED,
                    scopeRef: identity.scopeRef,
                    effectAuthorityRef: identity.effectAuthorityRef,
                    payload: {
                      sourceScope: envelope.sourceScope,
                      outboundEventId: envelope.outboundEventId,
                      idempotencyKey: envelope.idempotencyKey,
                      deliveredEventId,
                      claim,
                      ...(traceContext === undefined ? {} : { traceContext }),
                    },
                  },
                  {
                    ts: now,
                    kind: envelope.event,
                    scopeRef: identity.scopeRef,
                    effectAuthorityRef: identity.effectAuthorityRef,
                    payload: envelope.data,
                  },
                ];
              })
              .pipe(Effect.mapError((cause) => runtimeStorageOrJsonError("dispatch", cause)));
            return {
              deliveredEventId: events[1]!.id,
              receipt: dispatchLedgerDeliveryReceipt({
                targetScope: scopeLabel,
                deliveredEventId: events[1]!.id,
              }),
            };
          }),
      };
    }),
  );
