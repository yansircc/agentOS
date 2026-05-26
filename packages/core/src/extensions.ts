import { Data } from "effect";
import {
  CORE_CLAIMED_PREFIXES,
  CapabilityRejected,
  isCoreClaimedEventKind,
} from "./errors";

export interface ExtensionPackage {
  readonly packageId: string;
  readonly kindPrefixes: ReadonlyArray<string>;
  readonly version: string;
}

export class ExtensionCapabilityConflict extends Data.TaggedError(
  "agent_os.extension_capability_conflict",
)<{
  readonly packageId: string;
  readonly kindPrefix: string;
  readonly claimedBy: string;
}> {}

const prefixesOverlap = (a: string, b: string): boolean =>
  a.startsWith(b) || b.startsWith(a);

export type ExtensionValidation =
  | { readonly ok: true; readonly prefixes: ReadonlyArray<string> }
  | { readonly ok: false; readonly error: ExtensionCapabilityConflict };

export const validateExtensionPackages = (
  packages: ReadonlyArray<ExtensionPackage>,
): ExtensionValidation => {
  const seen: Array<{ readonly owner: string; readonly prefix: string }> =
    CORE_CLAIMED_PREFIXES.map((prefix) => ({
      owner: "@agent-os/core",
      prefix,
    }));
  const out: string[] = [];

  for (const pkg of packages) {
    for (const prefix of pkg.kindPrefixes) {
      if (prefix.length === 0) {
        return {
          ok: false,
          error: new ExtensionCapabilityConflict({
            packageId: pkg.packageId,
            kindPrefix: prefix,
            claimedBy: "empty-prefix",
          }),
        };
      }
      const conflict = seen.find((entry) => prefixesOverlap(prefix, entry.prefix));
      if (conflict !== undefined) {
        return {
          ok: false,
          error: new ExtensionCapabilityConflict({
            packageId: pkg.packageId,
            kindPrefix: prefix,
            claimedBy: conflict.owner,
          }),
        };
      }
      seen.push({ owner: pkg.packageId, prefix });
      out.push(prefix);
    }
  }

  return { ok: true, prefixes: out };
};

export const rejectClaimedAppEvent = (
  event: string,
  extensionPrefixes: ReadonlyArray<string>,
): CapabilityRejected | null => {
  if (isCoreClaimedEventKind(event)) {
    return new CapabilityRejected({ event, capability: "cap_app" });
  }
  if (extensionPrefixes.some((prefix) => event.startsWith(prefix))) {
    return new CapabilityRejected({ event, capability: "cap_app" });
  }
  return null;
};
