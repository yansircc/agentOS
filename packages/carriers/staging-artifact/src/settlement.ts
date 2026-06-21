import type { LivedClaim, PreClaim } from "@agent-os/core/effect-claim";
import { symbolicSettlementRef } from "@agent-os/core/settlement-contract";
import { stagingArtifactCarrier } from "./definition";

export const stagingArtifactSettlementRef = (...parts: ReadonlyArray<string | number>): string =>
  symbolicSettlementRef("staging", parts);

export const settleStagingArtifactLived = (
  claim: PreClaim,
  spec: {
    readonly proofRef: string;
    readonly carrierRef?: string;
  },
): LivedClaim =>
  stagingArtifactCarrier.settle.artifact_published(claim, {
    anchorId: spec.proofRef,
    ...(spec.carrierRef === undefined ? {} : { carrierRef: spec.carrierRef }),
  });
