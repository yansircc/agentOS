import { Schema } from "effect";
import { defineCarrier, event, ledgerProjection, lived, rejected } from "@agent-os/kernel/carrier";
import { materialRequirement, type AuthorityContract } from "@agent-os/kernel/material-ref";

export const RESOURCE_EVENT_PREFIX = "resource.";

export const RESOURCE_AUTHORITIES = {
  PROVISION: {
    authorityId: "@agent-os/resource-carrier.provision",
    authorityClass: "effect",
  },
  BIND: {
    authorityId: "@agent-os/resource-carrier.bind",
    authorityClass: "effect",
  },
  MUTATE: {
    authorityId: "@agent-os/resource-carrier.mutate",
    authorityClass: "effect",
  },
  DESTROY: {
    authorityId: "@agent-os/resource-carrier.destroy",
    authorityClass: "effect",
  },
} as const;

const apiToken = materialRequirement({
  slot: "api_token",
  kind: "credential",
  purpose: "resource_api",
});

const account = materialRequirement({
  slot: "account",
  kind: "external_resource",
  resourceKind: "account",
});

const binding = materialRequirement({
  slot: "binding",
  kind: "binding",
});

export const resourceAuthorityContracts: ReadonlyArray<AuthorityContract> = [
  {
    authorityRef: RESOURCE_AUTHORITIES.PROVISION,
    requiredMaterials: [apiToken, account],
  },
  {
    authorityRef: RESOURCE_AUTHORITIES.BIND,
    requiredMaterials: [apiToken, account, binding],
  },
  {
    authorityRef: RESOURCE_AUTHORITIES.MUTATE,
    requiredMaterials: [apiToken, account, binding],
  },
  {
    authorityRef: RESOURCE_AUTHORITIES.DESTROY,
    requiredMaterials: [apiToken, account],
  },
];

const credentialMaterialRefSchema = Schema.Struct({
  kind: Schema.Literal("credential"),
  ref: Schema.String,
  provider: Schema.optional(Schema.String),
  purpose: Schema.optional(Schema.String),
});

const endpointMaterialRefSchema = Schema.Struct({
  kind: Schema.Literal("endpoint"),
  ref: Schema.String,
  protocol: Schema.optional(Schema.String),
});

const bindingMaterialRefSchema = Schema.Struct({
  kind: Schema.Literal("binding"),
  provider: Schema.String,
  bindingKind: Schema.String,
  ref: Schema.String,
});

const externalResourceMaterialRefSchema = Schema.Struct({
  kind: Schema.Literal("external_resource"),
  provider: Schema.String,
  resourceKind: Schema.String,
  ref: Schema.String,
});

const materialRefSchema = Schema.Union(
  credentialMaterialRefSchema,
  endpointMaterialRefSchema,
  bindingMaterialRefSchema,
  externalResourceMaterialRefSchema,
);

export const resourceCarrierDefinition = defineCarrier({
  packageId: "@agent-os/resource-carrier",
  prefix: RESOURCE_EVENT_PREFIX,
  roles: ["resolver", "reader"],
  authorityContracts: resourceAuthorityContracts,
  materialRequirements: [apiToken, account, binding],
  events: {
    resource_provisioned: event({
      kind: "provisioned",
      payload: Schema.Struct({
        subjectRef: Schema.String,
        resourceKind: Schema.String,
        resourceRef: externalResourceMaterialRefSchema,
        accountRef: Schema.optional(externalResourceMaterialRefSchema),
        bindingRef: Schema.optional(bindingMaterialRefSchema),
        proofRef: Schema.String,
      }),
      claim: lived({ key: "claim", anchorKinds: ["carrier_proof", "external_receipt"] }),
    }),
    resource_bound: event({
      kind: "bound",
      payload: Schema.Struct({
        subjectRef: Schema.String,
        resourceRef: externalResourceMaterialRefSchema,
        bindingRef: bindingMaterialRefSchema,
        proofRef: Schema.String,
      }),
      claim: lived({ key: "claim", anchorKinds: ["carrier_proof", "external_receipt"] }),
    }),
    mutation_recorded: event({
      kind: "mutation.recorded",
      payload: Schema.Struct({
        subjectRef: Schema.String,
        resourceRef: materialRefSchema,
        mutationKind: Schema.String,
        mutationRef: Schema.String,
        proofRef: Schema.String,
        fingerprint: Schema.optional(Schema.String),
      }),
      claim: lived({ key: "claim", anchorKinds: ["carrier_proof", "external_receipt"] }),
    }),
    resource_destroyed: event({
      kind: "destroyed",
      payload: Schema.Struct({
        subjectRef: Schema.String,
        resourceRef: materialRefSchema,
        proofRef: Schema.String,
        reason: Schema.Literal("replaced", "expired", "aborted", "manual"),
      }),
      claim: lived({ key: "claim", anchorKinds: ["carrier_proof", "external_receipt"] }),
    }),
    failed: event({
      kind: "failed",
      payload: Schema.Struct({
        subjectRef: Schema.String,
        step: Schema.Literal("provision", "bind", "mutate", "destroy"),
        proofRef: Schema.optional(Schema.String),
        reason: Schema.String,
      }),
      claim: rejected({
        key: "claim",
        rejectionKinds: ["unsupported", "resource_denied", "policy_denied", "provider_rejected"],
      }),
    }),
  },
  projection: ledgerProjection({
    initial: () => ({ status: "missing" as const }),
    reduce: (state) => state,
  }),
});

export const RESOURCE_KIND = resourceCarrierDefinition.kind;
export const RESOURCE_EVENTS = resourceCarrierDefinition.events;
export const resourceBoundaryContract = resourceCarrierDefinition.boundaryContract;
export const resourceSettlementContract = resourceCarrierDefinition.settlementContract;
export const resourceBoundaryPackage = resourceCarrierDefinition.boundaryPackage;
