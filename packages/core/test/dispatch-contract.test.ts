/**
 * dispatchToScope — deterministic contract tests.
 *
 * Validates P1 of spec-28:
 *   - sender outbound event + dispatch_outbox row are atomic mechanics;
 *   - receiver writes dispatch.inbound.accepted + app event in one tx;
 *   - receiver dedupe SSoT is (sourceScope, idempotencyKey);
 *   - app payload is not wrapped with dispatch metadata;
 *   - failed delivery remains retryable instead of disappearing.
 */

import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import type {
  DispatchToScopeResult,
  DispatchToScopeSpec,
  LedgerEventRpc,
} from "../src";
import type { DispatchTestDO } from "./test-worker";

interface TestEnv {
  readonly DISPATCH_DO: DurableObjectNamespace<DispatchTestDO>;
}

const testEnv = env as unknown as TestEnv;

interface DispatchRpc {
  readonly dispatchToScope: (
    spec: DispatchToScopeSpec,
  ) => Promise<DispatchToScopeResult>;
  readonly emitEvent: (spec: {
    event: string;
    data: unknown;
  }) => Promise<{ id: number }>;
  readonly events: () => Promise<LedgerEventRpc[]>;
}

const stubFor = (
  scope: string,
): DurableObjectStub<DispatchTestDO> & DispatchRpc =>
  testEnv.DISPATCH_DO.get(
    testEnv.DISPATCH_DO.idFromName(scope),
  ) as DurableObjectStub<DispatchTestDO> & DispatchRpc;

const payloadOf = <T>(events: ReadonlyArray<LedgerEventRpc>, kind: string): T =>
  events.find((e) => e.kind === kind)?.payload as T;

const rowsOrEmpty = (
  state: DurableObjectState,
  sql: string,
): ReadonlyArray<Record<string, unknown>> => {
  try {
    return state.storage.sql.exec(sql).toArray() as Record<string, unknown>[];
  } catch (e) {
    if (e instanceof Error && e.message.includes("no such table")) {
      return [];
    }
    throw e;
  }
};

describe("dispatchToScope — cross-scope durable delivery primitive", () => {
  it("commits sender outbound event and dispatch_outbox row in one transaction", async () => {
    const sender = stubFor("dispatch-sender-atomic");
    const receiver = stubFor("dispatch-receiver-atomic");

    const result = await sender.dispatchToScope({
      target: { bindingRef: "peer", scope: "dispatch-receiver-atomic" },
      event: "test.delivered",
      data: { message: "hello" },
      idempotencyKey: "intent-1",
    });

    expect(result.outboundEventId).toBeGreaterThanOrEqual(1);

    await runInDurableObject(sender, async (_instance, state) => {
      const outbound = state.storage.sql
        .exec(
          "SELECT id, kind, payload FROM events WHERE kind = 'dispatch.outbound.requested'",
        )
        .toArray();
      const outbox = state.storage.sql
        .exec(
          "SELECT outbound_event_id, delivered_event_id FROM dispatch_outbox",
        )
        .toArray();
      const outboundDelivered = state.storage.sql
        .exec(
          "SELECT id, payload FROM events WHERE kind = 'dispatch.outbound.delivered'",
        )
        .toArray();

      expect(outbound).toHaveLength(1);
      expect(outbox).toHaveLength(1);
      expect(outboundDelivered).toHaveLength(1);
      expect(Number(outbound[0]?.id)).toBe(result.outboundEventId);
      expect(Number(outbox[0]?.outbound_event_id)).toBe(
        result.outboundEventId,
      );
      expect(Number(outbox[0]?.delivered_event_id)).toBe(
        Number(outboundDelivered[0]?.id),
      );
      expect(JSON.parse(String(outbound[0]?.payload))).toEqual({
        target: { bindingRef: "peer", scope: "dispatch-receiver-atomic" },
        event: "test.delivered",
        data: { message: "hello" },
        idempotencyKey: "intent-1",
      });
    });

    const receiverEvents: LedgerEventRpc[] = await receiver.events();
    expect(receiverEvents.some((e) => e.kind === "test.delivered")).toBe(true);
  });

  it("keeps outbox delivered FK local when receiver ledger ids diverge", async () => {
    const sender = stubFor("dispatch-sender-diverged-ledger");
    const receiver = stubFor("dispatch-receiver-diverged-ledger");

    await receiver.emitEvent({
      event: "test.seed",
      data: { purpose: "make receiver ids diverge" },
    });

    const result = await sender.dispatchToScope({
      target: { bindingRef: "peer", scope: "dispatch-receiver-diverged-ledger" },
      event: "test.delivered",
      data: { message: "cross-ledger" },
      idempotencyKey: "diverged-intent",
    });

    const receiverEvents: LedgerEventRpc[] = await receiver.events();
    const receiverDelivered = receiverEvents.find(
      (e) => e.kind === "test.delivered",
    );

    await runInDurableObject(sender, async (_instance, state) => {
      const senderDelivered = state.storage.sql
        .exec(
          "SELECT id, payload FROM events WHERE kind = 'dispatch.outbound.delivered'",
        )
        .toArray();
      const outbox = state.storage.sql
        .exec(
          "SELECT outbound_event_id, delivered_event_id FROM dispatch_outbox",
        )
        .toArray();

      expect(senderDelivered).toHaveLength(1);
      expect(outbox).toHaveLength(1);
      expect(Number(outbox[0]?.outbound_event_id)).toBe(
        result.outboundEventId,
      );
      expect(Number(outbox[0]?.delivered_event_id)).toBe(
        Number(senderDelivered[0]?.id),
      );

      const payload = JSON.parse(String(senderDelivered[0]?.payload)) as {
        readonly deliveredEventId: number;
      };
      expect(payload.deliveredEventId).toBe(receiverDelivered?.id);
      expect(payload.deliveredEventId).not.toBe(Number(senderDelivered[0]?.id));
    });
  });

  it("receiver dedupes by (sourceScope, idempotencyKey), not outboundEventId", async () => {
    const sender = stubFor("dispatch-sender-dedupe");
    const receiver = stubFor("dispatch-receiver-dedupe");

    const first = await sender.dispatchToScope({
      target: { bindingRef: "peer", scope: "dispatch-receiver-dedupe" },
      event: "test.delivered",
      data: { value: 1 },
      idempotencyKey: "same-intent",
    });
    const second = await sender.dispatchToScope({
      target: { bindingRef: "peer", scope: "dispatch-receiver-dedupe" },
      event: "test.delivered",
      data: { value: 999 },
      idempotencyKey: "same-intent",
    });

    expect(first.outboundEventId).not.toBe(second.outboundEventId);

    const events: LedgerEventRpc[] = await receiver.events();
    const delivered = events.filter((e) => e.kind === "test.delivered");
    const accepted = events.filter((e) => e.kind === "dispatch.inbound.accepted");
    const followups = events.filter((e) => e.kind === "test.followup");

    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.payload).toEqual({ value: 1 });
    expect(accepted).toHaveLength(1);
    expect(followups).toHaveLength(1);

    const acceptedPayload = accepted[0]?.payload as {
      readonly outboundEventId: number;
      readonly idempotencyKey: string;
      readonly deliveredEventId: number;
    };
    expect(acceptedPayload.outboundEventId).toBe(first.outboundEventId);
    expect(acceptedPayload.idempotencyKey).toBe("same-intent");
    expect(acceptedPayload.deliveredEventId).toBe(delivered[0]?.id);
  });

  it("preserves app payload exactly; dispatch metadata stays only in dispatch.inbound.accepted", async () => {
    const sender = stubFor("dispatch-sender-payload");
    const receiver = stubFor("dispatch-receiver-payload");
    const data = { nested: { a: 1 }, list: ["x", "y"] };

    const { outboundEventId } = await sender.dispatchToScope({
      target: { bindingRef: "peer", scope: "dispatch-receiver-payload" },
      event: "test.delivered",
      data,
      idempotencyKey: "payload-intent",
    });

    const events: LedgerEventRpc[] = await receiver.events();
    const deliveredPayload = payloadOf<typeof data>(events, "test.delivered");
    const inboundPayload = payloadOf<{
      readonly sourceScope: string;
      readonly outboundEventId: number;
      readonly idempotencyKey: string;
      readonly deliveredEventId: number;
    }>(events, "dispatch.inbound.accepted");

    expect(deliveredPayload).toEqual(data);
    expect(deliveredPayload).not.toHaveProperty("sourceScope");
    expect(deliveredPayload).not.toHaveProperty("outboundEventId");
    expect(inboundPayload).toEqual({
      sourceScope: "dispatch-sender-payload",
      outboundEventId,
      idempotencyKey: "payload-intent",
      deliveredEventId: events.find((e) => e.kind === "test.delivered")?.id,
    });
  });

  it("carries traceContext verbatim on outbound and inbound metadata rows", async () => {
    const sender = stubFor("dispatch-sender-trace");
    const receiver = stubFor("dispatch-receiver-trace");
    const traceContext = {
      traceparent:
        "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
      tracestate: "vendor=value",
    };

    const { outboundEventId } = await sender.dispatchToScope({
      target: { bindingRef: "peer", scope: "dispatch-receiver-trace" },
      event: "test.delivered",
      data: { message: "trace" },
      idempotencyKey: "trace-intent",
      traceContext,
    });

    await runInDurableObject(sender, async (_instance, state) => {
      const rows = state.storage.sql
        .exec(
          "SELECT payload FROM events WHERE kind = 'dispatch.outbound.requested'",
        )
        .toArray();
      expect(rows).toHaveLength(1);
      const payload = JSON.parse(String(rows[0]?.payload)) as {
        readonly traceContext?: unknown;
      };
      expect(payload.traceContext).toEqual(traceContext);
    });

    const receiverEvents: LedgerEventRpc[] = await receiver.events();
    const delivered = receiverEvents.find((e) => e.kind === "test.delivered");
    const inbound = receiverEvents.find(
      (e) => e.kind === "dispatch.inbound.accepted",
    );
    expect(delivered?.payload).toEqual({ message: "trace" });
    expect(inbound?.payload).toEqual({
      sourceScope: "dispatch-sender-trace",
      outboundEventId,
      idempotencyKey: "trace-intent",
      deliveredEventId: delivered?.id,
      traceContext,
    });
  });

  it("fires receiver on() after commit for app event only", async () => {
    const sender = stubFor("dispatch-sender-fire");
    const receiver = stubFor("dispatch-receiver-fire");

    await sender.dispatchToScope({
      target: { bindingRef: "peer", scope: "dispatch-receiver-fire" },
      event: "test.delivered",
      data: { message: "react" },
      idempotencyKey: "fire-intent",
    });

    const events: LedgerEventRpc[] = await receiver.events();
    const delivered = events.find((e) => e.kind === "test.delivered");
    const followup = events.find((e) => e.kind === "test.followup");

    expect(delivered).toBeDefined();
    expect(followup?.payload).toEqual({
      sourceId: delivered?.id,
      sourcePayload: { message: "react" },
    });
    expect(
      events.filter((e) => e.kind === "dispatch.inbound.handler_fired"),
    ).toHaveLength(0);
  });

  it("rejects missing bindingRef as config error before writing sender facts", async () => {
    const sender = stubFor("dispatch-sender-missing-binding");

    await runInDurableObject(sender, async (instance, state) => {
      const rpc = instance as unknown as DispatchRpc;
      let caught: { _tag?: string; bindingRef?: string } | undefined;
      try {
        await rpc.dispatchToScope({
          target: { bindingRef: "missing", scope: "irrelevant" },
          event: "test.delivered",
          data: {},
          idempotencyKey: "missing-intent",
        });
      } catch (e) {
        caught = e as { _tag?: string; bindingRef?: string };
      }

      expect(caught?._tag).toBe("agent_os.dispatch_target_not_found");
      expect(caught?.bindingRef).toBe("missing");

      const events = rowsOrEmpty(state, "SELECT * FROM events");
      const outbox = rowsOrEmpty(state, "SELECT * FROM dispatch_outbox");
      expect(events).toHaveLength(0);
      expect(outbox).toHaveLength(0);
    });
  });

  it("rejects reserved event kinds before writing sender facts", async () => {
    const sender = stubFor("dispatch-sender-reserved");

    await runInDurableObject(sender, async (instance, state) => {
      const rpc = instance as unknown as DispatchRpc;
      let caught: { _tag?: string; event?: string } | undefined;
      try {
        await rpc.dispatchToScope({
          target: { bindingRef: "peer", scope: "any" },
          event: "dispatch.consumed",
          data: {},
          idempotencyKey: "reserved-intent",
        });
      } catch (e) {
        caught = e as { _tag?: string; event?: string };
      }

      expect(caught?._tag).toBe("agent_os.reserved_event_kind");
      expect(caught?.event).toBe("dispatch.consumed");

      const events = rowsOrEmpty(state, "SELECT * FROM events");
      const outbox = rowsOrEmpty(state, "SELECT * FROM dispatch_outbox");
      expect(events).toHaveLength(0);
      expect(outbox).toHaveLength(0);
    });
  });

  it("failed first delivery logs failure and leaves retryable sender state", async () => {
    const sender = stubFor("dispatch-sender-failed");

    const { outboundEventId } = await sender.dispatchToScope({
      target: { bindingRef: "dead", scope: "dispatch-dead-target" },
      event: "test.delivered",
      data: { message: "will fail" },
      idempotencyKey: "dead-intent",
    });

    await runInDurableObject(sender, async (_instance, state) => {
      const failed = state.storage.sql
        .exec(
          "SELECT payload FROM events WHERE kind = 'dispatch.outbound.failed'",
        )
        .toArray();
      expect(failed).toHaveLength(1);
      const payload = JSON.parse(String(failed[0]?.payload)) as {
        readonly outboundEventId: number;
        readonly attempt: number;
        readonly nextAttemptAt: number;
        readonly error: string;
      };
      expect(payload.outboundEventId).toBe(outboundEventId);
      expect(payload.attempt).toBe(1);
      expect(payload.nextAttemptAt).toBeGreaterThan(Date.now() - 1_000);
      expect(payload.error).toContain("dead dispatch target");

      const outbox = state.storage.sql
        .exec(
          "SELECT outbound_event_id, delivered_event_id, attempts, next_attempt_at, last_error FROM dispatch_outbox",
        )
        .toArray();
      expect(outbox).toHaveLength(1);
      expect(Number(outbox[0]?.outbound_event_id)).toBe(outboundEventId);
      expect(outbox[0]?.delivered_event_id).toBeNull();
      expect(Number(outbox[0]?.attempts)).toBe(1);
      expect(Number(outbox[0]?.next_attempt_at)).toBe(payload.nextAttemptAt);
      expect(String(outbox[0]?.last_error)).toContain("dead dispatch target");
    });
  });
});
