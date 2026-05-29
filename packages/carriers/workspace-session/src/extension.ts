import { boundaryPackage, defineBoundaryContract } from "@agent-os/kernel/boundary-contract";
import { WORKSPACE_SESSION_KIND } from "./events";
import { workspaceSessionSettlementContract } from "./settlement";

export const WORKSPACE_SESSION_EVENT_PREFIX = "workspace_session.";

export const workspaceSessionBoundaryContract = defineBoundaryContract({
  packageId: "@agent-os/workspace-session",
  kindPrefixes: [WORKSPACE_SESSION_EVENT_PREFIX],
  roles: ["resolver", "reader"],
  vocabulary: WORKSPACE_SESSION_KIND,
  authorityContracts: [],
  materialRequirements: [],
  claimPayloadKey: "claim",
  claimPhases: {
    [WORKSPACE_SESSION_KIND.STARTED]: ["lived"],
    [WORKSPACE_SESSION_KIND.RESTORED]: ["lived"],
    [WORKSPACE_SESSION_KIND.BACKED_UP]: ["lived"],
    [WORKSPACE_SESSION_KIND.PREVIEW_ALLOCATED]: ["lived"],
    [WORKSPACE_SESSION_KIND.DESTROYED]: ["lived"],
    [WORKSPACE_SESSION_KIND.FAILED]: ["rejected"],
  },
  settlement: workspaceSessionSettlementContract,
  projection: {
    derivedFromLedger: true,
    shadowState: false,
  },
});

export const workspaceSessionBoundaryPackage = (version: string) =>
  boundaryPackage(workspaceSessionBoundaryContract, version);
