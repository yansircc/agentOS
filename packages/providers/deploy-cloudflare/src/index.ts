import { Data, Effect } from "effect";

export interface CloudflareWorkerBindingRef {
  readonly name: string;
  readonly bindingRef: string;
}

export interface CloudflareWorkerRouteRef {
  readonly routeRef: string;
}

export interface CloudflareWorkerDeployManifest {
  readonly targetRef: string;
  readonly mainModule: string;
  readonly compatibilityDate: string;
  readonly compatibilityFlags?: ReadonlyArray<string>;
  readonly bindings?: ReadonlyArray<CloudflareWorkerBindingRef>;
  readonly routes?: ReadonlyArray<CloudflareWorkerRouteRef>;
  readonly secretRefs?: Readonly<Record<string, string>>;
}

export interface CloudflareWorkerModule {
  readonly name: string;
  readonly content: string;
  readonly contentType?: string;
}

export interface CloudflareWorkerDeployBundle {
  readonly manifest: CloudflareWorkerDeployManifest;
  readonly modules: ReadonlyArray<CloudflareWorkerModule>;
}

export type CloudflareWorkerDeployBundleIssue =
  | "target_ref_not_symbolic"
  | "main_module_missing"
  | "module_name_duplicate"
  | "binding_ref_not_symbolic"
  | "route_ref_not_symbolic"
  | "secret_ref_not_symbolic";

export type CloudflareWorkerDeployBundleValidation =
  | { readonly ok: true; readonly bundle: CloudflareWorkerDeployBundle }
  | {
      readonly ok: false;
      readonly issues: ReadonlyArray<CloudflareWorkerDeployBundleIssue>;
    };

export interface CloudflareWorkerBundleResolver {
  readonly resolve: (
    artifactRef: string,
  ) => Effect.Effect<CloudflareWorkerDeployBundle, CloudflareWorkerBundleResolutionFailure>;
}

export class CloudflareWorkerBundleResolutionFailure extends Data.TaggedError(
  "agent_os.cloudflare_worker_bundle_resolution_failure",
)<{
  readonly artifactRef: string;
  readonly reason: string;
}> {}

export type CloudflareWorkerBundleDigestValidation =
  | { readonly ok: true; readonly digest: string }
  | {
      readonly ok: false;
      readonly expectedDigest: string;
      readonly actualDigest: string;
    };

const SCHEME_SHAPED_REF = /^[a-z][a-z0-9+.-]*:\/\//i;

const isSymbolicRef = (value: string): boolean =>
  value.length > 0 && !SCHEME_SHAPED_REF.test(value);

const sortedObject = (value: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const item = value[key];
    if (item !== undefined) out[key] = canonicalValue(item);
  }
  return out;
};

const canonicalValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value === "object" && value !== null) {
    return sortedObject(value as Record<string, unknown>);
  }
  return value;
};

export const encodeCloudflareWorkerDeployBundle = (
  bundle: CloudflareWorkerDeployBundle,
): Uint8Array => new TextEncoder().encode(JSON.stringify(canonicalValue(bundle)));

const arrayBufferOf = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

const hex = (bytes: ArrayBuffer): string =>
  Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");

export const cloudflareWorkerDeployBundleDigest = (
  bundle: CloudflareWorkerDeployBundle,
): Effect.Effect<string> =>
  Effect.promise(() =>
    crypto.subtle
      .digest("SHA-256", arrayBufferOf(encodeCloudflareWorkerDeployBundle(bundle)))
      .then((digest) => `sha256:${hex(digest)}`),
  );

export const validateCloudflareWorkerDeployBundle = (
  bundle: CloudflareWorkerDeployBundle,
): CloudflareWorkerDeployBundleValidation => {
  const issues: CloudflareWorkerDeployBundleIssue[] = [];
  const moduleNames = new Set<string>();
  let hasMainModule = false;

  if (!isSymbolicRef(bundle.manifest.targetRef)) issues.push("target_ref_not_symbolic");
  for (const module of bundle.modules) {
    if (moduleNames.has(module.name)) issues.push("module_name_duplicate");
    moduleNames.add(module.name);
    if (module.name === bundle.manifest.mainModule) hasMainModule = true;
  }
  if (!hasMainModule) issues.push("main_module_missing");

  for (const binding of bundle.manifest.bindings ?? []) {
    if (!isSymbolicRef(binding.bindingRef)) issues.push("binding_ref_not_symbolic");
  }
  for (const route of bundle.manifest.routes ?? []) {
    if (!isSymbolicRef(route.routeRef)) issues.push("route_ref_not_symbolic");
  }
  for (const secretRef of Object.values(bundle.manifest.secretRefs ?? {})) {
    if (!isSymbolicRef(secretRef)) issues.push("secret_ref_not_symbolic");
  }

  return issues.length === 0 ? { ok: true, bundle } : { ok: false, issues };
};

export const validateCloudflareWorkerDeployBundleDigest = (
  bundle: CloudflareWorkerDeployBundle,
  expectedDigest: string,
): Effect.Effect<CloudflareWorkerBundleDigestValidation> =>
  Effect.map(cloudflareWorkerDeployBundleDigest(bundle), (actualDigest) =>
    actualDigest === expectedDigest
      ? { ok: true as const, digest: actualDigest }
      : { ok: false as const, expectedDigest, actualDigest },
  );

export const resolveCloudflareWorkerDeployBundle = (
  resolver: CloudflareWorkerBundleResolver,
  artifactRef: string,
): Effect.Effect<CloudflareWorkerDeployBundle, CloudflareWorkerBundleResolutionFailure> =>
  resolver.resolve(artifactRef);
