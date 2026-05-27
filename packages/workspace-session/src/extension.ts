import type { ExtensionPackage } from "@agent-os/core/extensions";

export const WORKSPACE_SESSION_EVENT_PREFIX = "workspace_session.";

export const workspaceSessionExtensionPackage = (version: string): ExtensionPackage => ({
  packageId: "@agent-os/workspace-session",
  kindPrefixes: [WORKSPACE_SESSION_EVENT_PREFIX],
  version,
});
