import { boundaryExtensionPackage, defineBoundaryContract } from "@agent-os/core/boundary-contract";

export const WORKSPACE_SESSION_EVENT_PREFIX = "workspace_session.";

export const WORKSPACE_SESSION_EVENT_VOCABULARY = {
  STARTED: `${WORKSPACE_SESSION_EVENT_PREFIX}started`,
  RESTORED: `${WORKSPACE_SESSION_EVENT_PREFIX}restored`,
  BACKED_UP: `${WORKSPACE_SESSION_EVENT_PREFIX}backed_up`,
  PREVIEW_ALLOCATED: `${WORKSPACE_SESSION_EVENT_PREFIX}preview_allocated`,
  DESTROYED: `${WORKSPACE_SESSION_EVENT_PREFIX}destroyed`,
  FAILED: `${WORKSPACE_SESSION_EVENT_PREFIX}failed`,
} as const;

export const workspaceSessionBoundaryContract = defineBoundaryContract({
  packageId: "@agent-os/workspace-session",
  kindPrefixes: [WORKSPACE_SESSION_EVENT_PREFIX],
  roles: ["resolver", "reader"],
  vocabulary: WORKSPACE_SESSION_EVENT_VOCABULARY,
  authorityContracts: [],
  materialRequirements: [],
  claimPayloadKey: "claim",
  claimPhases: {
    [WORKSPACE_SESSION_EVENT_VOCABULARY.STARTED]: ["lived"],
    [WORKSPACE_SESSION_EVENT_VOCABULARY.RESTORED]: ["lived"],
    [WORKSPACE_SESSION_EVENT_VOCABULARY.BACKED_UP]: ["lived"],
    [WORKSPACE_SESSION_EVENT_VOCABULARY.PREVIEW_ALLOCATED]: ["lived"],
    [WORKSPACE_SESSION_EVENT_VOCABULARY.DESTROYED]: ["lived"],
    [WORKSPACE_SESSION_EVENT_VOCABULARY.FAILED]: ["rejected"],
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

export const workspaceSessionExtensionPackage = (version: string) =>
  boundaryExtensionPackage(workspaceSessionBoundaryContract, version);
