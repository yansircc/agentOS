import { boundaryExtensionPackage, defineBoundaryContract } from "@agent-os/core/boundary-contract";

export const STAGING_EVENT_PREFIX = "staging.";

export const STAGING_EVENT_VOCABULARY = {
  ARTIFACT_PUBLISHED: `${STAGING_EVENT_PREFIX}artifact.published`,
  ARTIFACT_REAPED: `${STAGING_EVENT_PREFIX}artifact.reaped`,
} as const;

export const stagingArtifactBoundaryContract = defineBoundaryContract({
  packageId: "@agent-os/staging-artifact",
  kindPrefixes: [STAGING_EVENT_PREFIX],
  roles: ["generator", "resolver", "reader"],
  vocabulary: STAGING_EVENT_VOCABULARY,
  authorityContracts: [],
  materialRequirements: [],
  claimPayloadKey: "claim",
  claimPhases: {
    [STAGING_EVENT_VOCABULARY.ARTIFACT_PUBLISHED]: ["lived"],
    [STAGING_EVENT_VOCABULARY.ARTIFACT_REAPED]: ["lived"],
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

export const stagingArtifactExtensionPackage = (version: string) =>
  boundaryExtensionPackage(stagingArtifactBoundaryContract, version);
