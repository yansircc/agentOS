import type { ExtensionPackage } from "@agent-os/core/extensions";

export const IMAGE_EVENT_PREFIX = "image.";

export const imageExtensionPackage = (
  version: string,
): ExtensionPackage => ({
  packageId: "@agent-os/image",
  kindPrefixes: [IMAGE_EVENT_PREFIX],
  version,
});
