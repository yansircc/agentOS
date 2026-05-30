import { Effect, Fiber, TestClock } from "effect";
import { describe, expect, it } from "@effect/vitest";
import { makePreClaim } from "@agent-os/kernel/effect-claim";
import { bindingMaterialRef } from "@agent-os/kernel/material-ref";

import {
  DISPATCH_MAX_ATTEMPTS,
  DISPATCH_RETRY_POLICY,
  DUE_WORK_DELIVERY_RETRY,
  DUE_WORK_RECONCILER_RUN,
  DUE_WORK_SCHEDULED_EVENT,
  DURABLE_TRIGGER_SCHEDULED_REQUESTED,
  describeDispatchCause,
  dispatchBackoffMs,
  dispatchExternalDeliveryReceipt,
  dispatchLedgerDeliveryReceipt,
  dispatchSettlementContract,
  durableTriggerBackoffMs,
  durableTriggerDuePayload,
  fireBackendEventHandlers,
  parseDurableTriggerRetryPolicy,
  parseDueWorkPayload,
  parseRequestedPayload,
  parseScheduledEventIntentPayload,
  reconcilerRunIntentPayload,
  scheduledEventIntentPayload,
  settleDispatchOutboundDelivered,
} from "../src";

const bindingRef = bindingMaterialRef({
  provider: "cloudflare",
  bindingKind: "durable_object",
  ref: "PEER_DO",
});

const claim = makePreClaim({
  operationRef: "dispatch:test",
  scopeRef: { kind: "conversation", scopeId: "sender" },
  authorityRef: { authorityId: "dispatch.send", authorityClass: "effect" },
  originRef: { originId: "backend-protocol-test", originKind: "test" },
});

describe("@agent-os/backend-protocol", () => {
  it("parses dispatch requested payload from ledger wire JSON", () => {
    const parsed = parseRequestedPayload(
      JSON.stringify({
        target: {
          bindingRef,
          scope: "receiver",
          scopeRef: { kind: "conversation", scopeId: "receiver" },
        },
        event: "app.deliver",
        data: { ok: true },
        idempotencyKey: "dispatch-1",
        retryPolicy: DISPATCH_RETRY_POLICY,
        claim,
        traceContext: { traceparent: "00-test", tracestate: "state" },
      }),
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.target.bindingRef).toEqual(bindingRef);
    expect(parsed.value.target.scope).toBe("receiver");
    expect(parsed.value.event).toBe("app.deliver");
    expect(parsed.value.traceContext).toEqual({
      traceparent: "00-test",
      tracestate: "state",
    });
  });

  it("returns typed failures for malformed dispatch payloads", () => {
    const malformedJson = parseRequestedPayload("{");
    expect(malformedJson.ok).toBe(false);
    if (malformedJson.ok) return;
    expect(malformedJson.failure._tag).toBe("agent_os.dispatch_payload_parse_failure");

    const malformedTarget = parseRequestedPayload(
      JSON.stringify({
        target: { scope: "receiver" },
        event: "app.deliver",
        idempotencyKey: "dispatch-1",
        retryPolicy: DISPATCH_RETRY_POLICY,
        claim,
      }),
    );
    expect(malformedTarget.ok).toBe(false);
    if (malformedTarget.ok) return;
    expect(malformedTarget.failure.reason).toBe(
      "dispatch target bindingRef must be a BindingMaterialRef",
    );
  });

  it("owns retry, cause, and due-work vocabulary", () => {
    expect(DISPATCH_MAX_ATTEMPTS).toBe(8);
    expect(dispatchBackoffMs(1)).toBe(1_000);
    expect(dispatchBackoffMs(8)).toBe(60_000);
    expect(durableTriggerBackoffMs(DISPATCH_RETRY_POLICY, 8)).toBe(60_000);
    expect(describeDispatchCause(new Error("boom"))).toBe("Error: boom");
    expect(DUE_WORK_SCHEDULED_EVENT).toBe("scheduled_event");
    expect(DUE_WORK_DELIVERY_RETRY).toBe("delivery_retry");
    expect(DUE_WORK_RECONCILER_RUN).toBe("reconciler_run");
    expect(DURABLE_TRIGGER_SCHEDULED_REQUESTED).toBe("durable_trigger.scheduled.requested");
    expect(parseDueWorkPayload(DUE_WORK_SCHEDULED_EVENT, { intentEventId: 7 })).toEqual({
      ok: true,
      payload: { intentEventId: 7 },
    });
    expect(parseDueWorkPayload(DUE_WORK_DELIVERY_RETRY, { intentEventId: 42 })).toEqual({
      ok: true,
      payload: { intentEventId: 42 },
    });
    expect(parseDueWorkPayload(DUE_WORK_RECONCILER_RUN, { intentEventId: 43 })).toEqual({
      ok: true,
      payload: { intentEventId: 43 },
    });
    expect(durableTriggerDuePayload(44)).toEqual({ intentEventId: 44 });
    const malformedDeliveryDue = parseDueWorkPayload(DUE_WORK_DELIVERY_RETRY, {
      outboundEventId: 42,
    });
    expect(malformedDeliveryDue.ok).toBe(false);
    if (malformedDeliveryDue.ok) return;
    expect(malformedDeliveryDue.cause.message).toBe("delivery retry due-work payload malformed");
  });

  it("keeps trigger intents and retry policy as serializable protocol data", () => {
    expect(parseDurableTriggerRetryPolicy(DISPATCH_RETRY_POLICY)).toEqual({
      ok: true,
      payload: DISPATCH_RETRY_POLICY,
    });
    const functionPolicy = parseDurableTriggerRetryPolicy({
      ...DISPATCH_RETRY_POLICY,
      next: () => 1,
    });
    expect(functionPolicy.ok).toBe(false);
    if (functionPolicy.ok) return;
    expect(functionPolicy.cause.message).toBe("durable trigger retry policy malformed");

    const scheduledIntent = scheduledEventIntentPayload("app.scheduled", { job: "one" });
    expect(parseScheduledEventIntentPayload(scheduledIntent)).toEqual({
      ok: true,
      value: scheduledIntent,
    });

    expect(
      reconcilerRunIntentPayload({
        intentEventId: 11,
        reconcilerId: "delivery.stale",
        idempotencyKey: "delivery.stale:11",
        retryPolicy: DISPATCH_RETRY_POLICY,
        payload: { olderThanMs: 60_000 },
      }),
    ).toMatchObject({
      intentEventId: 11,
      triggerKind: DUE_WORK_RECONCILER_RUN,
      targetKind: "reconciler",
      reconcilerId: "delivery.stale",
      idempotencyKey: "delivery.stale:11",
      retryPolicy: DISPATCH_RETRY_POLICY,
    });
  });

  it("settles outbound delivery against target receipts, not only receiver ledger ids", () => {
    expect(dispatchSettlementContract.anchorKinds).toEqual(["ledger_event", "external_receipt"]);
    expect(
      dispatchLedgerDeliveryReceipt({ targetScope: "receiver", deliveredEventId: 42 }),
    ).toEqual({
      anchorId: "dispatch.outbound:receiver:42",
      anchorKind: "ledger_event",
    });
    expect(
      dispatchExternalDeliveryReceipt({
        targetKind: "queue",
        targetScope: "image-jobs",
        idempotencyKey: "job-1",
      }),
    ).toEqual({
      anchorId: "dispatch.queue:image-jobs:job-1",
      anchorKind: "external_receipt",
    });

    const lived = settleDispatchOutboundDelivered(claim, {
      bindingKey: "binding:cloudflare:queue:image-jobs",
      deliveryReceipt: {
        anchorId: "queue:image-jobs:msg-1",
        anchorKind: "external_receipt",
      },
    });

    expect(lived.anchorRef).toEqual({
      anchorId: "queue:image-jobs:msg-1",
      anchorKind: "external_receipt",
      carrierRef: "dispatch:binding:cloudflare:queue:image-jobs",
    });
  });

  it.effect("bounds hung event handlers and continues fanout", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const fiber = yield* fireBackendEventHandlers(
        [
          () => {
            calls.push("hung");
            return new Promise<void>(() => undefined);
          },
          () => {
            calls.push("after");
          },
        ],
        {
          id: 1,
          ts: 1,
          kind: "app.handled",
          scope: "scope",
          payload: { ok: true },
        },
        "test handler",
      ).pipe(Effect.fork);

      yield* TestClock.adjust("6 seconds");
      yield* Fiber.join(fiber);

      expect(calls).toEqual(["hung", "after"]);
    }),
  );
});
