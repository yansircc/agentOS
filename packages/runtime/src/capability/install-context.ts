import type { EffectAuthorityBinding } from "@agent-os/core/material-ref";

export interface CapabilityCommitInput {
  readonly event: string;
  readonly data: unknown;
  readonly authorityBinding?: EffectAuthorityBinding;
}

/**
 * Installed capability handle
 * @internal
 */
export interface InstalledCapabilityHandle {
  readonly capabilityId: string;
  readonly commit: (input: CapabilityCommitInput) => Promise<unknown>;
}
