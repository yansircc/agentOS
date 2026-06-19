import { Effect } from "effect";
import { describe, expect, it } from "@effect/vitest";
import {
  DEPLOY_KIND,
  projectDeploy,
  type DeployProductionPromotedPayload,
  type DeployReconcileRequiredPayload,
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
  STAGING_KIND,
  projectStagingArtifact,
  settleStagingArtifactLived,
  stagingArtifactSettlementRef,
} from "@agent-os/staging-artifact";
import type { WorkspaceSessionExecResult } from "@agent-os/workspace-session";

import {
  CloudflareWorkerBundleResolutionFailure,
  CloudflareWorkerDeployResolutionFailure,
  cloudflareWorkerDeployBundleDigest,
  cloudflareWorkerDeployMaterialRef,
  cloudflareWorkerProductionEndpointMaterialRef,
  makeCloudflareWorkerDeployCarrier,
  makeCloudflareWorkerDeployResolverComposition,
  type CloudflareWorkerDeployBundle,
  type CloudflareWorkerDeployFetch,
  type CloudflareWorkerDeployFetchInit,
} from "../src";

const subjectRef = "site-1";
const sessionRef = "workspace-session:site-1";
const targetRef = "cloudflare-worker-target:production";
const previousDeployRef = "deploy:cloudflare:promote:v1";

const credentialRef = credentialMaterialRef("tenant/cloudflare/api-token", {
  provider: "cloudflare",
  purpose: "cloudflare_api",
});

const accountRef = externalResourceMaterialRef({
  provider: "cloudflare",
  resourceKind: "account",
  ref: "tenant/account/main",
});

const bundleFor = (artifactRef: string) =>
  ({
    manifest: {
      targetRef,
      mainModule: "index.js",
      compatibilityDate: "2026-06-01",
    },
    modules: [
      {
        name: "index.js",
        content: `export default { fetch: () => ({ body: ${JSON.stringify(artifactRef)} }) }`,
        contentType: "application/javascript+module",
      },
    ],
  }) satisfies CloudflareWorkerDeployBundle;

const claimFor = (
  packageId:
    | "@agent-os/staging-artifact"
    | "@agent-os/deploy.preview"
    | "@agent-os/deploy.promote"
    | "@agent-os/deploy.readback"
    | "@agent-os/deploy.rollback",
) =>
  makePreClaim({
    operationRef: `webapp:${subjectRef}:${packageId}`,
    scopeRef: { kind: "external", scopeId: "site/acme", systemRef: "cloudflare" },
    effectAuthorityRef: {
      authorityId: packageId,
      authorityClass: packageId.includes("staging") ? "artifact" : "deploy",
    },
    originRef: {
      originId: "@agent-os/webapp-orchestration-test",
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

describe("@agent-os/deploy-cloudflare webapp orchestration contract", () => {
  it.effect(
    "keeps Worker app deployment URLs behind resolver material across promote and rollback",
    () =>
      Effect.gen(function* () {
        const execResult = {
          exitCode: 0,
          stdout: "build complete",
          stderr: "",
          stdoutBytes: 14,
          stderrBytes: 0,
          stdoutTruncated: false,
          stderrTruncated: false,
          artifacts: [
            {
              ref: "staging:artifact:worker-v2",
              contentType: "application/vnd.agent-os.cloudflare-worker-bundle+json",
              name: "worker-v2",
            },
          ],
          durationMs: 42,
        } satisfies WorkspaceSessionExecResult;
        const artifactRef = execResult.artifacts[0]?.ref;
        expect(artifactRef).toBeDefined();
        const bundle = bundleFor(artifactRef ?? "missing");
        const digest = yield* cloudflareWorkerDeployBundleDigest(bundle);
        const stagingEvent = {
          id: 1,
          kind: STAGING_KIND.ARTIFACT_PUBLISHED,
          payload: {
            subjectRef,
            artifactRef,
            routeRef: targetRef,
            digest,
            claim: settleStagingArtifactLived(claimFor("@agent-os/staging-artifact"), {
              proofRef: stagingArtifactSettlementRef("artifact", subjectRef, "v2"),
              carrierRef: "staging-artifact",
            }),
          },
        };
        const stagingProjection = projectStagingArtifact([stagingEvent], subjectRef);
        expect(stagingProjection).toMatchObject({
          subjectRef,
          artifactRef,
          routeRef: targetRef,
          digest,
          status: "published",
        });

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
              ? Effect.succeed(stagingProjection.digest ?? "")
              : Effect.fail(
                  new CloudflareWorkerDeployResolutionFailure({
                    ref,
                    reason: "missing staging digest",
                  }),
                ),
          credentialRef,
          accountRef,
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
          claim: claimFor("@agent-os/deploy.preview"),
          subjectRef,
          artifactRef: stagingProjection.artifactRef ?? "",
          targetRef,
        });
        const promoted = expectPromoted(
          yield* carrier.promote({
            claim: claimFor("@agent-os/deploy.promote"),
            subjectRef,
            artifactRef: stagingProjection.artifactRef ?? "",
            productionTargetRef: targetRef,
          }),
        );
        materials.set(
          materialRefKey(cloudflareWorkerProductionEndpointMaterialRef(promoted.productionRef)),
          "https://raw-production-v2.example",
        );
        const readbackV2 = yield* carrier.readback({
          claim: claimFor("@agent-os/deploy.readback"),
          subjectRef,
          productionRef: promoted.productionRef,
        });
        const rolledBack = yield* carrier.rollback({
          claim: claimFor("@agent-os/deploy.rollback"),
          subjectRef,
          rollbackRef: previousDeployRef,
        });
        materials.set(
          materialRefKey(cloudflareWorkerProductionEndpointMaterialRef(promoted.productionRef)),
          "https://raw-production-v1.example",
        );
        const readbackV1 = yield* carrier.readback({
          claim: claimFor("@agent-os/deploy.readback"),
          subjectRef,
          productionRef: promoted.productionRef,
        });

        const deployEvents = [
          { id: 2, kind: DEPLOY_KIND.PREVIEW_RECORDED, payload: preview },
          { id: 3, kind: DEPLOY_KIND.PRODUCTION_PROMOTED, payload: promoted },
          { id: 4, kind: DEPLOY_KIND.PRODUCTION_READBACK, payload: readbackV2 },
        ];
        expect(projectDeploy(deployEvents, subjectRef)).toMatchObject({
          subjectRef,
          status: "live_verified",
          artifactRef,
          deployRef: promoted.deployRef,
          productionRef: promoted.productionRef,
        });
        const finalProjection = projectDeploy(
          [
            ...deployEvents,
            { id: 5, kind: DEPLOY_KIND.ROLLBACK_RECORDED, payload: rolledBack },
            { id: 6, kind: DEPLOY_KIND.PRODUCTION_READBACK, payload: readbackV1 },
          ],
          subjectRef,
        );
        expect(finalProjection).toMatchObject({
          subjectRef,
          status: "live_verified",
          artifactRef,
          deployRef: previousDeployRef,
          productionRef: promoted.productionRef,
        });
        expect(requests.map((request) => request.url)).toEqual([
          "https://api.cloudflare.com/client/v4/accounts/raw-account-id/workers/scripts/raw-script-name",
          "https://raw-production-v2.example",
          "https://api.cloudflare.com/client/v4/accounts/raw-account-id/workers/scripts/raw-script-name/deployments",
          "https://raw-production-v1.example",
        ]);
        const ledgerVisible = serialized([stagingEvent, deployEvents, rolledBack, readbackV1]);
        expect(ledgerVisible).not.toContain(sessionRef);
        expect(ledgerVisible).not.toContain("secret-cloudflare-token");
        expect(ledgerVisible).not.toContain("raw-account-id");
        expect(ledgerVisible).not.toContain("raw-script-name");
        expect(ledgerVisible).not.toContain("https://raw-production-v1.example");
        expect(ledgerVisible).not.toContain("https://raw-production-v2.example");
        expect(ledgerVisible).not.toContain("raw-version-v1");
        expect(ledgerVisible).not.toContain("raw-version-v2");
        expect(serialized(finalProjection)).not.toContain("https://");
      }),
  );
});
