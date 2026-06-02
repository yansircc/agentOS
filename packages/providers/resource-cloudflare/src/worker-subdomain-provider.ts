import type {
  CloudflareResourceCarrierOptions,
  CloudflareResourceFetch,
  CloudflareResourceFetchInit,
  CloudflareResourceFetchResponse,
  CloudflareResourceSpec,
  CloudflareWorkerSubdomainMaterial,
} from "./provider-core";
import { makeCloudflareResourceCarrier, workerSubdomainMaterialFrom } from "./provider-core";

export type CloudflareWorkerSubdomainFetchInit = CloudflareResourceFetchInit;
export type CloudflareWorkerSubdomainFetchResponse = CloudflareResourceFetchResponse;
export type CloudflareWorkerSubdomainFetch = CloudflareResourceFetch;

export type CloudflareWorkerSubdomainMutationInput = never;

export type CloudflareWorkerSubdomainResourceCarrierOptions =
  CloudflareResourceCarrierOptions<CloudflareWorkerSubdomainMutationInput>;

const workerSubdomainSpec: CloudflareResourceSpec<
  CloudflareWorkerSubdomainMaterial,
  CloudflareWorkerSubdomainMutationInput
> = {
  resourceKind: "worker_subdomain",
  bindingKind: "worker_subdomain",
  defaultCarrierRef: "cloudflare-worker-subdomain",
  supportedMutationKinds: new Set(),
  provisionRequiresMaterial: true,
  parseResourceMaterial: workerSubdomainMaterialFrom,
  materialFromProvisionResult: (context) => context.resourceMaterial ?? null,
  provisionRequest: (_accountId, context) => ({
    method: "POST",
    path: [
      "accounts",
      _accountId,
      "workers",
      "scripts",
      context.resourceMaterial?.scriptName ?? "",
      "subdomain",
    ],
    json: {
      enabled: context.resourceMaterial?.enabled,
      ...(context.resourceMaterial?.previewsEnabled === undefined
        ? {}
        : { previews_enabled: context.resourceMaterial.previewsEnabled }),
    },
  }),
  bindRequest: (accountId, material) => ({
    method: "GET",
    path: ["accounts", accountId, "workers", "scripts", material.scriptName, "subdomain"],
  }),
  destroyRequest: (accountId, material) => ({
    method: "POST",
    path: ["accounts", accountId, "workers", "scripts", material.scriptName, "subdomain"],
    json: {
      enabled: false,
      ...(material.previewsEnabled === undefined
        ? {}
        : { previews_enabled: material.previewsEnabled }),
    },
  }),
  parseMutationInput: () => null,
  mutationRequest: () => ({
    method: "GET",
    path: [],
  }),
};

export const makeCloudflareWorkerSubdomainResourceCarrier = (
  options: CloudflareWorkerSubdomainResourceCarrierOptions,
) => makeCloudflareResourceCarrier(workerSubdomainSpec, options);
