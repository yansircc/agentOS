import {
  validateEffectClaim,
  type LivedClaim,
  type RejectedClaim,
} from "@agent-os/core/effect-claim";
import {
  isMaterialRef,
  type BindingMaterialRef,
  type ExternalResourceMaterialRef,
  type MaterialRef,
} from "@agent-os/core/material-ref";

import { CLOUDFLARE_RESOURCE_EVENT_VOCABULARY } from "./extension";

export const CLOUDFLARE_RESOURCE_EVENTS = CLOUDFLARE_RESOURCE_EVENT_VOCABULARY;

export type CloudflareResourceEventKind =
  (typeof CLOUDFLARE_RESOURCE_EVENTS)[keyof typeof CLOUDFLARE_RESOURCE_EVENTS];

export type CloudflareResourceLifecycleStep = "provision" | "bind" | "mutate" | "destroy";

export interface CloudflareResourceProvisionedPayload {
  readonly subjectRef: string;
  readonly resourceKind: string;
  readonly resourceRef: ExternalResourceMaterialRef;
  readonly accountRef?: ExternalResourceMaterialRef;
  readonly bindingRef?: BindingMaterialRef;
  readonly proofRef: string;
  readonly claim: LivedClaim;
}

export interface CloudflareResourceBoundPayload {
  readonly subjectRef: string;
  readonly resourceRef: ExternalResourceMaterialRef;
  readonly bindingRef: BindingMaterialRef;
  readonly proofRef: string;
  readonly claim: LivedClaim;
}

export interface CloudflareResourceMutationRecordedPayload {
  readonly subjectRef: string;
  readonly resourceRef: MaterialRef;
  readonly mutationKind: string;
  readonly mutationRef: string;
  readonly proofRef: string;
  readonly fingerprint?: string;
  readonly claim: LivedClaim;
}

export interface CloudflareResourceDestroyedPayload {
  readonly subjectRef: string;
  readonly resourceRef: MaterialRef;
  readonly proofRef: string;
  readonly reason: "replaced" | "expired" | "aborted" | "manual";
  readonly claim: LivedClaim;
}

export interface CloudflareResourceFailedPayload {
  readonly subjectRef: string;
  readonly step: CloudflareResourceLifecycleStep;
  readonly proofRef?: string;
  readonly reason: string;
  readonly claim: RejectedClaim;
}

export interface CloudflareResourceLedgerEvent {
  readonly id: number;
  readonly kind: string;
  readonly payload: unknown;
}

export interface CloudflareResourceMutationFact extends CloudflareResourceMutationRecordedPayload {
  readonly eventId: number;
}

export interface CloudflareResourceProjection {
  readonly subjectRef: string;
  readonly status: "missing" | "active" | "mutated" | "destroyed" | "failed";
  readonly lastEventKind?: CloudflareResourceEventKind;
  readonly resourceKind?: string;
  readonly resourceRef?: MaterialRef;
  readonly accountRef?: ExternalResourceMaterialRef;
  readonly bindingRef?: BindingMaterialRef;
  readonly latestMutation?: CloudflareResourceMutationFact;
  readonly mutationEventIds: ReadonlyArray<number>;
  readonly failure?: CloudflareResourceFailedPayload;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const stringField = (payload: Record<string, unknown>, key: string): string | undefined =>
  typeof payload[key] === "string" ? payload[key] : undefined;

const livedClaimFrom = (value: unknown): LivedClaim | undefined => {
  const result = validateEffectClaim(value);
  return result.ok && result.claim.phase === "lived" ? result.claim : undefined;
};

const rejectedClaimFrom = (value: unknown): RejectedClaim | undefined => {
  const result = validateEffectClaim(value);
  return result.ok && result.claim.phase === "rejected" ? result.claim : undefined;
};

const externalResourceRefFrom = (value: unknown): ExternalResourceMaterialRef | undefined =>
  isMaterialRef(value) && value.kind === "external_resource" ? value : undefined;

const bindingRefFrom = (value: unknown): BindingMaterialRef | undefined =>
  isMaterialRef(value) && value.kind === "binding" ? value : undefined;

const materialRefFrom = (value: unknown): MaterialRef | undefined =>
  isMaterialRef(value) ? value : undefined;

const lifecycleStepFrom = (value: unknown): CloudflareResourceLifecycleStep | undefined =>
  value === "provision" || value === "bind" || value === "mutate" || value === "destroy"
    ? value
    : undefined;

const destroyReasonFrom = (
  value: unknown,
): CloudflareResourceDestroyedPayload["reason"] | undefined =>
  value === "replaced" || value === "expired" || value === "aborted" || value === "manual"
    ? value
    : undefined;

const mutationPayloadFrom = (
  event: CloudflareResourceLedgerEvent,
): CloudflareResourceMutationFact | undefined => {
  if (!isRecord(event.payload)) return undefined;
  const subjectRef = stringField(event.payload, "subjectRef");
  const resourceRef = materialRefFrom(event.payload.resourceRef);
  const mutationKind = stringField(event.payload, "mutationKind");
  const mutationRef = stringField(event.payload, "mutationRef");
  const proofRef = stringField(event.payload, "proofRef");
  const claim = livedClaimFrom(event.payload.claim);
  if (
    subjectRef === undefined ||
    resourceRef === undefined ||
    mutationKind === undefined ||
    mutationRef === undefined ||
    proofRef === undefined ||
    claim === undefined
  ) {
    return undefined;
  }
  return {
    eventId: event.id,
    subjectRef,
    resourceRef,
    mutationKind,
    mutationRef,
    proofRef,
    claim,
    ...(typeof event.payload.fingerprint === "string"
      ? { fingerprint: event.payload.fingerprint }
      : {}),
  };
};

const failedPayloadFrom = (
  payload: Record<string, unknown>,
): CloudflareResourceFailedPayload | undefined => {
  const subjectRef = stringField(payload, "subjectRef");
  const step = lifecycleStepFrom(payload.step);
  const reason = stringField(payload, "reason");
  const claim = rejectedClaimFrom(payload.claim);
  if (
    subjectRef === undefined ||
    step === undefined ||
    reason === undefined ||
    claim === undefined
  ) {
    return undefined;
  }
  return {
    subjectRef,
    step,
    reason,
    claim,
    ...(typeof payload.proofRef === "string" ? { proofRef: payload.proofRef } : {}),
  };
};

const materialRefEquals = (left: MaterialRef | undefined, right: MaterialRef): boolean => {
  if (left === undefined || left.kind !== right.kind) return false;
  switch (left.kind) {
    case "credential":
      return (
        right.kind === "credential" &&
        left.ref === right.ref &&
        left.provider === right.provider &&
        left.purpose === right.purpose
      );
    case "endpoint":
      return right.kind === "endpoint" && left.ref === right.ref && left.protocol === right.protocol;
    case "binding":
      return (
        right.kind === "binding" &&
        left.provider === right.provider &&
        left.bindingKind === right.bindingKind &&
        left.ref === right.ref
      );
    case "external_resource":
      return (
        right.kind === "external_resource" &&
        left.provider === right.provider &&
        left.resourceKind === right.resourceKind &&
        left.ref === right.ref
      );
  }
};

const hasLiveResource = (
  status: CloudflareResourceProjection["status"],
  provisionedResourceRef: ExternalResourceMaterialRef | undefined,
): boolean => status !== "missing" && status !== "destroyed" && provisionedResourceRef !== undefined;

export const projectCloudflareResource = (
  events: Iterable<CloudflareResourceLedgerEvent>,
  subjectRef: string,
): CloudflareResourceProjection => {
  let status: CloudflareResourceProjection["status"] = "missing";
  let lastEventKind: CloudflareResourceEventKind | undefined;
  let resourceKind: string | undefined;
  let provisionedResourceRef: ExternalResourceMaterialRef | undefined;
  let resourceRef: MaterialRef | undefined;
  let accountRef: ExternalResourceMaterialRef | undefined;
  let bindingRef: BindingMaterialRef | undefined;
  let latestMutation: CloudflareResourceMutationFact | undefined;
  let failure: CloudflareResourceFailedPayload | undefined;
  const mutationEventIds: number[] = [];

  for (const event of events) {
    if (!isRecord(event.payload)) continue;
    if (event.payload.subjectRef !== subjectRef) continue;
    switch (event.kind) {
      case CLOUDFLARE_RESOURCE_EVENTS.RESOURCE_PROVISIONED: {
        const nextResourceRef = externalResourceRefFrom(event.payload.resourceRef);
        const nextResourceKind = stringField(event.payload, "resourceKind");
        const proofRef = stringField(event.payload, "proofRef");
        const claim = livedClaimFrom(event.payload.claim);
        if (
          nextResourceRef === undefined ||
          nextResourceKind === undefined ||
          proofRef === undefined ||
          claim === undefined
        ) {
          break;
        }
        resourceKind = nextResourceKind;
        provisionedResourceRef = nextResourceRef;
        resourceRef = nextResourceRef;
        accountRef = externalResourceRefFrom(event.payload.accountRef);
        bindingRef = bindingRefFrom(event.payload.bindingRef);
        status = "active";
        lastEventKind = event.kind;
        failure = undefined;
        break;
      }
      case CLOUDFLARE_RESOURCE_EVENTS.RESOURCE_BOUND: {
        const nextResourceRef = externalResourceRefFrom(event.payload.resourceRef);
        const nextBindingRef = bindingRefFrom(event.payload.bindingRef);
        const proofRef = stringField(event.payload, "proofRef");
        const claim = livedClaimFrom(event.payload.claim);
        if (
          nextResourceRef === undefined ||
          nextBindingRef === undefined ||
          proofRef === undefined ||
          claim === undefined ||
          !hasLiveResource(status, provisionedResourceRef) ||
          !materialRefEquals(provisionedResourceRef, nextResourceRef)
        ) {
          break;
        }
        resourceRef = nextResourceRef;
        bindingRef = nextBindingRef;
        status = "active";
        lastEventKind = event.kind;
        failure = undefined;
        break;
      }
      case CLOUDFLARE_RESOURCE_EVENTS.MUTATION_RECORDED: {
        const mutation = mutationPayloadFrom(event);
        if (mutation === undefined) break;
        if (
          !hasLiveResource(status, provisionedResourceRef) ||
          bindingRef === undefined ||
          (!materialRefEquals(bindingRef, mutation.resourceRef) &&
            !materialRefEquals(provisionedResourceRef, mutation.resourceRef))
        ) {
          break;
        }
        resourceRef = mutation.resourceRef;
        latestMutation = mutation;
        mutationEventIds.push(event.id);
        status = "mutated";
        lastEventKind = event.kind;
        failure = undefined;
        break;
      }
      case CLOUDFLARE_RESOURCE_EVENTS.RESOURCE_DESTROYED: {
        const nextResourceRef = materialRefFrom(event.payload.resourceRef);
        const proofRef = stringField(event.payload, "proofRef");
        const reason = destroyReasonFrom(event.payload.reason);
        const claim = livedClaimFrom(event.payload.claim);
        if (
          nextResourceRef === undefined ||
          proofRef === undefined ||
          reason === undefined ||
          claim === undefined ||
          !hasLiveResource(status, provisionedResourceRef) ||
          (!materialRefEquals(provisionedResourceRef, nextResourceRef) &&
            !materialRefEquals(bindingRef, nextResourceRef))
        ) {
          break;
        }
        resourceRef = nextResourceRef;
        status = "destroyed";
        lastEventKind = event.kind;
        failure = undefined;
        break;
      }
      case CLOUDFLARE_RESOURCE_EVENTS.FAILED: {
        const nextFailure = failedPayloadFrom(event.payload);
        if (nextFailure === undefined) break;
        failure = nextFailure;
        status = "failed";
        lastEventKind = event.kind;
        break;
      }
    }
  }

  return {
    subjectRef,
    status,
    lastEventKind,
    resourceKind,
    resourceRef,
    accountRef,
    bindingRef,
    latestMutation,
    mutationEventIds,
    failure,
  };
};
