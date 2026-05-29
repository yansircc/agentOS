import type {
  AnchorRef,
  LivedClaim,
  PreClaim,
  RejectedClaim,
  RejectionRef,
} from "@agent-os/kernel/effect-claim";
import {
  defineSettlementContract,
  isSymbolicSettlementValue,
  settleLived,
  settleRejected,
  symbolicSettlementRef,
} from "@agent-os/kernel/settlement-contract";

export const deploySettlementContract = defineSettlementContract({
  settlementId: "@agent-os/deploy",
  anchorKinds: ["carrier_proof", "external_receipt"],
  rejectionKinds: ["provider_rejected", "policy_denied", "validation_failed"],
});

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
  settleLived(deploySettlementContract, claim, {
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
  settleRejected(deploySettlementContract, claim, {
    rejectionId: spec.proofRef,
    rejectionKind: spec.rejectionKind ?? "provider_rejected",
    reason: isSymbolicSettlementValue(spec.reason) ? spec.reason : "deploy_failed",
  });
