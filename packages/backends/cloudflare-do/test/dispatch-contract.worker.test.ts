import type {
  DispatchToScopeSpec,
  LedgerEventRpc,
  StreamEventsOptions,
} from "@agent-os/kernel/types";
import type {
  BackendProtocolTruthIdentity,
  DispatchTargetAdapter,
} from "@agent-os/backend-protocol";
/**
 * dispatchToScope — deterministic contract tests.
 *
 * Validates P1 of contract:
 *   - sender outbound event + dispatch_outbox row are atomic mechanics;
 *   - receiver writes dispatch.inbound.accepted + app event in one tx;
 *   - receiver dedupe SSoT is (sourceScope, idempotencyKey);
 *   - app payload is not wrapped with dispatch metadata;
 *   - failed delivery remains retryable instead of disappearing.
 */

import { SELF, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { DispatchToScopeResult } from "@agent-os/kernel/types";
import { validateEffectClaim } from "@agent-os/kernel/effect-claim";
import {
  DELIVERY_RETRY_TRIGGER_KIND,
  DISPATCH_RETRY_POLICY,
  dispatchLedgerDeliveryReceipt,
  dispatchReplaySnapshotFromDeliveredPayload,
  replayDispatchDeliveryFromSnapshot,
} from "@agent-os/backend-protocol";
import {
  bindingMaterialRef,
  materialRefKey,
  type BindingMaterialRef,
} from "@agent-os/kernel/material-ref";
import { sqlText } from "../src/storage/sql-row";
import { cloudflareRouteKeyFromScopeRef } from "../src/ledger/identity";
import type { DispatchTestDO } from "./test-worker";

interface TestEnv {
  readonly DISPATCH_DO: DurableObjectNamespace<DispatchTestDO>;
}

const testEnv = env as unknown as TestEnv;

interface DispatchRpc {
  readonly dispatchToScope: (spec: DispatchToScopeSpec) => Promise<DispatchToScopeResult>;
  readonly emitEvent: (spec: { event: string; data: unknown }) => Promise<{ id: number }>;
  readonly events: (
    identity: BackendProtocolTruthIdentity,
    opts?: StreamEventsOptions,
  ) => Promise<LedgerEventRpc[]>;
  readonly streamEvents: (
    identity: BackendProtocolTruthIdentity,
    opts?: StreamEventsOptions,
  ) => Promise<Response>;
}

const stubFor = (scope: string): DurableObjectStub<DispatchTestDO> & DispatchRpc =>
  testEnv.DISPATCH_DO.get(
    testEnv.DISPATCH_DO.idFromName(scope),
  ) as DurableObjectStub<DispatchTestDO> & DispatchRpc;

const dispatchTargetMaterializationCount = async (): Promise<number> => {
  const response = await SELF.fetch("https://test.local/dispatch-target-materializations");
  const body = (await response.json()) as { readonly count?: unknown };
  return typeof body.count === "number" ? body.count : Number.NaN;
};

const dispatchBindingRef = (ref: string): BindingMaterialRef =>
  bindingMaterialRef({
    provider: "cloudflare",
    bindingKind: "durable_object",
    ref,
  });

const peerBindingRef = dispatchBindingRef("peer");
const genericBindingRef = dispatchBindingRef("generic");
const peerBindingKey = materialRefKey(peerBindingRef);

const truthFor = (scope: string): BackendProtocolTruthIdentity => ({
  scopeRef: { kind: "conversation" as const, scopeId: scope },
  effectAuthorityRef: { authorityClass: "effect", authorityId: scope },
});

const targetFor = (scope: string, bindingRef = peerBindingRef) => ({
  bindingRef,
  ...truthFor(scope),
});

const routeKeyFor = (scope: string): string =>
  cloudflareRouteKeyFromScopeRef(truthFor(scope).scopeRef);

const dispatchOperationRef = (source: string, bindingKey: string, target: string, intent: string) =>
  `dispatch:${source}:${encodeURIComponent(bindingKey)}:${target}:${intent}`;

const payloadOf = <T>(events: ReadonlyArray<LedgerEventRpc>, kind: string): T =>
  events.find((e) => e.kind === kind)?.payload as T;

interface SseFrame {
  readonly event?: string;
  readonly data?: string;
}

const parseFrame = (raw: string): SseFrame => {
  let event: string | undefined;
  let data: string | undefined;
  for (const line of raw.split("\n")) {
    if (line.startsWith("event: ")) event = line.slice(7);
    else if (line.startsWith("data: ")) data = line.slice(6);
  }
  return { event, data };
};

const readLedgerRows = async (
  response: Response,
  count: number,
  timeoutMs = 1_000,
): Promise<ReadonlyArray<LedgerEventRpc>> => {
  if (response.body === null) throw new Error("stream response missing body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const rows: LedgerEventRpc[] = [];
  let buffer = "";
  const deadline = Date.now() + timeoutMs;
  try {
    while (rows.length < count) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`timed out waiting for ${count} ledger row(s)`);
      const read = await Promise.race([
        reader.read(),
        new Promise<ReadableStreamReadResult<Uint8Array>>((resolve) =>
          setTimeout(() => resolve({ done: true, value: undefined }), remaining),
        ),
      ]);
      if (read.done) throw new Error(`stream ended before ${count} ledger row(s)`);
      buffer += decoder.decode(read.value, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const frame = parseFrame(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
        if (frame.event === "ledger" && frame.data !== undefined) {
          rows.push(JSON.parse(frame.data) as LedgerEventRpc);
        }
        boundary = buffer.indexOf("\n\n");
      }
    }
    return rows;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
};

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
  it("replay mode live dispatch adapter not called when delivery receipt snapshot is present", async () => {
    let liveDispatchAdapterCalled = false;
    const liveDispatchAdapter: DispatchTargetAdapter = {
      deliver: () => {
        liveDispatchAdapterCalled = true;
        return Promise.reject(new Error("live dispatch should not be called in replay"));
      },
    };
    const deliveryReceipt = dispatchLedgerDeliveryReceipt({
      targetScope: "dispatch-replay-receiver",
      deliveredEventId: 42,
    });

    const replayed = replayDispatchDeliveryFromSnapshot(
      dispatchReplaySnapshotFromDeliveredPayload({
        outboundEventId: 7,
        target: targetFor("dispatch-replay-receiver", peerBindingRef),
        event: "test.delivered",
        idempotencyKey: "dispatch-replay",
        deliveryReceipt,
        attempt: 1,
      }),
    );

    expect(replayed).toEqual({ receipt: deliveryReceipt });
    expect(liveDispatchAdapterCalled).toBe(false);
    expect(liveDispatchAdapter.deliver).toBeDefined();
  });

  it("materializes dispatch targets once per DO instance", async () => {
    const before = await dispatchTargetMaterializationCount();
    const sender = stubFor("dispatch-target-snapshot");

    await sender.events(truthFor("dispatch-target-snapshot"));
    await sender.events(truthFor("dispatch-target-snapshot"));
    await sender.dispatchToScope({
      target: targetFor("dispatch-target-snapshot-dead", dispatchBindingRef("dead")),
      event: "test.delivered",
      data: { message: "dead target still uses snapshot" },
      idempotencyKey: "snapshot-intent",
    });

    const after = await dispatchTargetMaterializationCount();
    expect(after).toBe(before + 1);
  });

  it("commits sender outbound event and dispatch_outbox row in one transaction", async () => {
    const sender = stubFor("dispatch-sender-atomic");
    const receiver = stubFor("dispatch-receiver-atomic");

    const result = await sender.dispatchToScope({
      target: targetFor("dispatch-receiver-atomic"),
      event: "test.delivered",
      data: { message: "hello" },
      idempotencyKey: "intent-1",
    });

    expect(result.outboundEventId).toBeGreaterThanOrEqual(1);

    await runInDurableObject(sender, async (_instance, state) => {
      const outbound = state.storage.sql
        .exec("SELECT id, kind, payload FROM events WHERE kind = 'dispatch.outbound.requested'")
        .toArray();
      const outbox = state.storage.sql
        .exec("SELECT outbound_event_id, success_event_id FROM dispatch_outbox")
        .toArray();
      const outboundDelivered = state.storage.sql
        .exec("SELECT id, payload FROM events WHERE kind = 'dispatch.outbound.delivered'")
        .toArray();

      expect(outbound).toHaveLength(1);
      expect(outbox).toHaveLength(1);
      expect(outboundDelivered).toHaveLength(1);
      expect(Number(outbound[0]?.id)).toBe(result.outboundEventId);
      expect(Number(outbox[0]?.outbound_event_id)).toBe(result.outboundEventId);
      expect(Number(outbox[0]?.success_event_id)).toBe(Number(outboundDelivered[0]?.id));
      const payload = JSON.parse(sqlText(outbound[0]?.payload, "events.payload")) as {
        readonly claim: unknown;
      };
      expect(payload).toEqual({
        target: targetFor("dispatch-receiver-atomic"),
        event: "test.delivered",
        data: { message: "hello" },
        idempotencyKey: "intent-1",
        retryPolicy: DISPATCH_RETRY_POLICY,
        claim: expect.objectContaining({
          phase: "pre",
          operationRef: dispatchOperationRef(
            "dispatch-sender-atomic",
            peerBindingKey,
            routeKeyFor("dispatch-receiver-atomic"),
            "intent-1",
          ),
          scopeRef: {
            kind: "conversation",
            scopeId: "dispatch-receiver-atomic",
          },
          effectAuthorityRef: {
            authorityClass: "effect",
            authorityId: "dispatch-receiver-atomic",
          },
          originRef: {
            originId: "dispatch-sender-atomic",
            originKind: "agent_do",
          },
        }),
      });
      expect(validateEffectClaim(payload.claim).ok).toBe(true);
    });

    const receiverEvents: LedgerEventRpc[] = await receiver.events(
      truthFor("dispatch-receiver-atomic"),
    );
    expect(receiverEvents.some((e) => e.kind === "test.delivered")).toBe(true);
  });

  it("routes durable object dispatch by MaterialRef shape, not helper choice", async () => {
    const sender = stubFor("dispatch-generic-binding-sender");
    const receiver = stubFor("dispatch-generic-binding-receiver");

    const result = await sender.dispatchToScope({
      target: targetFor("dispatch-generic-binding-receiver", genericBindingRef),
      event: "test.delivered",
      data: { message: "generic binding target" },
      idempotencyKey: "generic-binding-target",
    });

    expect(result.outboundEventId).toBeGreaterThan(0);
    const receiverEvents = await receiver.events(truthFor("dispatch-generic-binding-receiver"));
    expect(receiverEvents.some((event) => event.kind === "test.delivered")).toBe(true);
  });

  it("keeps outbox delivered FK local when receiver ledger ids diverge", async () => {
    const sender = stubFor("dispatch-sender-diverged-ledger");
    const receiver = stubFor("dispatch-receiver-diverged-ledger");

    await receiver.emitEvent({
      event: "test.seed",
      data: { purpose: "make receiver ids diverge" },
    });

    const result = await sender.dispatchToScope({
      target: targetFor("dispatch-receiver-diverged-ledger"),
      event: "test.delivered",
      data: { message: "cross-ledger" },
      idempotencyKey: "diverged-intent",
    });

    const receiverEvents: LedgerEventRpc[] = await receiver.events(
      truthFor("dispatch-receiver-diverged-ledger"),
    );
    const receiverDelivered = receiverEvents.find((e) => e.kind === "test.delivered");

    await runInDurableObject(sender, async (_instance, state) => {
      const senderDelivered = state.storage.sql
        .exec("SELECT id, payload FROM events WHERE kind = 'dispatch.outbound.delivered'")
        .toArray();
      const outbox = state.storage.sql
        .exec("SELECT outbound_event_id, success_event_id FROM dispatch_outbox")
        .toArray();

      expect(senderDelivered).toHaveLength(1);
      expect(outbox).toHaveLength(1);
      expect(Number(outbox[0]?.outbound_event_id)).toBe(result.outboundEventId);
      expect(Number(outbox[0]?.success_event_id)).toBe(Number(senderDelivered[0]?.id));

      const payload = JSON.parse(sqlText(senderDelivered[0]?.payload, "events.payload")) as {
        readonly deliveryReceipt: unknown;
      };
      expect(payload.deliveryReceipt).toEqual(
        dispatchLedgerDeliveryReceipt({
          targetScope: "dispatch-receiver-diverged-ledger",
          deliveredEventId: Number(receiverDelivered?.id),
        }),
      );
    });
  });

  it("receiver dedupes by (sourceScope, idempotencyKey), not outboundEventId", async () => {
    const sender = stubFor("dispatch-sender-dedupe");
    const receiver = stubFor("dispatch-receiver-dedupe");

    const first = await sender.dispatchToScope({
      target: targetFor("dispatch-receiver-dedupe"),
      event: "test.delivered",
      data: { value: 1 },
      idempotencyKey: "same-intent",
    });
    const second = await sender.dispatchToScope({
      target: targetFor("dispatch-receiver-dedupe"),
      event: "test.delivered",
      data: { value: 999 },
      idempotencyKey: "same-intent",
    });

    expect(first.outboundEventId).not.toBe(second.outboundEventId);

    const events: LedgerEventRpc[] = await receiver.events(truthFor("dispatch-receiver-dedupe"));
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
      target: targetFor("dispatch-receiver-payload"),
      event: "test.delivered",
      data,
      idempotencyKey: "payload-intent",
    });

    const events: LedgerEventRpc[] = await receiver.events(truthFor("dispatch-receiver-payload"));
    const deliveredPayload = payloadOf<typeof data>(events, "test.delivered");
    const inboundPayload = payloadOf<{
      readonly sourceScope: string;
      readonly outboundEventId: number;
      readonly idempotencyKey: string;
      readonly deliveredEventId: number;
      readonly claim: unknown;
    }>(events, "dispatch.inbound.accepted");

    expect(deliveredPayload).toEqual(data);
    expect(deliveredPayload).not.toHaveProperty("sourceScope");
    expect(deliveredPayload).not.toHaveProperty("outboundEventId");
    expect(inboundPayload).toEqual({
      sourceScope: "dispatch-sender-payload",
      outboundEventId,
      idempotencyKey: "payload-intent",
      deliveredEventId: events.find((e) => e.kind === "test.delivered")?.id,
      claim: expect.objectContaining({
        phase: "lived",
        operationRef: dispatchOperationRef(
          "dispatch-sender-payload",
          peerBindingKey,
          routeKeyFor("dispatch-receiver-payload"),
          "payload-intent",
        ),
        anchorRef: expect.objectContaining({
          anchorKind: "ledger_event",
        }),
      }),
    });
    expect(validateEffectClaim(inboundPayload.claim).ok).toBe(true);
  });

  it("carries traceContext verbatim on outbound and inbound metadata rows", async () => {
    const sender = stubFor("dispatch-sender-trace");
    const receiver = stubFor("dispatch-receiver-trace");
    const traceContext = {
      traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
      tracestate: "vendor=value",
    };

    const { outboundEventId } = await sender.dispatchToScope({
      target: targetFor("dispatch-receiver-trace"),
      event: "test.delivered",
      data: { message: "trace" },
      idempotencyKey: "trace-intent",
      traceContext,
    });

    await runInDurableObject(sender, async (_instance, state) => {
      const rows = state.storage.sql
        .exec("SELECT payload FROM events WHERE kind = 'dispatch.outbound.requested'")
        .toArray();
      expect(rows).toHaveLength(1);
      const payload = JSON.parse(sqlText(rows[0]?.payload, "events.payload")) as {
        readonly traceContext?: unknown;
      };
      expect(payload.traceContext).toEqual(traceContext);
    });

    const receiverEvents: LedgerEventRpc[] = await receiver.events(
      truthFor("dispatch-receiver-trace"),
    );
    const delivered = receiverEvents.find((e) => e.kind === "test.delivered");
    const inbound = receiverEvents.find((e) => e.kind === "dispatch.inbound.accepted");
    expect(delivered?.payload).toEqual({ message: "trace" });
    expect(inbound?.payload).toEqual({
      sourceScope: "dispatch-sender-trace",
      outboundEventId,
      idempotencyKey: "trace-intent",
      deliveredEventId: delivered?.id,
      claim: expect.objectContaining({
        phase: "lived",
        operationRef: dispatchOperationRef(
          "dispatch-sender-trace",
          peerBindingKey,
          routeKeyFor("dispatch-receiver-trace"),
          "trace-intent",
        ),
      }),
      traceContext,
    });
  });

  it("fires receiver on() after commit for every inserted dispatch row", async () => {
    const sender = stubFor("dispatch-sender-fire");
    const receiver = stubFor("dispatch-receiver-fire");

    await sender.dispatchToScope({
      target: targetFor("dispatch-receiver-fire"),
      event: "test.delivered",
      data: { message: "react" },
      idempotencyKey: "fire-intent",
    });

    const events: LedgerEventRpc[] = await receiver.events(truthFor("dispatch-receiver-fire"));
    const delivered = events.find((e) => e.kind === "test.delivered");
    const followup = events.find((e) => e.kind === "test.followup");

    expect(delivered).toBeDefined();
    expect(followup?.payload).toEqual({
      sourceId: delivered?.id,
      sourcePayload: { message: "react" },
    });
    expect(events.filter((e) => e.kind === "test.inbound_accepted_handler_fired")).toHaveLength(1);
  });

  it("live-streams dispatch internal rows without reconnect and fires outbound handler once", async () => {
    const sender = stubFor("dispatch-sender-stream");
    const receiver = stubFor("dispatch-receiver-stream");
    const senderStream = await sender.streamEvents(truthFor("dispatch-sender-stream"), {
      heartbeatMs: 1_000,
    });
    const receiverStream = await receiver.streamEvents(truthFor("dispatch-receiver-stream"), {
      heartbeatMs: 1_000,
    });

    await sender.dispatchToScope({
      target: targetFor("dispatch-receiver-stream"),
      event: "test.delivered",
      data: { message: "stream" },
      idempotencyKey: "stream-intent",
    });

    const senderRows = await readLedgerRows(senderStream, 3);
    expect(senderRows.map((row) => row.kind)).toEqual([
      "dispatch.outbound.requested",
      "test.outbound_requested_handler_fired",
      "dispatch.outbound.delivered",
    ]);

    const receiverRows = await readLedgerRows(receiverStream, 4);
    expect(receiverRows.map((row) => row.kind)).toEqual([
      "dispatch.inbound.accepted",
      "test.delivered",
      "test.inbound_accepted_handler_fired",
      "test.followup",
    ]);

    const senderEvents: LedgerEventRpc[] = await sender.events(truthFor("dispatch-sender-stream"));
    expect(
      senderEvents.filter((e) => e.kind === "test.outbound_requested_handler_fired"),
    ).toHaveLength(1);
  });

  it("rejects missing bindingRef as config error before writing sender facts", async () => {
    const sender = stubFor("dispatch-sender-missing-binding");
    const missingBindingRef = dispatchBindingRef("missing");
    const missingBindingKey = materialRefKey(missingBindingRef);

    await runInDurableObject(sender, async (instance, state) => {
      const rpc = instance as unknown as DispatchRpc;
      let caught: { _tag?: string; bindingRef?: string } | undefined;
      try {
        await rpc.dispatchToScope({
          target: {
            bindingRef: missingBindingRef,
            ...truthFor("irrelevant"),
          },
          event: "test.delivered",
          data: {},
          idempotencyKey: "missing-intent",
        });
      } catch (e) {
        caught = e as { _tag?: string; bindingRef?: string };
      }

      expect(caught?._tag).toBe("agent_os.dispatch_target_not_found");
      expect(caught?.bindingRef).toBe(missingBindingKey);

      const events = rowsOrEmpty(state, "SELECT * FROM events");
      const outbox = rowsOrEmpty(state, "SELECT * FROM dispatch_outbox");
      expect(events).toHaveLength(0);
      expect(outbox).toHaveLength(0);
    });
  });

  it("rejects malformed bindingRef before writing sender facts", async () => {
    const sender = stubFor("dispatch-sender-malformed-binding");

    await runInDurableObject(sender, async (instance, state) => {
      const rpc = instance as unknown as DispatchRpc;
      let caught: { _tag?: string; position?: string } | undefined;
      try {
        await rpc.dispatchToScope({
          target: {
            bindingRef: "peer",
            ...truthFor("irrelevant"),
          },
          event: "test.delivered",
          data: {},
          idempotencyKey: "malformed-intent",
        } as unknown as DispatchToScopeSpec);
      } catch (e) {
        caught = e as { _tag?: string; position?: string };
      }

      expect(caught).toMatchObject({
        _tag: "agent_os.dispatch_binding_ref_malformed",
        position: "target",
      });

      const events = rowsOrEmpty(state, "SELECT * FROM events");
      const outbox = rowsOrEmpty(state, "SELECT * FROM dispatch_outbox");
      expect(events).toHaveLength(0);
      expect(outbox).toHaveLength(0);
    });
  });

  it("rejects missing target scopeRef instead of inferring from legacy scope strings", async () => {
    const sender = stubFor("dispatch-sender-unsupported-scope");

    await runInDurableObject(sender, async (instance, state) => {
      const rpc = instance as unknown as DispatchRpc;
      let caught: { _tag?: string; scopeId?: string; position?: string } | undefined;
      try {
        await rpc.dispatchToScope({
          target: { bindingRef: peerBindingRef, scope: "agent/name/item" },
          event: "test.delivered",
          data: {},
          idempotencyKey: "unsupported-scope",
        } as unknown as DispatchToScopeSpec);
      } catch (e) {
        caught = e as {
          _tag?: string;
          scopeId?: string;
          position?: string;
        };
      }

      expect(caught).toMatchObject({
        _tag: "agent_os.unsupported_scope_ref",
        scopeId: "malformed",
        position: "target",
      });

      const events = rowsOrEmpty(state, "SELECT * FROM events");
      const outbox = rowsOrEmpty(state, "SELECT * FROM dispatch_outbox");
      expect(events).toHaveLength(0);
      expect(outbox).toHaveLength(0);
    });
  });

  it("rejects claimed event kinds before writing sender facts", async () => {
    const sender = stubFor("dispatch-sender-claimed");

    await runInDurableObject(sender, async (instance, state) => {
      const rpc = instance as unknown as DispatchRpc;
      let caught: { _tag?: string; event?: string } | undefined;
      try {
        await rpc.dispatchToScope({
          target: {
            bindingRef: peerBindingRef,
            ...truthFor("any"),
          },
          event: "llm.response",
          data: {},
          idempotencyKey: "claimed-intent",
        });
      } catch (e) {
        caught = e as { _tag?: string; event?: string };
      }

      expect(caught?._tag).toBe("agent_os.capability_rejected");
      expect(caught?.event).toBe("llm.response");

      const events = rowsOrEmpty(state, "SELECT * FROM events");
      const outbox = rowsOrEmpty(state, "SELECT * FROM dispatch_outbox");
      expect(events).toHaveLength(0);
      expect(outbox).toHaveLength(0);
    });
  });

  it("failed first delivery logs failure and leaves retryable sender state", async () => {
    const sender = stubFor("dispatch-sender-failed");

    const { outboundEventId } = await sender.dispatchToScope({
      target: targetFor("dispatch-dead-target", dispatchBindingRef("dead")),
      event: "test.delivered",
      data: { message: "will fail" },
      idempotencyKey: "dead-intent",
    });

    await runInDurableObject(sender, async (_instance, state) => {
      const failed = state.storage.sql
        .exec("SELECT payload FROM events WHERE kind = 'dispatch.outbound.failed'")
        .toArray();
      expect(failed).toHaveLength(1);
      const payload = JSON.parse(sqlText(failed[0]?.payload, "events.payload")) as {
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
          "SELECT outbound_event_id, success_event_id, attempts, last_error FROM dispatch_outbox",
        )
        .toArray();
      expect(outbox).toHaveLength(1);
      expect(Number(outbox[0]?.outbound_event_id)).toBe(outboundEventId);
      expect(outbox[0]?.success_event_id).toBeNull();
      expect(Number(outbox[0]?.attempts)).toBe(1);
      expect(sqlText(outbox[0]?.last_error, "dispatch_outbox.last_error")).toContain(
        "dead dispatch target",
      );

      const due = state.storage.sql
        .exec(
          "SELECT fire_at, kind, payload, completed_at FROM due_work WHERE completed_at IS NULL",
        )
        .toArray();
      expect(due).toHaveLength(1);
      expect(Number(due[0]?.fire_at)).toBe(payload.nextAttemptAt);
      expect(due[0]?.kind).toBe(DELIVERY_RETRY_TRIGGER_KIND);
      expect(JSON.parse(sqlText(due[0]?.payload, "due_work.payload"))).toEqual({
        intentEventId: outboundEventId,
      });
    });
  });
});
