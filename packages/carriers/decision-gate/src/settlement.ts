import type { AdmitVerdict, LivedClaim, PreClaim, RejectionRef } from "@agent-os/core/effect-claim";
import { symbolicSettlementRef } from "@agent-os/core/settlement-contract";

import { decisionGateCarrier } from "./definition";
import type { DecisionGateProjection } from "./events";

export const decisionGateSettlementRef = (...parts: ReadonlyArray<string | number>): string =>
  symbolicSettlementRef("decision_gate", parts);

export const settleDecisionGateConsumed = (
  claim: PreClaim,
  spec: {
    readonly eventId: number;
    readonly gateRef: string;
  },
): LivedClaim =>
  decisionGateCarrier.settle.consumed(claim, {
    anchorId: decisionGateSettlementRef(spec.gateRef, spec.eventId),
    carrierRef: decisionGateSettlementRef("carrier", spec.gateRef),
  });

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
