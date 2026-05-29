import { boundaryPackage, defineBoundaryContract } from "@agent-os/kernel/boundary-contract";
import { GIT_KIND } from "./events";

export const GIT_EVENT_PREFIX = "git.";

export const gitCarrierBoundaryContract = defineBoundaryContract({
  packageId: "@agent-os/git-carrier",
  kindPrefixes: [GIT_EVENT_PREFIX],
  roles: ["generator", "resolver", "reader"],
  vocabulary: GIT_KIND,
  authorityContracts: [],
  materialRequirements: [],
  claimPayloadKey: "claim",
  claimPhases: {
    [GIT_KIND.WORKSPACE_CREATED]: ["lived"],
    [GIT_KIND.COMMIT_RECORDED]: ["lived"],
    [GIT_KIND.MERGE_RECORDED]: ["lived"],
    [GIT_KIND.REVERT_RECORDED]: ["lived"],
    [GIT_KIND.WORKSPACE_CLEANED]: ["lived"],
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

export const gitCarrierBoundaryPackage = (version: string) =>
  boundaryPackage(gitCarrierBoundaryContract, version);
