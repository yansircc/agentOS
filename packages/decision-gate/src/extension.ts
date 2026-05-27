import type { ExtensionPackage } from "@agent-os/core/extensions";

export const DECISION_GATE_EVENT_PREFIX = "decision_gate.";

export const decisionGateExtensionPackage = (version: string): ExtensionPackage => ({
  packageId: "@agent-os/decision-gate",
  kindPrefixes: [DECISION_GATE_EVENT_PREFIX],
  version,
});
