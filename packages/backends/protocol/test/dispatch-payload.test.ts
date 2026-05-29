import { describe, expect, it } from "@effect/vitest";
import { makePreClaim } from "@agent-os/kernel/effect-claim";
import { bindingMaterialRef } from "@agent-os/kernel/material-ref";

import {
  DISPATCH_MAX_ATTEMPTS,
  DUE_WORK_DISPATCH_RETRY,
  DUE_WORK_SCHEDULED_EVENT,
  describeCause,
  parseRequestedPayload,
  retryDelayMs,
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
    expect(retryDelayMs(1)).toBe(1_000);
    expect(retryDelayMs(8)).toBe(60_000);
    expect(describeCause(new Error("boom"))).toBe("Error: boom");
    expect(DUE_WORK_SCHEDULED_EVENT).toBe("scheduled_event");
    expect(DUE_WORK_DISPATCH_RETRY).toBe("dispatch_retry");
  });
});
