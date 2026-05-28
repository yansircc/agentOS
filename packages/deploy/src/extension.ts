import { boundaryExtensionPackage, defineBoundaryContract } from "@agent-os/core/boundary-contract";

export const DEPLOY_EVENT_PREFIX = "deploy.";

export const DEPLOY_EVENT_VOCABULARY = {
  PREVIEW_RECORDED: `${DEPLOY_EVENT_PREFIX}preview.recorded`,
  PRODUCTION_PROMOTED: `${DEPLOY_EVENT_PREFIX}production.promoted`,
  PRODUCTION_READBACK: `${DEPLOY_EVENT_PREFIX}production.readback`,
  ROLLBACK_RECORDED: `${DEPLOY_EVENT_PREFIX}rollback.recorded`,
  FAILED: `${DEPLOY_EVENT_PREFIX}failed`,
} as const;

export const deployBoundaryContract = defineBoundaryContract({
  packageId: "@agent-os/deploy",
  kindPrefixes: [DEPLOY_EVENT_PREFIX],
  roles: ["generator", "resolver", "reader"],
  vocabulary: DEPLOY_EVENT_VOCABULARY,
  authorityContracts: [],
  materialRequirements: [],
  claimPayloadKey: "claim",
  claimPhases: {
    [DEPLOY_EVENT_VOCABULARY.PREVIEW_RECORDED]: ["lived"],
    [DEPLOY_EVENT_VOCABULARY.PRODUCTION_PROMOTED]: ["lived"],
    [DEPLOY_EVENT_VOCABULARY.PRODUCTION_READBACK]: ["lived"],
    [DEPLOY_EVENT_VOCABULARY.ROLLBACK_RECORDED]: ["lived"],
    [DEPLOY_EVENT_VOCABULARY.FAILED]: ["rejected"],
  },
  proof: {
    anchorKinds: ["carrier_proof", "external_receipt"],
    symbolicOnly: true,
  },
  projection: {
    derivedFromLedger: true,
    shadowState: false,
  },
});

export const deployExtensionPackage = (version: string) =>
  boundaryExtensionPackage(deployBoundaryContract, version);
