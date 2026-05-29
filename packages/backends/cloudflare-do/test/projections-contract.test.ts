import { describe, expect, it } from "vite-plus/test";

import {
  projectClaimTrace,
  projectFailurePlane,
  projectQuotaState,
  projectResourceState,
  projectRunStatus,
  projectRunTrace,
} from "../src/projections";
import type { EffectClaim } from "@agent-os/kernel/effect-claim";
import { settleDispatchInboundAccepted } from "@agent-os/backend-protocol";
import type { LedgerEvent } from "@agent-os/kernel/types";

const event = (id: number, kind: string, payload: unknown, ts = id * 10): LedgerEvent => ({
  id,
  ts,
  kind,
  scope: "projection-scope",
  payload,
});

const preClaim: EffectClaim = {
  phase: "pre",
  operationRef: "dispatch:source:binding:target:idem-1",
  scopeRef: { kind: "conversation", scopeId: "thread/target" },
  authorityRef: {
    authorityId: "cap_dispatch",
    authorityClass: "effect",
  },
  originRef: {
    originId: "thread/source",
    originKind: "agent_do",
  },
};

const livedClaim: EffectClaim = settleDispatchInboundAccepted(preClaim, {
  sourceScope: "thread/source",
  targetScope: "thread/target",
  deliveredEventId: 42,
});

const toolClaim: EffectClaim = {
  phase: "lived",
  operationRef: "tool:projection-scope:1:0:call-1",
  scopeRef: livedClaim.scopeRef,
  authorityRef: {
    authorityId: "tool:lookup",
    authorityClass: "read",
  },
  originRef: {
    originId: "@agent-os/tool-registry/test",
    originKind: "tool_provider",
  },
  anchorRef: {
    anchorId: "tool.executed:tool:projection-scope:1:0:call-1",
    anchorKind: "carrier_proof",
    carrierRef: "tool:lookup",
  },
};

const rejectedClaim: EffectClaim = {
  phase: "rejected",
  operationRef: "verify:subject-1",
  scopeRef: { kind: "artifact", scopeId: "artifact/subject-1" },
  authorityRef: {
    authorityId: "verification.policy.default",
    authorityClass: "effect",
  },
  originRef: {
    originId: "@agent-os/verification",
    originKind: "extension_package",
  },
  rejectionRef: {
    rejectionId: "verification:proof-1",
    rejectionKind: "policy_denied",
    reason: "gate failed",
  },
};

describe("standard projections — contract", () => {
  it("projects claim trace from ledger claims without a second fact source", () => {
    const rows = [
      event(1, "dispatch.outbound.requested", { claim: preClaim }),
      event(2, "noise.with.invalid.claim", {
        claim: { ...preClaim, phase: "lived" },
      }),
      event(3, "dispatch.inbound.accepted", { claim: livedClaim }),
      event(4, "tool.executed", {
        claim: toolClaim,
      }),
    ];

    expect(projectClaimTrace(rows)).toEqual([
      {
        eventId: 1,
        eventKind: "dispatch.outbound.requested",
        scope: "projection-scope",
        ts: 10,
        phase: "pre",
        operationRef: preClaim.operationRef,
        scopeRef: preClaim.scopeRef,
        authorityRef: preClaim.authorityRef,
        originRef: preClaim.originRef,
      },
      {
        eventId: 3,
        eventKind: "dispatch.inbound.accepted",
        scope: "projection-scope",
        ts: 30,
        phase: "lived",
        operationRef: livedClaim.operationRef,
        scopeRef: livedClaim.scopeRef,
        authorityRef: livedClaim.authorityRef,
        originRef: livedClaim.originRef,
        anchorRef: livedClaim.anchorRef,
      },
      {
        eventId: 4,
        eventKind: "tool.executed",
        scope: "projection-scope",
        ts: 40,
        phase: "lived",
        operationRef: "tool:projection-scope:1:0:call-1",
        scopeRef: toolClaim.scopeRef,
        authorityRef: toolClaim.authorityRef,
        originRef: toolClaim.originRef,
        anchorRef: toolClaim.anchorRef,
      },
    ]);

    expect(
      projectClaimTrace(rows, {
        operationRef: livedClaim.operationRef,
        phases: ["lived"],
      }),
    ).toEqual([
      {
        eventId: 3,
        eventKind: "dispatch.inbound.accepted",
        scope: "projection-scope",
        ts: 30,
        phase: "lived",
        operationRef: livedClaim.operationRef,
        scopeRef: livedClaim.scopeRef,
        authorityRef: livedClaim.authorityRef,
        originRef: livedClaim.originRef,
        anchorRef: livedClaim.anchorRef,
      },
    ]);
  });

  it("projects failure plane from rejected claims and abort facts only", () => {
    const rows = [
      event(1, "verification.gate.rejected", { claim: rejectedClaim }),
      event(2, "dispatch.outbound.failed", { error: "temporary" }),
      event(3, "agent.aborted.tool_error", {
        runId: 99,
        reason: "tool failed",
      }),
    ];

    expect(projectFailurePlane(rows)).toEqual([
      {
        eventId: 1,
        eventKind: "verification.gate.rejected",
        scope: "projection-scope",
        ts: 10,
        plane: "claim_rejected",
        operationRef: rejectedClaim.operationRef,
        rejectionRef: rejectedClaim.rejectionRef,
        reason: "gate failed",
      },
      {
        eventId: 3,
        eventKind: "agent.aborted.tool_error",
        scope: "projection-scope",
        ts: 30,
        plane: "run_aborted",
        reason: "tool failed",
      },
    ]);
  });

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
        [event(1, "agent.run.started", {}), event(2, "agent.aborted.tool_error", { runId: 1 })],
        1,
      ),
    ).toEqual({
      kind: "aborted",
      at: 20,
      abortKind: "agent.aborted.tool_error",
    });
    expect(
      projectRunStatus([event(2, "llm.response", { turn: { id: 99, index: 0 } })], 99),
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
    expect(projectQuotaState(rows, { key: "lookup", windowMs: 100, limit: 5 }, 130)).toEqual({
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
