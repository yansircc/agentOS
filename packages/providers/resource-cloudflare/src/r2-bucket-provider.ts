import { Predicate } from "effect";
import type {
  CloudflareR2BucketMaterial,
  CloudflareResourceCarrierOptions,
  CloudflareResourceFetch,
  CloudflareResourceFetchInit,
  CloudflareResourceFetchResponse,
  CloudflareResourceSpec,
} from "./provider-core";
import {
  makeCloudflareResourceCarrier,
  materialHelpers,
  r2BucketMaterialFrom,
} from "./provider-core";

const { nonEmptyString } = materialHelpers;

export type CloudflareR2BucketFetchInit = CloudflareResourceFetchInit;
export type CloudflareR2BucketFetchResponse = CloudflareResourceFetchResponse;
export type CloudflareR2BucketFetch = CloudflareResourceFetch;

export type CloudflareR2BucketMutationInput =
  | {
      readonly objectKey: string;
      readonly body: BodyInit;
      readonly contentType?: string;
    }
  | {
      readonly objectKey: string;
    };

export type CloudflareR2BucketResourceCarrierOptions =
  CloudflareResourceCarrierOptions<CloudflareR2BucketMutationInput>;

const r2MutationInputFrom = (
  mutationKind: string,
  value: unknown,
): CloudflareR2BucketMutationInput | null => {
  if (!Predicate.isRecord(value)) return null;
  const objectKey = nonEmptyString(value.objectKey);
  if (objectKey === null) return null;
  if (mutationKind === "r2_bucket.put_object") {
    if (value.body === undefined) return null;
    return {
      objectKey,
      body: value.body as BodyInit,
      ...(typeof value.contentType === "string" ? { contentType: value.contentType } : {}),
    };
  }
  if (mutationKind === "r2_bucket.delete_object") {
    return { objectKey };
  }
  return null;
};

const r2BucketSpec: CloudflareResourceSpec<
  CloudflareR2BucketMaterial,
  CloudflareR2BucketMutationInput
> = {
  resourceKind: "r2_bucket",
  bindingKind: "r2_bucket",
  defaultCarrierRef: "cloudflare-r2-bucket",
  supportedMutationKinds: new Set(["r2_bucket.put_object", "r2_bucket.delete_object"]),
  parseResourceMaterial: r2BucketMaterialFrom,
  materialFromProvisionResult: (context) => ({ bucketName: context.resourceName }),
  provisionRequest: (accountId, context) => ({
    method: "POST",
    path: ["accounts", accountId, "r2", "buckets"],
    json: { name: context.resourceName },
  }),
  bindRequest: (accountId, material) => ({
    method: "GET",
    path: ["accounts", accountId, "r2", "buckets", material.bucketName],
  }),
  destroyRequest: (accountId, material) => ({
    method: "DELETE",
    path: ["accounts", accountId, "r2", "buckets", material.bucketName],
  }),
  parseMutationInput: r2MutationInputFrom,
  mutationRequest: (accountId, material, mutationKind, input) =>
    mutationKind === "r2_bucket.put_object" && "body" in input
      ? {
          method: "PUT",
          path: [
            "accounts",
            accountId,
            "r2",
            "buckets",
            material.bucketName,
            "objects",
            input.objectKey,
          ],
          body: input.body,
          headers:
            input.contentType === undefined ? undefined : { "Content-Type": input.contentType },
        }
      : {
          method: "DELETE",
          path: [
            "accounts",
            accountId,
            "r2",
            "buckets",
            material.bucketName,
            "objects",
            input.objectKey,
          ],
        },
};

export const makeCloudflareR2BucketResourceCarrier = (
  options: CloudflareR2BucketResourceCarrierOptions,
) => makeCloudflareResourceCarrier(r2BucketSpec, options);
