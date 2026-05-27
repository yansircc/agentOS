import type {
  CloudflareKVNamespaceMaterial,
  CloudflareResourceCarrierOptions,
  CloudflareResourceFetch,
  CloudflareResourceFetchInit,
  CloudflareResourceFetchResponse,
  CloudflareResourceSpec,
} from "./provider-core";
import {
  kvNamespaceMaterialFrom,
  makeCloudflareResourceCarrier,
  materialHelpers,
} from "./provider-core";

const { isRecord, nonEmptyString } = materialHelpers;

export type CloudflareKVNamespaceFetchInit = CloudflareResourceFetchInit;
export type CloudflareKVNamespaceFetchResponse = CloudflareResourceFetchResponse;
export type CloudflareKVNamespaceFetch = CloudflareResourceFetch;

export type CloudflareKVNamespaceMutationInput =
  | {
      readonly body: ReadonlyArray<Record<string, unknown>>;
    }
  | {
      readonly keys: ReadonlyArray<string>;
    };

export type CloudflareKVNamespaceResourceCarrierOptions =
  CloudflareResourceCarrierOptions<CloudflareKVNamespaceMutationInput>;

const namespaceIdFromCreate = (body: unknown): string | null => {
  if (!isRecord(body) || !isRecord(body.result)) return null;
  return nonEmptyString(body.result.id);
};

const kvMutationInputFrom = (
  mutationKind: string,
  value: unknown,
): CloudflareKVNamespaceMutationInput | null => {
  if (!isRecord(value)) return null;
  if (mutationKind === "kv_namespace.bulk_put") {
    return Array.isArray(value.body) && value.body.every(isRecord) ? { body: value.body } : null;
  }
  if (mutationKind === "kv_namespace.bulk_delete") {
    return Array.isArray(value.keys) && value.keys.every((key) => typeof key === "string")
      ? { keys: value.keys }
      : null;
  }
  return null;
};

const kvNamespaceSpec: CloudflareResourceSpec<
  CloudflareKVNamespaceMaterial,
  CloudflareKVNamespaceMutationInput
> = {
  resourceKind: "kv_namespace",
  bindingKind: "kv_namespace",
  defaultCarrierRef: "cloudflare-kv-namespace",
  supportedMutationKinds: new Set(["kv_namespace.bulk_put", "kv_namespace.bulk_delete"]),
  parseResourceMaterial: kvNamespaceMaterialFrom,
  materialFromProvisionResult: (resourceName, body) => {
    const namespaceId = namespaceIdFromCreate(body);
    return namespaceId === null ? null : { namespaceId, title: resourceName };
  },
  provisionRequest: (accountId, context) => ({
    method: "POST",
    path: ["accounts", accountId, "storage", "kv", "namespaces"],
    json: { title: context.resourceName },
  }),
  bindRequest: (accountId, material) => ({
    method: "GET",
    path: ["accounts", accountId, "storage", "kv", "namespaces", material.namespaceId],
  }),
  destroyRequest: (accountId, material) => ({
    method: "DELETE",
    path: ["accounts", accountId, "storage", "kv", "namespaces", material.namespaceId],
  }),
  parseMutationInput: kvMutationInputFrom,
  mutationRequest: (accountId, material, mutationKind, input) =>
    mutationKind === "kv_namespace.bulk_put"
      ? {
          method: "PUT",
          path: [
            "accounts",
            accountId,
            "storage",
            "kv",
            "namespaces",
            material.namespaceId,
            "bulk",
          ],
          json: "body" in input ? input.body : [],
        }
      : {
          method: "POST",
          path: [
            "accounts",
            accountId,
            "storage",
            "kv",
            "namespaces",
            material.namespaceId,
            "bulk",
            "delete",
          ],
          json: "keys" in input ? input.keys : [],
        },
};

export const makeCloudflareKVNamespaceResourceCarrier = (
  options: CloudflareKVNamespaceResourceCarrierOptions,
) => makeCloudflareResourceCarrier(kvNamespaceSpec, options);
