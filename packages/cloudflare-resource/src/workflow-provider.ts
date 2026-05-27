import type {
  CloudflareResourceCarrierOptions,
  CloudflareResourceFetch,
  CloudflareResourceFetchInit,
  CloudflareResourceFetchResponse,
  CloudflareResourceSpec,
  CloudflareWorkflowMaterial,
} from "./provider-core";
import {
  makeCloudflareResourceCarrier,
  materialHelpers,
  workflowMaterialFrom,
} from "./provider-core";

const { isRecord, nonEmptyString } = materialHelpers;

export type CloudflareWorkflowFetchInit = CloudflareResourceFetchInit;
export type CloudflareWorkflowFetchResponse = CloudflareResourceFetchResponse;
export type CloudflareWorkflowFetch = CloudflareResourceFetch;

export interface CloudflareWorkflowMutationInput {
  readonly instanceId?: string;
  readonly payload?: unknown;
}

export type CloudflareWorkflowResourceCarrierOptions =
  CloudflareResourceCarrierOptions<CloudflareWorkflowMutationInput>;

const workflowMutationInputFrom = (
  mutationKind: string,
  value: unknown,
): CloudflareWorkflowMutationInput | null => {
  if (mutationKind !== "workflow.create_instance" || !isRecord(value)) return null;
  const instanceId =
    value.instanceId === undefined ? undefined : nonEmptyString(value.instanceId);
  if (value.instanceId !== undefined && instanceId === null) return null;
  if (instanceId === null) return null;
  return {
    ...(instanceId === undefined ? {} : { instanceId }),
    ...(Object.hasOwn(value, "payload") ? { payload: value.payload } : {}),
  };
};

const workflowSpec: CloudflareResourceSpec<CloudflareWorkflowMaterial, CloudflareWorkflowMutationInput> =
  {
    resourceKind: "workflow",
    bindingKind: "workflow",
    defaultCarrierRef: "cloudflare-workflow",
    supportedMutationKinds: new Set(["workflow.create_instance"]),
    provisionRequiresMaterial: true,
    validateProvisionMaterial: (material) =>
      nonEmptyString(material.className) === null || nonEmptyString(material.scriptName) === null
        ? "cloudflare_workflow_provision_material_requires_class_and_script"
        : null,
    parseResourceMaterial: workflowMaterialFrom,
    materialFromProvisionResult: (resourceName) => ({
      workflowName: resourceName,
    }),
    provisionRequest: (accountId, context) => ({
      method: "PUT",
      path: ["accounts", accountId, "workflows", context.resourceName],
      json: {
        class_name: context.resourceMaterial?.className,
        script_name: context.resourceMaterial?.scriptName,
      },
    }),
    bindRequest: (accountId, material) => ({
      method: "GET",
      path: ["accounts", accountId, "workflows", material.workflowName],
    }),
    destroyRequest: (accountId, material) => ({
      method: "DELETE",
      path: ["accounts", accountId, "workflows", material.workflowName],
    }),
    parseMutationInput: workflowMutationInputFrom,
    mutationRequest: (accountId, material, _mutationKind, input) => ({
      method: "POST",
      path: ["accounts", accountId, "workflows", material.workflowName, "instances"],
      json: {
        ...(input.instanceId === undefined ? {} : { id: input.instanceId }),
        ...(Object.hasOwn(input, "payload") ? { params: input.payload } : {}),
      },
    }),
  };

export const makeCloudflareWorkflowResourceCarrier = (
  options: CloudflareWorkflowResourceCarrierOptions,
) => makeCloudflareResourceCarrier(workflowSpec, options);
