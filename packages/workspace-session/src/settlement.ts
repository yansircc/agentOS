import {
  settleRejectedClaim,
  type PreClaim,
  type RejectionRef,
} from "@agent-os/core/effect-claim";
import type { ExtensionCapability } from "@agent-os/core/extensions";

import type { WorkspaceSessionFailure } from "./carrier";
import {
  WORKSPACE_SESSION_EVENTS,
  type WorkspaceSessionBackedUpPayload,
  type WorkspaceSessionDestroyedPayload,
  type WorkspaceSessionFailedPayload,
  type WorkspaceSessionPreviewAllocatedPayload,
  type WorkspaceSessionRestoredPayload,
  type WorkspaceSessionStartedPayload,
} from "./events";

export const workspaceSessionRejectionKind = (
  code: WorkspaceSessionFailure["code"],
): RejectionRef["rejectionKind"] =>
  code === "ScopeNotSession"
    ? "unsupported"
    : code === "PolicyDenied"
      ? "policy_denied"
      : "provider_rejected";

export const settleWorkspaceSessionRejected = (
  claim: PreClaim,
  spec: {
    readonly code: WorkspaceSessionFailure["code"];
    readonly reason: string;
    readonly proofRef?: string;
    readonly rejectionKind?: RejectionRef["rejectionKind"];
  },
): WorkspaceSessionFailure["claim"] =>
  settleRejectedClaim(claim, {
    rejectionId: spec.proofRef ?? `${claim.operationRef}:rejected`,
    rejectionKind:
      spec.rejectionKind ?? workspaceSessionRejectionKind(spec.code),
    reason: spec.reason,
  });

export const commitWorkspaceSessionStarted = (
  cap: ExtensionCapability,
  payload: WorkspaceSessionStartedPayload,
): Promise<{ readonly id: number }> =>
  cap.commit({ event: WORKSPACE_SESSION_EVENTS.STARTED, data: payload });

export const commitWorkspaceSessionRestored = (
  cap: ExtensionCapability,
  payload: WorkspaceSessionRestoredPayload,
): Promise<{ readonly id: number }> =>
  cap.commit({ event: WORKSPACE_SESSION_EVENTS.RESTORED, data: payload });

export const commitWorkspaceSessionBackedUp = (
  cap: ExtensionCapability,
  payload: WorkspaceSessionBackedUpPayload,
): Promise<{ readonly id: number }> =>
  cap.commit({ event: WORKSPACE_SESSION_EVENTS.BACKED_UP, data: payload });

export const commitWorkspaceSessionPreviewAllocated = (
  cap: ExtensionCapability,
  payload: WorkspaceSessionPreviewAllocatedPayload,
): Promise<{ readonly id: number }> =>
  cap.commit({
    event: WORKSPACE_SESSION_EVENTS.PREVIEW_ALLOCATED,
    data: payload,
  });

export const commitWorkspaceSessionDestroyed = (
  cap: ExtensionCapability,
  payload: WorkspaceSessionDestroyedPayload,
): Promise<{ readonly id: number }> =>
  cap.commit({ event: WORKSPACE_SESSION_EVENTS.DESTROYED, data: payload });

export const commitWorkspaceSessionFailed = (
  cap: ExtensionCapability,
  payload: WorkspaceSessionFailedPayload,
): Promise<{ readonly id: number }> =>
  cap.commit({ event: WORKSPACE_SESSION_EVENTS.FAILED, data: payload });
