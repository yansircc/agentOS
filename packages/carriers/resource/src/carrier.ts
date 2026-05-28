import type { Effect } from "effect";
import type { PreClaim, RejectedClaim } from "@agent-os/kernel/effect-claim";
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
} from "./events";

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

export interface ResourceFailure {
  readonly code:
    | "MaterialUnavailable"
    | "PolicyDenied"
    | "ProvisionFailed"
    | "BindingFailed"
    | "MutationFailed"
    | "DestroyFailed"
    | "ProviderFailure"
    | "UnsupportedResource";
  readonly step: ResourceLifecycleStep;
  readonly reason: string;
  readonly proofRef?: string;
  readonly claim: RejectedClaim;
}

export interface ResourceCarrier {
  readonly provision: (
    request: ResourceProvisionRequest,
  ) => Effect.Effect<ResourceProvisionedPayload, ResourceFailure>;
  readonly bind: (
    request: ResourceBindRequest,
  ) => Effect.Effect<ResourceBoundPayload, ResourceFailure>;
  readonly mutate: (
    request: ResourceMutationRequest,
  ) => Effect.Effect<ResourceMutationRecordedPayload, ResourceFailure>;
  readonly destroy: (
    request: ResourceDestroyRequest,
  ) => Effect.Effect<ResourceDestroyedPayload, ResourceFailure>;
}

export const resourceFailedPayload = (
  failure: ResourceFailure,
  subjectRef: string,
): ResourceFailedPayload => ({
  subjectRef,
  step: failure.step,
  reason: failure.reason,
  claim: failure.claim,
  ...(failure.proofRef === undefined ? {} : { proofRef: failure.proofRef }),
});
