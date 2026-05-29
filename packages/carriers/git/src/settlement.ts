import type { LivedClaim, PreClaim } from "@agent-os/kernel/effect-claim";
import {
  defineSettlementContract,
  settleLived,
  symbolicSettlementRef,
} from "@agent-os/kernel/settlement-contract";

export const gitSettlementContract = defineSettlementContract({
  settlementId: "@agent-os/git-carrier",
  anchorKinds: ["carrier_proof"],
  rejectionKinds: [],
});

export const gitSettlementRef = (...parts: ReadonlyArray<string | number>): string =>
  symbolicSettlementRef("git", parts);

export const settleGitLived = (
  claim: PreClaim,
  spec: {
    readonly proofRef: string;
    readonly carrierRef?: string;
  },
): LivedClaim =>
  settleLived(gitSettlementContract, claim, {
    anchorId: spec.proofRef,
    anchorKind: "carrier_proof",
    ...(spec.carrierRef === undefined ? {} : { carrierRef: spec.carrierRef }),
  });
