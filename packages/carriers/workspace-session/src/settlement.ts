import {
  type AnchorRef,
  type LivedClaim,
  type PreClaim,
  type RejectedClaim,
  type RejectionRef,
} from "@agent-os/kernel/effect-claim";
import {
  defineSettlementContract,
  isSymbolicSettlementValue,
  settleLived,
  settleRejected,
  symbolicSettlementRef,
} from "@agent-os/kernel/settlement-contract";

import type { WorkspaceSessionFailure } from "./carrier";

export const workspaceSessionSettlementContract = defineSettlementContract({
  settlementId: "@agent-os/workspace-session",
  anchorKinds: ["carrier_proof"],
  rejectionKinds: ["unsupported", "policy_denied", "provider_rejected", "resource_denied"],
});

export const workspaceSessionSettlementRef = (...parts: ReadonlyArray<string | number>): string =>
  symbolicSettlementRef("workspace_session", parts);

export const workspaceSessionRejectionKind = (
  code: WorkspaceSessionFailure["code"],
): RejectionRef["rejectionKind"] =>
  code === "ScopeNotSession"
    ? "unsupported"
    : code === "PolicyDenied"
      ? "policy_denied"
      : "provider_rejected";

export const settleWorkspaceSessionLived = (
  claim: PreClaim,
  spec: {
    readonly proofRef: string;
    readonly carrierRef: string;
    readonly anchorKind?: AnchorRef["anchorKind"];
  },
): LivedClaim =>
  settleLived(workspaceSessionSettlementContract, claim, {
    anchorId: spec.proofRef,
    anchorKind: spec.anchorKind ?? "carrier_proof",
    carrierRef: spec.carrierRef,
  });

export const settleWorkspaceSessionRejected = (
  claim: PreClaim,
  spec: {
    readonly code: WorkspaceSessionFailure["code"];
    readonly reason: string;
    readonly proofRef?: string;
    readonly rejectionKind?: RejectionRef["rejectionKind"];
  },
): RejectedClaim =>
  settleRejected(workspaceSessionSettlementContract, claim, {
    rejectionId: spec.proofRef ?? workspaceSessionSettlementRef(claim.operationRef, "rejected"),
    rejectionKind: spec.rejectionKind ?? workspaceSessionRejectionKind(spec.code),
    reason: isSymbolicSettlementValue(spec.reason) ? spec.reason : `workspace_session_${spec.code}`,
  });
