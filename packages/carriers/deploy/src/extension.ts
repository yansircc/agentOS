import { boundaryPackage, defineBoundaryContract } from "@agent-os/kernel/boundary-contract";
import { DEPLOY_KIND } from "./events";

export const DEPLOY_EVENT_PREFIX = "deploy.";

export const deployBoundaryContract = defineBoundaryContract({
  packageId: "@agent-os/deploy",
  kindPrefixes: [DEPLOY_EVENT_PREFIX],
  roles: ["generator", "resolver", "reader"],
  vocabulary: DEPLOY_KIND,
  authorityContracts: [],
  materialRequirements: [],
  claimPayloadKey: "claim",
  claimPhases: {
    [DEPLOY_KIND.PREVIEW_RECORDED]: ["lived"],
    [DEPLOY_KIND.PRODUCTION_PROMOTED]: ["lived"],
    [DEPLOY_KIND.PRODUCTION_READBACK]: ["lived"],
    [DEPLOY_KIND.ROLLBACK_RECORDED]: ["lived"],
    [DEPLOY_KIND.FAILED]: ["rejected"],
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

export const deployBoundaryPackage = (version: string) =>
  boundaryPackage(deployBoundaryContract, version);
