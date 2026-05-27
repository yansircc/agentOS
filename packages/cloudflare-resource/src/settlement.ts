import type { RejectionRef } from "@agent-os/core/effect-claim";
import { settleRejectedClaim, type PreClaim } from "@agent-os/core/effect-claim";
import type { ExtensionCapability } from "@agent-os/core/extensions";

import type { CloudflareResourceFailure } from "./carrier";
import {
  CLOUDFLARE_RESOURCE_EVENTS,
  type CloudflareResourceBoundPayload,
  type CloudflareResourceDestroyedPayload,
  type CloudflareResourceFailedPayload,
  type CloudflareResourceMutationRecordedPayload,
  type CloudflareResourceProvisionedPayload,
} from "./events";

export const cloudflareResourceRejectionKind = (
  code: CloudflareResourceFailure["code"],
): RejectionRef["rejectionKind"] =>
  code === "UnsupportedResource"
    ? "unsupported"
    : code === "MaterialUnavailable"
      ? "resource_denied"
      : code === "PolicyDenied"
        ? "policy_denied"
      : "provider_rejected";

export const settleCloudflareResourceRejected = (
  claim: PreClaim,
  spec: {
    readonly code: CloudflareResourceFailure["code"];
    readonly reason: string;
    readonly proofRef?: string;
    readonly rejectionKind?: RejectionRef["rejectionKind"];
  },
): CloudflareResourceFailure["claim"] =>
  settleRejectedClaim(claim, {
    rejectionId: spec.proofRef ?? `${claim.operationRef}:rejected`,
    rejectionKind: spec.rejectionKind ?? cloudflareResourceRejectionKind(spec.code),
    reason: spec.reason,
  });

export const commitCloudflareResourceProvisioned = (
  cap: ExtensionCapability,
  payload: CloudflareResourceProvisionedPayload,
): Promise<{ readonly id: number }> =>
  cap.commit({ event: CLOUDFLARE_RESOURCE_EVENTS.RESOURCE_PROVISIONED, data: payload });

export const commitCloudflareResourceBound = (
  cap: ExtensionCapability,
  payload: CloudflareResourceBoundPayload,
): Promise<{ readonly id: number }> =>
  cap.commit({ event: CLOUDFLARE_RESOURCE_EVENTS.RESOURCE_BOUND, data: payload });

export const commitCloudflareResourceMutationRecorded = (
  cap: ExtensionCapability,
  payload: CloudflareResourceMutationRecordedPayload,
): Promise<{ readonly id: number }> =>
  cap.commit({ event: CLOUDFLARE_RESOURCE_EVENTS.MUTATION_RECORDED, data: payload });

export const commitCloudflareResourceDestroyed = (
  cap: ExtensionCapability,
  payload: CloudflareResourceDestroyedPayload,
): Promise<{ readonly id: number }> =>
  cap.commit({ event: CLOUDFLARE_RESOURCE_EVENTS.RESOURCE_DESTROYED, data: payload });

export const commitCloudflareResourceFailed = (
  cap: ExtensionCapability,
  payload: CloudflareResourceFailedPayload,
): Promise<{ readonly id: number }> =>
  cap.commit({ event: CLOUDFLARE_RESOURCE_EVENTS.FAILED, data: payload });
