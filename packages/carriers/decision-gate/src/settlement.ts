import type { AdmitVerdict, PreClaim, RejectionRef } from "@agent-os/kernel/effect-claim";

import type { DecisionGateProjection } from "./events";

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
