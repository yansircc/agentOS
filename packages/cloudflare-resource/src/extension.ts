import { boundaryExtensionPackage, defineBoundaryContract } from "@agent-os/core/boundary-contract";
import { materialRequirement, type AuthorityContract } from "@agent-os/core/material-ref";

export const CLOUDFLARE_RESOURCE_EVENT_PREFIX = "cf_resource.";

export const CLOUDFLARE_RESOURCE_EVENT_VOCABULARY = {
  RESOURCE_PROVISIONED: `${CLOUDFLARE_RESOURCE_EVENT_PREFIX}resource.provisioned`,
  RESOURCE_BOUND: `${CLOUDFLARE_RESOURCE_EVENT_PREFIX}resource.bound`,
  MUTATION_RECORDED: `${CLOUDFLARE_RESOURCE_EVENT_PREFIX}mutation.recorded`,
  RESOURCE_DESTROYED: `${CLOUDFLARE_RESOURCE_EVENT_PREFIX}resource.destroyed`,
  FAILED: `${CLOUDFLARE_RESOURCE_EVENT_PREFIX}failed`,
} as const;

export const CLOUDFLARE_RESOURCE_AUTHORITIES = {
  PROVISION: {
    authorityId: "@agent-os/cloudflare-resource.provision",
    authorityClass: "effect",
  },
  BIND: {
    authorityId: "@agent-os/cloudflare-resource.bind",
    authorityClass: "effect",
  },
  MUTATE: {
    authorityId: "@agent-os/cloudflare-resource.mutate",
    authorityClass: "effect",
  },
  DESTROY: {
    authorityId: "@agent-os/cloudflare-resource.destroy",
    authorityClass: "effect",
  },
} as const;

const apiToken = materialRequirement({
  slot: "api_token",
  kind: "credential",
  provider: "cloudflare",
  purpose: "cloudflare_api",
});

const account = materialRequirement({
  slot: "account",
  kind: "external_resource",
  provider: "cloudflare",
  resourceKind: "account",
});

const binding = materialRequirement({
  slot: "binding",
  kind: "binding",
  provider: "cloudflare",
});

export const cloudflareResourceAuthorityContracts: ReadonlyArray<AuthorityContract> = [
  {
    authorityRef: CLOUDFLARE_RESOURCE_AUTHORITIES.PROVISION,
    requiredMaterials: [apiToken, account],
  },
  {
    authorityRef: CLOUDFLARE_RESOURCE_AUTHORITIES.BIND,
    requiredMaterials: [apiToken, account, binding],
  },
  {
    authorityRef: CLOUDFLARE_RESOURCE_AUTHORITIES.MUTATE,
    requiredMaterials: [apiToken, account, binding],
  },
  {
    authorityRef: CLOUDFLARE_RESOURCE_AUTHORITIES.DESTROY,
    requiredMaterials: [apiToken, account],
  },
];

export const cloudflareResourceBoundaryContract = defineBoundaryContract({
  packageId: "@agent-os/cloudflare-resource",
  kindPrefixes: [CLOUDFLARE_RESOURCE_EVENT_PREFIX],
  roles: ["resolver", "reader"],
  vocabulary: CLOUDFLARE_RESOURCE_EVENT_VOCABULARY,
  authorityContracts: cloudflareResourceAuthorityContracts,
  claimPayloadKey: "claim",
  terminalClaims: ["lived", "rejected"],
  proof: {
    anchorKinds: ["carrier_proof", "external_receipt"],
    symbolicOnly: true,
  },
  projection: {
    derivedFromLedger: true,
    shadowState: false,
  },
});

export const cloudflareResourceExtensionPackage = (version: string) =>
  boundaryExtensionPackage(cloudflareResourceBoundaryContract, version);
