import { Effect, Fiber, TestClock } from "effect";
import { describe, expect, it } from "@effect/vitest";
import { makePreClaim } from "@agent-os/kernel/effect-claim";
import { bindingMaterialRef } from "@agent-os/kernel/material-ref";

import {
  DELIVERY_RETRY_TRIGGER_KIND,
  DISPATCH_MAX_ATTEMPTS,
  DISPATCH_RETRY_POLICY,
  backendProtocolEventIdentityKey,
  backendProtocolProjectionKey,
  backendProtocolTruthIdentityKey,
  describeDispatchCause,
  dispatchBackoffMs,
  dispatchExternalDeliveryReceipt,
  dispatchLedgerDeliveryReceipt,
  dispatchSettlementContract,
  durableTriggerBackoffMs,
  durableTriggerDuePayload,
  fireBackendEventHandlers,
  parseDurableTriggerRetryPolicy,
  parseBackendProtocolLedgerEventRpc,
  parseIntentPointerDuePayload,
  parseRequestedPayload,
  settleDispatchOutboundDelivered,
} from "../src";

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

    expect(backendProtocolTruthIdentityKey(base)).toBe("conversation:same-scope|test:same-scope:none");
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
