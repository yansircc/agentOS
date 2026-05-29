import { boundaryPackage, defineBoundaryContract } from "@agent-os/kernel/boundary-contract";
import { DECISION_GATE_KIND } from "./events";
import { decisionGateSettlementContract } from "./settlement";

export const DECISION_GATE_EVENT_PREFIX = "decision_gate.";

export const decisionGateBoundaryContract = defineBoundaryContract({
  packageId: "@agent-os/decision-gate",
  kindPrefixes: [DECISION_GATE_EVENT_PREFIX],
  roles: ["admitter", "reader"],
  vocabulary: DECISION_GATE_KIND,
  authorityContracts: [],
  materialRequirements: [],
  claimPayloadKey: "claim",
  claimPhases: {
    [DECISION_GATE_KIND.REQUESTED]: ["pre"],
    [DECISION_GATE_KIND.DECIDED]: ["lived"],
    [DECISION_GATE_KIND.CONSUMED]: ["lived"],
  },
  settlement: decisionGateSettlementContract,
  projection: {
    derivedFromLedger: true,
    shadowState: false,
  },
});

export const decisionGateBoundaryPackage = (version: string) =>
  boundaryPackage(decisionGateBoundaryContract, version);
