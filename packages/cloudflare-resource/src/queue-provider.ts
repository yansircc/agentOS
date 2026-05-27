import type {
  CloudflareQueueMaterial,
  CloudflareResourceCarrierOptions,
  CloudflareResourceFetch,
  CloudflareResourceFetchInit,
  CloudflareResourceFetchResponse,
  CloudflareResourceSpec,
} from "./provider-core";
import {
  makeCloudflareResourceCarrier,
  materialHelpers,
  queueMaterialFrom,
} from "./provider-core";

const { isRecord, nonEmptyString } = materialHelpers;

export type CloudflareQueueFetchInit = CloudflareResourceFetchInit;
export type CloudflareQueueFetchResponse = CloudflareResourceFetchResponse;
export type CloudflareQueueFetch = CloudflareResourceFetch;

export type CloudflareQueueMutationInput =
  | {
      readonly body: unknown;
      readonly contentType?: "json" | "text";
    }
  | {
      readonly messages: ReadonlyArray<unknown>;
    };

export type CloudflareQueueResourceCarrierOptions =
  CloudflareResourceCarrierOptions<CloudflareQueueMutationInput>;

const queueIdFromCreate = (body: unknown): string | null => {
  if (!isRecord(body) || !isRecord(body.result)) return null;
  return nonEmptyString(body.result.queue_id) ?? nonEmptyString(body.result.id);
};

const queueMutationInputFrom = (
  mutationKind: string,
  value: unknown,
): CloudflareQueueMutationInput | null => {
  if (!isRecord(value)) return null;
  if (mutationKind === "queue.send") {
    if (!("body" in value)) return null;
    if (
      value.contentType !== undefined &&
      value.contentType !== "json" &&
      value.contentType !== "text"
    ) {
      return null;
    }
    return {
      body: value.body,
      ...(value.contentType === undefined ? {} : { contentType: value.contentType }),
    };
  }
  if (mutationKind === "queue.send_batch") {
    return Array.isArray(value.messages) ? { messages: value.messages } : null;
  }
  return null;
};

const queueSpec: CloudflareResourceSpec<CloudflareQueueMaterial, CloudflareQueueMutationInput> = {
  resourceKind: "queue",
  bindingKind: "queue",
  defaultCarrierRef: "cloudflare-queue",
  supportedMutationKinds: new Set(["queue.send", "queue.send_batch"]),
  parseResourceMaterial: queueMaterialFrom,
  materialFromProvisionResult: (resourceName, body) => {
    const queueId = queueIdFromCreate(body);
    return queueId === null ? null : { queueId, queueName: resourceName };
  },
  provisionRequest: (accountId, context) => ({
    method: "POST",
    path: ["accounts", accountId, "queues"],
    json: { queue_name: context.resourceName },
  }),
  bindRequest: (accountId, material) => ({
    method: "GET",
    path: ["accounts", accountId, "queues", material.queueId],
  }),
  destroyRequest: (accountId, material) => ({
    method: "DELETE",
    path: ["accounts", accountId, "queues", material.queueId],
  }),
  parseMutationInput: queueMutationInputFrom,
  mutationRequest: (accountId, material, mutationKind, input) =>
    mutationKind === "queue.send"
      ? {
          method: "POST",
          path: ["accounts", accountId, "queues", material.queueId, "messages"],
          json:
            "body" in input
              ? {
                  body: input.body,
                  content_type:
                    input.contentType ?? (typeof input.body === "string" ? "text" : "json"),
                }
              : { body: null, content_type: "json" },
        }
      : {
          method: "POST",
          path: ["accounts", accountId, "queues", material.queueId, "messages", "batch"],
          json: "messages" in input ? { messages: input.messages } : { messages: [] },
        },
};

export const makeCloudflareQueueResourceCarrier = (options: CloudflareQueueResourceCarrierOptions) =>
  makeCloudflareResourceCarrier(queueSpec, options);
