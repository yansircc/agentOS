import type { ExtensionPackage } from "@agent-os/core/extensions";

export const STAGING_EVENT_PREFIX = "staging.";

export const stagingArtifactExtensionPackage = (version: string): ExtensionPackage => ({
  packageId: "@agent-os/staging-artifact",
  kindPrefixes: [STAGING_EVENT_PREFIX],
  version,
});
