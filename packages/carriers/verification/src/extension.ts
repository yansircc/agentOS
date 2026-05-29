import { boundaryPackage, defineBoundaryContract } from "@agent-os/kernel/boundary-contract";
import { VERIFICATION_KIND } from "./events";
import { verificationSettlementContract } from "./settlement";

export const VERIFICATION_EVENT_PREFIX = "verification.";

export const verificationBoundaryContract = defineBoundaryContract({
  packageId: "@agent-os/verification",
  kindPrefixes: [VERIFICATION_EVENT_PREFIX],
  roles: ["generator", "reader"],
  vocabulary: VERIFICATION_KIND,
  authorityContracts: [],
  materialRequirements: [],
  claimPayloadKey: "claim",
  claimPhases: {
    [VERIFICATION_KIND.GATE_RECORDED]: ["lived"],
  },
  settlement: verificationSettlementContract,
  projection: {
    derivedFromLedger: true,
    shadowState: false,
  },
});

export const verificationBoundaryPackage = (version: string) =>
  boundaryPackage(verificationBoundaryContract, version);
