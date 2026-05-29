import {
  DECISION_GATE_EVENTS,
  DECISION_GATE_KIND,
  admitDecisionGate,
  decisionGateBoundaryPackage,
  projectDecisionGate,
  settleDecisionGateConsumed,
} from "../src";
import { makePreClaim } from "@agent-os/kernel/effect-claim";
import { makeCommitters, type ExtensionCapability } from "@agent-os/kernel/extensions";

const claim = makePreClaim({
  operationRef: "publish:subject-1",
  scopeRef: { kind: "artifact", scopeId: "artifact/subject-1" },
  authorityRef: {
    authorityId: "publish.subject",
    authorityClass: "effect",
  },
  originRef: {
    originId: "agent/run-1",
    originKind: "agent_run",
  },
});

const consumedClaim = settleDecisionGateConsumed(claim, {
  gateRef: "gate/1",
  eventId: 3,
});

describe("@agent-os/decision-gate", () => {
  it("declares decision_gate.* as an extension-owned prefix", () => {
    expect(decisionGateBoundaryPackage("0.1.0")).toMatchObject({
      packageId: "@agent-os/decision-gate",
      kindPrefixes: ["decision_gate."],
      version: "0.1.0",
    });
  });

  it("projects requested, decided, and consumed gate state", () => {
    const events = [
      {
        id: 1,
        kind: DECISION_GATE_KIND.REQUESTED,
        payload: {
          gateRef: "gate/1",
          subjectRef: "subject-1",
          policyRef: "publish-policy",
          claim,
        },
      },
      {
        id: 2,
        kind: DECISION_GATE_KIND.DECIDED,
        payload: {
          gateRef: "gate/1",
          decisionRef: "decision/1",
          decision: "approved",
          decidedBy: "operator/alice",
        },
      },
      {
        id: 3,
        kind: DECISION_GATE_KIND.CONSUMED,
        payload: {
          gateRef: "gate/1",
          decisionRef: "decision/1",
          consumedBy: "publish-saga",
          claim: consumedClaim,
        },
      },
    ] as const;

    expect(projectDecisionGate(events, "gate/1")).toEqual({
      gateRef: "gate/1",
      status: "consumed",
      request: {
        gateRef: "gate/1",
        subjectRef: "subject-1",
        policyRef: "publish-policy",
        claim,
      },
      decision: {
        gateRef: "gate/1",
        decisionRef: "decision/1",
        decision: "approved",
        decidedBy: "operator/alice",
      },
      consumed: {
        gateRef: "gate/1",
        decisionRef: "decision/1",
        consumedBy: "publish-saga",
        claim: consumedClaim,
      },
    });
  });

  it("turns approved, rejected, pending, consumed, and missing projections into admit verdicts", () => {
    const rejected = {
      rejectionId: "decision/2",
      rejectionKind: "policy_denied" as const,
      reason: "operator rejected",
    };

    expect(
      admitDecisionGate(claim, {
        gateRef: "gate/approved",
        status: "approved",
        decision: {
          gateRef: "gate/approved",
          decisionRef: "decision/1",
          decision: "approved",
          decidedBy: "operator/alice",
        },
      }),
    ).toEqual({ ok: true });
    expect(
      admitDecisionGate(claim, {
        gateRef: "gate/rejected",
        status: "rejected",
        decision: {
          gateRef: "gate/rejected",
          decisionRef: "decision/2",
          decision: "rejected",
          decidedBy: "operator/bob",
          rejectionRef: rejected,
        },
      }),
    ).toEqual({ ok: false, rejectionRef: rejected });
    expect(admitDecisionGate(claim, { gateRef: "gate/pending", status: "requested" })).toEqual({
      ok: false,
      rejectionRef: {
        rejectionId: "publish:subject-1",
        rejectionKind: "policy_denied",
        reason: "decision_gate_pending",
      },
    });
    expect(admitDecisionGate(claim, { gateRef: "gate/consumed", status: "consumed" })).toEqual({
      ok: false,
      rejectionRef: {
        rejectionId: "publish:subject-1",
        rejectionKind: "capability_denied",
        reason: "decision_gate_consumed",
      },
    });
    expect(admitDecisionGate(claim, { gateRef: "gate/missing", status: "missing" })).toEqual({
      ok: false,
      rejectionRef: {
        rejectionId: "publish:subject-1",
        rejectionKind: "policy_denied",
        reason: "decision_gate_missing",
      },
    });
  });

  it("skips malformed gate facts instead of inventing state", () => {
    const events = [
      {
        id: 1,
        kind: DECISION_GATE_KIND.REQUESTED,
        payload: {
          gateRef: "gate/bad",
          subjectRef: "subject-1",
          claim: { ...claim, phase: "lived" },
        },
      },
      {
        id: 2,
        kind: DECISION_GATE_KIND.DECIDED,
        payload: {
          gateRef: "gate/bad",
          decisionRef: "decision/bad",
          decision: "rejected",
          decidedBy: "operator/bob",
        },
      },
    ] as const;

    expect(projectDecisionGate(events, "gate/bad")).toEqual({
      gateRef: "gate/bad",
      status: "missing",
      request: undefined,
      decision: undefined,
      consumed: undefined,
    });
  });

  it("does not approve a gate from a decision without a request", () => {
    const events = [
      {
        id: 1,
        kind: DECISION_GATE_KIND.DECIDED,
        payload: {
          gateRef: "gate/lone-decision",
          decisionRef: "decision/lone",
          decision: "approved",
          decidedBy: "operator/alice",
        },
      },
    ] as const;

    expect(projectDecisionGate(events, "gate/lone-decision")).toEqual({
      gateRef: "gate/lone-decision",
      status: "missing",
      request: undefined,
      decision: undefined,
      consumed: undefined,
    });
  });

  it("commits decision_gate.* facts through ExtensionCapability", async () => {
    const committed: Array<{ event: string; data: unknown }> = [];
    const cap: ExtensionCapability = {
      packageId: "@agent-os/decision-gate",
      kindPrefixes: ["decision_gate."],
      version: "0.1.0",
      commit: async (spec) => {
        committed.push(spec);
        return { id: committed.length };
      },
      time: async (spec) => {
        committed.push(spec);
        return { id: committed.length };
      },
    };

    await expect(
      makeCommitters(DECISION_GATE_EVENTS, cap)[DECISION_GATE_KIND.REQUESTED]({
        gateRef: "gate/1",
        subjectRef: "subject-1",
        summary: "publish ready",
        claim,
      }),
    ).resolves.toEqual({ id: 1 });

    expect(committed).toEqual([
      {
        event: DECISION_GATE_KIND.REQUESTED,
        data: {
          gateRef: "gate/1",
          subjectRef: "subject-1",
          summary: "publish ready",
          claim,
        },
      },
    ]);
  });
});
