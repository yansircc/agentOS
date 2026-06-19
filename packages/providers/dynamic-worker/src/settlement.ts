import type {
  IndeterminateClaim,
  IndeterminateRef,
  LivedClaim,
  PreClaim,
  RejectedClaim,
  RejectionRef,
} from "@agent-os/kernel/effect-claim";
import {
  defineSettlementContract,
  isSymbolicSettlementValue,
  settleIndeterminate,
  settleLived,
  settleRejected,
  symbolicSettlementRef,
} from "@agent-os/kernel/settlement-contract";

import type { DynamicWorkerProviderFailure } from "./types";

export const dynamicWorkerSettlementContract = defineSettlementContract({
  settlementId: "@agent-os/dynamic-worker",
  anchorKinds: ["carrier_proof"],
  rejectionKinds: ["policy_denied", "resource_denied", "provider_rejected"],
  indeterminateKinds: ["provider_pending", "reconcile_required", "witness_unavailable"],
});

export const dynamicWorkerCarrierRef = "dynamic-worker" as const;

export const dynamicWorkerSettlementRef = (...parts: ReadonlyArray<string | number>): string =>
  symbolicSettlementRef("dynamic_worker", parts);

export const dynamicWorkerProviderRejectionKind = (
  failure: DynamicWorkerProviderFailure,
): RejectionRef["rejectionKind"] =>
  failure.code === "ResourceLimitExceeded" ? "resource_denied" : "provider_rejected";

export const dynamicWorkerFailureReason = (failure: DynamicWorkerProviderFailure): string =>
  isSymbolicSettlementValue(failure.reason) ? failure.reason : `dynamic_worker_${failure.code}`;

export const settleDynamicWorkerRejected = (
  claim: PreClaim,
  spec: {
    readonly rejectionKind: RejectionRef["rejectionKind"];
    readonly reason: string;
  },
): RejectedClaim =>
  settleRejected(dynamicWorkerSettlementContract, claim, {
    rejectionId: dynamicWorkerSettlementRef(claim.operationRef, "rejected"),
    rejectionKind: spec.rejectionKind,
    reason: isSymbolicSettlementValue(spec.reason)
      ? spec.reason
      : dynamicWorkerSettlementRef(spec.rejectionKind),
  });

export const settleDynamicWorkerPolicyDenied = (claim: PreClaim, reason: string): RejectedClaim =>
  settleDynamicWorkerRejected(claim, {
    rejectionKind: "policy_denied",
    reason,
  });

export const settleDynamicWorkerProviderFailure = (
  claim: PreClaim,
  failure: DynamicWorkerProviderFailure,
): RejectedClaim =>
  settleDynamicWorkerRejected(claim, {
    rejectionKind: dynamicWorkerProviderRejectionKind(failure),
    reason: dynamicWorkerFailureReason(failure),
  });

export const settleDynamicWorkerLived = (
  claim: PreClaim,
  spec: {
    readonly workerId: string;
  },
): LivedClaim =>
  settleLived(dynamicWorkerSettlementContract, claim, {
    anchorId: dynamicWorkerSettlementRef(spec.workerId),
    anchorKind: "carrier_proof",
    carrierRef: dynamicWorkerCarrierRef,
  });

export const settleDynamicWorkerIndeterminate = (
  claim: PreClaim,
  spec: {
    readonly indeterminateId: string;
    readonly indeterminateKind?: IndeterminateRef["indeterminateKind"];
    readonly reason?: string;
  },
): IndeterminateClaim =>
  settleIndeterminate(dynamicWorkerSettlementContract, claim, {
    indeterminateId: dynamicWorkerSettlementRef(spec.indeterminateId),
    indeterminateKind: spec.indeterminateKind ?? "provider_pending",
    reason:
      spec.reason === undefined
        ? "provider_pending"
        : isSymbolicSettlementValue(spec.reason)
          ? spec.reason
          : dynamicWorkerSettlementRef(spec.indeterminateKind ?? "provider_pending"),
    carrierRef: dynamicWorkerCarrierRef,
  });
