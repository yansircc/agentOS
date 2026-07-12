import { describe, expect, it } from "@effect/vitest";
import type { LedgerEvent } from "@agent-os/core/types";
import { RUNTIME_FACT_OWNER } from "@agent-os/core/runtime-protocol";
import {
  createLocalRuntimeLedgerSnapshotSseResponse,
  encodeLocalRuntimeLedgerSnapshotSse,
} from "@agent-os/runtime/local";

const event = (id: number, kind: string): LedgerEvent => ({
  id,
  ts: 1_700_000_000_000 + id,
  kind,
  scopeRef: { kind: "session", scopeId: "local-snapshot-sse" },
  effectAuthorityRef: { authorityClass: "effect", authorityId: "local-snapshot-sse" },
  factOwnerRef: RUNTIME_FACT_OWNER,
  payload: { id },
});

describe("local runtime ledger snapshot SSE", () => {
  it("encodes finite ledger frames with SSE ids and raw ledger JSON", () => {
    const body = encodeLocalRuntimeLedgerSnapshotSse([
      event(1, "agent.run.started"),
      event(2, "agent.run.completed"),
    ]);

    expect(body).toContain("id: 1\nevent: ledger\n");
    expect(body).toContain('data: {"id":1,');
    expect(body).toContain('"kind":"agent.run.started"');
    expect(body).toContain("id: 2\nevent: ledger\n");
    expect(body).toContain('"kind":"agent.run.completed"');
    expect(body).not.toContain("keepalive");
    expect(body).not.toContain("connected");
  });

  it("applies snapshot cursor queries without live or polling semantics", async () => {
    const source = [
      event(1, "agent.run.started"),
      event(2, "llm.requested"),
      event(3, "agent.run.completed"),
    ];

    const response = createLocalRuntimeLedgerSnapshotSseResponse(source, {
      query: { afterId: 1 },
    });
    const text = await response.text();

    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(text).not.toContain("id: 1\n");
    expect(text).toContain("id: 2\n");
    expect(text).toContain("id: 3\n");
    expect(text.endsWith("\n\n")).toBe(true);
  });

  it("passes cursor queries to runtime-backed sources", () => {
    let observedQuery: unknown;
    const source = (query: unknown) => {
      observedQuery = query;
      return [event(4, "agent.run.completed")];
    };

    const body = encodeLocalRuntimeLedgerSnapshotSse(source, { afterId: 3 });

    expect(observedQuery).toEqual({ afterId: 3 });
    expect(body).toContain("id: 4\n");
  });
});
