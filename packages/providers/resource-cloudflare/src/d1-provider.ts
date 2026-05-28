import type {
  CloudflareD1Material,
  CloudflareResourceCarrierOptions,
  CloudflareResourceFetch,
  CloudflareResourceFetchInit,
  CloudflareResourceFetchResponse,
  CloudflareResourceSpec,
} from "./provider-core";
import { d1MaterialFrom, makeCloudflareResourceCarrier, materialHelpers } from "./provider-core";

const { isRecord, nonEmptyString } = materialHelpers;

export type CloudflareD1FetchInit = CloudflareResourceFetchInit;
export type CloudflareD1FetchResponse = CloudflareResourceFetchResponse;
export type CloudflareD1Fetch = CloudflareResourceFetch;

export interface CloudflareD1MutationInput {
  readonly sql: string;
  readonly params?: ReadonlyArray<unknown>;
}

export type CloudflareD1ResourceCarrierOptions =
  CloudflareResourceCarrierOptions<CloudflareD1MutationInput>;

const d1DatabaseIdFromCreate = (body: unknown): string | null => {
  if (!isRecord(body) || !isRecord(body.result)) return null;
  return nonEmptyString(body.result.uuid);
};

const mutationInputFrom = (value: unknown): CloudflareD1MutationInput | null => {
  if (!isRecord(value)) return null;
  const sql = nonEmptyString(value.sql);
  if (sql === null) return null;
  if (value.params !== undefined && !Array.isArray(value.params)) return null;
  return value.params === undefined ? { sql } : { sql, params: value.params };
};

const querySucceeded = (body: unknown): boolean => {
  if (!isRecord(body)) return false;
  if (!Array.isArray(body.result)) return true;
  return body.result.every((item) => !isRecord(item) || item.success !== false);
};

const d1Spec: CloudflareResourceSpec<CloudflareD1Material, CloudflareD1MutationInput> = {
  resourceKind: "d1",
  bindingKind: "d1",
  defaultCarrierRef: "cloudflare-d1",
  supportedMutationKinds: new Set(["d1.exec", "d1.query"]),
  parseResourceMaterial: d1MaterialFrom,
  materialFromProvisionResult: (resourceName, body) => {
    const databaseId = d1DatabaseIdFromCreate(body);
    return databaseId === null ? null : { databaseId, databaseName: resourceName };
  },
  provisionRequest: (accountId, context) => ({
    method: "POST",
    path: ["accounts", accountId, "d1", "database"],
    json: { name: context.resourceName },
  }),
  bindRequest: (accountId, material) => ({
    method: "GET",
    path: ["accounts", accountId, "d1", "database", material.databaseId],
  }),
  destroyRequest: (accountId, material) => ({
    method: "DELETE",
    path: ["accounts", accountId, "d1", "database", material.databaseId],
  }),
  parseMutationInput: (_mutationKind, value) => mutationInputFrom(value),
  mutationRequest: (accountId, material, _mutationKind, input) => ({
    method: "POST",
    path: ["accounts", accountId, "d1", "database", material.databaseId, "query"],
    json:
      input.params === undefined ? { sql: input.sql } : { sql: input.sql, params: input.params },
  }),
  validateResponse: (step, body) =>
    step === "mutate" && !querySucceeded(body) ? "cloudflare_d1_query_not_successful" : null,
};

export const makeCloudflareD1ResourceCarrier = (options: CloudflareD1ResourceCarrierOptions) =>
  makeCloudflareResourceCarrier(d1Spec, options);
