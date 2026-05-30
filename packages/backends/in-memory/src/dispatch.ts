import { Clock, Effect, Layer } from "effect";
import {
  CapabilityRejected,
  DispatchScopeMismatch,
  DispatchTargetNotFound,
  JsonStringifyError,
  SqlError,
  UnsupportedScopeRef,
  isCoreClaimedEventKind,
} from "@agent-os/kernel/errors";
import { isScopeRef, makeOperationRef, makePreClaim } from "@agent-os/kernel/effect-claim";
import { materialRefKey } from "@agent-os/kernel/material-ref";
import { Dispatch, type DispatchEnvelope, type DispatchTargetAdapter } from "@agent-os/runtime";
import {
  DISPATCH_EVENT_KINDS,
  DISPATCH_INBOUND_ACCEPTED,
  DISPATCH_MAX_ATTEMPTS,
  copyTraceContext,
  describeDispatchCause,
  dispatchLedgerDeliveryReceipt,
  dispatchBackoffMs,
  parseDispatchLivedClaim,
  settleDispatchInboundAccepted,
  settleDispatchOutboundDelivered,
} from "@agent-os/backend-protocol";
import type { InMemoryBackendState } from "./state";
import { decodeOk, finiteNumberField, recordOf, type DecodeResult } from "./decode";
import type { DispatchRequestedPayload, InMemoryDispatchTargetRegistry } from "./dispatch-types";

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

const drainDueOutbox = (
  state: InMemoryBackendState,
  scope: string,
  targets: InMemoryDispatchTargetRegistry,
  now: number,
): Effect.Effect<{ readonly delivered: number; readonly failed: number }, JsonStringifyError> =>
  Effect.gen(function* () {
    let delivered = 0;
    let failed = 0;
    for (const due of state.dueDeliveryOutbox(now)) {
      const row = due.row;
      const bindingKey = materialRefKey(row.requested.target.bindingRef);
      const target = targetFor(targets, bindingKey);
      const attempt = row.attempts + 1;
      if (target === undefined) {
        const terminal = attempt >= DISPATCH_MAX_ATTEMPTS;
        const nextAttemptAt = terminal ? null : now + dispatchBackoffMs(attempt);
        yield* state.commitEvents([
          {
            ts: now,
            kind: DISPATCH_EVENT_KINDS.OUTBOUND_FAILED,
            scope,
            payload: {
              outboundEventId: row.outboundEventId,
              target: row.requested.target,
              event: row.requested.event,
              idempotencyKey: row.requested.idempotencyKey,
              attempt,
              error: "agent_os.dispatch_target_not_found",
              terminal,
              ...(nextAttemptAt === null ? {} : { nextAttemptAt }),
            },
          },
        ]);
        row.attempts = attempt;
        row.lastError = "agent_os.dispatch_target_not_found";
        state.completeDueWork(due.dueWorkId, now);
        if (nextAttemptAt !== null) state.addDeliveryRetryDue(row.outboundEventId, nextAttemptAt);
        failed += 1;
        continue;
      }

      const envelope: DispatchEnvelope = {
        sourceScope: row.sourceScope,
        outboundEventId: row.outboundEventId,
        targetScope: row.requested.target.scope,
        event: row.requested.event,
        data: row.requested.data,
        idempotencyKey: row.requested.idempotencyKey,
        claim: row.requested.claim,
        ...(row.requested.traceContext === undefined
          ? {}
          : { traceContext: row.requested.traceContext }),
      };
      const result = yield* Effect.tryPromise({
        try: () => target.deliver(envelope),
        catch: (cause) => cause,
      }).pipe(Effect.either);

      if (result._tag === "Right") {
        const [event] = yield* state.commitEvents([
          {
            ts: now,
            kind: DISPATCH_EVENT_KINDS.OUTBOUND_DELIVERED,
            scope,
            payload: {
              outboundEventId: row.outboundEventId,
              target: row.requested.target,
              event: row.requested.event,
              idempotencyKey: row.requested.idempotencyKey,
              deliveryReceipt: result.right.receipt,
              attempt,
              claim: settleDispatchOutboundDelivered(row.requested.claim, {
                bindingKey,
                deliveryReceipt: result.right.receipt,
              }),
              ...(row.requested.traceContext === undefined
                ? {}
                : { traceContext: row.requested.traceContext }),
            },
          },
        ]);
        row.deliveredEventId = event!.id;
        row.attempts = attempt;
        row.lastError = null;
        state.completeDueWork(due.dueWorkId, now);
        delivered += 1;
        continue;
      }

      const terminal = attempt >= DISPATCH_MAX_ATTEMPTS;
      const nextAttemptAt = terminal ? null : now + dispatchBackoffMs(attempt);
      const error = describeDispatchCause(result.left);
      yield* state.commitEvents([
        {
          ts: now,
          kind: DISPATCH_EVENT_KINDS.OUTBOUND_FAILED,
          scope,
          payload: {
            outboundEventId: row.outboundEventId,
            target: row.requested.target,
            event: row.requested.event,
            idempotencyKey: row.requested.idempotencyKey,
            attempt,
            error,
            terminal,
            ...(nextAttemptAt === null ? {} : { nextAttemptAt }),
          },
        },
      ]);
      row.attempts = attempt;
      row.lastError = error;
      state.completeDueWork(due.dueWorkId, now);
      if (nextAttemptAt !== null) state.addDeliveryRetryDue(row.outboundEventId, nextAttemptAt);
      failed += 1;
    }
    return { delivered, failed };
  });

export const InMemoryDispatchLive = (
  state: InMemoryBackendState,
  scope: string,
  targets: InMemoryDispatchTargetRegistry = {},
): Layer.Layer<Dispatch> =>
  Layer.succeed(Dispatch, {
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
        const traceContext = copyTraceContext(spec.traceContext);
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
        const requested: DispatchRequestedPayload = {
          target: spec.target,
          event: spec.event,
          data: spec.data,
          idempotencyKey: spec.idempotencyKey,
          claim,
          ...(traceContext === undefined ? {} : { traceContext }),
        };
        const [event] = yield* state.commitEvents([
          {
            ts: now,
            kind: DISPATCH_EVENT_KINDS.OUTBOUND_REQUESTED,
            scope,
            payload: requested,
          },
        ]);
        state.addOutbox({
          outboundEventId: event!.id,
          sourceScope: scope,
          requested,
          attempts: 0,
          deliveredEventId: null,
          lastError: null,
        });
        state.addDeliveryRetryDue(event!.id, now);
        yield* drainDueOutbox(state, scope, targets, now);
        return { outboundEventId: event!.id };
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
        const traceContext = copyTraceContext(envelope.traceContext);
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

    drainDue: (now) => drainDueOutbox(state, scope, targets, now),
  });
