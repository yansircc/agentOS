import { Data } from "effect";
import { CORE_CLAIMED_PREFIXES, CapabilityRejected, isCoreClaimedEventKind } from "./errors";
import type { BoundaryContract } from "./boundary-contract";

declare const boundaryPackageBrand: unique symbol;

export interface BoundaryPackage {
  readonly packageId: string;
  readonly kindPrefixes: ReadonlyArray<string>;
  readonly version: string;
  readonly boundaryContract: BoundaryContract;
  readonly [boundaryPackageBrand]: true;
}

export interface EventNamespace {
  readonly packageId: string;
  readonly kindPrefixes: ReadonlyArray<string>;
  readonly version: string;
}

export type ExtensionDeclaration = BoundaryPackage | EventNamespace;

export interface ExtensionCommitSpec {
  readonly event: string;
  readonly data: unknown;
}

export interface ExtensionTimeSpec extends ExtensionCommitSpec {
  readonly at: number;
}

export interface ExtensionCapability {
  readonly packageId: string;
  readonly kindPrefixes: ReadonlyArray<string>;
  readonly version: string;
  readonly commit: (spec: ExtensionCommitSpec) => Promise<{ readonly id: number }>;
  readonly time: (spec: ExtensionTimeSpec) => Promise<{ readonly id: number }>;
}

export type EventPayloadMap = Readonly<Record<string, unknown>>;

export type EventPayload<K> = K;

export const payload = <T>(): EventPayload<T> => undefined as unknown as T;

export const defineEventPayloads = <const T extends EventPayloadMap>(events: T): T => events;

export const defineEventKindView = <
  const Events extends EventPayloadMap,
  const View extends Readonly<Record<string, keyof Events & string>>,
>(
  _events: Events,
  view: View,
): View => view;

export type CommitterMap<T extends EventPayloadMap> = {
  readonly [K in keyof T & string]: (payload: T[K]) => Promise<{ readonly id: number }>;
};

export const makeCommitters = <const T extends EventPayloadMap>(
  events: T,
  cap: ExtensionCapability,
): CommitterMap<T> => {
  const out: Record<string, (payload: unknown) => Promise<{ readonly id: number }>> = {};
  for (const event of Object.keys(events)) {
    out[event] = (data: unknown) => cap.commit({ event, data });
  }
  return out as CommitterMap<T>;
};

export class ExtensionCapabilityConflict extends Data.TaggedError(
  "agent_os.extension_capability_conflict",
)<{
  readonly packageId: string;
  readonly kindPrefix: string;
  readonly claimedBy: string;
}> {}

const prefixesOverlap = (a: string, b: string): boolean => a.startsWith(b) || b.startsWith(a);

export type ExtensionValidation =
  | {
      readonly ok: true;
      readonly prefixes: ReadonlyArray<string>;
      readonly declarations: ReadonlyArray<ExtensionDeclaration>;
    }
  | { readonly ok: false; readonly error: ExtensionCapabilityConflict };

export const isBoundaryPackage = (value: ExtensionDeclaration): value is BoundaryPackage =>
  "boundaryContract" in value;

export const eventNamespace = (spec: EventNamespace): EventNamespace => ({
  packageId: spec.packageId,
  kindPrefixes: spec.kindPrefixes,
  version: spec.version,
});

export const validateExtensionDeclarations = (
  declarations: ReadonlyArray<ExtensionDeclaration>,
): ExtensionValidation => {
  const seen: Array<{ readonly owner: string; readonly prefix: string }> =
    CORE_CLAIMED_PREFIXES.map((prefix) => ({
      owner: "@agent-os/runtime",
      prefix,
    }));
  const packageIds = new Set<string>();
  const out: string[] = [];

  for (const declaration of declarations) {
    if (packageIds.has(declaration.packageId)) {
      return {
        ok: false,
        error: new ExtensionCapabilityConflict({
          packageId: declaration.packageId,
          kindPrefix: "*",
          claimedBy: declaration.packageId,
        }),
      };
    }
    packageIds.add(declaration.packageId);

    for (const prefix of declaration.kindPrefixes) {
      if (prefix.length === 0) {
        return {
          ok: false,
          error: new ExtensionCapabilityConflict({
            packageId: declaration.packageId,
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
            packageId: declaration.packageId,
            kindPrefix: prefix,
            claimedBy: conflict.owner,
          }),
        };
      }
      seen.push({ owner: declaration.packageId, prefix });
      out.push(prefix);
    }
  }

  return { ok: true, prefixes: out, declarations };
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

export const extensionOwnsEvent = (declaration: ExtensionDeclaration, event: string): boolean =>
  declaration.kindPrefixes.some((prefix) => event.startsWith(prefix));
