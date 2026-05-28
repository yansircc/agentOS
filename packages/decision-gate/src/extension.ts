import { boundaryExtensionPackage, defineBoundaryContract } from "@agent-os/core/boundary-contract";

export const DECISION_GATE_EVENT_PREFIX = "decision_gate.";

export const DECISION_GATE_EVENT_VOCABULARY = {
  REQUESTED: `${DECISION_GATE_EVENT_PREFIX}requested`,
  DECIDED: `${DECISION_GATE_EVENT_PREFIX}decided`,
  CONSUMED: `${DECISION_GATE_EVENT_PREFIX}consumed`,
} as const;

export const decisionGateBoundaryContract = defineBoundaryContract({
  packageId: "@agent-os/decision-gate",
  kindPrefixes: [DECISION_GATE_EVENT_PREFIX],
  roles: ["admitter", "reader"],
  vocabulary: DECISION_GATE_EVENT_VOCABULARY,
  authorityContracts: [],
  materialRequirements: [],
  claimPayloadKey: "claim",
  terminalClaims: ["lived"],
  proof: {
    anchorKinds: ["ledger_event"],
    symbolicOnly: true,
  },
  projection: {
    derivedFromLedger: true,
    shadowState: false,
  },
});

export const decisionGateExtensionPackage = (version: string) =>
  boundaryExtensionPackage(decisionGateBoundaryContract, version);
