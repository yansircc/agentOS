/**
 * Installed capability handle
 * @internal
 */
export interface InstalledCapabilityHandle {
  readonly capabilityId: string;
  readonly commit: (input: { readonly event: string; readonly data: unknown }) => Promise<unknown>;
}
