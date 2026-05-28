import type { AdmitVerdict, PreClaim, RejectionRef } from "@agent-os/kernel/effect-claim";
import type { ExtensionCapability } from "@agent-os/kernel/extensions";

import {
  DECISION_GATE_EVENTS,
  type DecisionGateConsumedPayload,
  type DecisionGateDecidedPayload,
  type DecisionGateProjection,
  type DecisionGateRequestedPayload,
} from "./events";

const rejection = (
  claim: PreClaim,
  reason: string,
  kind: RejectionRef["rejectionKind"] = "policy_denied",
): AdmitVerdict => ({
  ok: false,
  rejectionRef: {
    rejectionId: claim.operationRef,
    rejectionKind: kind,
    reason,
  },
});

export const admitDecisionGate = (
  claim: PreClaim,
  projection: DecisionGateProjection,
): AdmitVerdict => {
  switch (projection.status) {
    case "approved":
      return { ok: true };
    case "rejected":
      return projection.decision?.rejectionRef === undefined
        ? rejection(claim, "decision_gate_rejected")
        : { ok: false, rejectionRef: projection.decision.rejectionRef };
    case "consumed":
      return rejection(claim, "decision_gate_consumed", "capability_denied");
    case "requested":
      return rejection(claim, "decision_gate_pending");
    case "missing":
      return rejection(claim, "decision_gate_missing");
  }
};

export const commitDecisionGateRequested = (
  cap: ExtensionCapability,
  payload: DecisionGateRequestedPayload,
): Promise<{ readonly id: number }> =>
  cap.commit({ event: DECISION_GATE_EVENTS.REQUESTED, data: payload });

export const commitDecisionGateDecided = (
  cap: ExtensionCapability,
  payload: DecisionGateDecidedPayload,
): Promise<{ readonly id: number }> =>
  cap.commit({ event: DECISION_GATE_EVENTS.DECIDED, data: payload });

export const commitDecisionGateConsumed = (
  cap: ExtensionCapability,
  payload: DecisionGateConsumedPayload,
): Promise<{ readonly id: number }> =>
  cap.commit({ event: DECISION_GATE_EVENTS.CONSUMED, data: payload });
