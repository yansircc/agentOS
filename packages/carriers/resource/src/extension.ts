import { boundaryPackage, defineBoundaryContract } from "@agent-os/kernel/boundary-contract";
import { materialRequirement, type AuthorityContract } from "@agent-os/kernel/material-ref";

export const RESOURCE_EVENT_PREFIX = "resource.";

export const RESOURCE_EVENT_VOCABULARY = {
  RESOURCE_PROVISIONED: `${RESOURCE_EVENT_PREFIX}resource.provisioned`,
  RESOURCE_BOUND: `${RESOURCE_EVENT_PREFIX}resource.bound`,
  MUTATION_RECORDED: `${RESOURCE_EVENT_PREFIX}mutation.recorded`,
  RESOURCE_DESTROYED: `${RESOURCE_EVENT_PREFIX}resource.destroyed`,
  FAILED: `${RESOURCE_EVENT_PREFIX}failed`,
} as const;

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

export const resourceBoundaryContract = defineBoundaryContract({
  packageId: "@agent-os/resource-carrier",
  kindPrefixes: [RESOURCE_EVENT_PREFIX],
  roles: ["resolver", "reader"],
  vocabulary: RESOURCE_EVENT_VOCABULARY,
  authorityContracts: resourceAuthorityContracts,
  materialRequirements: [apiToken, account, binding],
  claimPayloadKey: "claim",
  claimPhases: {
    [RESOURCE_EVENT_VOCABULARY.RESOURCE_PROVISIONED]: ["lived"],
    [RESOURCE_EVENT_VOCABULARY.RESOURCE_BOUND]: ["lived"],
    [RESOURCE_EVENT_VOCABULARY.MUTATION_RECORDED]: ["lived"],
    [RESOURCE_EVENT_VOCABULARY.RESOURCE_DESTROYED]: ["lived"],
    [RESOURCE_EVENT_VOCABULARY.FAILED]: ["rejected"],
  },
  proof: {
    anchorKinds: ["carrier_proof", "external_receipt"],
    symbolicOnly: true,
  },
  projection: {
    derivedFromLedger: true,
    shadowState: false,
  },
});

export const resourceBoundaryPackage = (version: string) =>
  boundaryPackage(resourceBoundaryContract, version);
