import type { LivedClaim, PreClaim } from "@agent-os/core/effect-claim";
import { symbolicSettlementRef } from "@agent-os/core/settlement-contract";
import { gitCarrier } from "./definition";

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
