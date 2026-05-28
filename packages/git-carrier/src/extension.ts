import { boundaryPackage, defineBoundaryContract } from "@agent-os/kernel/boundary-contract";

export const GIT_EVENT_PREFIX = "git.";

export const GIT_EVENT_VOCABULARY = {
  WORKSPACE_CREATED: `${GIT_EVENT_PREFIX}workspace.created`,
  COMMIT_RECORDED: `${GIT_EVENT_PREFIX}commit.recorded`,
  MERGE_RECORDED: `${GIT_EVENT_PREFIX}merge.recorded`,
  REVERT_RECORDED: `${GIT_EVENT_PREFIX}revert.recorded`,
  WORKSPACE_CLEANED: `${GIT_EVENT_PREFIX}workspace.cleaned`,
} as const;

export const gitCarrierBoundaryContract = defineBoundaryContract({
  packageId: "@agent-os/git-carrier",
  kindPrefixes: [GIT_EVENT_PREFIX],
  roles: ["generator", "resolver", "reader"],
  vocabulary: GIT_EVENT_VOCABULARY,
  authorityContracts: [],
  materialRequirements: [],
  claimPayloadKey: "claim",
  claimPhases: {
    [GIT_EVENT_VOCABULARY.WORKSPACE_CREATED]: ["lived"],
    [GIT_EVENT_VOCABULARY.COMMIT_RECORDED]: ["lived"],
    [GIT_EVENT_VOCABULARY.MERGE_RECORDED]: ["lived"],
    [GIT_EVENT_VOCABULARY.REVERT_RECORDED]: ["lived"],
    [GIT_EVENT_VOCABULARY.WORKSPACE_CLEANED]: ["lived"],
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
