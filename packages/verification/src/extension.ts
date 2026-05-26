import type { ExtensionPackage } from "@agent-os/core/extensions";

export const VERIFICATION_EVENT_PREFIX = "verification.";

export const verificationExtensionPackage = (
  version: string,
): ExtensionPackage => ({
  packageId: "@agent-os/verification",
  kindPrefixes: [VERIFICATION_EVENT_PREFIX],
  version,
});
