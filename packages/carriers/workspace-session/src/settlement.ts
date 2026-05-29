import {
  settleRejectedClaim,
  type PreClaim,
  type RejectionRef,
} from "@agent-os/kernel/effect-claim";

import type { WorkspaceSessionFailure } from "./carrier";

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
    rejectionKind: spec.rejectionKind ?? workspaceSessionRejectionKind(spec.code),
    reason: spec.reason,
  });
