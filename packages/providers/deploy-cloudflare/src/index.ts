import { Data, Effect, Predicate } from "effect";
import {
  deploySettlementRef,
  settleDeployIndeterminate,
  settleDeployLived,
  settleDeployRejected,
  type DeployCarrier,
  type DeployFailure,
  type DeployPreviewRequest,
  type DeployPromoteRequest,
  type DeployReadbackRequest,
  type DeployReconcileRequiredPayload,
  type DeployRollbackRequest,
} from "@agent-os/deploy";
import {
  bindingMaterialRef,
  endpointMaterialRef,
  externalResourceMaterialRef,
  materialRefKey,
  type BindingMaterialRef,
  type CredentialMaterialRef,
  type EndpointMaterialRef,
  type ExternalResourceMaterialRef,
  type MaterialRef,
} from "@agent-os/kernel/material-ref";
import type { RefResolver } from "@agent-os/kernel/ref-resolver";

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

export interface CloudflareWorkerDeployMaterial {
  readonly accountId: string;
  readonly scriptName: string;
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
  readonly target: <A, E, R>(
    targetRef: string,
    use: (material: CloudflareWorkerTargetMaterial) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | CloudflareWorkerDeployResolutionFailure, R>;
  readonly previousDeployRef?: (
    targetRef: string,
  ) => Effect.Effect<string | null, CloudflareWorkerDeployResolutionFailure>;
  readonly productionEndpoint: <A, E, R>(
    productionRef: string,
    use: (endpoint: string) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | CloudflareWorkerDeployResolutionFailure, R>;
  readonly rollback: <A, E, R>(
    rollbackRef: string,
    use: (material: CloudflareWorkerRollbackMaterial) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | CloudflareWorkerDeployResolutionFailure, R>;
  readonly binding?: <A, E, R>(
    bindingRef: string,
    use: (material: Record<string, unknown>) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | CloudflareWorkerDeployResolutionFailure, R>;
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

export interface CloudflareWorkerDeployResolverCompositionOptions {
  readonly materialResolver: RefResolver;
  readonly bundleResolver: CloudflareWorkerBundleResolver;
  readonly expectedDigest: (
    artifactRef: string,
  ) => Effect.Effect<string, CloudflareWorkerDeployResolutionFailure>;
  readonly credentialRef: CredentialMaterialRef;
  readonly accountRef: ExternalResourceMaterialRef;
  readonly targetMaterialRef?: (targetRef: string) => ExternalResourceMaterialRef;
  readonly bindingMaterialRef?: (bindingRef: string) => BindingMaterialRef;
  readonly productionEndpointRef?: (productionRef: string) => EndpointMaterialRef;
  readonly rollbackDeployMaterialRef?: (rollbackRef: string) => ExternalResourceMaterialRef;
  readonly previousDeployRef?: (
    targetRef: string,
  ) => Effect.Effect<string | null, CloudflareWorkerDeployResolutionFailure>;
}

export interface CloudflareWorkerDeployResolverComposition {
  readonly bundleResolver: CloudflareWorkerBundleResolver;
  readonly resolver: CloudflareWorkerDeployResolver;
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
  Effect.withSpan("agentos.cloudflare.deploy.bundle_digest")(
    Effect.promise(() =>
      crypto.subtle
        .digest("SHA-256", arrayBufferOf(encodeCloudflareWorkerDeployBundle(bundle)))
        .then((digest) => `sha256:${hex(digest)}`),
    ),
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
  Effect.withSpan("agentos.cloudflare.deploy.validate_bundle_digest")(
    Effect.map(cloudflareWorkerDeployBundleDigest(bundle), (actualDigest) =>
      actualDigest === expectedDigest
        ? { ok: true as const, digest: actualDigest }
        : { ok: false as const, expectedDigest, actualDigest },
    ),
  );

export const resolveCloudflareWorkerDeployBundle = (
  resolver: CloudflareWorkerBundleResolver,
  artifactRef: string,
): Effect.Effect<CloudflareWorkerDeployBundle, CloudflareWorkerBundleResolutionFailure> =>
  Effect.withSpan("agentos.cloudflare.deploy.resolve_bundle")(resolver.resolve(artifactRef));

export const cloudflareWorkerTargetMaterialRef = (targetRef: string): ExternalResourceMaterialRef =>
  externalResourceMaterialRef({
    provider: "cloudflare",
    resourceKind: "worker_script",
    ref: targetRef,
  });

export const cloudflareWorkerDeployMaterialRef = (deployRef: string): ExternalResourceMaterialRef =>
  externalResourceMaterialRef({
    provider: "cloudflare",
    resourceKind: "worker_deploy",
    ref: deployRef,
  });

export const cloudflareWorkerProductionEndpointMaterialRef = (
  productionRef: string,
): EndpointMaterialRef => endpointMaterialRef(productionRef, { protocol: "https" });

export const cloudflareWorkerBindingMaterialRef = (ref: string): BindingMaterialRef =>
  bindingMaterialRef({
    provider: "cloudflare",
    bindingKind: "worker_binding",
    ref,
  });

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

const reconcileRequiredPayload = (
  request:
    | DeployPreviewRequest
    | DeployPromoteRequest
    | DeployReadbackRequest
    | DeployRollbackRequest,
  step: "preview" | "promote" | "readback" | "rollback",
  reason: string,
): DeployReconcileRequiredPayload => {
  const ref = proofRef(step, `${request.subjectRef}:${reason}:reconcile`);
  return {
    subjectRef: request.subjectRef,
    step,
    proofRef: ref,
    reason: deploySettlementRef("reason", reason),
    claim: settleDeployIndeterminate(request.claim, {
      proofRef: ref,
      reason: deploySettlementRef("reason", reason),
    }),
  };
};

const catchDeployReconcileRequired =
  (
    request:
      | DeployPreviewRequest
      | DeployPromoteRequest
      | DeployReadbackRequest
      | DeployRollbackRequest,
    step: "preview" | "promote" | "readback" | "rollback",
  ) =>
  <A, E, R>(
    effect: Effect.Effect<A, E | CloudflareWorkerDeployResolutionFailure, R>,
  ): Effect.Effect<A | DeployReconcileRequiredPayload, E, R> =>
    Effect.catchTag(effect, "agent_os.cloudflare_worker_deploy_resolution_failure", () =>
      Effect.succeed(
        reconcileRequiredPayload(
          request,
          step,
          "cloudflare_worker_deploy_material_resolution_failed",
        ),
      ),
    );

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

const mapDeployResolutionFailureOnly =
  (
    request:
      | DeployPreviewRequest
      | DeployPromoteRequest
      | DeployReadbackRequest
      | DeployRollbackRequest,
    step: "preview" | "promote" | "readback" | "rollback",
  ) =>
  <E>(failure: E | CloudflareWorkerDeployResolutionFailure): E | DeployFailure =>
    failure instanceof CloudflareWorkerDeployResolutionFailure
      ? mapDeployResolutionFailure(request, step)(failure)
      : failure;

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

const withResolvedBindings = <A, E, R>(
  options: CloudflareWorkerDeployCarrierOptions,
  request: DeployPromoteRequest,
  bundle: CloudflareWorkerDeployBundle,
  use: (bindings: ReadonlyArray<Record<string, unknown>>) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | DeployFailure, R> => {
  const bindings = bundle.manifest.bindings ?? [];
  const loop = (
    index: number,
    out: ReadonlyArray<Record<string, unknown>>,
  ): Effect.Effect<A, E | DeployFailure, R> => {
    const binding = bindings[index];
    if (binding === undefined) return use(out);
    if (options.resolver.binding === undefined) {
      return Effect.fail(failed(request, "promote", "cloudflare_worker_binding_resolver_missing"));
    }
    return options.resolver
      .binding(binding.bindingRef, (material) =>
        loop(index + 1, [...out, { ...material, name: binding.name }]),
      )
      .pipe(Effect.mapError(mapDeployResolutionFailureOnly(request, "promote")));
  };
  return loop(0, []);
};

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

const nonEmptyString = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

const accountMaterialFrom = (value: unknown): { readonly accountId: string } | null => {
  if (!Predicate.isObject(value)) return null;
  const accountId = nonEmptyString(value.accountId);
  return accountId === null ? null : { accountId };
};

const targetMaterialFrom = (value: unknown): { readonly scriptName: string } | null => {
  if (!Predicate.isObject(value)) return null;
  const scriptName = nonEmptyString(value.scriptName);
  return scriptName === null ? null : { scriptName };
};

const deployMaterialFrom = (value: unknown): CloudflareWorkerDeployMaterial | null => {
  if (!Predicate.isObject(value)) return null;
  const accountId = nonEmptyString(value.accountId);
  const scriptName = nonEmptyString(value.scriptName);
  const artifactRef = nonEmptyString(value.artifactRef);
  const targetRef = nonEmptyString(value.targetRef);
  const versionId = value.versionId === undefined ? undefined : nonEmptyString(value.versionId);
  const deploymentId =
    value.deploymentId === undefined ? undefined : nonEmptyString(value.deploymentId);
  if (
    accountId === null ||
    scriptName === null ||
    artifactRef === null ||
    targetRef === null ||
    versionId === null ||
    deploymentId === null
  ) {
    return null;
  }
  return {
    accountId,
    scriptName,
    artifactRef,
    targetRef,
    ...(versionId === undefined ? {} : { versionId }),
    ...(deploymentId === undefined ? {} : { deploymentId }),
  };
};

const recordMaterialFrom = (value: unknown): Record<string, unknown> | null =>
  Predicate.isObject(value) ? (value as Record<string, unknown>) : null;

const materialResolutionFailure = (ref: MaterialRef, reason: string) =>
  new CloudflareWorkerDeployResolutionFailure({ ref: materialRefKey(ref), reason });

const withMaterial = <A, B, E, R>(
  resolver: RefResolver,
  ref: MaterialRef,
  parse: (value: unknown) => A | null,
  reason: string,
  use: (material: A) => Effect.Effect<B, E | CloudflareWorkerDeployResolutionFailure, R>,
): Effect.Effect<B, E | CloudflareWorkerDeployResolutionFailure, R> =>
  Effect.acquireUseRelease(
    Effect.try({
      try: () => resolver.material(ref),
      catch: () => materialResolutionFailure(ref, reason),
    }).pipe(
      Effect.flatMap((value) =>
        value === null
          ? Effect.fail(materialResolutionFailure(ref, reason))
          : Effect.succeed(value),
      ),
    ),
    (value): Effect.Effect<B, E | CloudflareWorkerDeployResolutionFailure, R> => {
      const material = parse(value);
      return material === null
        ? Effect.fail(materialResolutionFailure(ref, reason))
        : use(material);
    },
    (value) =>
      Effect.sync(() => {
        resolver.dispose?.({ ref, material: value });
      }),
  );

const withCredentialToken = <A, E, R>(
  options: CloudflareWorkerDeployResolverCompositionOptions,
  use: (token: string) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | CloudflareWorkerDeployResolutionFailure, R> =>
  withMaterial(
    options.materialResolver,
    options.credentialRef,
    nonEmptyString,
    "cloudflare_worker_credential_material_invalid",
    use,
  );

export const makeCloudflareWorkerDeployResolverComposition = (
  options: CloudflareWorkerDeployResolverCompositionOptions,
): CloudflareWorkerDeployResolverComposition => {
  const targetMaterialRef = options.targetMaterialRef ?? cloudflareWorkerTargetMaterialRef;
  const productionEndpointRef =
    options.productionEndpointRef ?? cloudflareWorkerProductionEndpointMaterialRef;
  const rollbackDeployMaterialRef =
    options.rollbackDeployMaterialRef ?? cloudflareWorkerDeployMaterialRef;

  const target = <A, E, R>(
    targetRef: string,
    use: (material: CloudflareWorkerTargetMaterial) => Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | CloudflareWorkerDeployResolutionFailure, R> =>
    withCredentialToken(options, (apiToken) =>
      withMaterial(
        options.materialResolver,
        options.accountRef,
        accountMaterialFrom,
        "cloudflare_worker_account_material_invalid",
        (account) =>
          withMaterial(
            options.materialResolver,
            targetMaterialRef(targetRef),
            targetMaterialFrom,
            "cloudflare_worker_target_material_invalid",
            (worker) =>
              use({ accountId: account.accountId, scriptName: worker.scriptName, apiToken }),
          ),
      ),
    );

  const resolver: CloudflareWorkerDeployResolver = {
    expectedDigest: options.expectedDigest,
    target,
    ...(options.previousDeployRef === undefined
      ? {}
      : { previousDeployRef: options.previousDeployRef }),
    productionEndpoint: (productionRef, use) =>
      withMaterial(
        options.materialResolver,
        productionEndpointRef(productionRef),
        nonEmptyString,
        "cloudflare_worker_production_endpoint_material_invalid",
        use,
      ),
    rollback: (rollbackRef, use) =>
      withCredentialToken(options, (apiToken) =>
        withMaterial(
          options.materialResolver,
          rollbackDeployMaterialRef(rollbackRef),
          deployMaterialFrom,
          "cloudflare_worker_rollback_material_invalid",
          (material) => {
            if (material.versionId === undefined) {
              return Effect.fail(
                materialResolutionFailure(
                  rollbackDeployMaterialRef(rollbackRef),
                  "cloudflare_worker_rollback_material_requires_version_id",
                ),
              );
            }
            return use({
              accountId: material.accountId,
              scriptName: material.scriptName,
              apiToken,
              restoredDeployRef: rollbackRef,
              versionId: material.versionId,
            });
          },
        ),
      ),
    ...(options.bindingMaterialRef === undefined
      ? {}
      : {
          binding: (bindingRefValue, use) =>
            withMaterial(
              options.materialResolver,
              options.bindingMaterialRef?.(bindingRefValue) ??
                cloudflareWorkerBindingMaterialRef(bindingRefValue),
              recordMaterialFrom,
              "cloudflare_worker_binding_material_invalid",
              use,
            ),
        }),
  };

  return {
    bundleResolver: options.bundleResolver,
    resolver,
  };
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
      Effect.withSpan("agentos.cloudflare.deploy.preview")(
        Effect.gen(function* () {
          yield* requireValidBundle(options, request, "preview", request.targetRef);
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
      ),

    promote: (request) =>
      Effect.withSpan("agentos.cloudflare.deploy.promote")(
        Effect.gen(function* () {
          const bundle = yield* requireValidBundle(
            options,
            request,
            "promote",
            request.productionTargetRef,
          );
          return yield* options.resolver
            .target(request.productionTargetRef, (target) =>
              withResolvedBindings(options, request, bundle, (bindings) =>
                Effect.gen(function* () {
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
                  const versionId =
                    stringFromResult(body, "id") ?? stringFromResult(body, "version_id");
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
              ),
            )
            .pipe(
              catchDeployReconcileRequired(request, "promote"),
              Effect.mapError(mapDeployResolutionFailureOnly(request, "promote")),
            );
        }),
      ),

    readback: (request) =>
      Effect.withSpan("agentos.cloudflare.deploy.readback")(
        options.resolver
          .productionEndpoint(request.productionRef, (endpoint) =>
            Effect.gen(function* () {
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
          )
          .pipe(
            catchDeployReconcileRequired(request, "readback"),
            Effect.mapError(mapDeployResolutionFailureOnly(request, "readback")),
          ),
      ),

    rollback: (request) =>
      Effect.withSpan("agentos.cloudflare.deploy.rollback")(
        options.resolver
          .rollback(request.rollbackRef, (material) =>
            Effect.gen(function* () {
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
          )
          .pipe(
            catchDeployReconcileRequired(request, "rollback"),
            Effect.mapError(mapDeployResolutionFailureOnly(request, "rollback")),
          ),
      ),
  };
};
