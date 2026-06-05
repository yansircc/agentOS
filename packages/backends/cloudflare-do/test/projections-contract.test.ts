import { describe, expect, it } from "vite-plus/test";

import {
  projectClaimTrace,
  projectFailurePlane,
  projectQuotaState,
  projectResourceState,
} from "../src/projections";
import type { EffectClaim } from "@agent-os/kernel/effect-claim";
import { settleDispatchInboundAccepted } from "@agent-os/backend-protocol";
import type { LedgerEvent } from "@agent-os/kernel/types";

const eventIdentity = (scopeId: string) => ({
  scopeRef: { kind: "conversation" as const, scopeId },
  factOwnerRef: "@agent-os/test",
  effectAuthorityRef: { authorityClass: "test", authorityId: scopeId },
});

const event = (id: number, kind: string, payload: unknown, ts = id * 10): LedgerEvent => ({
  id,
  ts,
  kind,
  ...eventIdentity("projection-scope"),
  payload,
});

const preClaim: EffectClaim = {
  phase: "pre",
  operationRef: "dispatch:source:binding:target:idem-1",
  scopeRef: { kind: "conversation", scopeId: "thread/target" },
  effectAuthorityRef: {
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
  effectAuthorityRef: {
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
  effectAuthorityRef: {
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
        scopeKey: "conversation:projection-scope",
        ts: 10,
        phase: "pre",
        operationRef: preClaim.operationRef,
        scopeRef: preClaim.scopeRef,
        effectAuthorityRef: preClaim.effectAuthorityRef,
        originRef: preClaim.originRef,
      },
      {
        eventId: 3,
        eventKind: "dispatch.inbound.accepted",
        scopeKey: "conversation:projection-scope",
        ts: 30,
        phase: "lived",
        operationRef: livedClaim.operationRef,
        scopeRef: livedClaim.scopeRef,
        effectAuthorityRef: livedClaim.effectAuthorityRef,
        originRef: livedClaim.originRef,
        anchorRef: livedClaim.anchorRef,
      },
      {
        eventId: 4,
        eventKind: "tool.executed",
        scopeKey: "conversation:projection-scope",
        ts: 40,
        phase: "lived",
        operationRef: "tool:projection-scope:1:0:call-1",
        scopeRef: toolClaim.scopeRef,
        effectAuthorityRef: toolClaim.effectAuthorityRef,
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
        scopeKey: "conversation:projection-scope",
        ts: 30,
        phase: "lived",
        operationRef: livedClaim.operationRef,
        scopeRef: livedClaim.scopeRef,
        effectAuthorityRef: livedClaim.effectAuthorityRef,
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
        scopeKey: "conversation:projection-scope",
        ts: 10,
        plane: "claim_rejected",
        operationRef: rejectedClaim.operationRef,
        rejectionRef: rejectedClaim.rejectionRef,
        reason: "gate failed",
      },
      {
        eventId: 3,
        eventKind: "agent.aborted.tool_error",
        scopeKey: "conversation:projection-scope",
        ts: 30,
        plane: "run_aborted",
        reason: "tool failed",
      },
    ]);
  });

  it("projects quota from quota.consumed facts", () => {
    const rows = [
      event(1, "quota.consumed", {
        key: "lookup",
        amount: 2,
        toolName: "lookup",
        operationRef: "op-1",
      }),
      event(2, "quota.consumed", {
        key: "other",
        amount: 9,
        toolName: "other",
        operationRef: "op-2",
      }),
      event(3, "quota.consumed", {
        key: "lookup",
        amount: 1,
        toolName: "lookup",
        operationRef: "op-3",
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
      event(1, "resource_pool.granted", { key: "gpu", amount: 10, ref: "grant" }),
      event(2, "resource_pool.reserved", {
        key: "gpu",
        amount: 4,
        ref: "reserve-a",
        reservationId: "r1",
        idempotencyKey: "idem-1",
      }),
      event(3, "resource_pool.reserved", {
        key: "gpu",
        amount: 3,
        ref: "reserve-b",
        reservationId: "r2",
        idempotencyKey: "idem-2",
      }),
      event(4, "resource_pool.consumed", {
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
