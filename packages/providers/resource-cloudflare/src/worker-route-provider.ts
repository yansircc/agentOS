import { Predicate } from "effect";
import type {
  CloudflareResourceCarrierOptions,
  CloudflareResourceFetch,
  CloudflareResourceFetchInit,
  CloudflareResourceFetchResponse,
  CloudflareResourceSpec,
  CloudflareWorkerRouteMaterial,
} from "./provider-core";
import {
  makeCloudflareResourceCarrier,
  materialHelpers,
  workerRouteMaterialFrom,
} from "./provider-core";

const { nonEmptyString } = materialHelpers;

export type CloudflareWorkerRouteFetchInit = CloudflareResourceFetchInit;
export type CloudflareWorkerRouteFetchResponse = CloudflareResourceFetchResponse;
export type CloudflareWorkerRouteFetch = CloudflareResourceFetch;

export type CloudflareWorkerRouteMutationInput = never;

export type CloudflareWorkerRouteResourceCarrierOptions =
  CloudflareResourceCarrierOptions<CloudflareWorkerRouteMutationInput>;

const routeIdFromCreate = (body: unknown): string | null => {
  if (!Predicate.isRecord(body) || !Predicate.isRecord(body.result)) return null;
  return nonEmptyString(body.result.id);
};

const requireRouteId = (
  step: "provision" | "bind" | "mutate" | "destroy",
  material: CloudflareWorkerRouteMaterial,
): string | null =>
  step === "bind" || step === "destroy"
    ? material.routeId === undefined
      ? "cloudflare_worker_route_material_requires_route_id"
      : null
    : null;

const workerRouteSpec: CloudflareResourceSpec<
  CloudflareWorkerRouteMaterial,
  CloudflareWorkerRouteMutationInput
> = {
  resourceKind: "worker_route",
  bindingKind: "worker_route",
  defaultCarrierRef: "cloudflare-worker-route",
  supportedMutationKinds: new Set(),
  provisionRequiresMaterial: true,
  validateProvisionMaterial: (material) =>
    material.scriptName === undefined
      ? "cloudflare_worker_route_material_requires_script_name"
      : null,
  validateResolvedMaterial: requireRouteId,
  parseResourceMaterial: workerRouteMaterialFrom,
  materialFromProvisionResult: (context, body) => {
    const routeId = routeIdFromCreate(body);
    const material = context.resourceMaterial;
    if (routeId === null || material === undefined || material.scriptName === undefined)
      return null;
    return {
      zoneId: material.zoneId,
      pattern: material.pattern,
      scriptName: material.scriptName,
      routeId,
    };
  },
  provisionRequest: (_accountId, context) => ({
    method: "POST",
    path: ["zones", context.resourceMaterial?.zoneId ?? "", "workers", "routes"],
    json: {
      pattern: context.resourceMaterial?.pattern,
      script: context.resourceMaterial?.scriptName,
    },
  }),
  bindRequest: (_accountId, material) => ({
    method: "GET",
    path: ["zones", material.zoneId, "workers", "routes", material.routeId ?? ""],
  }),
  destroyRequest: (_accountId, material) => ({
    method: "DELETE",
    path: ["zones", material.zoneId, "workers", "routes", material.routeId ?? ""],
  }),
  parseMutationInput: () => null,
  mutationRequest: () => ({
    method: "GET",
    path: [],
  }),
};

export const makeCloudflareWorkerRouteResourceCarrier = (
  options: CloudflareWorkerRouteResourceCarrierOptions,
) => makeCloudflareResourceCarrier(workerRouteSpec, options);
