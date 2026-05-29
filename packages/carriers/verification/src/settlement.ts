import type { AnchorRef, LivedClaim, PreClaim } from "@agent-os/kernel/effect-claim";
import { symbolicSettlementRef } from "@agent-os/kernel/settlement-contract";
import { verificationCarrier, verificationSettlementContract } from "./definition";

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
  verificationCarrier.settle.gate_recorded(claim, {
    anchorId: spec.proofRef,
    anchorKind: spec.anchorKind ?? "carrier_proof",
    ...(spec.carrierRef === undefined ? {} : { carrierRef: spec.carrierRef }),
  });
