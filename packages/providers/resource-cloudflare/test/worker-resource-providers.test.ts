import { Cause, Effect, Exit, Option } from "effect";
import { describe, expect, it, vi } from "@effect/vitest";
import { makePreClaim } from "@agent-os/core/effect-claim";
import {
  credentialMaterialRef,
  externalResourceMaterialRef,
  materialRefKey,
  type ExternalResourceMaterialRef,
  type MaterialRef,
} from "@agent-os/core/material-ref";
import type { RefResolver } from "@agent-os/core/ref-resolver";
import { RESOURCE_AUTHORITIES } from "@agent-os/resource-carrier";

import {
  makeCloudflareWorkerRouteResourceCarrier,
  makeCloudflareWorkerScriptResourceCarrier,
  makeCloudflareWorkerSubdomainResourceCarrier,
  type CloudflareResourceFetch,
  type CloudflareResourceFetchInit,
} from "../src";

const expectFailure = <A>(exit: Exit.Exit<unknown, A>): A => {
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) {
    const failure = Cause.findErrorOption(exit.cause);
    expect(Option.isSome(failure)).toBe(true);
    if (Option.isSome(failure)) return failure.value;
  }
  expect.fail("expected failed exit");
  return undefined as never;
};

const credentialRef = credentialMaterialRef("tenant/cloudflare/api-token", {
  provider: "cloudflare",
  purpose: "cloudflare_api",
});

const accountRef = externalResourceMaterialRef({
  provider: "cloudflare",
  resourceKind: "account",
  ref: "tenant/account/main",
});

const workerScriptRef = externalResourceMaterialRef({
  provider: "cloudflare",
  resourceKind: "worker_script",
  ref: "tenant/worker/main",
});

const workerRouteRef = externalResourceMaterialRef({
  provider: "cloudflare",
  resourceKind: "worker_route",
  ref: "tenant/route/production",
});

const workerSubdomainRef = externalResourceMaterialRef({
  provider: "cloudflare",
  resourceKind: "worker_subdomain",
  ref: "tenant/worker/workers-dev",
});

const claimFor = (
  resourceKind: "worker_script" | "worker_route" | "worker_subdomain",
  step: "provision" | "bind" | "mutate" | "destroy",
) =>
  makePreClaim({
    operationRef: `cf-resource:${resourceKind}:subject:${step}`,
    scopeRef: {
      kind: "external",
      scopeId: `cloudflare/tenant/${resourceKind}/main`,
      systemRef: "cloudflare",
    },
    effectAuthorityRef:
      step === "provision"
        ? RESOURCE_AUTHORITIES.PROVISION
        : step === "bind"
          ? RESOURCE_AUTHORITIES.BIND
          : step === "destroy"
            ? RESOURCE_AUTHORITIES.DESTROY
            : RESOURCE_AUTHORITIES.MUTATE,
    originRef: {
      originId: "@agent-os/resource-carrier",
      originKind: "extension_package",
    },
  });

const resolverFromMap = (materials: Map<string, unknown>): RefResolver => ({
  material: (ref: MaterialRef) => materials.get(materialRefKey(ref)) ?? null,
});

const standardMaterials = () =>
  new Map<string, unknown>([
    [materialRefKey(credentialRef), "secret-cloudflare-token"],
    [materialRefKey(accountRef), { accountId: "raw-account-id" }],
  ]);

const jsonResponse = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

const parseJsonBody = (body: BodyInit | undefined): unknown => {
  expect(typeof body).toBe("string");
  return JSON.parse(typeof body === "string" ? body : "null");
};

const redactedLedgerPayload = (value: unknown): string => JSON.stringify(value);

describe("@agent-os/resource-cloudflare Worker resources", () => {
  it.effect("provisions a Worker target/name with symbolic ledger payloads", () =>
    Effect.gen(function* () {
      const requests: Array<{ readonly url: string; readonly init: CloudflareResourceFetchInit }> =
        [];
      const materials = standardMaterials();
      const recorded: Array<{
        readonly ref: ExternalResourceMaterialRef;
        readonly material: unknown;
      }> = [];
      const fetch: CloudflareResourceFetch = async (url, init) => {
        requests.push({ url, init });
        return jsonResponse(200, {
          success: true,
          result: { id: "raw-worker-id", leaked: "raw-provider-secret" },
        });
      };
      const carrier = makeCloudflareWorkerScriptResourceCarrier({
        fetch,
        resolver: resolverFromMap(materials),
        carrierRef: "cloudflare-worker-script-test",
        recordMaterial: (ref, material) => {
          recorded.push({ ref, material });
          materials.set(materialRefKey(ref), material);
        },
        resolveMutationInput: async () => null,
      });

      const provisioned = yield* carrier.provision({
        claim: claimFor("worker_script", "provision"),
        subjectRef: "worker-target-1",
        resourceKind: "worker_script",
        resourceName: "raw-script-name",
        credentialRef,
        accountRef,
        resourceRef: workerScriptRef,
      });

      expect(provisioned).toMatchObject({
        subjectRef: "worker-target-1",
        resourceKind: "worker_script",
        resourceRef: workerScriptRef,
        accountRef,
        proofRef: expect.stringMatching(
          /^resource:cloudflare:worker_script:provision:[a-f0-9]{8}$/,
        ),
      });
      const serialized = redactedLedgerPayload(provisioned);
      expect(serialized).not.toContain("secret-cloudflare-token");
      expect(serialized).not.toContain("raw-account-id");
      expect(serialized).not.toContain("raw-worker-id");
      expect(serialized).not.toContain("raw-script-name");
      expect(serialized).not.toContain("raw-provider-secret");
      expect(recorded).toEqual([
        {
          ref: workerScriptRef,
          material: { scriptName: "raw-script-name", workerId: "raw-worker-id" },
        },
      ]);
      expect(requests).toHaveLength(1);
      expect(requests[0]?.url).toBe(
        "https://api.cloudflare.com/client/v4/accounts/raw-account-id/workers/workers",
      );
      expect(parseJsonBody(requests[0]?.init.body)).toEqual({ name: "raw-script-name" });
    }),
  );

  it.effect(
    "provisions and destroys a Worker route while keeping route material resolver-side",
    () =>
      Effect.gen(function* () {
        const requests: Array<{
          readonly url: string;
          readonly init: CloudflareResourceFetchInit;
        }> = [];
        const materials = standardMaterials();
        materials.set(materialRefKey(workerRouteRef), {
          zoneId: "raw-zone-id",
          pattern: "raw.example.com/*",
          scriptName: "raw-script-name",
        });
        const fetch: CloudflareResourceFetch = async (url, init) => {
          requests.push({ url, init });
          if (init.method === "POST") {
            return jsonResponse(200, {
              success: true,
              result: { id: "raw-route-id", leaked: "raw-route-secret" },
            });
          }
          return jsonResponse(200, { success: true, result: {} });
        };
        const carrier = makeCloudflareWorkerRouteResourceCarrier({
          fetch,
          resolver: resolverFromMap(materials),
          recordMaterial: (ref, material) => {
            materials.set(materialRefKey(ref), material);
          },
          resolveMutationInput: async () => null,
        });

        const provisioned = yield* carrier.provision({
          claim: claimFor("worker_route", "provision"),
          subjectRef: "route-1",
          resourceKind: "worker_route",
          resourceName: "production-route",
          credentialRef,
          accountRef,
          resourceRef: workerRouteRef,
        });
        const destroyed = yield* carrier.destroy({
          claim: claimFor("worker_route", "destroy"),
          subjectRef: "route-1",
          credentialRef,
          accountRef,
          resourceRef: workerRouteRef,
          reason: "manual",
        });

        expect(provisioned).toMatchObject({
          subjectRef: "route-1",
          resourceKind: "worker_route",
          resourceRef: workerRouteRef,
        });
        expect(destroyed).toMatchObject({
          subjectRef: "route-1",
          resourceRef: workerRouteRef,
          reason: "manual",
        });
        expect(materials.get(materialRefKey(workerRouteRef))).toEqual({
          zoneId: "raw-zone-id",
          pattern: "raw.example.com/*",
          scriptName: "raw-script-name",
          routeId: "raw-route-id",
        });
        const serialized = redactedLedgerPayload([provisioned, destroyed]);
        expect(serialized).not.toContain("secret-cloudflare-token");
        expect(serialized).not.toContain("raw-account-id");
        expect(serialized).not.toContain("raw-zone-id");
        expect(serialized).not.toContain("raw-route-id");
        expect(serialized).not.toContain("raw.example.com");
        expect(serialized).not.toContain("raw-script-name");
        expect(serialized).not.toContain("raw-route-secret");
        expect(requests.map((request) => [request.url, request.init.method])).toEqual([
          ["https://api.cloudflare.com/client/v4/zones/raw-zone-id/workers/routes", "POST"],
          [
            "https://api.cloudflare.com/client/v4/zones/raw-zone-id/workers/routes/raw-route-id",
            "DELETE",
          ],
        ]);
        expect(parseJsonBody(requests[0]?.init.body)).toEqual({
          pattern: "raw.example.com/*",
          script: "raw-script-name",
        });
      }),
  );

  it.effect("fails route destroy before fetch when live route id material is absent", () =>
    Effect.gen(function* () {
      const materials = standardMaterials();
      materials.set(materialRefKey(workerRouteRef), {
        zoneId: "raw-zone-id",
        pattern: "raw.example.com/*",
        scriptName: "raw-script-name",
      });
      const fetch = vi.fn<CloudflareResourceFetch>();
      const carrier = makeCloudflareWorkerRouteResourceCarrier({
        fetch,
        resolver: resolverFromMap(materials),
        resolveMutationInput: async () => null,
      });

      const failure = expectFailure(
        yield* Effect.exit(
          carrier.destroy({
            claim: claimFor("worker_route", "destroy"),
            subjectRef: "route-1",
            credentialRef,
            accountRef,
            resourceRef: workerRouteRef,
            reason: "manual",
          }),
        ),
      );

      expect(fetch).not.toHaveBeenCalled();
      expect(failure).toMatchObject({
        code: "MaterialUnavailable",
        step: "destroy",
        reason: "cloudflare_worker_route_material_requires_route_id",
        claim: {
          phase: "indeterminate",
          indeterminateRef: {
            indeterminateKind: "reconcile_required",
            reason: "resource:reason:material_unavailable:worker_route:destroy",
          },
        },
      });
    }),
  );

  it.effect(
    "provisions and disables a workers.dev subdomain without serializing endpoint data",
    () =>
      Effect.gen(function* () {
        const requests: Array<{
          readonly url: string;
          readonly init: CloudflareResourceFetchInit;
        }> = [];
        const materials = standardMaterials();
        materials.set(materialRefKey(workerSubdomainRef), {
          scriptName: "raw-script-name",
          enabled: true,
          previewsEnabled: false,
        });
        const fetch: CloudflareResourceFetch = async (url, init) => {
          requests.push({ url, init });
          return jsonResponse(200, { success: true, result: { enabled: init.method === "POST" } });
        };
        const carrier = makeCloudflareWorkerSubdomainResourceCarrier({
          fetch,
          resolver: resolverFromMap(materials),
          recordMaterial: (ref, material) => {
            materials.set(materialRefKey(ref), material);
          },
          resolveMutationInput: async () => null,
        });

        const provisioned = yield* carrier.provision({
          claim: claimFor("worker_subdomain", "provision"),
          subjectRef: "workers-dev-1",
          resourceKind: "worker_subdomain",
          resourceName: "workers-dev",
          credentialRef,
          accountRef,
          resourceRef: workerSubdomainRef,
        });
        const destroyed = yield* carrier.destroy({
          claim: claimFor("worker_subdomain", "destroy"),
          subjectRef: "workers-dev-1",
          credentialRef,
          accountRef,
          resourceRef: workerSubdomainRef,
          reason: "manual",
        });

        const serialized = redactedLedgerPayload([provisioned, destroyed]);
        expect(serialized).not.toContain("secret-cloudflare-token");
        expect(serialized).not.toContain("raw-account-id");
        expect(serialized).not.toContain("raw-script-name");
        expect(serialized).not.toContain("workers.dev");
        expect(requests.map((request) => [request.url, request.init.method])).toEqual([
          [
            "https://api.cloudflare.com/client/v4/accounts/raw-account-id/workers/scripts/raw-script-name/subdomain",
            "POST",
          ],
          [
            "https://api.cloudflare.com/client/v4/accounts/raw-account-id/workers/scripts/raw-script-name/subdomain",
            "POST",
          ],
        ]);
        expect(parseJsonBody(requests[0]?.init.body)).toEqual({
          enabled: true,
          previews_enabled: false,
        });
        expect(parseJsonBody(requests[1]?.init.body)).toEqual({
          enabled: false,
          previews_enabled: false,
        });
      }),
  );
});
