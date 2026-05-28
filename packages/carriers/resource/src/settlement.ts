import type { RejectionRef } from "@agent-os/kernel/effect-claim";
import { settleRejectedClaim, type PreClaim } from "@agent-os/kernel/effect-claim";
import type { ExtensionCapability } from "@agent-os/kernel/extensions";

import type { ResourceFailure } from "./carrier";
import {
  RESOURCE_EVENTS,
  type ResourceBoundPayload,
  type ResourceDestroyedPayload,
  type ResourceFailedPayload,
  type ResourceMutationRecordedPayload,
  type ResourceProvisionedPayload,
} from "./events";

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

export const commitResourceProvisioned = (
  cap: ExtensionCapability,
  payload: ResourceProvisionedPayload,
): Promise<{ readonly id: number }> =>
  cap.commit({ event: RESOURCE_EVENTS.RESOURCE_PROVISIONED, data: payload });

export const commitResourceBound = (
  cap: ExtensionCapability,
  payload: ResourceBoundPayload,
): Promise<{ readonly id: number }> =>
  cap.commit({ event: RESOURCE_EVENTS.RESOURCE_BOUND, data: payload });

export const commitResourceMutationRecorded = (
  cap: ExtensionCapability,
  payload: ResourceMutationRecordedPayload,
): Promise<{ readonly id: number }> =>
  cap.commit({ event: RESOURCE_EVENTS.MUTATION_RECORDED, data: payload });

export const commitResourceDestroyed = (
  cap: ExtensionCapability,
  payload: ResourceDestroyedPayload,
): Promise<{ readonly id: number }> =>
  cap.commit({ event: RESOURCE_EVENTS.RESOURCE_DESTROYED, data: payload });

export const commitResourceFailed = (
  cap: ExtensionCapability,
  payload: ResourceFailedPayload,
): Promise<{ readonly id: number }> =>
  cap.commit({ event: RESOURCE_EVENTS.FAILED, data: payload });
