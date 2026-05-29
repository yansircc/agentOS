import { boundaryPackage, defineBoundaryContract } from "@agent-os/kernel/boundary-contract";
import { DECISION_GATE_KIND } from "./events";

export const DECISION_GATE_EVENT_PREFIX = "decision_gate.";

export const DECISION_GATE_EVENT_VOCABULARY = DECISION_GATE_KIND;

export const decisionGateBoundaryContract = defineBoundaryContract({
  packageId: "@agent-os/decision-gate",
  kindPrefixes: [DECISION_GATE_EVENT_PREFIX],
  roles: ["admitter", "reader"],
  vocabulary: DECISION_GATE_EVENT_VOCABULARY,
  authorityContracts: [],
  materialRequirements: [],
  claimPayloadKey: "claim",
  claimPhases: {
    [DECISION_GATE_KIND.REQUESTED]: ["pre"],
    [DECISION_GATE_KIND.DECIDED]: ["lived"],
    [DECISION_GATE_KIND.CONSUMED]: ["lived"],
  },
  proof: {
    anchorKinds: ["ledger_event"],
    symbolicOnly: true,
  },
  projection: {
    derivedFromLedger: true,
    shadowState: false,
  },
});

export const decisionGateBoundaryPackage = (version: string) =>
  boundaryPackage(decisionGateBoundaryContract, version);
