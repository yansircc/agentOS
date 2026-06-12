import type {
  LivedClaim,
  PreClaim,
  RejectedClaim,
  RejectionRef,
} from "@agent-os/kernel/effect-claim";
import { symbolicSettlementRef } from "@agent-os/kernel/settlement-contract";
import { workspaceJobCarrier } from "./definition";

export const workspaceJobSettlementRef = (...parts: ReadonlyArray<string | number>): string =>
  symbolicSettlementRef("workspace_job", parts);

export const settleWorkspaceJobTerminalFinalized = (
  claim: PreClaim,
  spec: {
    readonly runId: string;
    readonly requestedEventId: number;
    readonly artifactRef: string;
  },
): LivedClaim =>
  workspaceJobCarrier.settle.terminal_finalized(claim, {
    anchorId: workspaceJobSettlementRef(
      "terminal_finalized",
      spec.runId,
      spec.requestedEventId,
      spec.artifactRef,
    ),
    anchorKind: "carrier_proof",
    carrierRef: workspaceJobSettlementRef("carrier", "workspace-job"),
  });

export const settleWorkspaceJobVerified = (
  claim: PreClaim,
  spec: {
    readonly runId: string;
    readonly requestedEventId: number;
    readonly terminalFinalizedEventId: number;
  },
): LivedClaim =>
  workspaceJobCarrier.settle.verified(claim, {
    anchorId: workspaceJobSettlementRef(
      "verified",
      spec.runId,
      spec.requestedEventId,
      spec.terminalFinalizedEventId,
    ),
    anchorKind: "carrier_proof",
    carrierRef: workspaceJobSettlementRef("carrier", "workspace-job"),
  });

export const rejectWorkspaceJobByVerifier = (
  claim: PreClaim,
  spec: {
    readonly runId: string;
    readonly requestedEventId: number;
    readonly terminalFinalizedEventId: number;
    readonly rejectionKind?: Extract<
      RejectionRef["rejectionKind"],
      "validation_failed" | "policy_denied"
    >;
  },
): RejectedClaim =>
  workspaceJobCarrier.reject.verifier_rejected(claim, {
    rejectionId: workspaceJobSettlementRef(
      "verifier_rejected",
      spec.runId,
      spec.requestedEventId,
      spec.terminalFinalizedEventId,
    ),
    rejectionKind: spec.rejectionKind ?? "validation_failed",
    reason: workspaceJobSettlementRef(
      "reason",
      "verifier_rejected",
      spec.runId,
      spec.requestedEventId,
      spec.terminalFinalizedEventId,
    ),
  });

export const rejectWorkspaceJobFailed = (
  claim: PreClaim,
  spec: {
    readonly runId: string;
    readonly requestedEventId: number;
    readonly rejectionKind?: RejectionRef["rejectionKind"];
  },
): RejectedClaim =>
  workspaceJobCarrier.reject.failed(claim, {
    rejectionId: workspaceJobSettlementRef("failed", spec.runId, spec.requestedEventId),
    rejectionKind: spec.rejectionKind ?? "provider_rejected",
    reason: workspaceJobSettlementRef("reason", "failed", spec.runId, spec.requestedEventId),
  });
