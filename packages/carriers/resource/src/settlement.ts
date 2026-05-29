import type { RejectionRef } from "@agent-os/kernel/effect-claim";
import { settleRejectedClaim, type PreClaim } from "@agent-os/kernel/effect-claim";

import type { ResourceFailure } from "./carrier";

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

export const settleResourceRejected = (
  claim: PreClaim,
  spec: {
    readonly code: ResourceFailure["code"];
    readonly reason: string;
    readonly proofRef?: string;
    readonly rejectionKind?: RejectionRef["rejectionKind"];
  },
): ResourceFailure["claim"] =>
  settleRejectedClaim(claim, {
    rejectionId: spec.proofRef ?? `${claim.operationRef}:rejected`,
    rejectionKind: spec.rejectionKind ?? resourceRejectionKind(spec.code),
    reason: spec.reason,
  });
