import {
  type AnchorRef,
  type LivedClaim,
  type PreClaim,
  type RejectedClaim,
  type RejectionRef,
} from "@agent-os/kernel/effect-claim";
import {
  isSymbolicSettlementValue,
  symbolicSettlementRef,
} from "@agent-os/kernel/settlement-contract";

import {
  workspaceSessionCarrier,
  workspaceSessionSettlementContract,
} from "./definition";
import type { WorkspaceSessionFailure } from "./carrier";

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
  workspaceSessionCarrier.settle.started(claim, {
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
  workspaceSessionCarrier.reject.failed(claim, {
    rejectionId: spec.proofRef ?? workspaceSessionSettlementRef(claim.operationRef, "rejected"),
    rejectionKind: spec.rejectionKind ?? workspaceSessionRejectionKind(spec.code),
    reason: isSymbolicSettlementValue(spec.reason) ? spec.reason : `workspace_session_${spec.code}`,
  });
