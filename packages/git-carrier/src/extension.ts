import { boundaryExtensionPackage, defineBoundaryContract } from "@agent-os/core/boundary-contract";

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
  claimPayloadKey: "claim",
  terminalClaims: ["lived"],
  proof: {
    anchorKinds: ["carrier_proof"],
    symbolicOnly: true,
  },
  projection: {
    derivedFromLedger: true,
    shadowState: false,
  },
});

export const gitCarrierExtensionPackage = (version: string) =>
  boundaryExtensionPackage(gitCarrierBoundaryContract, version);
