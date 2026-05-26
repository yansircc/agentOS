import { describe, expect, it } from "vitest";

import {
  projectQuotaState,
  projectResourceState,
  projectRunStatus,
  projectRunTrace,
} from "../src/projections";
import type { LedgerEvent } from "../src/types";

const event = (
  id: number,
  kind: string,
  payload: unknown,
  ts = id * 10,
): LedgerEvent => ({
  id,
  ts,
  kind,
  scope: "projection-scope",
  payload,
});

describe("standard projections — spec-34", () => {
  it("projects run trace and delivered status from run-owned facts", () => {
    const rows = [
      event(1, "agent.run.started", { intent: "x" }),
      event(2, "chat.ingested", { runId: 1, intent: "x", context: {} }),
      event(3, "llm.response", {
        turn: { id: 1, index: 0 },
        text: "use tool",
        toolCalls: [],
        usage: { totalTokens: 3 },
      }),
      event(4, "tool.executed", {
        runId: 1,
        name: "lookup",
        args: "{}",
        result: { ok: true },
      }),
      event(5, "answer.ready", {
        final: "done",
        turn: { id: 1, index: 1 },
      }),
      event(6, "agent.run.completed", { runId: 1, event: "answer.ready" }),
    ];

    expect(projectRunTrace(rows, 1)).toEqual({
      runId: 1,
      startedAt: 10,
      turns: [
        {
          id: 1,
          index: 0,
          at: 30,
          text: "use tool",
          usage: { totalTokens: 3 },
        },
      ],
      toolCalls: [
        {
          at: 40,
          name: "lookup",
          args: "{}",
          result: { ok: true },
        },
      ],
      terminal: {
        kind: "delivered",
        at: 60,
        event: "answer.ready",
        payload: { runId: 1, event: "answer.ready" },
      },
    });
    expect(projectRunStatus(rows, 1)).toEqual({
      kind: "delivered",
      at: 60,
      event: "answer.ready",
    });
  });

  it("projects open, aborted, and orphaned run statuses honestly", () => {
    expect(projectRunStatus([event(1, "agent.run.started", {})], 1)).toEqual({
      kind: "open_without_terminal",
      startedAt: 10,
    });
    expect(
      projectRunStatus(
        [
          event(1, "agent.run.started", {}),
          event(2, "agent.aborted.tool_error", { runId: 1 }),
        ],
        1,
      ),
    ).toEqual({
      kind: "aborted",
      at: 20,
      abortKind: "agent.aborted.tool_error",
    });
    expect(
      projectRunStatus(
        [event(2, "llm.response", { turn: { id: 99, index: 0 } })],
        99,
      ),
    ).toEqual({
      kind: "orphaned",
      startedAt: 20,
      evidence: "llm.response",
    });
  });

  it("projects quota from dispatch.consumed without quota.* facts", () => {
    const rows = [
      event(1, "dispatch.consumed", {
        key: "lookup",
        amount: 2,
        toolName: "lookup",
      }),
      event(2, "dispatch.consumed", {
        key: "other",
        amount: 9,
        toolName: "other",
      }),
      event(3, "dispatch.consumed", {
        key: "lookup",
        amount: 1,
        toolName: "lookup",
      }),
    ];
    expect(
      projectQuotaState(rows, { key: "lookup", windowMs: 100, limit: 5 }, 130),
    ).toEqual({
      consumed: 1,
      limit: 5,
      remaining: 4,
      refundable: 0,
      windowStart: 30,
    });
  });

  it("projects resource state from explicit reservation lifecycle", () => {
    const rows = [
      event(1, "resource.granted", { key: "gpu", amount: 10, ref: "grant" }),
      event(2, "resource.reserved", {
        key: "gpu",
        amount: 4,
        ref: "reserve-a",
        reservationId: "r1",
        idempotencyKey: "idem-1",
      }),
      event(3, "resource.reserved", {
        key: "gpu",
        amount: 3,
        ref: "reserve-b",
        reservationId: "r2",
        idempotencyKey: "idem-2",
      }),
      event(4, "resource.consumed", {
        reservationId: "r2",
        ref: "consume-b",
      }),
    ];
    expect(projectResourceState(rows, "gpu")).toEqual({
      granted: 10,
      reserved: 4,
      consumed: 3,
      available: 3,
      reservations: [{ id: "r1", amount: 4 }],
    });
  });
});
