import type { Effect } from "effect";
import type { PreClaim, RejectedClaim } from "@agent-os/core/effect-claim";
import type {
  BindingMaterialRef,
  ExternalResourceMaterialRef,
  MaterialRef,
} from "@agent-os/core/material-ref";

import type {
  CloudflareResourceBoundPayload,
  CloudflareResourceDestroyedPayload,
  CloudflareResourceFailedPayload,
  CloudflareResourceLifecycleStep,
  CloudflareResourceMutationRecordedPayload,
  CloudflareResourceProvisionedPayload,
} from "./events";

export interface CloudflareResourceProvisionRequest {
  readonly claim: PreClaim;
  readonly subjectRef: string;
  readonly resourceKind: string;
  readonly accountRef?: ExternalResourceMaterialRef;
  readonly bindingRef?: BindingMaterialRef;
}

export interface CloudflareResourceBindRequest {
  readonly claim: PreClaim;
  readonly subjectRef: string;
  readonly resourceRef: ExternalResourceMaterialRef;
  readonly bindingRef: BindingMaterialRef;
}

export interface CloudflareResourceMutationRequest {
  readonly claim: PreClaim;
  readonly subjectRef: string;
  readonly resourceRef: MaterialRef;
  readonly mutationKind: string;
  readonly inputRef?: string;
  readonly fingerprint?: string;
}

export interface CloudflareResourceDestroyRequest {
  readonly claim: PreClaim;
  readonly subjectRef: string;
  readonly resourceRef: MaterialRef;
  readonly reason: CloudflareResourceDestroyedPayload["reason"];
}

export interface CloudflareResourceFailure {
  readonly code:
    | "MaterialUnavailable"
    | "PolicyDenied"
    | "ProvisionFailed"
    | "BindingFailed"
    | "MutationFailed"
    | "DestroyFailed"
    | "ProviderFailure";
  readonly step: CloudflareResourceLifecycleStep;
  readonly reason: string;
  readonly proofRef?: string;
  readonly claim: RejectedClaim;
}

export interface CloudflareResourceCarrier {
  readonly provision: (
    request: CloudflareResourceProvisionRequest,
  ) => Effect.Effect<CloudflareResourceProvisionedPayload, CloudflareResourceFailure>;
  readonly bind: (
    request: CloudflareResourceBindRequest,
  ) => Effect.Effect<CloudflareResourceBoundPayload, CloudflareResourceFailure>;
  readonly mutate: (
    request: CloudflareResourceMutationRequest,
  ) => Effect.Effect<CloudflareResourceMutationRecordedPayload, CloudflareResourceFailure>;
  readonly destroy: (
    request: CloudflareResourceDestroyRequest,
  ) => Effect.Effect<CloudflareResourceDestroyedPayload, CloudflareResourceFailure>;
}

export const cloudflareResourceFailedPayload = (
  failure: CloudflareResourceFailure,
  subjectRef: string,
): CloudflareResourceFailedPayload => ({
  subjectRef,
  step: failure.step,
  reason: failure.reason,
  claim: failure.claim,
  ...(failure.proofRef === undefined ? {} : { proofRef: failure.proofRef }),
});
