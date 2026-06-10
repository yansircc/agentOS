import { Effect, Fiber, TestClock } from "effect";
import { describe, expect, it } from "@effect/vitest";
import { makePreClaim } from "@agent-os/kernel/effect-claim";
import { bindingMaterialRef } from "@agent-os/kernel/material-ref";

import {
  DELIVERY_RETRY_TRIGGER_KIND,
  DISPATCH_MAX_ATTEMPTS,
  DISPATCH_RETRY_POLICY,
  DURABLE_TRIGGER_SCHEDULED_CANCELLED,
  DURABLE_TRIGGER_SCHEDULED_REQUESTED,
  QUOTA_EVENT_KIND,
  RESOURCE_EVENT_KIND,
  SCHEDULED_EVENT_TRIGGER_KIND,
  backendProtocolEventIdentityKey,
  backendProtocolProjectionKey,
  backendProtocolTruthIdentityKey,
  describeDispatchCause,
  dispatchBackoffMs,
  dispatchExternalDeliveryReceipt,
  dispatchFailedHasNoDeliveryReceipt,
  dispatchLedgerDeliveryReceipt,
  dispatchReplaySnapshotFromDeliveredPayload,
  dispatchReceiptBeforeTerminalProof,
  dispatchSettlementContract,
  durableTriggerBackoffMs,
  durableTriggerDuePayload,
  parseDurableTriggerRetryPolicy,
  parseBackendProtocolLedgerEventRpc,
  parseIntentPointerDuePayload,
  parseScheduledEventIntentPayload,
  parseRequestedPayload,
  projectQuotaGrantUsage,
  projectQuotaState,
  projectResourceRows,
  projectResourceState,
  replayDispatchDeliveryFromSnapshot,
  scheduledEventIntentPayload,
  settleDispatchOutboundDelivered,
  type DispatchTargetAdapter,
} from "../src";
import { fireBackendEventHandlers } from "../src/reference";

const traceContext = {
  traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
  tracestate: "vendor=value",
};

const bindingRef = bindingMaterialRef({
  provider: "cloudflare",
  bindingKind: "durable_object",
  ref: "PEER_DO",
});

const eventIdentity = (scopeId: string) => ({
  scopeRef: { kind: "conversation" as const, scopeId },
  factOwnerRef: "@agent-os/test",
  effectAuthorityRef: { authorityClass: "test", authorityId: scopeId },
});

const truthIdentity = (scopeId: string) => ({
  scopeRef: { kind: "conversation" as const, scopeId },
  effectAuthorityRef: { authorityClass: "effect", authorityId: `dispatch:${scopeId}` },
});

const claim = makePreClaim({
  operationRef: "dispatch:test",
  scopeRef: { kind: "conversation", scopeId: "sender" },
  effectAuthorityRef: { authorityId: "dispatch.send", authorityClass: "effect" },
  originRef: { originId: "backend-protocol-test", originKind: "test" },
});

const ledgerEvent = (id: number, kind: string, payload: unknown) => ({
  id,
  ts: id,
  kind,
  ...eventIdentity("projection"),
  payload,
});

describe("@agent-os/backend-protocol", () => {
  it("parses dispatch requested payload from ledger wire JSON", () => {
    const parsed = parseRequestedPayload(
      JSON.stringify({
        target: {
          bindingRef,
          ...truthIdentity("receiver"),
        },
        event: "app.deliver",
        data: { ok: true },
        idempotencyKey: "dispatch-1",
        retryPolicy: DISPATCH_RETRY_POLICY,
        claim,
        traceContext,
      }),
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.target.bindingRef).toEqual(bindingRef);
    expect(parsed.value.target).not.toHaveProperty("scope");
    expect(parsed.value.target.scopeRef).toEqual({ kind: "conversation", scopeId: "receiver" });
    expect(parsed.value.target.effectAuthorityRef).toEqual({
      authorityClass: "effect",
      authorityId: "dispatch:receiver",
    });
    expect(parsed.value.event).toBe("app.deliver");
    expect(parsed.value.traceContext).toEqual(traceContext);
  });

  it("rejects malformed trace context before dispatch propagation", () => {
    const parsed = parseRequestedPayload(
      JSON.stringify({
        target: {
          bindingRef,
          ...truthIdentity("receiver"),
        },
        event: "app.deliver",
        data: { ok: true },
        idempotencyKey: "dispatch-1",
        retryPolicy: DISPATCH_RETRY_POLICY,
        claim,
        traceContext: { traceparent: "00-test" },
      }),
    );

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.failure.reason).toContain("traceparent");
  });

  it("returns typed failures for malformed dispatch payloads", () => {
    const malformedJson = parseRequestedPayload("{");
    expect(malformedJson.ok).toBe(false);
    if (malformedJson.ok) return;
    expect(malformedJson.failure._tag).toBe("agent_os.dispatch_payload_parse_failure");

    const malformedTarget = parseRequestedPayload(
      JSON.stringify({
        target: { scopeRef: { kind: "conversation", scopeId: "receiver" } },
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

  it("rejects legacy target scope strings instead of deriving identity from them", () => {
    const parsed = parseRequestedPayload(
      JSON.stringify({
        target: {
          bindingRef,
          scope: "receiver",
          ...truthIdentity("receiver"),
        },
        event: "app.deliver",
        data: { ok: true },
        idempotencyKey: "dispatch-1",
        retryPolicy: DISPATCH_RETRY_POLICY,
        claim,
      }),
    );

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.failure.reason).toBe("dispatch target must not include legacy scope");
  });

  it("rejects partial target identity without effect authority", () => {
    const parsed = parseRequestedPayload(
      JSON.stringify({
        target: {
          bindingRef,
          scopeRef: { kind: "conversation", scopeId: "receiver" },
        },
        event: "app.deliver",
        data: { ok: true },
        idempotencyKey: "dispatch-1",
        retryPolicy: DISPATCH_RETRY_POLICY,
        claim,
      }),
    );

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.failure.reason).toBe("dispatch target effectAuthorityRef malformed");
  });

  it("keys truth, owner, and projections by exact structured identity", () => {
    const base = eventIdentity("same-scope");
    const alternateAuthority = {
      ...base,
      effectAuthorityRef: { authorityClass: "test", authorityId: "alternate" },
    };
    const alternateOwner = {
      ...base,
      factOwnerRef: "@agent-os/other",
    };

    expect(backendProtocolTruthIdentityKey(base)).toBe(
      "conversation:same-scope|test:same-scope:none",
    );
    expect(backendProtocolTruthIdentityKey(base)).not.toBe(
      backendProtocolTruthIdentityKey(alternateAuthority),
    );
    expect(backendProtocolEventIdentityKey(base)).not.toBe(
      backendProtocolEventIdentityKey(alternateOwner),
    );
    expect(
      backendProtocolProjectionKey({
        ...base,
        projectionKind: "resource",
        projectionId: "credit",
      }),
    ).not.toBe(
      backendProtocolProjectionKey({
        ...base,
        projectionKind: "resource",
        projectionId: "tokens",
      }),
    );
  });

  it("rejects ownerless or legacy-scope event rows at the protocol boundary", () => {
    const ownerless = parseBackendProtocolLedgerEventRpc({
      id: 1,
      ts: 1,
      kind: "app.handled",
      scopeRef: { kind: "conversation", scopeId: "receiver" },
      effectAuthorityRef: { authorityClass: "effect", authorityId: "dispatch:receiver" },
      payload: { ok: true },
    });
    expect(ownerless.ok).toBe(false);
    if (ownerless.ok) return;
    expect(ownerless.failure.reason).toBe("ledger event fields malformed");

    const legacyScope = parseBackendProtocolLedgerEventRpc({
      id: 1,
      ts: 1,
      kind: "app.handled",
      scope: "receiver",
      ...eventIdentity("receiver"),
      payload: { ok: true },
    });
    expect(legacyScope.ok).toBe(false);
    if (legacyScope.ok) return;
    expect(legacyScope.failure.reason).toBe("ledger event must not include legacy scope");
  });

  it("owns retry, cause, and due-work pointer vocabulary", () => {
    expect(DISPATCH_MAX_ATTEMPTS).toBe(8);
    expect(DELIVERY_RETRY_TRIGGER_KIND).toBe("delivery_retry");
    expect(dispatchBackoffMs(1)).toBe(1_000);
    expect(dispatchBackoffMs(8)).toBe(60_000);
    expect(durableTriggerBackoffMs(DISPATCH_RETRY_POLICY, 8)).toBe(60_000);
    expect(describeDispatchCause(new Error("boom"))).toBe("Error: boom");
    expect(parseIntentPointerDuePayload({ intentEventId: 7 })).toEqual({
      ok: true,
      payload: { intentEventId: 7 },
    });
    expect(durableTriggerDuePayload(44)).toEqual({ intentEventId: 44 });
    expect(parseIntentPointerDuePayload({ intentEventId: 7, outboundEventId: 42 }).ok).toBe(false);
    expect(parseIntentPointerDuePayload({ intentEventId: 0 }).ok).toBe(false);
    const malformedDeliveryDue = parseIntentPointerDuePayload({
      outboundEventId: 42,
    });
    expect(malformedDeliveryDue.ok).toBe(false);
    if (malformedDeliveryDue.ok) return;
    expect(malformedDeliveryDue.cause.message).toBe("durable trigger due-work payload malformed");
  });

  it("owns scheduled trigger discriminator and intent payload vocabulary", () => {
    const payload = scheduledEventIntentPayload("app.scheduled", { job: "one" });
    expect(SCHEDULED_EVENT_TRIGGER_KIND).toBe("scheduled_event");
    expect(DURABLE_TRIGGER_SCHEDULED_REQUESTED).toBe("durable_trigger.scheduled.requested");
    expect(DURABLE_TRIGGER_SCHEDULED_CANCELLED).toBe("durable_trigger.scheduled.cancelled");
    expect(parseScheduledEventIntentPayload(payload)).toEqual({
      ok: true,
      payload,
    });
    expect(parseScheduledEventIntentPayload({ eventKind: "app.scheduled", extra: true }).ok).toBe(
      false,
    );
    const malformed = parseScheduledEventIntentPayload({ data: { job: "one" } });
    expect(malformed.ok).toBe(false);
    if (malformed.ok) return;
    expect(malformed.cause.message).toBe("scheduled event intent payload malformed");
  });

  it("owns resource payload codecs and projection fold", () => {
    const rows = [
      {
        kind: RESOURCE_EVENT_KIND.GRANTED,
        payload: JSON.stringify({ key: "gpu", amount: 10, ref: "seed" }),
      },
      {
        kind: RESOURCE_EVENT_KIND.RESERVED,
        payload: {
          key: "gpu",
          amount: 3,
          ref: "reserve-1",
          idempotencyKey: "op-1",
          reservationId: "reservation-1",
        },
      },
      {
        kind: RESOURCE_EVENT_KIND.RESERVED,
        payload: {
          key: "gpu",
          amount: 2,
          ref: "reserve-2",
          idempotencyKey: "op-2",
          reservationId: "reservation-2",
        },
      },
      {
        kind: RESOURCE_EVENT_KIND.RELEASED,
        payload: { reservationId: "reservation-2", ref: "release-2" },
      },
      {
        kind: RESOURCE_EVENT_KIND.CONSUMED,
        payload: { reservationId: "reservation-1", ref: "consume-1" },
      },
      {
        kind: RESOURCE_EVENT_KIND.RESERVE_REJECTED,
        payload: {
          key: "gpu",
          amount: 99,
          ref: "reserve-reject",
          idempotencyKey: "op-reject",
          available: 7,
        },
      },
    ];

    const projected = projectResourceRows(rows);

    expect(projected.byKey.get("gpu")).toEqual({ available: 7, reserved: 0, consumed: 3 });
    expect(projected.byId.get("reservation-1")).toMatchObject({ status: "consumed" });
    expect(projected.byId.get("reservation-2")).toMatchObject({ status: "released" });
    expect(projected.byIdempotencyKey.get("op-1")?.reservationId).toBe("reservation-1");
    expect(
      projectResourceState(
        rows.map((row, index) => ledgerEvent(index + 1, String(row.kind), row.payload)),
        "gpu",
      ),
    ).toEqual({
      granted: 10,
      reserved: 0,
      consumed: 3,
      available: 7,
      reservations: [],
    });
  });

  it("owns quota payload codecs, idempotent grant usage, and malformed fact failure", () => {
    const events = [
      ledgerEvent(1, QUOTA_EVENT_KIND.CONSUMED, {
        key: "tool-a",
        amount: 2,
        toolName: "tool-a",
        operationRef: "op-1",
      }),
      ledgerEvent(2, QUOTA_EVENT_KIND.CONSUMED, {
        key: "tool-a",
        amount: 3,
        toolName: "tool-a",
        operationRef: "op-2",
      }),
      ledgerEvent(3, QUOTA_EVENT_KIND.CONSUMED, {
        key: "tool-b",
        amount: 7,
        toolName: "tool-b",
        operationRef: "op-b",
      }),
    ];

    expect(
      projectQuotaGrantUsage(events, {
        key: "tool-a",
        windowStart: 0,
        operationRef: "op-2",
      }),
    ).toEqual({ consumed: 2, alreadyGranted: true });
    expect(projectQuotaState(events, { key: "tool-a", windowMs: 2, limit: 10 }, 3)).toEqual({
      consumed: 5,
      limit: 10,
      remaining: 5,
      refundable: 0,
      windowStart: 1,
    });
    expect(() =>
      projectQuotaGrantUsage(
        [
          ledgerEvent(1, QUOTA_EVENT_KIND.CONSUMED, {
            key: "tool-a",
            amount: "x",
            toolName: "tool-a",
            operationRef: "bad-op",
          }),
        ],
        { key: "tool-a", windowStart: 0, operationRef: "op-3" },
      ),
    ).toThrow();
  });

  it("keeps retry policy as serializable protocol data", () => {
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

  it("receipt-before-terminal proof ties terminal delivery to idempotency receipt", () => {
    const delivered = {
      outboundEventId: 22,
      target: {
        bindingRef,
        ...truthIdentity("receiver"),
      },
      event: "app.deliver",
      idempotencyKey: "dispatch-terminal-1",
      deliveryReceipt: dispatchExternalDeliveryReceipt({
        targetKind: "queue",
        targetScope: "receiver",
        idempotencyKey: "dispatch-terminal-1",
      }),
      attempt: 1,
      traceContext,
    };

    expect(dispatchReceiptBeforeTerminalProof(delivered)).toEqual({
      eventKind: "dispatch.outbound.delivered",
      outboundEventId: 22,
      idempotencyKey: "dispatch-terminal-1",
      deliveryReceipt: delivered.deliveryReceipt,
      attempt: 1,
    });
    expect(
      dispatchFailedHasNoDeliveryReceipt({
        outboundEventId: 22,
        target: delivered.target,
        event: delivered.event,
        idempotencyKey: delivered.idempotencyKey,
        attempt: 8,
        error: "permanent",
        terminal: true,
      }),
    ).toBe(true);
    expect(
      dispatchFailedHasNoDeliveryReceipt({
        outboundEventId: 22,
        target: delivered.target,
        event: delivered.event,
        idempotencyKey: delivered.idempotencyKey,
        attempt: 8,
        error: "permanent",
        terminal: true,
        deliveryReceipt: delivered.deliveryReceipt,
      } as never),
    ).toBe(false);
  });

  it("replay mode DispatchTargetAdapter not called: dispatch delivery replays from receipt snapshot", async () => {
    let liveDispatchTargetAdapterCalled = false;
    const liveDispatchTargetAdapter: DispatchTargetAdapter = {
      deliver: () => {
        liveDispatchTargetAdapterCalled = true;
        return Promise.reject(new Error("live dispatch adapter should not be called in replay"));
      },
    };
    const delivered = {
      outboundEventId: 17,
      target: {
        bindingRef,
        ...truthIdentity("receiver"),
      },
      event: "app.deliver",
      idempotencyKey: "dispatch-replay-1",
      deliveryReceipt: dispatchExternalDeliveryReceipt({
        targetKind: "queue",
        targetScope: "receiver",
        idempotencyKey: "dispatch-replay-1",
      }),
      attempt: 2,
      traceContext,
    };

    const snapshot = dispatchReplaySnapshotFromDeliveredPayload(delivered);
    const replayed = replayDispatchDeliveryFromSnapshot(snapshot);

    expect(replayed).toEqual({ receipt: delivered.deliveryReceipt });
    expect(liveDispatchTargetAdapterCalled).toBe(false);
    expect(liveDispatchTargetAdapter.deliver).toBeDefined();
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
          ...eventIdentity("scope"),
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
