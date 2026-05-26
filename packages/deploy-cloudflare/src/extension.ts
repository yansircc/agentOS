import type { ExtensionPackage } from "@agent-os/core/extensions";

export const DEPLOY_EVENT_PREFIX = "deploy.";

export const deployCloudflareExtensionPackage = (
  version: string,
): ExtensionPackage => ({
  packageId: "@agent-os/deploy-cloudflare",
  kindPrefixes: [DEPLOY_EVENT_PREFIX],
  version,
});
