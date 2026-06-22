import type {
  IndeterminateClaim,
  IndeterminateRef,
  LivedClaim,
  PreClaim,
  RejectedClaim,
  RejectionRef,
} from "@agent-os/core/effect-claim";
import { symbolicSettlementRef } from "@agent-os/core/settlement-contract";
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

export const settleWorkspaceJobSeedWritten = (
  claim: PreClaim,
  spec: {
    readonly runId: string;
    readonly requestedEventId: number;
  },
): LivedClaim =>
  workspaceJobCarrier.settle.seed_written(claim, {
    anchorId: workspaceJobSettlementRef("seed_written", spec.runId, spec.requestedEventId),
    anchorKind: "carrier_proof",
    carrierRef: workspaceJobSettlementRef("carrier", "workspace-job"),
  });

export const settleWorkspaceJobTerminalBuildAttempted = (
  claim: PreClaim,
  spec: {
    readonly runId: string;
    readonly requestedEventId: number;
    readonly sha256: string;
  },
): LivedClaim =>
  workspaceJobCarrier.settle.terminal_build_attempted(claim, {
    anchorId: workspaceJobSettlementRef(
      "terminal_build_attempted",
      spec.runId,
      spec.requestedEventId,
      spec.sha256,
    ),
    anchorKind: "carrier_proof",
    carrierRef: workspaceJobSettlementRef("carrier", "workspace-job"),
  });

export const settleWorkspaceJobArtifactWritten = (
  claim: PreClaim,
  spec: {
    readonly runId: string;
    readonly requestedEventId: number;
    readonly artifactRef: string;
  },
): LivedClaim =>
  workspaceJobCarrier.settle.artifact_written(claim, {
    anchorId: workspaceJobSettlementRef(
      "artifact_written",
      spec.runId,
      spec.requestedEventId,
      spec.artifactRef,
    ),
    anchorKind: "carrier_proof",
    carrierRef: workspaceJobSettlementRef("carrier", "workspace-job"),
  });

export const settleWorkspaceJobArtifactReadbackVerified = (
  claim: PreClaim,
  spec: {
    readonly runId: string;
    readonly requestedEventId: number;
    readonly artifactRef: string;
    readonly sha256: string;
  },
): LivedClaim =>
  workspaceJobCarrier.settle.artifact_readback_verified(claim, {
    anchorId: workspaceJobSettlementRef(
      "artifact_readback_verified",
      spec.runId,
      spec.requestedEventId,
      spec.artifactRef,
      spec.sha256,
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

export const settleWorkspaceJobReconcileRequired = (
  claim: PreClaim,
  spec: {
    readonly runId: string;
    readonly requestedEventId: number;
    readonly indeterminateKind?: Extract<
      IndeterminateRef["indeterminateKind"],
      "reconcile_required" | "witness_unavailable" | "retry_pending"
    >;
  },
): IndeterminateClaim =>
  workspaceJobCarrier.indeterminate.reconcile_required(claim, {
    indeterminateId: workspaceJobSettlementRef(
      "reconcile_required",
      spec.runId,
      spec.requestedEventId,
    ),
    indeterminateKind: spec.indeterminateKind ?? "reconcile_required",
    reason: workspaceJobSettlementRef(
      "reason",
      "reconcile_required",
      spec.runId,
      spec.requestedEventId,
    ),
    carrierRef: workspaceJobSettlementRef("carrier", "workspace-job"),
  });
