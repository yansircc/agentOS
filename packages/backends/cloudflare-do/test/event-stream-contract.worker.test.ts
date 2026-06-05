import type { LedgerEventRpc, StreamEventsOptions } from "@agent-os/kernel/types";
import type { BackendProtocolTruthIdentity } from "@agent-os/backend-protocol";
/**
 * Ledger event stream — deterministic contract tests.
 *
 * Validates contract:
 *   - events(opts) is the cursor/filter/limit snapshot read;
 *   - streamEvents(opts) emits SSE frames whose wire is LedgerEventRpc;
 *   - stream tail is not routed through app on() handler semantics;
 *   - Last-Event-ID parsing stays in Worker fetch integration.
 */

import { SELF, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { EventQueryOptions } from "@agent-os/kernel/types";
import type { StreamTestDO } from "./test-worker";
import { testTruthIdentity } from "./_identity";

interface TestEnv {
  readonly STREAM_DO: DurableObjectNamespace<StreamTestDO>;
}

interface StreamRpc {
  readonly emitEvent: (spec: {
    readonly event: string;
    readonly data: unknown;
  }) => Promise<{ id: number }>;
  readonly events: (
    identity: BackendProtocolTruthIdentity,
    opts?: EventQueryOptions,
  ) => Promise<ReadonlyArray<LedgerEventRpc>>;
  readonly streamEvents: (
    identity: BackendProtocolTruthIdentity,
    opts?: StreamEventsOptions,
  ) => Promise<Response>;
}

interface SseFrame {
  readonly raw: string;
  readonly id?: string;
  readonly event?: string;
  readonly data?: string;
}

const testEnv = env as unknown as TestEnv;

const stubFor = (scope: string): StreamRpc =>
  testEnv.STREAM_DO.get(testEnv.STREAM_DO.idFromName(scope)) as unknown as StreamRpc;

const withStreamDO = <A>(
  scope: string,
  f: (instance: StreamRpc, identity: BackendProtocolTruthIdentity) => Promise<A>,
): Promise<A> => {
  const stub = testEnv.STREAM_DO.get(testEnv.STREAM_DO.idFromName(scope));
  return runInDurableObject(stub, (instance) =>
    f(instance as unknown as StreamRpc, testTruthIdentity(scope)),
  );
};

const parseFrame = (raw: string): SseFrame => {
  let id: string | undefined;
  let event: string | undefined;
  let data: string | undefined;
  for (const line of raw.split("\n")) {
    if (line.startsWith("id: ")) id = line.slice(4);
    else if (line.startsWith("event: ")) event = line.slice(7);
    else if (line.startsWith("data: ")) data = line.slice(6);
  }
  return { raw, id, event, data };
};

const readFrames = async (
  response: Response,
  accept: (frame: SseFrame) => boolean,
  count: number,
  timeoutMs = 1_000,
): Promise<ReadonlyArray<SseFrame>> => {
  if (response.body === null) {
    throw new Error("stream response missing body");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const accepted: SseFrame[] = [];
  let buffer = "";
  const deadline = Date.now() + timeoutMs;

  try {
    while (accepted.length < count) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(`timed out waiting for ${count} SSE frame(s)`);
      }
      const read = await Promise.race([
        reader.read(),
        new Promise<ReadableStreamReadResult<Uint8Array>>((resolve) =>
          setTimeout(() => resolve({ done: true, value: undefined }), remaining),
        ),
      ]);
      if (read.done) {
        throw new Error(`stream ended before ${count} SSE frame(s)`);
      }
      buffer += decoder.decode(read.value, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const raw = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const frame = parseFrame(raw);
        if (accept(frame)) accepted.push(frame);
        boundary = buffer.indexOf("\n\n");
      }
    }
    return accepted;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
};

const readLedgerRows = async (
  response: Response,
  count: number,
  timeoutMs = 1_000,
): Promise<ReadonlyArray<LedgerEventRpc>> => {
  const frames = await readFrames(
    response,
    (frame) => frame.event === "ledger" && frame.data !== undefined,
    count,
    timeoutMs,
  );
  return frames.map((frame) => JSON.parse(frame.data ?? "{}") as LedgerEventRpc);
};

describe("ledger event stream — contract", () => {
  it("events(opts) snapshots by cursor, limit, and exact kind set", async () => {
    await withStreamDO("stream-events-snapshot", async (stub, identity) => {
      const first = await stub.emitEvent({ event: "A", data: { n: 1 } });
      await stub.emitEvent({ event: "B", data: { n: 2 } });
      await stub.emitEvent({ event: "C", data: { n: 3 } });

      const allKinds: string[] = (await stub.events(identity)).map((e) => e.kind);
      const afterFirstKinds: string[] = (await stub.events(identity, { afterId: first.id })).map(
        (e) => e.kind,
      );
      const limitedKinds: string[] = (await stub.events(identity, { limit: 2 })).map((e) => e.kind);
      const filteredKinds: string[] = (await stub.events(identity, { kinds: ["A", "C"] })).map(
        (e) => e.kind,
      );

      expect(allKinds).toEqual(["A", "B", "C"]);
      expect(afterFirstKinds).toEqual(["B", "C"]);
      expect(limitedKinds).toEqual(["A", "B"]);
      expect(filteredKinds).toEqual(["A", "C"]);
    });
  });

  it("streams existing snapshot rows as closed LedgerEventRpc SSE wire", async () => {
    await withStreamDO("stream-snapshot-wire", async (stub, identity) => {
      const first = await stub.emitEvent({
        event: "snapshot.one",
        data: { value: 1 },
      });
      const second = await stub.emitEvent({
        event: "snapshot.two",
        data: { value: 2 },
      });

      const response = await stub.streamEvents(identity, {
        afterId: 0,
        heartbeatMs: 1_000,
      });
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      const frames = await readFrames(response, (frame) => frame.event === "ledger", 2);
      expect(frames.map((frame) => frame.id)).toEqual([String(first.id), String(second.id)]);
      expect(frames.map((frame) => frame.event)).toEqual(["ledger", "ledger"]);
      expect(frames.map((frame) => JSON.parse(frame.data ?? "{}"))).toEqual([
        {
          id: first.id,
          ts: expect.any(Number),
          kind: "snapshot.one",
          scopeRef: identity.scopeRef,
          effectAuthorityRef: identity.effectAuthorityRef,
          factOwnerRef: "@agent-os/runtime",
          payload: { value: 1 },
        },
        {
          id: second.id,
          ts: expect.any(Number),
          kind: "snapshot.two",
          scopeRef: identity.scopeRef,
          effectAuthorityRef: identity.effectAuthorityRef,
          factOwnerRef: "@agent-os/runtime",
          payload: { value: 2 },
        },
      ]);
    });
  });

  it("resumes from afterId without overlap", async () => {
    await withStreamDO("stream-cursor", async (stub, identity) => {
      await stub.emitEvent({ event: "cursor.one", data: {} });
      const second = await stub.emitEvent({ event: "cursor.two", data: {} });
      await stub.emitEvent({ event: "cursor.three", data: {} });

      const rows = await readLedgerRows(
        await stub.streamEvents(identity, { afterId: second.id }),
        1,
      );
      expect(rows.map((row) => row.kind)).toEqual(["cursor.three"]);
    });
  });

  it("live-tails rows emitted after stream open", async () => {
    await withStreamDO("stream-live-tail", async (stub, identity) => {
      const response = await stub.streamEvents(identity, { heartbeatMs: 1_000 });

      await stub.emitEvent({ event: "live.one", data: { n: 1 } });
      await stub.emitEvent({ event: "live.two", data: { n: 2 } });
      await stub.emitEvent({ event: "live.three", data: { n: 3 } });

      const rows = await readLedgerRows(response, 3);
      expect(rows.map((row) => row.kind)).toEqual(["live.one", "live.two", "live.three"]);
    });
  });

  it("hands off from snapshot to live tail without duplicate rows", async () => {
    await withStreamDO("stream-snapshot-live-handoff", async (stub, identity) => {
      await stub.emitEvent({ event: "handoff.snapshot", data: {} });
      const response = await stub.streamEvents(identity, { heartbeatMs: 1_000 });

      await stub.emitEvent({ event: "handoff.live", data: {} });

      const rows = await readLedgerRows(response, 2);
      expect(rows.map((row) => row.kind)).toEqual(["handoff.snapshot", "handoff.live"]);
    });
  });

  it("filters stream rows by exact kind set; empty kinds means all kinds", async () => {
    await withStreamDO("stream-filter", async (stub, identity) => {
      await stub.emitEvent({ event: "A", data: {} });
      await stub.emitEvent({ event: "B", data: {} });
      await stub.emitEvent({ event: "C", data: {} });

      const filtered = await readLedgerRows(
        await stub.streamEvents(identity, { kinds: ["A", "C"] }),
        2,
      );
      expect(filtered.map((row) => row.kind)).toEqual(["A", "C"]);

      const all = await readLedgerRows(await stub.streamEvents(identity, { kinds: [] }), 3);
      expect(all.map((row) => row.kind)).toEqual(["A", "B", "C"]);
    });
  });

  it("emits heartbeat comment frames", async () => {
    await withStreamDO("stream-heartbeat", async (stub, identity) => {
      const frames = await readFrames(
        await stub.streamEvents(identity, { heartbeatMs: 30 }),
        (frame) => frame.raw.startsWith(":"),
        3,
        500,
      );
      expect(frames.every((frame) => frame.raw === ": keepalive")).toBe(true);
    });
  });

  it("stream sink runs outside app on() handler delay", async () => {
    await withStreamDO("stream-outside-app-handler", async (stub, identity) => {
      const response = await stub.streamEvents(identity, { heartbeatMs: 1_000 });
      const pendingEmit = stub.emitEvent({
        event: "stream.slow",
        data: { value: "visible-before-handler-finishes" },
      });

      const rows = await readLedgerRows(response, 1, 300);
      expect(rows[0]?.kind).toBe("stream.slow");
      await pendingEmit;
    });
  });

  it("Worker fetch integration parses Last-Event-ID into afterId", async () => {
    const scope = "stream-worker-reconnect";
    const stub = stubFor(scope);
    await stub.emitEvent({ event: "worker.one", data: {} });
    const second = await stub.emitEvent({ event: "worker.two", data: {} });
    await stub.emitEvent({ event: "worker.three", data: {} });

    const response = await SELF.fetch(`https://test.local/stream/${scope}`, {
      headers: { "Last-Event-ID": String(second.id) },
    });
    const rows = await readLedgerRows(response, 1);
    expect(rows.map((row) => row.kind)).toEqual(["worker.three"]);
  });

  it("Worker fetch integration treats invalid Last-Event-ID as fresh stream", async () => {
    const scope = "stream-worker-invalid-cursor";
    const stub = stubFor(scope);
    await stub.emitEvent({ event: "worker.first", data: {} });

    const response = await SELF.fetch(`https://test.local/stream/${scope}`, {
      headers: { "Last-Event-ID": "not-a-number" },
    });
    const rows = await readLedgerRows(response, 1);
    expect(rows.map((row) => row.kind)).toEqual(["worker.first"]);
  });
});
