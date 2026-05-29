import type {
  AnchorRef,
  LivedClaim,
  PreClaim,
  RejectedClaim,
  RejectionRef,
} from "@agent-os/kernel/effect-claim";
import {
  isSymbolicSettlementValue,
  symbolicSettlementRef,
} from "@agent-os/kernel/settlement-contract";

import { resourceCarrierDefinition } from "./definition";
import type { ResourceFailure } from "./carrier";

export const resourceSettlementRef = (...parts: ReadonlyArray<string | number>): string =>
  symbolicSettlementRef("resource", parts);

export const resourceRejectionKind = (
  code: ResourceFailure["code"],
): RejectionRef["rejectionKind"] =>
  code === "UnsupportedResource"
    ? "unsupported"
    : code === "MaterialUnavailable"
      ? "resource_denied"
      : code === "PolicyDenied"
        ? "policy_denied"
        : "provider_rejected";

export const settleResourceLived = (
  claim: PreClaim,
  spec: {
    readonly proofRef: string;
    readonly carrierRef: string;
    readonly anchorKind?: AnchorRef["anchorKind"];
  },
): LivedClaim =>
  resourceCarrierDefinition.settle.resource_provisioned(claim, {
    anchorId: spec.proofRef,
    anchorKind: spec.anchorKind ?? "carrier_proof",
    carrierRef: spec.carrierRef,
  });

export const settleResourceRejected = (
  claim: PreClaim,
  spec: {
    readonly code: ResourceFailure["code"];
    readonly reason: string;
    readonly proofRef?: string;
    readonly rejectionKind?: RejectionRef["rejectionKind"];
  },
): RejectedClaim =>
  resourceCarrierDefinition.reject.failed(claim, {
    rejectionId: spec.proofRef ?? resourceSettlementRef(claim.operationRef, "rejected"),
    rejectionKind: spec.rejectionKind ?? resourceRejectionKind(spec.code),
    reason: isSymbolicSettlementValue(spec.reason) ? spec.reason : `resource_${spec.code}`,
  });
