import { Data, Effect } from "effect";
import {
  deploySettlementRef,
  settleDeployLived,
  settleDeployRejected,
  type DeployCarrier,
  type DeployFailure,
  type DeployPreviewRequest,
  type DeployPromoteRequest,
  type DeployReadbackRequest,
  type DeployRollbackRequest,
} from "@agent-os/deploy";

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

export interface CloudflareWorkerTargetMaterial {
  readonly accountId: string;
  readonly scriptName: string;
  readonly apiToken: string;
}

export interface CloudflareWorkerDeployMaterial extends CloudflareWorkerTargetMaterial {
  readonly artifactRef: string;
  readonly targetRef: string;
  readonly versionId?: string;
  readonly deploymentId?: string;
}

export interface CloudflareWorkerProductionMaterial {
  readonly targetRef: string;
  readonly deployRef: string;
  readonly accountId: string;
  readonly scriptName: string;
}

export interface CloudflareWorkerRollbackMaterial extends CloudflareWorkerTargetMaterial {
  readonly restoredDeployRef: string;
  readonly versionId: string;
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

export interface CloudflareWorkerDeployResolver {
  readonly expectedDigest: (
    artifactRef: string,
  ) => Effect.Effect<string, CloudflareWorkerDeployResolutionFailure>;
  readonly target: (
    targetRef: string,
  ) => Effect.Effect<CloudflareWorkerTargetMaterial, CloudflareWorkerDeployResolutionFailure>;
  readonly previousDeployRef?: (
    targetRef: string,
  ) => Effect.Effect<string | null, CloudflareWorkerDeployResolutionFailure>;
  readonly productionEndpoint: (
    productionRef: string,
  ) => Effect.Effect<string, CloudflareWorkerDeployResolutionFailure>;
  readonly rollback: (
    rollbackRef: string,
  ) => Effect.Effect<CloudflareWorkerRollbackMaterial, CloudflareWorkerDeployResolutionFailure>;
  readonly binding?: (
    bindingRef: string,
  ) => Effect.Effect<Record<string, unknown>, CloudflareWorkerDeployResolutionFailure>;
}

export class CloudflareWorkerBundleResolutionFailure extends Data.TaggedError(
  "agent_os.cloudflare_worker_bundle_resolution_failure",
)<{
  readonly artifactRef: string;
  readonly reason: string;
}> {}

export class CloudflareWorkerDeployResolutionFailure extends Data.TaggedError(
  "agent_os.cloudflare_worker_deploy_resolution_failure",
)<{
  readonly ref: string;
  readonly reason: string;
}> {}

export interface CloudflareWorkerDeployFetchInit {
  readonly method: "GET" | "POST" | "PUT" | "DELETE";
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: BodyInit;
}

export interface CloudflareWorkerDeployFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly json: () => Promise<unknown>;
}

export type CloudflareWorkerDeployFetch = (
  url: string,
  init: CloudflareWorkerDeployFetchInit,
) => Promise<CloudflareWorkerDeployFetchResponse>;

export interface CloudflareWorkerDeployCarrierOptions {
  readonly fetch: CloudflareWorkerDeployFetch;
  readonly bundleResolver: CloudflareWorkerBundleResolver;
  readonly resolver: CloudflareWorkerDeployResolver;
  readonly recordMaterial?: (ref: string, material: unknown) => void | Promise<void>;
  readonly baseUrl?: string;
  readonly carrierRef?: string;
}

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

const DEFAULT_BASE_URL = "https://api.cloudflare.com/client/v4";

const withoutTrailingSlash = (value: string): string => value.replace(/\/+$/, "");

const encodePart = (value: string): string => encodeURIComponent(value);

const baseUrlOf = (options: CloudflareWorkerDeployCarrierOptions): string =>
  withoutTrailingSlash(options.baseUrl ?? DEFAULT_BASE_URL);

const apiUrl = (
  options: CloudflareWorkerDeployCarrierOptions,
  path: ReadonlyArray<string>,
): string => `${baseUrlOf(options)}/${path.map(encodePart).join("/")}`;

const proofToken = (value: string): string => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
};

const proofRef = (
  step: "preview" | "promote" | "readback" | "rollback",
  requestKey: string,
): string => deploySettlementRef("cloudflare", step, proofToken(requestKey));

const deployFailureCode = (step: "preview" | "promote" | "readback" | "rollback") =>
  step === "preview"
    ? "PreviewFailed"
    : step === "promote"
      ? "PromotionFailed"
      : step === "readback"
        ? "ReadbackFailed"
        : "RollbackFailed";

const failed = (
  request:
    | DeployPreviewRequest
    | DeployPromoteRequest
    | DeployReadbackRequest
    | DeployRollbackRequest,
  step: "preview" | "promote" | "readback" | "rollback",
  reason: string,
): DeployFailure => {
  const ref = proofRef(step, `${request.subjectRef}:${reason}`);
  return {
    code: deployFailureCode(step),
    reason,
    proofRef: ref,
    claim: settleDeployRejected(request.claim, {
      proofRef: ref,
      reason,
      rejectionKind: reason.startsWith("cloudflare_worker_bundle_")
        ? "validation_failed"
        : "provider_rejected",
    }),
  };
};

const mapBundleResolutionFailure =
  (
    request:
      | DeployPreviewRequest
      | DeployPromoteRequest
      | DeployReadbackRequest
      | DeployRollbackRequest,
    step: "preview" | "promote" | "readback" | "rollback",
  ) =>
  (_failure: CloudflareWorkerBundleResolutionFailure): DeployFailure =>
    failed(request, step, "cloudflare_worker_bundle_resolution_failed");

const mapDeployResolutionFailure =
  (
    request:
      | DeployPreviewRequest
      | DeployPromoteRequest
      | DeployReadbackRequest
      | DeployRollbackRequest,
    step: "preview" | "promote" | "readback" | "rollback",
  ) =>
  (_failure: CloudflareWorkerDeployResolutionFailure): DeployFailure =>
    failed(request, step, "cloudflare_worker_deploy_material_resolution_failed");

const requireValidBundle = (
  options: CloudflareWorkerDeployCarrierOptions,
  request: DeployPreviewRequest | DeployPromoteRequest,
  step: "preview" | "promote",
  expectedTargetRef: string,
): Effect.Effect<CloudflareWorkerDeployBundle, DeployFailure> =>
  Effect.gen(function* () {
    const bundle = yield* resolveCloudflareWorkerDeployBundle(
      options.bundleResolver,
      request.artifactRef,
    ).pipe(Effect.mapError(mapBundleResolutionFailure(request, step)));
    const validation = validateCloudflareWorkerDeployBundle(bundle);
    if (!validation.ok) {
      return yield* Effect.fail(
        failed(request, step, `cloudflare_worker_bundle_invalid:${validation.issues.join(",")}`),
      );
    }
    if (bundle.manifest.targetRef !== expectedTargetRef) {
      return yield* Effect.fail(failed(request, step, "cloudflare_worker_bundle_target_mismatch"));
    }
    if (Object.keys(bundle.manifest.secretRefs ?? {}).length > 0) {
      return yield* Effect.fail(
        failed(request, step, "cloudflare_worker_secret_bindings_unsupported"),
      );
    }
    const expectedDigest = yield* options.resolver
      .expectedDigest(request.artifactRef)
      .pipe(Effect.mapError(mapDeployResolutionFailure(request, step)));
    const digest = yield* validateCloudflareWorkerDeployBundleDigest(bundle, expectedDigest);
    if (!digest.ok) {
      return yield* Effect.fail(failed(request, step, "cloudflare_worker_bundle_digest_mismatch"));
    }
    return bundle;
  });

const livedClaim = (
  request:
    | DeployPreviewRequest
    | DeployPromoteRequest
    | DeployReadbackRequest
    | DeployRollbackRequest,
  ref: string,
  carrierRef: string,
) =>
  settleDeployLived(request.claim, {
    proofRef: ref,
    carrierRef,
    anchorKind: "external_receipt",
  });

const metadataFor = (
  bundle: CloudflareWorkerDeployBundle,
  bindings: ReadonlyArray<Record<string, unknown>>,
): Record<string, unknown> => ({
  main_module: bundle.manifest.mainModule,
  compatibility_date: bundle.manifest.compatibilityDate,
  ...(bundle.manifest.compatibilityFlags === undefined
    ? {}
    : { compatibility_flags: bundle.manifest.compatibilityFlags }),
  ...(bindings.length === 0 ? {} : { bindings }),
});

const resolvedBindings = (
  options: CloudflareWorkerDeployCarrierOptions,
  request: DeployPromoteRequest,
  bundle: CloudflareWorkerDeployBundle,
): Effect.Effect<ReadonlyArray<Record<string, unknown>>, DeployFailure> =>
  Effect.forEach(bundle.manifest.bindings ?? [], (binding) => {
    if (options.resolver.binding === undefined) {
      return Effect.fail(failed(request, "promote", "cloudflare_worker_binding_resolver_missing"));
    }
    return options.resolver.binding(binding.bindingRef).pipe(
      Effect.map((material) => ({ ...material, name: binding.name })),
      Effect.mapError(mapDeployResolutionFailure(request, "promote")),
    );
  });

const workerUploadBody = (
  bundle: CloudflareWorkerDeployBundle,
  bindings: ReadonlyArray<Record<string, unknown>>,
): FormData => {
  const body = new FormData();
  body.set(
    "metadata",
    new Blob([JSON.stringify(metadataFor(bundle, bindings))], { type: "application/json" }),
    "metadata.json",
  );
  for (const module of bundle.modules) {
    body.set(
      module.name,
      new Blob([module.content], {
        type: module.contentType ?? "application/javascript+module",
      }),
      module.name,
    );
  }
  return body;
};

const cloudflareJson = (
  options: CloudflareWorkerDeployCarrierOptions,
  request: DeployPromoteRequest | DeployRollbackRequest,
  step: "promote" | "rollback",
  token: string,
  apiPath: ReadonlyArray<string>,
  init: Omit<CloudflareWorkerDeployFetchInit, "headers"> & {
    readonly headers?: Readonly<Record<string, string>>;
  },
): Effect.Effect<unknown, DeployFailure> =>
  Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: () =>
        options.fetch(apiUrl(options, apiPath), {
          ...init,
          headers: {
            Authorization: `Bearer ${token}`,
            ...init.headers,
          },
        }),
      catch: () => failed(request, step, `cloudflare_worker_${step}_fetch_failed`),
    });
    if (!response.ok) {
      return yield* Effect.fail(
        failed(request, step, `cloudflare_worker_${step}_http_${response.status}`),
      );
    }
    const body = yield* Effect.tryPromise({
      try: () => response.json(),
      catch: () => failed(request, step, `cloudflare_worker_${step}_response_json_invalid`),
    });
    if (
      typeof body !== "object" ||
      body === null ||
      (body as { success?: unknown }).success !== true
    ) {
      return yield* Effect.fail(failed(request, step, `cloudflare_worker_${step}_not_successful`));
    }
    return body;
  });

const stringFromResult = (body: unknown, key: string): string | undefined => {
  if (typeof body !== "object" || body === null) return undefined;
  const result = (body as { readonly result?: unknown }).result;
  if (typeof result !== "object" || result === null) return undefined;
  const value = (result as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
};

const recordMaterial = (
  options: CloudflareWorkerDeployCarrierOptions,
  request: DeployPromoteRequest,
  ref: string,
  material: unknown,
): Effect.Effect<void, DeployFailure> => {
  if (options.recordMaterial === undefined) return Effect.void;
  return Effect.asVoid(
    Effect.tryPromise({
      try: () => Promise.resolve(options.recordMaterial?.(ref, material)),
      catch: () => failed(request, "promote", "cloudflare_worker_material_record_failed"),
    }),
  );
};

const readbackFailedPayload = (request: DeployReadbackRequest, reason: string) => {
  const ref = proofRef("readback", `${request.subjectRef}:${request.productionRef}:${reason}`);
  return {
    subjectRef: request.subjectRef,
    step: "readback" as const,
    proofRef: ref,
    reason,
    claim: settleDeployRejected(request.claim, {
      proofRef: ref,
      reason,
      rejectionKind: "provider_rejected",
    }),
  };
};

export const makeCloudflareWorkerDeployCarrier = (
  options: CloudflareWorkerDeployCarrierOptions,
): DeployCarrier => {
  const carrierRef = options.carrierRef ?? "cloudflare-worker-deploy";

  return {
    preview: (request) =>
      Effect.gen(function* () {
        yield* requireValidBundle(options, request, "preview", request.targetRef);
        yield* options.resolver
          .target(request.targetRef)
          .pipe(Effect.mapError(mapDeployResolutionFailure(request, "preview")));
        const previewRef = proofRef(
          "preview",
          `${request.subjectRef}:${request.artifactRef}:${request.targetRef}`,
        );
        return {
          subjectRef: request.subjectRef,
          previewRef,
          artifactRef: request.artifactRef,
          claim: livedClaim(request, previewRef, carrierRef),
        };
      }),

    promote: (request) =>
      Effect.gen(function* () {
        const bundle = yield* requireValidBundle(
          options,
          request,
          "promote",
          request.productionTargetRef,
        );
        const target = yield* options.resolver
          .target(request.productionTargetRef)
          .pipe(Effect.mapError(mapDeployResolutionFailure(request, "promote")));
        const bindings = yield* resolvedBindings(options, request, bundle);
        const body = yield* cloudflareJson(
          options,
          request,
          "promote",
          target.apiToken,
          ["accounts", target.accountId, "workers", "scripts", target.scriptName],
          {
            method: "PUT",
            body: workerUploadBody(bundle, bindings),
          },
        );
        const versionId = stringFromResult(body, "id") ?? stringFromResult(body, "version_id");
        const deploymentId = stringFromResult(body, "deployment_id");
        const deployRef = proofRef(
          "promote",
          `${request.subjectRef}:${request.artifactRef}:${request.productionTargetRef}`,
        );
        const productionRef = deploySettlementRef(
          "cloudflare",
          "production",
          proofToken(`${request.subjectRef}:${request.productionTargetRef}`),
        );
        const rollbackRef =
          options.resolver.previousDeployRef === undefined
            ? null
            : yield* options.resolver
                .previousDeployRef(request.productionTargetRef)
                .pipe(Effect.mapError(mapDeployResolutionFailure(request, "promote")));
        yield* recordMaterial(options, request, deployRef, {
          accountId: target.accountId,
          scriptName: target.scriptName,
          apiToken: target.apiToken,
          artifactRef: request.artifactRef,
          targetRef: request.productionTargetRef,
          ...(versionId === undefined ? {} : { versionId }),
          ...(deploymentId === undefined ? {} : { deploymentId }),
        } satisfies CloudflareWorkerDeployMaterial);
        yield* recordMaterial(options, request, productionRef, {
          targetRef: request.productionTargetRef,
          deployRef,
          accountId: target.accountId,
          scriptName: target.scriptName,
        } satisfies CloudflareWorkerProductionMaterial);
        return {
          subjectRef: request.subjectRef,
          deployRef,
          productionRef,
          ...(rollbackRef === null ? {} : { rollbackRef }),
          claim: livedClaim(request, deployRef, carrierRef),
        };
      }),

    readback: (request) =>
      Effect.gen(function* () {
        const endpoint = yield* options.resolver
          .productionEndpoint(request.productionRef)
          .pipe(Effect.mapError(mapDeployResolutionFailure(request, "readback")));
        const response = yield* Effect.tryPromise({
          try: () => options.fetch(endpoint, { method: "GET", headers: {} }),
          catch: () => failed(request, "readback", "cloudflare_worker_readback_fetch_failed"),
        });
        const readbackRef = proofRef(
          "readback",
          `${request.subjectRef}:${request.productionRef}:${response.status}`,
        );
        if (!response.ok) {
          return readbackFailedPayload(
            request,
            `cloudflare_worker_readback_http_${response.status}`,
          );
        }
        return {
          subjectRef: request.subjectRef,
          productionRef: request.productionRef,
          readbackRef,
          status: "passed" as const,
          claim: livedClaim(request, readbackRef, carrierRef),
        };
      }),

    rollback: (request) =>
      Effect.gen(function* () {
        const material = yield* options.resolver
          .rollback(request.rollbackRef)
          .pipe(Effect.mapError(mapDeployResolutionFailure(request, "rollback")));
        const body = yield* cloudflareJson(
          options,
          request,
          "rollback",
          material.apiToken,
          [
            "accounts",
            material.accountId,
            "workers",
            "scripts",
            material.scriptName,
            "deployments",
          ],
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              strategy: "percentage",
              versions: [{ version_id: material.versionId, percentage: 100 }],
            }),
          },
        );
        const restoredDeployRef = material.restoredDeployRef;
        const rollbackRef = proofRef(
          "rollback",
          `${request.subjectRef}:${request.rollbackRef}:${stringFromResult(body, "id") ?? ""}`,
        );
        return {
          subjectRef: request.subjectRef,
          rollbackRef,
          restoredDeployRef,
          claim: livedClaim(request, rollbackRef, carrierRef),
        };
      }),
  };
};
