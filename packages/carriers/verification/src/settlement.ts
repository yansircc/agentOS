import type { AnchorRef, LivedClaim, PreClaim } from "@agent-os/kernel/effect-claim";
import {
  defineSettlementContract,
  settleLived,
  symbolicSettlementRef,
} from "@agent-os/kernel/settlement-contract";

export const verificationSettlementContract = defineSettlementContract({
  settlementId: "@agent-os/verification",
  anchorKinds: ["carrier_proof", "external_receipt"],
  rejectionKinds: [],
});

export const verificationSettlementRef = (...parts: ReadonlyArray<string | number>): string =>
  symbolicSettlementRef("verification", parts);

export const settleVerificationLived = (
  claim: PreClaim,
  spec: {
    readonly proofRef: string;
    readonly carrierRef?: string;
    readonly anchorKind?: AnchorRef["anchorKind"];
  },
): LivedClaim =>
  settleLived(verificationSettlementContract, claim, {
    anchorId: spec.proofRef,
    anchorKind: spec.anchorKind ?? "carrier_proof",
    ...(spec.carrierRef === undefined ? {} : { carrierRef: spec.carrierRef }),
  });
