import { Effect } from "effect";
import { settleLivedClaim, type PreClaim } from "@agent-os/core/effect-claim";
import {
  externalResourceMaterialRef,
  type BindingMaterialRef,
  type CredentialMaterialRef,
  type ExternalResourceMaterialRef,
  type MaterialRef,
} from "@agent-os/core/material-ref";
import type { RefResolver } from "@agent-os/core/ref-resolver";

import type {
  CloudflareResourceBindRequest,
  CloudflareResourceCarrier,
  CloudflareResourceDestroyRequest,
  CloudflareResourceFailure,
  CloudflareResourceMutationRequest,
  CloudflareResourceProvisionRequest,
} from "./carrier";
import type { CloudflareResourceLifecycleStep } from "./events";
import { settleCloudflareResourceRejected } from "./settlement";

export interface CloudflareD1FetchInit {
  readonly method: "POST" | "DELETE";
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
}

export interface CloudflareD1FetchResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly json: () => Promise<unknown>;
}

export type CloudflareD1Fetch = (
  url: string,
  init: CloudflareD1FetchInit,
) => Promise<CloudflareD1FetchResponse>;

export interface CloudflareD1MutationInput {
  readonly sql: string;
  readonly params?: ReadonlyArray<unknown>;
}

export interface CloudflareD1ResourceCarrierOptions {
  readonly fetch: CloudflareD1Fetch;
  readonly resolver: RefResolver;
  readonly resolveMutationInput: (inputRef: string) => Promise<CloudflareD1MutationInput | null>;
  readonly baseUrl?: string;
  readonly carrierRef?: string;
}

const DEFAULT_BASE_URL = "https://api.cloudflare.com/client/v4";
const DEFAULT_CARRIER_REF = "cloudflare-d1";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const nonEmptyString = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

const providerFailure = (
  claim: PreClaim,
  step: CloudflareResourceLifecycleStep,
  code: CloudflareResourceFailure["code"],
  reason: string,
  proofRef?: string,
): CloudflareResourceFailure => ({
  code,
  step,
  reason,
  claim: settleCloudflareResourceRejected(claim, {
    code,
    reason,
    ...(proofRef === undefined ? {} : { proofRef }),
  }),
  ...(proofRef === undefined ? {} : { proofRef }),
});

const materialUnavailable = (
  claim: PreClaim,
  step: CloudflareResourceLifecycleStep,
  reason: string,
): CloudflareResourceFailure => providerFailure(claim, step, "MaterialUnavailable", reason);

const providerRejected = (
  claim: PreClaim,
  step: CloudflareResourceLifecycleStep,
  reason: string,
): CloudflareResourceFailure => providerFailure(claim, step, "ProviderFailure", reason);

const failedCodeFor = (step: CloudflareResourceLifecycleStep): CloudflareResourceFailure["code"] =>
  step === "provision"
    ? "ProvisionFailed"
    : step === "bind"
      ? "BindingFailed"
      : step === "mutate"
        ? "MutationFailed"
        : "DestroyFailed";

const encodePart = (value: string): string => encodeURIComponent(value);

const baseUrlOf = (options: CloudflareD1ResourceCarrierOptions): string =>
  (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");

const apiUrl = (options: CloudflareD1ResourceCarrierOptions, path: ReadonlyArray<string>): string =>
  `${baseUrlOf(options)}/${path.map(encodePart).join("/")}`;

const proofRef = (
  step: CloudflareResourceLifecycleStep,
  accountId: string,
  resourceId: string,
  subjectRef: string,
): string =>
  `proof://cloudflare/d1/${step}/${encodePart(accountId)}/${encodePart(resourceId)}/${encodePart(
    subjectRef,
  )}`;

const isCloudflareCredentialRef = (ref: CredentialMaterialRef): boolean =>
  ref.provider === "cloudflare" && ref.purpose === "cloudflare_api";

const resolveApiToken = (
  options: CloudflareD1ResourceCarrierOptions,
  claim: PreClaim,
  step: CloudflareResourceLifecycleStep,
  credentialRef: CredentialMaterialRef,
): Effect.Effect<string, CloudflareResourceFailure> =>
  Effect.gen(function* () {
    if (!isCloudflareCredentialRef(credentialRef)) {
      return yield* Effect.fail(
        materialUnavailable(claim, step, "cloudflare_api credential material is required"),
      );
    }
    const material = yield* Effect.try({
      try: () => options.resolver.material(credentialRef),
      catch: () => materialUnavailable(claim, step, "cloudflare_api credential resolution failed"),
    });
    if (typeof material !== "string" || material.length === 0) {
      return yield* Effect.fail(
        materialUnavailable(claim, step, "cloudflare_api credential material is unavailable"),
      );
    }
    return material;
  });

const accountIdFrom = (
  claim: PreClaim,
  step: CloudflareResourceLifecycleStep,
  accountRef: ExternalResourceMaterialRef,
): Effect.Effect<string, CloudflareResourceFailure> => {
  if (accountRef.provider !== "cloudflare" || accountRef.resourceKind !== "account") {
    return Effect.fail(materialUnavailable(claim, step, "cloudflare account material is required"));
  }
  return Effect.succeed(accountRef.ref);
};

const d1ResourceFrom = (
  claim: PreClaim,
  step: CloudflareResourceLifecycleStep,
  resourceRef: MaterialRef,
): Effect.Effect<ExternalResourceMaterialRef, CloudflareResourceFailure> => {
  if (
    resourceRef.kind !== "external_resource" ||
    resourceRef.provider !== "cloudflare" ||
    resourceRef.resourceKind !== "d1"
  ) {
    return Effect.fail(
      materialUnavailable(claim, step, "cloudflare d1 resource material is required"),
    );
  }
  return Effect.succeed(resourceRef);
};

const d1BindingFrom = (
  claim: PreClaim,
  bindingRef: BindingMaterialRef,
): Effect.Effect<BindingMaterialRef, CloudflareResourceFailure> => {
  if (bindingRef.provider !== "cloudflare" || bindingRef.bindingKind !== "d1") {
    return Effect.fail(
      materialUnavailable(claim, "bind", "cloudflare d1 binding material is required"),
    );
  }
  return Effect.succeed(bindingRef);
};

const cloudflareJson = (
  options: CloudflareD1ResourceCarrierOptions,
  claim: PreClaim,
  step: CloudflareResourceLifecycleStep,
  token: string,
  path: ReadonlyArray<string>,
  init: Omit<CloudflareD1FetchInit, "headers">,
): Effect.Effect<unknown, CloudflareResourceFailure> =>
  Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: () =>
        options.fetch(apiUrl(options, path), {
          ...init,
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
        }),
      catch: () => providerRejected(claim, step, "cloudflare_d1_fetch_failed"),
    });
    if (!response.ok) {
      return yield* Effect.fail(
        providerFailure(
          claim,
          step,
          failedCodeFor(step),
          `cloudflare_d1_${step}_http_${response.status}`,
        ),
      );
    }
    const body = yield* Effect.tryPromise({
      try: () => response.json(),
      catch: () => providerRejected(claim, step, "cloudflare_d1_response_json_invalid"),
    });
    if (!isRecord(body) || body.success !== true) {
      return yield* Effect.fail(
        providerFailure(claim, step, failedCodeFor(step), `cloudflare_d1_${step}_not_successful`),
      );
    }
    return body;
  });

const d1DatabaseIdFromCreate = (body: unknown): string | null => {
  if (!isRecord(body) || !isRecord(body.result)) return null;
  return nonEmptyString(body.result.uuid);
};

const mutationInputBody = (input: CloudflareD1MutationInput): Record<string, unknown> | null => {
  if (typeof input.sql !== "string" || input.sql.length === 0) return null;
  if (input.params !== undefined && !Array.isArray(input.params)) return null;
  return input.params === undefined ? { sql: input.sql } : { sql: input.sql, params: input.params };
};

const querySucceeded = (body: unknown): boolean => {
  if (!isRecord(body)) return false;
  if (!Array.isArray(body.result)) return true;
  return body.result.every((item) => !isRecord(item) || item.success !== false);
};

const mutationInputFrom = (
  options: CloudflareD1ResourceCarrierOptions,
  claim: PreClaim,
  inputRef: string,
): Effect.Effect<Record<string, unknown>, CloudflareResourceFailure> =>
  Effect.gen(function* () {
    const input = yield* Effect.tryPromise({
      try: () => options.resolveMutationInput(inputRef),
      catch: () => materialUnavailable(claim, "mutate", "cloudflare_d1_mutation_input_unavailable"),
    });
    if (input === null) {
      return yield* Effect.fail(
        materialUnavailable(claim, "mutate", "cloudflare_d1_mutation_input_unavailable"),
      );
    }
    const body = mutationInputBody(input);
    if (body === null) {
      return yield* Effect.fail(
        materialUnavailable(claim, "mutate", "cloudflare_d1_mutation_input_invalid"),
      );
    }
    return body;
  });

export const makeCloudflareD1ResourceCarrier = (
  options: CloudflareD1ResourceCarrierOptions,
): CloudflareResourceCarrier => {
  const carrierRef = options.carrierRef ?? DEFAULT_CARRIER_REF;

  return {
    provision: (request: CloudflareResourceProvisionRequest) =>
      Effect.gen(function* () {
        if (request.resourceKind !== "d1") {
          return yield* Effect.fail(
            materialUnavailable(request.claim, "provision", "cloudflare_d1_resource_kind_required"),
          );
        }
        const token = yield* resolveApiToken(
          options,
          request.claim,
          "provision",
          request.credentialRef,
        );
        const accountId = yield* accountIdFrom(request.claim, "provision", request.accountRef);
        const body = yield* cloudflareJson(
          options,
          request.claim,
          "provision",
          token,
          ["accounts", accountId, "d1", "database"],
          {
            method: "POST",
            body: JSON.stringify({ name: request.resourceName }),
          },
        );
        const databaseId = d1DatabaseIdFromCreate(body);
        if (databaseId === null) {
          return yield* Effect.fail(
            providerFailure(
              request.claim,
              "provision",
              "ProvisionFailed",
              "cloudflare_d1_create_result_missing_uuid",
            ),
          );
        }
        const resourceRef = externalResourceMaterialRef({
          provider: "cloudflare",
          resourceKind: "d1",
          ref: databaseId,
        });
        const anchorId = proofRef("provision", accountId, databaseId, request.subjectRef);
        return {
          subjectRef: request.subjectRef,
          resourceKind: "d1",
          resourceRef,
          accountRef: request.accountRef,
          ...(request.bindingRef === undefined ? {} : { bindingRef: request.bindingRef }),
          proofRef: anchorId,
          claim: settleLivedClaim(request.claim, {
            anchorId,
            anchorKind: "carrier_proof",
            carrierRef,
          }),
        };
      }),

    bind: (request: CloudflareResourceBindRequest) =>
      Effect.gen(function* () {
        yield* resolveApiToken(options, request.claim, "bind", request.credentialRef);
        const accountId = yield* accountIdFrom(request.claim, "bind", request.accountRef);
        const resourceRef = yield* d1ResourceFrom(request.claim, "bind", request.resourceRef);
        const bindingRef = yield* d1BindingFrom(request.claim, request.bindingRef);
        const anchorId = proofRef("bind", accountId, resourceRef.ref, bindingRef.ref);
        return {
          subjectRef: request.subjectRef,
          resourceRef,
          bindingRef,
          proofRef: anchorId,
          claim: settleLivedClaim(request.claim, {
            anchorId,
            anchorKind: "carrier_proof",
            carrierRef,
          }),
        };
      }),

    mutate: (request: CloudflareResourceMutationRequest) =>
      Effect.gen(function* () {
        if (request.mutationKind !== "d1.exec" && request.mutationKind !== "d1.query") {
          return yield* Effect.fail(
            providerFailure(
              request.claim,
              "mutate",
              "MutationFailed",
              "cloudflare_d1_mutation_kind_unsupported",
            ),
          );
        }
        const token = yield* resolveApiToken(
          options,
          request.claim,
          "mutate",
          request.credentialRef,
        );
        const accountId = yield* accountIdFrom(request.claim, "mutate", request.accountRef);
        const resourceRef = yield* d1ResourceFrom(request.claim, "mutate", request.resourceRef);
        const body = yield* mutationInputFrom(options, request.claim, request.inputRef);
        const responseBody = yield* cloudflareJson(
          options,
          request.claim,
          "mutate",
          token,
          ["accounts", accountId, "d1", "database", resourceRef.ref, "query"],
          {
            method: "POST",
            body: JSON.stringify(body),
          },
        );
        if (!querySucceeded(responseBody)) {
          return yield* Effect.fail(
            providerFailure(
              request.claim,
              "mutate",
              "MutationFailed",
              "cloudflare_d1_query_not_successful",
            ),
          );
        }
        const anchorId = proofRef("mutate", accountId, resourceRef.ref, request.inputRef);
        return {
          subjectRef: request.subjectRef,
          resourceRef,
          mutationKind: request.mutationKind,
          mutationRef: request.inputRef,
          proofRef: anchorId,
          ...(request.fingerprint === undefined ? {} : { fingerprint: request.fingerprint }),
          claim: settleLivedClaim(request.claim, {
            anchorId,
            anchorKind: "carrier_proof",
            carrierRef,
          }),
        };
      }),

    destroy: (request: CloudflareResourceDestroyRequest) =>
      Effect.gen(function* () {
        const token = yield* resolveApiToken(
          options,
          request.claim,
          "destroy",
          request.credentialRef,
        );
        const accountId = yield* accountIdFrom(request.claim, "destroy", request.accountRef);
        const resourceRef = yield* d1ResourceFrom(request.claim, "destroy", request.resourceRef);
        yield* cloudflareJson(
          options,
          request.claim,
          "destroy",
          token,
          ["accounts", accountId, "d1", "database", resourceRef.ref],
          {
            method: "DELETE",
          },
        );
        const anchorId = proofRef("destroy", accountId, resourceRef.ref, request.subjectRef);
        return {
          subjectRef: request.subjectRef,
          resourceRef,
          proofRef: anchorId,
          reason: request.reason,
          claim: settleLivedClaim(request.claim, {
            anchorId,
            anchorKind: "carrier_proof",
            carrierRef,
          }),
        };
      }),
  };
};
