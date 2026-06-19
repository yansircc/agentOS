import { Effect } from "effect";
import { describe, expect, it } from "@effect/vitest";
import type {
  DeployProductionPromotedPayload,
  DeployReconcileRequiredPayload,
  DeployRollbackRecordedPayload,
} from "@agent-os/deploy";
import { makePreClaim } from "@agent-os/kernel/effect-claim";
import {
  credentialMaterialRef,
  externalResourceMaterialRef,
  materialRefKey,
  type MaterialRef,
} from "@agent-os/kernel/material-ref";
import type { RefResolver } from "@agent-os/kernel/ref-resolver";

import {
  CloudflareWorkerBundleResolutionFailure,
  CloudflareWorkerDeployResolutionFailure,
  cloudflareWorkerBindingMaterialRef,
  cloudflareWorkerDeployBundleDigest,
  cloudflareWorkerDeployMaterialRef,
  cloudflareWorkerProductionEndpointMaterialRef,
  makeCloudflareWorkerDeployCarrier,
  makeCloudflareWorkerDeployResolverComposition,
  type CloudflareWorkerDeployBundle,
  type CloudflareWorkerDeployFetch,
  type CloudflareWorkerDeployFetchInit,
} from "../src";

const credentialRef = credentialMaterialRef("tenant/cloudflare/api-token", {
  provider: "cloudflare",
  purpose: "cloudflare_api",
});

const accountRef = externalResourceMaterialRef({
  provider: "cloudflare",
  resourceKind: "account",
  ref: "tenant/account/main",
});

const targetRef = "cloudflare-worker-target:production";
const artifactRef = "staging:artifact:worker-v2";
const previousDeployRef = "deploy:cloudflare:promote:v1";
const bindingRef = "cloudflare-worker-binding:kv";

const bundle = {
  manifest: {
    targetRef,
    mainModule: "index.js",
    compatibilityDate: "2026-06-01",
    bindings: [{ name: "KV", bindingRef }],
  },
  modules: [
    {
      name: "index.js",
      content: "export default { fetch: () => ({ status: 200 }) }",
      contentType: "application/javascript+module",
    },
  ],
} satisfies CloudflareWorkerDeployBundle;

const claimFor = (step: "preview" | "promote" | "readback" | "rollback") =>
  makePreClaim({
    operationRef: `deploy:worker:${step}`,
    scopeRef: { kind: "external", scopeId: "site/acme", systemRef: "cloudflare" },
    effectAuthorityRef: {
      authorityId: `@agent-os/deploy.${step}`,
      authorityClass: "deploy",
    },
    originRef: {
      originId: "@agent-os/deploy-cloudflare",
      originKind: "extension_package",
    },
  });

const resolverFromMap = (materials: Map<string, unknown>): RefResolver => ({
  material: (ref: MaterialRef) => materials.get(materialRefKey(ref)) ?? null,
});

const jsonResponse = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

const serialized = (value: unknown): string => JSON.stringify(value);

const expectPromoted = (
  payload: DeployProductionPromotedPayload | DeployReconcileRequiredPayload,
): DeployProductionPromotedPayload => {
  expect(payload).toMatchObject({
    claim: { phase: "lived" },
    deployRef: expect.any(String),
    productionRef: expect.any(String),
  });
  if (
    payload.claim.phase === "lived" &&
    "deployRef" in payload &&
    typeof payload.deployRef === "string" &&
    "productionRef" in payload &&
    typeof payload.productionRef === "string"
  ) {
    return payload;
  }
  throw new Error("expected deploy production_promoted payload");
};

const expectRollback = (
  payload: DeployRollbackRecordedPayload | DeployReconcileRequiredPayload,
): DeployRollbackRecordedPayload => {
  expect(payload).toMatchObject({
    claim: { phase: "lived" },
    restoredDeployRef: expect.any(String),
  });
  if (
    payload.claim.phase === "lived" &&
    "restoredDeployRef" in payload &&
    typeof payload.restoredDeployRef === "string"
  ) {
    return payload;
  }
  throw new Error("expected deploy rollback_recorded payload");
};

describe("@agent-os/deploy-cloudflare resolver composition", () => {
  it.effect(
    "composes Cloudflare Worker deploy material without ledger-visible URLs or tokens",
    () =>
      Effect.gen(function* () {
        const digest = yield* cloudflareWorkerDeployBundleDigest(bundle);
        const materials = new Map<string, unknown>([
          [materialRefKey(credentialRef), "secret-cloudflare-token"],
          [materialRefKey(accountRef), { accountId: "raw-account-id" }],
          [
            materialRefKey(
              externalResourceMaterialRef({
                provider: "cloudflare",
                resourceKind: "worker_script",
                ref: targetRef,
              }),
            ),
            { scriptName: "raw-script-name" },
          ],
          [
            materialRefKey(cloudflareWorkerBindingMaterialRef(bindingRef)),
            { type: "kv_namespace", namespace_id: "raw-kv-namespace-id" },
          ],
          [
            materialRefKey(cloudflareWorkerDeployMaterialRef(previousDeployRef)),
            {
              accountId: "raw-account-id",
              scriptName: "raw-script-name",
              artifactRef: "staging:artifact:worker-v1",
              targetRef,
              versionId: "raw-version-v1",
            },
          ],
        ]);
        const requests: Array<{
          readonly url: string;
          readonly init: CloudflareWorkerDeployFetchInit;
        }> = [];
        const fetch: CloudflareWorkerDeployFetch = async (url, init) => {
          requests.push({ url, init });
          if (init.method === "PUT") {
            return jsonResponse(200, {
              success: true,
              result: { id: "raw-version-v2", deployment_id: "raw-deployment-v2" },
            });
          }
          if (init.method === "POST") {
            return jsonResponse(200, {
              success: true,
              result: { id: "raw-rollback-deployment" },
            });
          }
          return jsonResponse(200, { success: true });
        };
        const composition = makeCloudflareWorkerDeployResolverComposition({
          materialResolver: resolverFromMap(materials),
          bundleResolver: {
            resolve: (ref) =>
              ref === artifactRef
                ? Effect.succeed(bundle)
                : Effect.fail(
                    new CloudflareWorkerBundleResolutionFailure({
                      artifactRef: ref,
                      reason: "missing test bundle",
                    }),
                  ),
          },
          expectedDigest: (ref) =>
            ref === artifactRef
              ? Effect.succeed(digest)
              : Effect.fail(
                  new CloudflareWorkerDeployResolutionFailure({
                    ref,
                    reason: "missing staging digest",
                  }),
                ),
          credentialRef,
          accountRef,
          bindingMaterialRef: cloudflareWorkerBindingMaterialRef,
          previousDeployRef: () => Effect.succeed(previousDeployRef),
        });
        const carrier = makeCloudflareWorkerDeployCarrier({
          fetch,
          ...composition,
          recordMaterial: (ref, material) => {
            materials.set(materialRefKey(cloudflareWorkerDeployMaterialRef(ref)), material);
          },
        });

        const preview = yield* carrier.preview({
          claim: claimFor("preview"),
          subjectRef: "site-1",
          artifactRef,
          targetRef,
        });
        const promoted = expectPromoted(
          yield* carrier.promote({
            claim: claimFor("promote"),
            subjectRef: "site-1",
            artifactRef,
            productionTargetRef: targetRef,
          }),
        );
        materials.set(
          materialRefKey(cloudflareWorkerProductionEndpointMaterialRef(promoted.productionRef)),
          "https://raw-production.example",
        );
        const readback = yield* carrier.readback({
          claim: claimFor("readback"),
          subjectRef: "site-1",
          productionRef: promoted.productionRef,
        });
        const rolledBack = expectRollback(
          yield* carrier.rollback({
            claim: claimFor("rollback"),
            subjectRef: "site-1",
            rollbackRef: previousDeployRef,
          }),
        );

        expect(requests.map((request) => request.url)).toEqual([
          "https://api.cloudflare.com/client/v4/accounts/raw-account-id/workers/scripts/raw-script-name",
          "https://raw-production.example",
          "https://api.cloudflare.com/client/v4/accounts/raw-account-id/workers/scripts/raw-script-name/deployments",
        ]);
        expect(rolledBack.restoredDeployRef).toBe(previousDeployRef);
        const ledgerVisible = serialized([preview, promoted, readback, rolledBack]);
        expect(ledgerVisible).not.toContain("secret-cloudflare-token");
        expect(ledgerVisible).not.toContain("raw-account-id");
        expect(ledgerVisible).not.toContain("raw-script-name");
        expect(ledgerVisible).not.toContain("raw-kv-namespace-id");
        expect(ledgerVisible).not.toContain("https://raw-production.example");
        expect(ledgerVisible).not.toContain("raw-version-v1");
        expect(ledgerVisible).not.toContain("raw-version-v2");
        const recordedDeploy = materials.get(
          materialRefKey(cloudflareWorkerDeployMaterialRef(promoted.deployRef)),
        );
        expect(serialized(recordedDeploy)).toContain("raw-version-v2");
        expect(serialized(recordedDeploy)).not.toContain("secret-cloudflare-token");
      }),
  );
});
