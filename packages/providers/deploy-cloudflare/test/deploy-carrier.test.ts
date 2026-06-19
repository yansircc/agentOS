import { Cause, Effect, Exit, Option } from "effect";
import { describe, expect, it } from "@effect/vitest";
import { makePreClaim } from "@agent-os/kernel/effect-claim";

import {
  CloudflareWorkerDeployResolutionFailure,
  cloudflareWorkerDeployBundleDigest,
  makeCloudflareWorkerDeployCarrier,
  type CloudflareWorkerDeployBundle,
  type CloudflareWorkerDeployCarrierOptions,
  type CloudflareWorkerDeployFetch,
  type CloudflareWorkerDeployFetchInit,
} from "../src";

const targetRef = "cloudflare-worker-target:production";
const artifactRef = "staging:artifact:worker-v1";
const previousDeployRef = "deploy:cloudflare:version:previous";
const productionRef = "deploy:cloudflare:production:site";
const rollbackRef = "deploy:cloudflare:version:rollback";

const bundle = {
  manifest: {
    targetRef,
    mainModule: "index.js",
    compatibilityDate: "2026-06-01",
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

const jsonResponse = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

const optionsFor = (
  digest: string,
  fetch: CloudflareWorkerDeployFetch,
  recorded: Array<{ readonly ref: string; readonly material: unknown }> = [],
): CloudflareWorkerDeployCarrierOptions => ({
  fetch,
  bundleResolver: {
    resolve: () => Effect.succeed(bundle),
  },
  resolver: {
    expectedDigest: () => Effect.succeed(digest),
    target: (_targetRef, use) =>
      use({
        accountId: "raw-account-id",
        scriptName: "raw-script-name",
        apiToken: "secret-cloudflare-token",
      }),
    previousDeployRef: () => Effect.succeed(previousDeployRef),
    productionEndpoint: (_productionRef, use) => use("https://raw-production.example"),
    rollback: (_rollbackRef, use) =>
      use({
        accountId: "raw-account-id",
        scriptName: "raw-script-name",
        apiToken: "secret-cloudflare-token",
        restoredDeployRef: "deploy:cloudflare:version:restored",
        versionId: "raw-version-id",
      }),
  },
  recordMaterial: (ref, material) => {
    recorded.push({ ref, material });
  },
});

const serialized = (value: unknown): string => JSON.stringify(value);

describe("@agent-os/deploy-cloudflare DeployCarrier", () => {
  it.effect("records preview as validation-only symbolic deploy evidence", () =>
    Effect.gen(function* () {
      const digest = yield* cloudflareWorkerDeployBundleDigest(bundle);
      const requests: Array<unknown> = [];
      const carrier = makeCloudflareWorkerDeployCarrier(
        optionsFor(digest, async (url, init) => {
          requests.push({ url, init });
          return jsonResponse(500, { success: false });
        }),
      );

      const preview = yield* carrier.preview({
        claim: claimFor("preview"),
        subjectRef: "site-1",
        artifactRef,
        targetRef,
      });

      expect(preview).toMatchObject({
        subjectRef: "site-1",
        artifactRef,
        previewRef: expect.stringMatching(/^deploy:cloudflare:preview:[a-f0-9]{8}$/),
      });
      expect(requests).toEqual([]);
      expect(serialized(preview)).not.toContain("raw-account-id");
      expect(serialized(preview)).not.toContain("raw-script-name");
      expect(serialized(preview)).not.toContain("secret-cloudflare-token");
    }),
  );

  it.effect("promotes by uploading Worker modules and returning only symbolic deploy refs", () =>
    Effect.gen(function* () {
      const digest = yield* cloudflareWorkerDeployBundleDigest(bundle);
      const requests: Array<{
        readonly url: string;
        readonly init: CloudflareWorkerDeployFetchInit;
      }> = [];
      const recorded: Array<{ readonly ref: string; readonly material: unknown }> = [];
      const carrier = makeCloudflareWorkerDeployCarrier(
        optionsFor(
          digest,
          async (url, init) => {
            requests.push({ url, init });
            return jsonResponse(200, {
              success: true,
              result: { id: "raw-version-id", deployment_id: "raw-deployment-id" },
            });
          },
          recorded,
        ),
      );

      const promoted = yield* carrier.promote({
        claim: claimFor("promote"),
        subjectRef: "site-1",
        artifactRef,
        productionTargetRef: targetRef,
      });

      expect(promoted).toMatchObject({
        subjectRef: "site-1",
        deployRef: expect.stringMatching(/^deploy:cloudflare:promote:[a-f0-9]{8}$/),
        productionRef: expect.stringMatching(/^deploy:cloudflare:production:[a-f0-9]{8}$/),
        rollbackRef: previousDeployRef,
      });
      expect(requests).toHaveLength(1);
      expect(requests[0]?.url).toBe(
        "https://api.cloudflare.com/client/v4/accounts/raw-account-id/workers/scripts/raw-script-name",
      );
      expect(requests[0]?.init.method).toBe("PUT");
      expect(requests[0]?.init.headers).toEqual({
        Authorization: "Bearer secret-cloudflare-token",
      });
      expect(requests[0]?.init.body).toBeInstanceOf(FormData);
      const payload = serialized(promoted);
      expect(payload).not.toContain("raw-account-id");
      expect(payload).not.toContain("raw-script-name");
      expect(payload).not.toContain("secret-cloudflare-token");
      expect(payload).not.toContain("raw-version-id");
      expect(payload).not.toContain("raw-deployment-id");
      expect(recorded).toHaveLength(2);
      expect(serialized(recorded)).toContain("raw-version-id");
      expect(serialized(recorded)).toContain("raw-script-name");
      expect(serialized(recorded)).not.toContain("secret-cloudflare-token");
    }),
  );

  it.effect("readback resolves the live URL outside deploy projection payloads", () =>
    Effect.gen(function* () {
      const digest = yield* cloudflareWorkerDeployBundleDigest(bundle);
      const requests: Array<{
        readonly url: string;
        readonly init: CloudflareWorkerDeployFetchInit;
      }> = [];
      const carrier = makeCloudflareWorkerDeployCarrier(
        optionsFor(digest, async (url, init) => {
          requests.push({ url, init });
          return jsonResponse(200, { success: true });
        }),
      );

      const readback = yield* carrier.readback({
        claim: claimFor("readback"),
        subjectRef: "site-1",
        productionRef,
      });

      expect(readback).toMatchObject({
        subjectRef: "site-1",
        productionRef,
        readbackRef: expect.stringMatching(/^deploy:cloudflare:readback:[a-f0-9]{8}$/),
        status: "passed",
      });
      expect(requests).toEqual([
        { url: "https://raw-production.example", init: { method: "GET", headers: {} } },
      ]);
      expect(serialized(readback)).not.toContain("https://raw-production.example");
    }),
  );

  it.effect("returns reconcile-required when readback material is unavailable", () =>
    Effect.gen(function* () {
      const digest = yield* cloudflareWorkerDeployBundleDigest(bundle);
      const carrier = makeCloudflareWorkerDeployCarrier({
        ...optionsFor(digest, async () => jsonResponse(200, { success: true })),
        resolver: {
          ...optionsFor(digest, async () => jsonResponse(200, { success: true })).resolver,
          productionEndpoint: (ref) =>
            Effect.fail(
              new CloudflareWorkerDeployResolutionFailure({
                ref,
                reason: "missing_endpoint_material",
              }),
            ),
        },
      });

      const readback = yield* carrier.readback({
        claim: claimFor("readback"),
        subjectRef: "site-1",
        productionRef,
      });

      expect(readback).toMatchObject({
        subjectRef: "site-1",
        step: "readback",
        reason: "deploy:reason:cloudflare_worker_deploy_material_resolution_failed",
        claim: {
          phase: "indeterminate",
          indeterminateRef: {
            indeterminateKind: "reconcile_required",
          },
        },
      });
    }),
  );

  it.effect("rolls back by deploying a resolved previous version ref", () =>
    Effect.gen(function* () {
      const digest = yield* cloudflareWorkerDeployBundleDigest(bundle);
      const requests: Array<{
        readonly url: string;
        readonly init: CloudflareWorkerDeployFetchInit;
      }> = [];
      const carrier = makeCloudflareWorkerDeployCarrier(
        optionsFor(digest, async (url, init) => {
          requests.push({ url, init });
          return jsonResponse(200, { success: true, result: { id: "raw-rollback-deployment-id" } });
        }),
      );

      const rolledBack = yield* carrier.rollback({
        claim: claimFor("rollback"),
        subjectRef: "site-1",
        rollbackRef,
      });

      expect(rolledBack).toMatchObject({
        subjectRef: "site-1",
        rollbackRef: expect.stringMatching(/^deploy:cloudflare:rollback:[a-f0-9]{8}$/),
        restoredDeployRef: "deploy:cloudflare:version:restored",
      });
      expect(requests[0]?.url).toBe(
        "https://api.cloudflare.com/client/v4/accounts/raw-account-id/workers/scripts/raw-script-name/deployments",
      );
      expect(requests[0]?.init.body).toBe(
        JSON.stringify({
          strategy: "percentage",
          versions: [{ version_id: "raw-version-id", percentage: 100 }],
        }),
      );
      const payload = serialized(rolledBack);
      expect(payload).not.toContain("raw-account-id");
      expect(payload).not.toContain("raw-script-name");
      expect(payload).not.toContain("secret-cloudflare-token");
      expect(payload).not.toContain("raw-version-id");
      expect(payload).not.toContain("raw-rollback-deployment-id");
    }),
  );

  it.effect("fails before provider upload when the artifact digest does not match staging", () =>
    Effect.gen(function* () {
      const requests: Array<unknown> = [];
      const carrier = makeCloudflareWorkerDeployCarrier(
        optionsFor("sha256:not-the-digest", async (url, init) => {
          requests.push({ url, init });
          return jsonResponse(200, { success: true });
        }),
      );

      const failure = expectFailure(
        yield* Effect.exit(
          carrier.promote({
            claim: claimFor("promote"),
            subjectRef: "site-1",
            artifactRef,
            productionTargetRef: targetRef,
          }),
        ),
      );

      expect(requests).toEqual([]);
      expect(failure).toMatchObject({
        code: "PromotionFailed",
        reason: "cloudflare_worker_bundle_digest_mismatch",
      });
    }),
  );
});
