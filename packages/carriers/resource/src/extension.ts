import { boundaryPackage, defineBoundaryContract } from "@agent-os/kernel/boundary-contract";
import { materialRequirement, type AuthorityContract } from "@agent-os/kernel/material-ref";
import { RESOURCE_KIND } from "./events";

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

export const resourceBoundaryContract = defineBoundaryContract({
  packageId: "@agent-os/resource-carrier",
  kindPrefixes: [RESOURCE_EVENT_PREFIX],
  roles: ["resolver", "reader"],
  vocabulary: RESOURCE_KIND,
  authorityContracts: resourceAuthorityContracts,
  materialRequirements: [apiToken, account, binding],
  claimPayloadKey: "claim",
  claimPhases: {
    [RESOURCE_KIND.RESOURCE_PROVISIONED]: ["lived"],
    [RESOURCE_KIND.RESOURCE_BOUND]: ["lived"],
    [RESOURCE_KIND.MUTATION_RECORDED]: ["lived"],
    [RESOURCE_KIND.RESOURCE_DESTROYED]: ["lived"],
    [RESOURCE_KIND.FAILED]: ["rejected"],
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
