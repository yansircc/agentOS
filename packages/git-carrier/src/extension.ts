import type { ExtensionPackage } from "@agent-os/core/extensions";

export const GIT_EVENT_PREFIX = "git.";

export const gitCarrierExtensionPackage = (
  version: string,
): ExtensionPackage => ({
  packageId: "@agent-os/git-carrier",
  kindPrefixes: [GIT_EVENT_PREFIX],
  version,
});
