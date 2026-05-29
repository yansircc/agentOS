import type { LivedClaim, PreClaim } from "@agent-os/kernel/effect-claim";
import { symbolicSettlementRef } from "@agent-os/kernel/settlement-contract";
import { gitCarrier, gitSettlementContract } from "./definition";

export const gitSettlementRef = (...parts: ReadonlyArray<string | number>): string =>
  symbolicSettlementRef("git", parts);

export const settleGitLived = (
  claim: PreClaim,
  spec: {
    readonly proofRef: string;
    readonly carrierRef?: string;
  },
): LivedClaim =>
  gitCarrier.settle.commit_recorded(claim, {
    anchorId: spec.proofRef,
    ...(spec.carrierRef === undefined ? {} : { carrierRef: spec.carrierRef }),
  });
