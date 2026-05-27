import {
  boundaryExtensionPackage,
  defineBoundaryContract,
} from "@agent-os/core/boundary-contract";

export const VERIFICATION_EVENT_PREFIX = "verification.";

export const VERIFICATION_EVENT_VOCABULARY = {
  GATE_RECORDED: `${VERIFICATION_EVENT_PREFIX}gate.recorded`,
} as const;

export const verificationBoundaryContract = defineBoundaryContract({
  packageId: "@agent-os/verification",
  kindPrefixes: [VERIFICATION_EVENT_PREFIX],
  roles: ["generator", "reader"],
  vocabulary: VERIFICATION_EVENT_VOCABULARY,
  authorityContracts: [],
  claimPayloadKey: "claim",
  terminalClaims: ["lived"],
  proof: {
    anchorKinds: ["carrier_proof", "external_receipt"],
    symbolicOnly: true,
  },
  projection: {
    derivedFromLedger: true,
    shadowState: false,
  },
});

export const verificationExtensionPackage = (version: string) =>
  boundaryExtensionPackage(verificationBoundaryContract, version);
