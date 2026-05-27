import type { ExtensionPackage } from "@agent-os/core/extensions";
import { materialRequirement, type AuthorityContract } from "@agent-os/core/material-ref";

export const CLOUDFLARE_RESOURCE_EVENT_PREFIX = "cf_resource.";

export const cloudflareResourceExtensionPackage = (version: string): ExtensionPackage => ({
  packageId: "@agent-os/cloudflare-resource",
  kindPrefixes: [CLOUDFLARE_RESOURCE_EVENT_PREFIX],
  version,
});

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
