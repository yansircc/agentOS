import type { EventNamespace } from "@agent-os/kernel/extensions";

export const IMAGE_EVENT_PREFIX = "image.";

export const imageEventNamespace = (version: string): EventNamespace => ({
  packageId: "@agent-os/image",
  kindPrefixes: [IMAGE_EVENT_PREFIX],
  version,
});
