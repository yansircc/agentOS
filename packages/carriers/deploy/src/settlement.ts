import type {
  AnchorRef,
  IndeterminateClaim,
  IndeterminateRef,
  LivedClaim,
  PreClaim,
  RejectedClaim,
  RejectionRef,
} from "@agent-os/core/effect-claim";
import {
  isSymbolicSettlementValue,
  symbolicSettlementRef,
} from "@agent-os/core/settlement-contract";
import { deployCarrier } from "./definition";

export const deploySettlementRef = (...parts: ReadonlyArray<string | number>): string =>
  symbolicSettlementRef("deploy", parts);

export const settleDeployLived = (
  claim: PreClaim,
  spec: {
    readonly proofRef: string;
    readonly carrierRef?: string;
    readonly anchorKind?: AnchorRef["anchorKind"];
  },
): LivedClaim =>
  deployCarrier.settle.preview_recorded(claim, {
    anchorId: spec.proofRef,
    anchorKind: spec.anchorKind ?? "carrier_proof",
    ...(spec.carrierRef === undefined ? {} : { carrierRef: spec.carrierRef }),
  });

export const settleDeployRejected = (
  claim: PreClaim,
  spec: {
    readonly proofRef: string;
    readonly reason: string;
    readonly rejectionKind?: RejectionRef["rejectionKind"];
  },
): RejectedClaim =>
  deployCarrier.reject.failed(claim, {
    rejectionId: spec.proofRef,
    rejectionKind: spec.rejectionKind ?? "provider_rejected",
    reason: isSymbolicSettlementValue(spec.reason) ? spec.reason : "deploy_failed",
  });

export const settleDeployIndeterminate = (
  claim: PreClaim,
  spec: {
    readonly proofRef: string;
    readonly reason: string;
    readonly indeterminateKind?: IndeterminateRef["indeterminateKind"];
  },
): IndeterminateClaim =>
  deployCarrier.indeterminate.reconcile_required(claim, {
    indeterminateId: spec.proofRef,
    indeterminateKind: spec.indeterminateKind ?? "reconcile_required",
    reason: isSymbolicSettlementValue(spec.reason) ? spec.reason : "deploy_reconcile_required",
  });
