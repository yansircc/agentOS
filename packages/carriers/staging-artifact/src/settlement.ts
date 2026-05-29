import type { LivedClaim, PreClaim } from "@agent-os/kernel/effect-claim";
import {
  defineSettlementContract,
  settleLived,
  symbolicSettlementRef,
} from "@agent-os/kernel/settlement-contract";

export const stagingArtifactSettlementContract = defineSettlementContract({
  settlementId: "@agent-os/staging-artifact",
  anchorKinds: ["carrier_proof"],
  rejectionKinds: [],
});

export const stagingArtifactSettlementRef = (...parts: ReadonlyArray<string | number>): string =>
  symbolicSettlementRef("staging", parts);

export const settleStagingArtifactLived = (
  claim: PreClaim,
  spec: {
    readonly proofRef: string;
    readonly carrierRef?: string;
  },
): LivedClaim =>
  settleLived(stagingArtifactSettlementContract, claim, {
    anchorId: spec.proofRef,
    anchorKind: "carrier_proof",
    ...(spec.carrierRef === undefined ? {} : { carrierRef: spec.carrierRef }),
  });
