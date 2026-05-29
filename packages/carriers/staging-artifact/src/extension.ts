import { boundaryPackage, defineBoundaryContract } from "@agent-os/kernel/boundary-contract";
import { STAGING_KIND } from "./events";

export const STAGING_EVENT_PREFIX = "staging.";

export const STAGING_EVENT_VOCABULARY = STAGING_KIND;

export const stagingArtifactBoundaryContract = defineBoundaryContract({
  packageId: "@agent-os/staging-artifact",
  kindPrefixes: [STAGING_EVENT_PREFIX],
  roles: ["generator", "resolver", "reader"],
  vocabulary: STAGING_EVENT_VOCABULARY,
  authorityContracts: [],
  materialRequirements: [],
  claimPayloadKey: "claim",
  claimPhases: {
    [STAGING_KIND.ARTIFACT_PUBLISHED]: ["lived"],
    [STAGING_KIND.ARTIFACT_REAPED]: ["lived"],
  },
  proof: {
    anchorKinds: ["carrier_proof"],
    symbolicOnly: true,
  },
  projection: {
    derivedFromLedger: true,
    shadowState: false,
  },
});

export const stagingArtifactBoundaryPackage = (version: string) =>
  boundaryPackage(stagingArtifactBoundaryContract, version);
