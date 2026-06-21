import type { Effect as EffectType } from "effect";
import type { IndeterminateClaim, PreClaim, RejectedClaim } from "@agent-os/kernel/effect-claim";
import type {
  CredentialMaterialRef,
  BindingMaterialRef,
  ExternalResourceMaterialRef,
  MaterialRef,
} from "@agent-os/kernel/material-ref";

import type {
  ResourceBoundPayload,
  ResourceDestroyedPayload,
  ResourceFailedPayload,
  ResourceLifecycleStep,
  ResourceMutationRecordedPayload,
  ResourceProvisionedPayload,
  ResourceReconcileRequiredPayload,
} from "./events";
import { RESOURCE_KIND } from "./definition";

export interface ResourceProvisionRequest {
  readonly claim: PreClaim;
  readonly subjectRef: string;
  readonly resourceKind: string;
  readonly resourceName: string;
  readonly credentialRef: CredentialMaterialRef;
  readonly accountRef: ExternalResourceMaterialRef;
  readonly resourceRef?: ExternalResourceMaterialRef;
  readonly bindingRef?: BindingMaterialRef;
}

export interface ResourceBindRequest {
  readonly claim: PreClaim;
  readonly subjectRef: string;
  readonly credentialRef: CredentialMaterialRef;
  readonly accountRef: ExternalResourceMaterialRef;
  readonly resourceRef: ExternalResourceMaterialRef;
  readonly bindingRef: BindingMaterialRef;
}

export interface ResourceMutationRequest {
  readonly claim: PreClaim;
  readonly subjectRef: string;
  readonly credentialRef: CredentialMaterialRef;
  readonly accountRef: ExternalResourceMaterialRef;
  readonly resourceRef: MaterialRef;
  readonly bindingRef: BindingMaterialRef;
  readonly mutationKind: string;
  readonly inputRef: string;
  readonly fingerprint?: string;
}

export interface ResourceDestroyRequest {
  readonly claim: PreClaim;
  readonly subjectRef: string;
  readonly credentialRef: CredentialMaterialRef;
  readonly accountRef: ExternalResourceMaterialRef;
  readonly resourceRef: MaterialRef;
  readonly reason: ResourceDestroyedPayload["reason"];
}

export type ResourceFailureCode =
  | "MaterialUnavailable"
  | "PolicyDenied"
  | "ProvisionFailed"
  | "BindingFailed"
  | "MutationFailed"
  | "DestroyFailed"
  | "ProviderFailure"
  | "UnsupportedResource";

interface ResourceFailureBase {
  readonly code: ResourceFailureCode;
  readonly step: ResourceLifecycleStep;
  readonly reason: string;
}

export interface ResourceRejectedFailure extends ResourceFailureBase {
  readonly proofRef?: string;
  readonly claim: RejectedClaim;
}

export interface ResourceIndeterminateFailure extends ResourceFailureBase {
  readonly proofRef: string;
  readonly claim: IndeterminateClaim;
}

export type ResourceFailure = ResourceRejectedFailure | ResourceIndeterminateFailure;

const isResourceIndeterminateFailure = (
  failure: ResourceFailure,
): failure is ResourceIndeterminateFailure => failure.claim.phase === "indeterminate";

export interface ResourceCarrier {
  readonly provision: (
    request: ResourceProvisionRequest,
  ) => EffectType.Effect<ResourceProvisionedPayload, ResourceFailure>;
  readonly bind: (
    request: ResourceBindRequest,
  ) => EffectType.Effect<ResourceBoundPayload, ResourceFailure>;
  readonly mutate: (
    request: ResourceMutationRequest,
  ) => EffectType.Effect<ResourceMutationRecordedPayload, ResourceFailure>;
  readonly destroy: (
    request: ResourceDestroyRequest,
  ) => EffectType.Effect<ResourceDestroyedPayload, ResourceFailure>;
}

export const resourceFailedPayload = (
  failure: ResourceFailure,
  subjectRef: string,
): ResourceFailedPayload | ResourceReconcileRequiredPayload => {
  if (isResourceIndeterminateFailure(failure)) {
    return {
      subjectRef,
      step: failure.step,
      reason: failure.reason,
      proofRef: failure.proofRef,
      claim: failure.claim,
    };
  }
  return {
    subjectRef,
    step: failure.step,
    reason: failure.reason,
    claim: failure.claim,
    ...(failure.proofRef === undefined ? {} : { proofRef: failure.proofRef }),
  };
};

export const resourceFailureEventKind = (
  failure: ResourceFailure,
): typeof RESOURCE_KIND.FAILED | typeof RESOURCE_KIND.RECONCILE_REQUIRED =>
  failure.claim.phase === "indeterminate" ? RESOURCE_KIND.RECONCILE_REQUIRED : RESOURCE_KIND.FAILED;
