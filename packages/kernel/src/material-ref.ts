import { Predicate } from "effect";
import { isAuthorityRef, type AuthorityRef } from "./effect-claim";
import { isNonEmptyString } from "./string-guards";

export interface CredentialMaterialRef {
  readonly kind: "credential";
  readonly ref: string;
  readonly provider?: string;
  readonly purpose?: string;
}

export interface EndpointMaterialRef {
  readonly kind: "endpoint";
  readonly ref: string;
  readonly protocol?: string;
}

export interface BindingMaterialRef {
  readonly kind: "binding";
  readonly provider: string;
  readonly bindingKind: string;
  readonly ref: string;
}

export interface ExternalResourceMaterialRef {
  readonly kind: "external_resource";
  readonly provider: string;
  readonly resourceKind: string;
  readonly ref: string;
}

/**
 * Symbolic material reference kept out of durable claims and browser projections.
 *
 * @agentosPrimitive primitive.kernel.MaterialRef
 * @agentosInvariant invariant.d10.truth-identity
 * @agentosDocs docs/concepts/carriers-and-material.md
 * @public
 */
export type MaterialRef =
  | CredentialMaterialRef
  | EndpointMaterialRef
  | BindingMaterialRef
  | ExternalResourceMaterialRef;

export type MaterialKind = MaterialRef["kind"];

export interface CredentialMaterialRequirement {
  readonly slot: string;
  readonly kind: "credential";
  readonly required: boolean;
  readonly provider?: string;
  readonly purpose?: string;
}

export interface EndpointMaterialRequirement {
  readonly slot: string;
  readonly kind: "endpoint";
  readonly required: boolean;
  readonly protocol?: string;
}

export interface BindingMaterialRequirement {
  readonly slot: string;
  readonly kind: "binding";
  readonly required: boolean;
  readonly provider?: string;
  readonly bindingKind?: string;
}

export interface ExternalResourceMaterialRequirement {
  readonly slot: string;
  readonly kind: "external_resource";
  readonly required: boolean;
  readonly provider?: string;
  readonly resourceKind?: string;
}

export type MaterialRequirement =
  | CredentialMaterialRequirement
  | EndpointMaterialRequirement
  | BindingMaterialRequirement
  | ExternalResourceMaterialRequirement;

export type MaterialRequirementInput =
  | (Omit<CredentialMaterialRequirement, "required"> & {
      readonly required?: boolean;
    })
  | (Omit<EndpointMaterialRequirement, "required"> & {
      readonly required?: boolean;
    })
  | (Omit<BindingMaterialRequirement, "required"> & {
      readonly required?: boolean;
    })
  | (Omit<ExternalResourceMaterialRequirement, "required"> & {
      readonly required?: boolean;
    });

/**
 * Effect authority declaration and its required material slots.
 *
 * @agentosPrimitive primitive.kernel.EffectAuthorityContract
 * @agentosAlias effectAuthorityContract
 * @agentosInvariant invariant.d10.truth-identity
 * @agentosDocs docs/boundary-contract.md
 * @public
 */
export interface EffectAuthorityContract {
  readonly effectAuthorityRef: AuthorityRef;
  readonly requiredMaterials: ReadonlyArray<MaterialRequirement>;
}

export type MaterialValidationIssue =
  | "material_ref_must_be_object"
  | "material_ref_invalid"
  | "material_requirement_must_be_object"
  | "material_requirement_invalid"
  | "authority_contract_must_be_object"
  | "authority_contract_invalid";

const optionalString = (value: unknown): value is string | undefined =>
  value === undefined || typeof value === "string";

const hasOnlyKeys = (value: Record<string, unknown>, keys: ReadonlySet<string>): boolean =>
  Object.keys(value).every((key) => keys.has(key));

const CREDENTIAL_KEYS = new Set(["kind", "ref", "provider", "purpose"]);
const ENDPOINT_KEYS = new Set(["kind", "ref", "protocol"]);
const BINDING_KEYS = new Set(["kind", "provider", "bindingKind", "ref"]);
const EXTERNAL_RESOURCE_KEYS = new Set(["kind", "provider", "resourceKind", "ref"]);

const CREDENTIAL_REQUIREMENT_KEYS = new Set(["slot", "kind", "required", "provider", "purpose"]);
const ENDPOINT_REQUIREMENT_KEYS = new Set(["slot", "kind", "required", "protocol"]);
const BINDING_REQUIREMENT_KEYS = new Set(["slot", "kind", "required", "provider", "bindingKind"]);
const EXTERNAL_RESOURCE_REQUIREMENT_KEYS = new Set([
  "slot",
  "kind",
  "required",
  "provider",
  "resourceKind",
]);

export const credentialMaterialRef = (
  ref: string,
  options: { readonly provider?: string; readonly purpose?: string } = {},
): CredentialMaterialRef => ({
  kind: "credential",
  ref,
  ...(options.provider === undefined ? {} : { provider: options.provider }),
  ...(options.purpose === undefined ? {} : { purpose: options.purpose }),
});

export const endpointMaterialRef = (
  ref: string,
  options: { readonly protocol?: string } = {},
): EndpointMaterialRef => ({
  kind: "endpoint",
  ref,
  ...(options.protocol === undefined ? {} : { protocol: options.protocol }),
});

export const bindingMaterialRef = (spec: {
  readonly provider: string;
  readonly bindingKind: string;
  readonly ref: string;
}): BindingMaterialRef => ({
  kind: "binding",
  provider: spec.provider,
  bindingKind: spec.bindingKind,
  ref: spec.ref,
});

export const externalResourceMaterialRef = (spec: {
  readonly provider: string;
  readonly resourceKind: string;
  readonly ref: string;
}): ExternalResourceMaterialRef => ({
  kind: "external_resource",
  provider: spec.provider,
  resourceKind: spec.resourceKind,
  ref: spec.ref,
});

export const materialRequirement = (spec: MaterialRequirementInput): MaterialRequirement =>
  ({
    ...spec,
    required: spec.required ?? true,
  }) as MaterialRequirement;

export const isMaterialRef = (value: unknown): value is MaterialRef => {
  if (!Predicate.isObject(value)) return false;
  switch (value.kind) {
    case "credential":
      return (
        hasOnlyKeys(value, CREDENTIAL_KEYS) &&
        isNonEmptyString(value.ref) &&
        optionalString(value.provider) &&
        optionalString(value.purpose)
      );
    case "endpoint":
      return (
        hasOnlyKeys(value, ENDPOINT_KEYS) &&
        isNonEmptyString(value.ref) &&
        optionalString(value.protocol)
      );
    case "binding":
      return (
        hasOnlyKeys(value, BINDING_KEYS) &&
        isNonEmptyString(value.provider) &&
        isNonEmptyString(value.bindingKind) &&
        isNonEmptyString(value.ref)
      );
    case "external_resource":
      return (
        hasOnlyKeys(value, EXTERNAL_RESOURCE_KEYS) &&
        isNonEmptyString(value.provider) &&
        isNonEmptyString(value.resourceKind) &&
        isNonEmptyString(value.ref)
      );
    default:
      return false;
  }
};

export const isMaterialRequirement = (value: unknown): value is MaterialRequirement => {
  if (!Predicate.isObject(value)) {
    return false;
  }
  if (!isNonEmptyString(value.slot) || typeof value.required !== "boolean") {
    return false;
  }
  switch (value.kind) {
    case "credential":
      return (
        hasOnlyKeys(value, CREDENTIAL_REQUIREMENT_KEYS) &&
        optionalString(value.provider) &&
        optionalString(value.purpose)
      );
    case "endpoint":
      return hasOnlyKeys(value, ENDPOINT_REQUIREMENT_KEYS) && optionalString(value.protocol);
    case "binding":
      return (
        hasOnlyKeys(value, BINDING_REQUIREMENT_KEYS) &&
        optionalString(value.provider) &&
        optionalString(value.bindingKind)
      );
    case "external_resource":
      return (
        hasOnlyKeys(value, EXTERNAL_RESOURCE_REQUIREMENT_KEYS) &&
        optionalString(value.provider) &&
        optionalString(value.resourceKind)
      );
    default:
      return false;
  }
};

export const isEffectAuthorityContract = (value: unknown): value is EffectAuthorityContract =>
  Predicate.isObject(value) &&
  hasOnlyKeys(value, new Set(["effectAuthorityRef", "requiredMaterials"])) &&
  isAuthorityRef(value.effectAuthorityRef) &&
  Array.isArray(value.requiredMaterials) &&
  value.requiredMaterials.every(isMaterialRequirement);

export const materialRefSatisfiesRequirement = (
  ref: MaterialRef,
  requirement: MaterialRequirement,
): boolean => {
  if (ref.kind !== requirement.kind) return false;
  switch (ref.kind) {
    case "credential":
      if (requirement.kind !== "credential") return false;
      return (
        (requirement.provider === undefined || ref.provider === requirement.provider) &&
        (requirement.purpose === undefined || ref.purpose === requirement.purpose)
      );
    case "endpoint":
      if (requirement.kind !== "endpoint") return false;
      return requirement.protocol === undefined || ref.protocol === requirement.protocol;
    case "binding":
      if (requirement.kind !== "binding") return false;
      return (
        (requirement.provider === undefined || ref.provider === requirement.provider) &&
        (requirement.bindingKind === undefined || ref.bindingKind === requirement.bindingKind)
      );
    case "external_resource":
      if (requirement.kind !== "external_resource") return false;
      return (
        (requirement.provider === undefined || ref.provider === requirement.provider) &&
        (requirement.resourceKind === undefined || ref.resourceKind === requirement.resourceKind)
      );
  }
};

const encodePart = (value: string): string => encodeURIComponent(value);

export const materialRefKey = (ref: MaterialRef): string => {
  switch (ref.kind) {
    case "credential":
      return ["credential", ref.provider ?? "_", ref.ref].map(encodePart).join(":");
    case "endpoint":
      return ["endpoint", ref.protocol ?? "_", ref.ref].map(encodePart).join(":");
    case "binding":
      return ["binding", ref.provider, ref.bindingKind, ref.ref].map(encodePart).join(":");
    case "external_resource":
      return ["external_resource", ref.provider, ref.resourceKind, ref.ref]
        .map(encodePart)
        .join(":");
  }
};
