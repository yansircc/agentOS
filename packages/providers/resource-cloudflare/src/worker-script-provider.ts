import { Predicate } from "effect";
import type {
  CloudflareResourceCarrierOptions,
  CloudflareResourceFetch,
  CloudflareResourceFetchInit,
  CloudflareResourceFetchResponse,
  CloudflareResourceSpec,
  CloudflareWorkerScriptMaterial,
} from "./provider-core";
import {
  makeCloudflareResourceCarrier,
  materialHelpers,
  workerScriptMaterialFrom,
} from "./provider-core";

const { nonEmptyString } = materialHelpers;

export type CloudflareWorkerScriptFetchInit = CloudflareResourceFetchInit;
export type CloudflareWorkerScriptFetchResponse = CloudflareResourceFetchResponse;
export type CloudflareWorkerScriptFetch = CloudflareResourceFetch;

export type CloudflareWorkerScriptMutationInput = never;

export type CloudflareWorkerScriptResourceCarrierOptions =
  CloudflareResourceCarrierOptions<CloudflareWorkerScriptMutationInput>;

const workerIdFromCreate = (body: unknown): string | null => {
  if (!Predicate.isObject(body) || !Predicate.isObject(body.result)) return null;
  return nonEmptyString(body.result.id);
};

const requireWorkerId = (
  step: "provision" | "bind" | "mutate" | "destroy",
  material: CloudflareWorkerScriptMaterial,
): string | null =>
  step === "bind" || step === "destroy"
    ? material.workerId === undefined
      ? "cloudflare_worker_script_material_requires_worker_id"
      : null
    : null;

const workerScriptSpec: CloudflareResourceSpec<
  CloudflareWorkerScriptMaterial,
  CloudflareWorkerScriptMutationInput
> = {
  resourceKind: "worker_script",
  bindingKind: "worker_script",
  defaultCarrierRef: "cloudflare-worker-script",
  supportedMutationKinds: new Set(),
  parseResourceMaterial: workerScriptMaterialFrom,
  validateResolvedMaterial: requireWorkerId,
  materialFromProvisionResult: (context, body) => {
    const workerId = workerIdFromCreate(body);
    return workerId === null ? null : { scriptName: context.resourceName, workerId };
  },
  provisionRequest: (_accountId, context) => ({
    method: "POST",
    path: ["accounts", _accountId, "workers", "workers"],
    json: { name: context.resourceName },
  }),
  bindRequest: (accountId, material) => ({
    method: "GET",
    path: ["accounts", accountId, "workers", "workers", material.workerId ?? ""],
  }),
  destroyRequest: (accountId, material) => ({
    method: "DELETE",
    path: ["accounts", accountId, "workers", "workers", material.workerId ?? ""],
  }),
  parseMutationInput: () => null,
  mutationRequest: () => ({
    method: "GET",
    path: [],
  }),
};

export const makeCloudflareWorkerScriptResourceCarrier = (
  options: CloudflareWorkerScriptResourceCarrierOptions,
) => makeCloudflareResourceCarrier(workerScriptSpec, options);
