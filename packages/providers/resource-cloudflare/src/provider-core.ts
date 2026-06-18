import { Effect, Predicate } from "effect";
import type { PreClaim } from "@agent-os/kernel/effect-claim";
import {
  externalResourceMaterialRef,
  materialRefKey,
  type BindingMaterialRef,
  type CredentialMaterialRef,
  type ExternalResourceMaterialRef,
  type MaterialRef,
} from "@agent-os/kernel/material-ref";
import {
  useRefResolverMaterial,
  type RefResolutionFailed,
  type RefResolver,
} from "@agent-os/kernel/ref-resolver";

import type {
  ResourceBindRequest,
  ResourceCarrier,
  ResourceDestroyRequest,
  ResourceFailure,
  ResourceMutationRequest,
  ResourceProvisionRequest,
} from "@agent-os/resource-carrier";
import type { ResourceLifecycleStep } from "@agent-os/resource-carrier";
import {
  resourceSettlementRef,
  settleResourceLived,
  settleResourceRejected,
} from "@agent-os/resource-carrier";

export type CloudflareResourceKind =
  | "d1"
  | "kv_namespace"
  | "r2_bucket"
  | "queue"
  | "workflow"
  | "worker_script"
  | "worker_route"
  | "worker_subdomain";

export interface CloudflareResourceFetchInit {
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: BodyInit;
}

export interface CloudflareResourceFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly json: () => Promise<unknown>;
}

export type CloudflareResourceFetch = (
  url: string,
  init: CloudflareResourceFetchInit,
) => Promise<CloudflareResourceFetchResponse>;

export interface CloudflareAccountMaterial {
  readonly accountId: string;
}

export interface CloudflareBindingMaterial {
  readonly bindingName: string;
}

export interface CloudflareD1Material {
  readonly databaseId: string;
  readonly databaseName?: string;
}

export interface CloudflareKVNamespaceMaterial {
  readonly namespaceId: string;
  readonly title?: string;
}

export interface CloudflareR2BucketMaterial {
  readonly bucketName: string;
}

export interface CloudflareQueueMaterial {
  readonly queueId: string;
  readonly queueName?: string;
}

export interface CloudflareWorkflowMaterial {
  readonly workflowName: string;
  readonly className?: string;
  readonly scriptName?: string;
}

export interface CloudflareWorkerScriptMaterial {
  readonly scriptName: string;
  readonly workerId?: string;
}

export interface CloudflareWorkerRouteMaterial {
  readonly zoneId: string;
  readonly pattern: string;
  readonly scriptName?: string;
  readonly routeId?: string;
}

export interface CloudflareWorkerSubdomainMaterial {
  readonly scriptName: string;
  readonly enabled: boolean;
  readonly previewsEnabled?: boolean;
}

export interface CloudflareResourceCarrierOptions<MutationInput> {
  readonly fetch: CloudflareResourceFetch;
  readonly resolver: RefResolver;
  readonly resolveMutationInput: (inputRef: string) => Promise<MutationInput | null>;
  readonly recordMaterial?: (
    ref: ExternalResourceMaterialRef,
    material: unknown,
  ) => void | Promise<void>;
  readonly baseUrl?: string;
  readonly carrierRef?: string;
}

interface CloudflareApiRequest {
  readonly method: CloudflareResourceFetchInit["method"];
  readonly path: ReadonlyArray<string>;
  readonly json?: unknown;
  readonly body?: BodyInit;
  readonly headers?: Readonly<Record<string, string>>;
}

interface ProvisionContext<Material> {
  readonly resourceName: string;
  readonly resourceMaterial?: Material;
}

export interface CloudflareResourceSpec<Material, MutationInput> {
  readonly resourceKind: CloudflareResourceKind;
  readonly bindingKind: string;
  readonly defaultCarrierRef: string;
  readonly supportedMutationKinds: ReadonlySet<string>;
  readonly provisionRequiresMaterial?: boolean;
  readonly validateProvisionMaterial?: (material: Material) => string | null;
  readonly validateResolvedMaterial?: (
    step: ResourceLifecycleStep,
    material: Material,
  ) => string | null;
  readonly parseResourceMaterial: (value: unknown) => Material | null;
  readonly materialFromProvisionResult: (
    context: ProvisionContext<Material>,
    body: unknown,
  ) => Material | null;
  readonly provisionRequest: (
    accountId: string,
    context: ProvisionContext<Material>,
  ) => CloudflareApiRequest;
  readonly bindRequest: (accountId: string, material: Material) => CloudflareApiRequest;
  readonly destroyRequest: (accountId: string, material: Material) => CloudflareApiRequest;
  readonly parseMutationInput: (mutationKind: string, value: unknown) => MutationInput | null;
  readonly mutationRequest: (
    accountId: string,
    material: Material,
    mutationKind: string,
    input: MutationInput,
  ) => CloudflareApiRequest;
  readonly validateResponse?: (step: ResourceLifecycleStep, body: unknown) => string | null;
}

const DEFAULT_BASE_URL = "https://api.cloudflare.com/client/v4";

const nonEmptyString = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

const hasOnlyKeys = (value: Record<string, unknown>, keys: ReadonlySet<string>): boolean =>
  Object.keys(value).every((key) => keys.has(key));

const optionalNonEmptyString = (value: unknown): value is string | undefined =>
  value === undefined || (typeof value === "string" && value.length > 0);

const encodePart = (value: string): string => encodeURIComponent(value);

const baseUrlOf = <MutationInput>(
  options: CloudflareResourceCarrierOptions<MutationInput>,
): string => (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");

const apiUrl = <MutationInput>(
  options: CloudflareResourceCarrierOptions<MutationInput>,
  path: ReadonlyArray<string>,
): string => `${baseUrlOf(options)}/${path.map(encodePart).join("/")}`;

const providerFailure = (
  claim: PreClaim,
  resourceKind: CloudflareResourceKind,
  step: ResourceLifecycleStep,
  code: ResourceFailure["code"],
  reason: string,
): ResourceFailure => {
  const proofRef = failureProofRef(resourceKind, step, claim);
  return {
    code,
    step,
    reason,
    proofRef,
    claim: settleResourceRejected(claim, {
      code,
      reason,
      proofRef,
    }),
  };
};

const failedCodeFor = (step: ResourceLifecycleStep): ResourceFailure["code"] =>
  step === "provision"
    ? "ProvisionFailed"
    : step === "bind"
      ? "BindingFailed"
      : step === "mutate"
        ? "MutationFailed"
        : "DestroyFailed";

const materialUnavailable = (
  claim: PreClaim,
  resourceKind: CloudflareResourceKind,
  step: ResourceLifecycleStep,
  reason: string,
): ResourceFailure => providerFailure(claim, resourceKind, step, "MaterialUnavailable", reason);

const unsupportedResource = (
  claim: PreClaim,
  resourceKind: CloudflareResourceKind,
  step: ResourceLifecycleStep,
  reason: string,
): ResourceFailure => providerFailure(claim, resourceKind, step, "UnsupportedResource", reason);

const providerRejected = (
  claim: PreClaim,
  resourceKind: CloudflareResourceKind,
  step: ResourceLifecycleStep,
  reason: string,
): ResourceFailure => providerFailure(claim, resourceKind, step, "ProviderFailure", reason);

const proofRef = (
  resourceKind: CloudflareResourceKind,
  step: ResourceLifecycleStep,
  claim: PreClaim,
): string =>
  resourceSettlementRef("cloudflare", resourceKind, step, proofToken(claim.operationRef));

const proofToken = (value: string): string => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
};

const failureProofRef = (
  resourceKind: CloudflareResourceKind,
  step: ResourceLifecycleStep,
  claim: PreClaim,
): string =>
  resourceSettlementRef(
    "cloudflare",
    resourceKind,
    step,
    proofToken(claim.operationRef),
    "rejected",
  );

const isCloudflareCredentialRef = (ref: CredentialMaterialRef): boolean =>
  ref.provider === "cloudflare" && ref.purpose === "cloudflare_api";

const requireCloudflareCredential = <Material, MutationInput>(
  options: CloudflareResourceCarrierOptions<MutationInput>,
  spec: CloudflareResourceSpec<Material, MutationInput>,
  claim: PreClaim,
  step: ResourceLifecycleStep,
  credentialRef: CredentialMaterialRef,
): Effect.Effect<string, ResourceFailure> =>
  Effect.gen(function* () {
    if (!isCloudflareCredentialRef(credentialRef)) {
      return yield* Effect.fail(
        materialUnavailable(
          claim,
          spec.resourceKind,
          step,
          "cloudflare_api credential material is required",
        ),
      );
    }
    const material = yield* useRefResolverMaterial(options.resolver, credentialRef, (value) =>
      Effect.succeed(value),
    ).pipe(
      Effect.mapError((error: RefResolutionFailed) =>
        materialUnavailable(
          claim,
          spec.resourceKind,
          step,
          error.reason === "resolver_threw"
            ? "cloudflare_api credential resolution failed"
            : "cloudflare_api credential material is unavailable",
        ),
      ),
    );
    if (typeof material !== "string" || material.length === 0) {
      return yield* Effect.fail(
        materialUnavailable(
          claim,
          spec.resourceKind,
          step,
          "cloudflare_api credential material is unavailable",
        ),
      );
    }
    return material;
  });

const requireCloudflareAccount = <Material, MutationInput>(
  options: CloudflareResourceCarrierOptions<MutationInput>,
  spec: CloudflareResourceSpec<Material, MutationInput>,
  claim: PreClaim,
  step: ResourceLifecycleStep,
  accountRef: ExternalResourceMaterialRef,
): Effect.Effect<CloudflareAccountMaterial, ResourceFailure> =>
  Effect.gen(function* () {
    if (accountRef.provider !== "cloudflare" || accountRef.resourceKind !== "account") {
      return yield* Effect.fail(
        materialUnavailable(
          claim,
          spec.resourceKind,
          step,
          "cloudflare account material is required",
        ),
      );
    }
    const material = yield* useRefResolverMaterial(options.resolver, accountRef, (value) =>
      Effect.succeed(value),
    ).pipe(
      Effect.mapError((error: RefResolutionFailed) =>
        materialUnavailable(
          claim,
          spec.resourceKind,
          step,
          error.reason === "resolver_threw"
            ? "cloudflare account resolution failed"
            : "cloudflare account material must contain accountId",
        ),
      ),
    );
    if (!Predicate.isObject(material)) {
      return yield* Effect.fail(
        materialUnavailable(
          claim,
          spec.resourceKind,
          step,
          "cloudflare account material must contain accountId",
        ),
      );
    }
    const accountId = nonEmptyString(material.accountId);
    if (accountId === null) {
      return yield* Effect.fail(
        materialUnavailable(
          claim,
          spec.resourceKind,
          step,
          "cloudflare account material must contain accountId",
        ),
      );
    }
    return { accountId };
  });

const requireResourceRef = <Material, MutationInput>(
  spec: CloudflareResourceSpec<Material, MutationInput>,
  claim: PreClaim,
  step: ResourceLifecycleStep,
  resourceRef: MaterialRef,
): Effect.Effect<ExternalResourceMaterialRef, ResourceFailure> => {
  if (
    resourceRef.kind !== "external_resource" ||
    resourceRef.provider !== "cloudflare" ||
    resourceRef.resourceKind !== spec.resourceKind
  ) {
    return Effect.fail(
      unsupportedResource(
        claim,
        spec.resourceKind,
        step,
        `cloudflare_${spec.resourceKind}_resource_ref_required`,
      ),
    );
  }
  return Effect.succeed(resourceRef);
};

const requireBindingRef = <Material, MutationInput>(
  spec: CloudflareResourceSpec<Material, MutationInput>,
  claim: PreClaim,
  step: ResourceLifecycleStep,
  bindingRef: BindingMaterialRef,
): Effect.Effect<BindingMaterialRef, ResourceFailure> => {
  if (bindingRef.provider !== "cloudflare" || bindingRef.bindingKind !== spec.bindingKind) {
    return Effect.fail(
      unsupportedResource(
        claim,
        spec.resourceKind,
        step,
        `cloudflare_${spec.resourceKind}_binding_ref_required`,
      ),
    );
  }
  return Effect.succeed(bindingRef);
};

const requireResourceMaterial = <Material, MutationInput>(
  options: CloudflareResourceCarrierOptions<MutationInput>,
  spec: CloudflareResourceSpec<Material, MutationInput>,
  claim: PreClaim,
  step: ResourceLifecycleStep,
  resourceRef: ExternalResourceMaterialRef,
): Effect.Effect<Material, ResourceFailure> =>
  Effect.gen(function* () {
    const material = yield* useRefResolverMaterial(options.resolver, resourceRef, (value) =>
      Effect.succeed(value),
    ).pipe(
      Effect.mapError((error: RefResolutionFailed) =>
        materialUnavailable(
          claim,
          spec.resourceKind,
          step,
          error.reason === "resolver_threw"
            ? `cloudflare_${spec.resourceKind}_resource_resolution_failed`
            : `cloudflare_${spec.resourceKind}_resource_material_unavailable`,
        ),
      ),
    );
    const parsed = spec.parseResourceMaterial(material);
    if (parsed === null) {
      return yield* Effect.fail(
        materialUnavailable(
          claim,
          spec.resourceKind,
          step,
          `cloudflare_${spec.resourceKind}_resource_material_unavailable`,
        ),
      );
    }
    const reason = spec.validateResolvedMaterial?.(step, parsed) ?? null;
    if (reason !== null) {
      return yield* Effect.fail(materialUnavailable(claim, spec.resourceKind, step, reason));
    }
    return parsed;
  });

const requireBindingMaterial = <Material, MutationInput>(
  options: CloudflareResourceCarrierOptions<MutationInput>,
  spec: CloudflareResourceSpec<Material, MutationInput>,
  claim: PreClaim,
  step: ResourceLifecycleStep,
  bindingRef: BindingMaterialRef,
): Effect.Effect<CloudflareBindingMaterial, ResourceFailure> =>
  Effect.gen(function* () {
    const material = yield* useRefResolverMaterial(options.resolver, bindingRef, (value) =>
      Effect.succeed(value),
    ).pipe(
      Effect.mapError((error: RefResolutionFailed) =>
        materialUnavailable(
          claim,
          spec.resourceKind,
          step,
          error.reason === "resolver_threw"
            ? `cloudflare_${spec.resourceKind}_binding_resolution_failed`
            : `cloudflare_${spec.resourceKind}_binding_material_unavailable`,
        ),
      ),
    );
    if (!Predicate.isObject(material)) {
      return yield* Effect.fail(
        materialUnavailable(
          claim,
          spec.resourceKind,
          step,
          `cloudflare_${spec.resourceKind}_binding_material_unavailable`,
        ),
      );
    }
    const bindingName = nonEmptyString(material.bindingName);
    if (bindingName === null) {
      return yield* Effect.fail(
        materialUnavailable(
          claim,
          spec.resourceKind,
          step,
          `cloudflare_${spec.resourceKind}_binding_material_unavailable`,
        ),
      );
    }
    return { bindingName };
  });

const cloudflareJson = <Material, MutationInput>(
  options: CloudflareResourceCarrierOptions<MutationInput>,
  spec: CloudflareResourceSpec<Material, MutationInput>,
  claim: PreClaim,
  step: ResourceLifecycleStep,
  token: string,
  request: CloudflareApiRequest,
): Effect.Effect<unknown, ResourceFailure> =>
  Effect.gen(function* () {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      ...(request.json === undefined ? {} : { "Content-Type": "application/json" }),
      ...request.headers,
    };
    const response = yield* Effect.tryPromise({
      try: () =>
        options.fetch(apiUrl(options, request.path), {
          method: request.method,
          headers,
          ...(request.json === undefined && request.body === undefined
            ? {}
            : {
                body:
                  request.json === undefined
                    ? request.body
                    : (JSON.stringify(request.json) as BodyInit),
              }),
        }),
      catch: () =>
        providerRejected(
          claim,
          spec.resourceKind,
          step,
          `cloudflare_${spec.resourceKind}_fetch_failed`,
        ),
    });
    if (!response.ok) {
      return yield* Effect.fail(
        providerFailure(
          claim,
          spec.resourceKind,
          step,
          failedCodeFor(step),
          `cloudflare_${spec.resourceKind}_${step}_http_${response.status}`,
        ),
      );
    }
    const body = yield* Effect.tryPromise({
      try: () => response.json(),
      catch: () =>
        providerRejected(
          claim,
          spec.resourceKind,
          step,
          `cloudflare_${spec.resourceKind}_response_json_invalid`,
        ),
    });
    if (!Predicate.isObject(body) || body.success !== true) {
      return yield* Effect.fail(
        providerFailure(
          claim,
          spec.resourceKind,
          step,
          failedCodeFor(step),
          `cloudflare_${spec.resourceKind}_${step}_not_successful`,
        ),
      );
    }
    return body;
  });

const recordProvisionedMaterial = <Material, MutationInput>(
  options: CloudflareResourceCarrierOptions<MutationInput>,
  spec: CloudflareResourceSpec<Material, MutationInput>,
  claim: PreClaim,
  resourceRef: ExternalResourceMaterialRef,
  material: Material,
): Effect.Effect<void, ResourceFailure> => {
  if (options.recordMaterial === undefined) return Effect.void;
  return Effect.asVoid(
    Effect.tryPromise({
      try: () => Promise.resolve(options.recordMaterial?.(resourceRef, material)),
      catch: () =>
        materialUnavailable(
          claim,
          spec.resourceKind,
          "provision",
          `cloudflare_${spec.resourceKind}_provisioned_material_record_failed`,
        ),
    }),
  );
};

const validateProviderResponse = <Material, MutationInput>(
  spec: CloudflareResourceSpec<Material, MutationInput>,
  claim: PreClaim,
  step: ResourceLifecycleStep,
  body: unknown,
): Effect.Effect<void, ResourceFailure> => {
  const reason = spec.validateResponse?.(step, body) ?? null;
  return reason === null
    ? Effect.void
    : Effect.fail(providerFailure(claim, spec.resourceKind, step, failedCodeFor(step), reason));
};

const defaultResourceRef = (resourceKind: CloudflareResourceKind, resourceName: string) =>
  externalResourceMaterialRef({
    provider: "cloudflare",
    resourceKind,
    ref: `${resourceKind}/${resourceName}`,
  });

const requireProvisionResourceRef = <Material, MutationInput>(
  spec: CloudflareResourceSpec<Material, MutationInput>,
  claim: PreClaim,
  request: ResourceProvisionRequest,
): Effect.Effect<ExternalResourceMaterialRef, ResourceFailure> =>
  requireResourceRef(
    spec,
    claim,
    "provision",
    request.resourceRef ?? defaultResourceRef(spec.resourceKind, request.resourceName),
  );

const requireMutationInput = <Material, MutationInput>(
  options: CloudflareResourceCarrierOptions<MutationInput>,
  spec: CloudflareResourceSpec<Material, MutationInput>,
  claim: PreClaim,
  mutationKind: string,
  inputRef: string,
): Effect.Effect<MutationInput, ResourceFailure> =>
  Effect.gen(function* () {
    if (inputRef.length === 0) {
      return yield* Effect.fail(
        materialUnavailable(
          claim,
          spec.resourceKind,
          "mutate",
          `cloudflare_${spec.resourceKind}_mutation_input_unavailable`,
        ),
      );
    }
    const material = yield* Effect.tryPromise({
      try: () => options.resolveMutationInput(inputRef),
      catch: () =>
        materialUnavailable(
          claim,
          spec.resourceKind,
          "mutate",
          `cloudflare_${spec.resourceKind}_mutation_input_unavailable`,
        ),
    });
    const input = spec.parseMutationInput(mutationKind, material);
    if (input === null) {
      return yield* Effect.fail(
        materialUnavailable(
          claim,
          spec.resourceKind,
          "mutate",
          `cloudflare_${spec.resourceKind}_mutation_input_unavailable`,
        ),
      );
    }
    return input;
  });

const livedPayloadClaim = (
  claim: PreClaim,
  resourceKind: CloudflareResourceKind,
  step: ResourceLifecycleStep,
  carrierRef: string,
) =>
  settleResourceLived(claim, {
    proofRef: proofRef(resourceKind, step, claim),
    carrierRef,
  });

export const makeCloudflareResourceCarrier = <Material, MutationInput>(
  spec: CloudflareResourceSpec<Material, MutationInput>,
  options: CloudflareResourceCarrierOptions<MutationInput>,
): ResourceCarrier => {
  const carrierRef = options.carrierRef ?? spec.defaultCarrierRef;

  return {
    provision: (request: ResourceProvisionRequest) =>
      Effect.gen(function* () {
        if (request.resourceKind !== spec.resourceKind) {
          return yield* Effect.fail(
            unsupportedResource(
              request.claim,
              spec.resourceKind,
              "provision",
              `cloudflare_${spec.resourceKind}_resource_kind_required`,
            ),
          );
        }
        const resourceRef = yield* requireProvisionResourceRef(spec, request.claim, request);
        const provisionMaterial = spec.provisionRequiresMaterial
          ? yield* requireResourceMaterial(options, spec, request.claim, "provision", resourceRef)
          : undefined;
        if (provisionMaterial !== undefined) {
          const reason = spec.validateProvisionMaterial?.(provisionMaterial) ?? null;
          if (reason !== null) {
            return yield* Effect.fail(
              materialUnavailable(request.claim, spec.resourceKind, "provision", reason),
            );
          }
        }
        const token = yield* requireCloudflareCredential(
          options,
          spec,
          request.claim,
          "provision",
          request.credentialRef,
        );
        const account = yield* requireCloudflareAccount(
          options,
          spec,
          request.claim,
          "provision",
          request.accountRef,
        );
        if (request.bindingRef !== undefined) {
          const bindingRef = yield* requireBindingRef(
            spec,
            request.claim,
            "provision",
            request.bindingRef,
          );
          yield* requireBindingMaterial(options, spec, request.claim, "provision", bindingRef);
        }
        const body = yield* cloudflareJson(
          options,
          spec,
          request.claim,
          "provision",
          token,
          spec.provisionRequest(account.accountId, {
            resourceName: request.resourceName,
            resourceMaterial: provisionMaterial,
          }),
        );
        yield* validateProviderResponse(spec, request.claim, "provision", body);
        const material = spec.materialFromProvisionResult(
          {
            resourceName: request.resourceName,
            resourceMaterial: provisionMaterial,
          },
          body,
        );
        if (material === null) {
          return yield* Effect.fail(
            providerFailure(
              request.claim,
              spec.resourceKind,
              "provision",
              "ProvisionFailed",
              `cloudflare_${spec.resourceKind}_create_result_missing_material`,
            ),
          );
        }
        yield* recordProvisionedMaterial(options, spec, request.claim, resourceRef, material);
        const anchorId = proofRef(spec.resourceKind, "provision", request.claim);
        return {
          subjectRef: request.subjectRef,
          resourceKind: spec.resourceKind,
          resourceRef,
          accountRef: request.accountRef,
          ...(request.bindingRef === undefined ? {} : { bindingRef: request.bindingRef }),
          proofRef: anchorId,
          claim: livedPayloadClaim(request.claim, spec.resourceKind, "provision", carrierRef),
        };
      }),

    bind: (request: ResourceBindRequest) =>
      Effect.gen(function* () {
        const resourceRef = yield* requireResourceRef(
          spec,
          request.claim,
          "bind",
          request.resourceRef,
        );
        const bindingRef = yield* requireBindingRef(
          spec,
          request.claim,
          "bind",
          request.bindingRef,
        );
        const token = yield* requireCloudflareCredential(
          options,
          spec,
          request.claim,
          "bind",
          request.credentialRef,
        );
        const account = yield* requireCloudflareAccount(
          options,
          spec,
          request.claim,
          "bind",
          request.accountRef,
        );
        const material = yield* requireResourceMaterial(
          options,
          spec,
          request.claim,
          "bind",
          resourceRef,
        );
        yield* requireBindingMaterial(options, spec, request.claim, "bind", bindingRef);
        const body = yield* cloudflareJson(
          options,
          spec,
          request.claim,
          "bind",
          token,
          spec.bindRequest(account.accountId, material),
        );
        yield* validateProviderResponse(spec, request.claim, "bind", body);
        const anchorId = proofRef(spec.resourceKind, "bind", request.claim);
        return {
          subjectRef: request.subjectRef,
          resourceRef,
          bindingRef,
          proofRef: anchorId,
          claim: livedPayloadClaim(request.claim, spec.resourceKind, "bind", carrierRef),
        };
      }),

    mutate: (request: ResourceMutationRequest) =>
      Effect.gen(function* () {
        if (!spec.supportedMutationKinds.has(request.mutationKind)) {
          return yield* Effect.fail(
            unsupportedResource(
              request.claim,
              spec.resourceKind,
              "mutate",
              `cloudflare_${spec.resourceKind}_mutation_kind_unsupported`,
            ),
          );
        }
        const resourceRef = yield* requireResourceRef(
          spec,
          request.claim,
          "mutate",
          request.resourceRef,
        );
        const bindingRef = yield* requireBindingRef(
          spec,
          request.claim,
          "mutate",
          request.bindingRef,
        );
        const token = yield* requireCloudflareCredential(
          options,
          spec,
          request.claim,
          "mutate",
          request.credentialRef,
        );
        const account = yield* requireCloudflareAccount(
          options,
          spec,
          request.claim,
          "mutate",
          request.accountRef,
        );
        const material = yield* requireResourceMaterial(
          options,
          spec,
          request.claim,
          "mutate",
          resourceRef,
        );
        yield* requireBindingMaterial(options, spec, request.claim, "mutate", bindingRef);
        const input = yield* requireMutationInput(
          options,
          spec,
          request.claim,
          request.mutationKind,
          request.inputRef,
        );
        const body = yield* cloudflareJson(
          options,
          spec,
          request.claim,
          "mutate",
          token,
          spec.mutationRequest(account.accountId, material, request.mutationKind, input),
        );
        yield* validateProviderResponse(spec, request.claim, "mutate", body);
        const anchorId = proofRef(spec.resourceKind, "mutate", request.claim);
        return {
          subjectRef: request.subjectRef,
          resourceRef,
          mutationKind: request.mutationKind,
          mutationRef: request.inputRef,
          proofRef: anchorId,
          ...(request.fingerprint === undefined ? {} : { fingerprint: request.fingerprint }),
          claim: livedPayloadClaim(request.claim, spec.resourceKind, "mutate", carrierRef),
        };
      }),

    destroy: (request: ResourceDestroyRequest) =>
      Effect.gen(function* () {
        const resourceRef = yield* requireResourceRef(
          spec,
          request.claim,
          "destroy",
          request.resourceRef,
        );
        const token = yield* requireCloudflareCredential(
          options,
          spec,
          request.claim,
          "destroy",
          request.credentialRef,
        );
        const account = yield* requireCloudflareAccount(
          options,
          spec,
          request.claim,
          "destroy",
          request.accountRef,
        );
        const material = yield* requireResourceMaterial(
          options,
          spec,
          request.claim,
          "destroy",
          resourceRef,
        );
        const body = yield* cloudflareJson(
          options,
          spec,
          request.claim,
          "destroy",
          token,
          spec.destroyRequest(account.accountId, material),
        );
        yield* validateProviderResponse(spec, request.claim, "destroy", body);
        const anchorId = proofRef(spec.resourceKind, "destroy", request.claim);
        return {
          subjectRef: request.subjectRef,
          resourceRef,
          proofRef: anchorId,
          reason: request.reason,
          claim: livedPayloadClaim(request.claim, spec.resourceKind, "destroy", carrierRef),
        };
      }),
  };
};

const accountIdKeys = new Set(["accountId"]);
const d1MaterialKeys = new Set(["databaseId", "databaseName"]);
const kvMaterialKeys = new Set(["namespaceId", "title"]);
const r2MaterialKeys = new Set(["bucketName"]);
const queueMaterialKeys = new Set(["queueId", "queueName"]);
const workflowMaterialKeys = new Set(["workflowName", "className", "scriptName"]);
const workerScriptMaterialKeys = new Set(["scriptName", "workerId"]);
const workerRouteMaterialKeys = new Set(["zoneId", "pattern", "scriptName", "routeId"]);
const workerSubdomainMaterialKeys = new Set(["scriptName", "enabled", "previewsEnabled"]);

export const accountMaterialFrom = (value: unknown): CloudflareAccountMaterial | null =>
  (() => {
    if (!Predicate.isObject(value) || !hasOnlyKeys(value, accountIdKeys)) return null;
    const accountId = nonEmptyString(value.accountId);
    return accountId === null ? null : { accountId };
  })();

export const d1MaterialFrom = (value: unknown): CloudflareD1Material | null =>
  (() => {
    if (!Predicate.isObject(value) || !hasOnlyKeys(value, d1MaterialKeys)) return null;
    const databaseId = nonEmptyString(value.databaseId);
    if (databaseId === null || !optionalNonEmptyString(value.databaseName)) return null;
    return {
      databaseId,
      ...(value.databaseName === undefined ? {} : { databaseName: value.databaseName }),
    };
  })();

export const kvNamespaceMaterialFrom = (value: unknown): CloudflareKVNamespaceMaterial | null =>
  (() => {
    if (!Predicate.isObject(value) || !hasOnlyKeys(value, kvMaterialKeys)) return null;
    const namespaceId = nonEmptyString(value.namespaceId);
    if (namespaceId === null || !optionalNonEmptyString(value.title)) return null;
    return {
      namespaceId,
      ...(value.title === undefined ? {} : { title: value.title }),
    };
  })();

export const r2BucketMaterialFrom = (value: unknown): CloudflareR2BucketMaterial | null =>
  (() => {
    if (!Predicate.isObject(value) || !hasOnlyKeys(value, r2MaterialKeys)) return null;
    const bucketName = nonEmptyString(value.bucketName);
    return bucketName === null ? null : { bucketName };
  })();

export const queueMaterialFrom = (value: unknown): CloudflareQueueMaterial | null =>
  (() => {
    if (!Predicate.isObject(value) || !hasOnlyKeys(value, queueMaterialKeys)) return null;
    const queueId = nonEmptyString(value.queueId);
    if (queueId === null || !optionalNonEmptyString(value.queueName)) return null;
    return {
      queueId,
      ...(value.queueName === undefined ? {} : { queueName: value.queueName }),
    };
  })();

export const workflowMaterialFrom = (value: unknown): CloudflareWorkflowMaterial | null =>
  (() => {
    if (!Predicate.isObject(value) || !hasOnlyKeys(value, workflowMaterialKeys)) return null;
    const workflowName = nonEmptyString(value.workflowName);
    if (
      workflowName === null ||
      !optionalNonEmptyString(value.className) ||
      !optionalNonEmptyString(value.scriptName)
    ) {
      return null;
    }
    return {
      workflowName,
      ...(value.className === undefined ? {} : { className: value.className }),
      ...(value.scriptName === undefined ? {} : { scriptName: value.scriptName }),
    };
  })();

export const workerScriptMaterialFrom = (value: unknown): CloudflareWorkerScriptMaterial | null =>
  (() => {
    if (!Predicate.isObject(value) || !hasOnlyKeys(value, workerScriptMaterialKeys)) return null;
    const scriptName = nonEmptyString(value.scriptName);
    if (scriptName === null || !optionalNonEmptyString(value.workerId)) return null;
    return {
      scriptName,
      ...(value.workerId === undefined ? {} : { workerId: value.workerId }),
    };
  })();

export const workerRouteMaterialFrom = (value: unknown): CloudflareWorkerRouteMaterial | null =>
  (() => {
    if (!Predicate.isObject(value) || !hasOnlyKeys(value, workerRouteMaterialKeys)) return null;
    const zoneId = nonEmptyString(value.zoneId);
    const pattern = nonEmptyString(value.pattern);
    if (
      zoneId === null ||
      pattern === null ||
      !optionalNonEmptyString(value.scriptName) ||
      !optionalNonEmptyString(value.routeId)
    ) {
      return null;
    }
    return {
      zoneId,
      pattern,
      ...(value.scriptName === undefined ? {} : { scriptName: value.scriptName }),
      ...(value.routeId === undefined ? {} : { routeId: value.routeId }),
    };
  })();

export const workerSubdomainMaterialFrom = (
  value: unknown,
): CloudflareWorkerSubdomainMaterial | null =>
  (() => {
    if (!Predicate.isObject(value) || !hasOnlyKeys(value, workerSubdomainMaterialKeys)) return null;
    const scriptName = nonEmptyString(value.scriptName);
    if (
      scriptName === null ||
      typeof value.enabled !== "boolean" ||
      (value.previewsEnabled !== undefined && typeof value.previewsEnabled !== "boolean")
    ) {
      return null;
    }
    return {
      scriptName,
      enabled: value.enabled,
      ...(value.previewsEnabled === undefined ? {} : { previewsEnabled: value.previewsEnabled }),
    };
  })();

export const materialKey = materialRefKey;

export const materialHelpers = {
  nonEmptyString,
  hasOnlyKeys,
} as const;
