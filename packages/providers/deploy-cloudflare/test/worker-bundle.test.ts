import { Effect } from "effect";
import { describe, expect, it } from "@effect/vitest";

import {
  cloudflareWorkerDeployBundleDigest,
  resolveCloudflareWorkerDeployBundle,
  validateCloudflareWorkerDeployBundle,
  validateCloudflareWorkerDeployBundleDigest,
  type CloudflareWorkerDeployBundle,
} from "../src";

const bundle = {
  manifest: {
    targetRef: "cloudflare-worker-target:acme",
    mainModule: "index.js",
    compatibilityDate: "2026-06-01",
    bindings: [{ name: "DB", bindingRef: "cloudflare-binding:d1:primary" }],
    routes: [{ routeRef: "cloudflare-route:production" }],
    secretRefs: { OPENAI_API_KEY: "tenant-secret:openai" },
  },
  modules: [
    {
      name: "index.js",
      content: "export default { fetch: () => ({ status: 200 }) }",
      contentType: "application/javascript+module",
    },
  ],
} satisfies CloudflareWorkerDeployBundle;

describe("@agent-os/deploy-cloudflare Worker bundle material", () => {
  it.effect("computes a digest over manifest and code material", () =>
    Effect.gen(function* () {
      const base = yield* cloudflareWorkerDeployBundleDigest(bundle);
      const changedCode = yield* cloudflareWorkerDeployBundleDigest({
        ...bundle,
        modules: [
          { ...bundle.modules[0]!, content: "export default { fetch: () => ({ status: 500 }) }" },
        ],
      });
      const changedManifest = yield* cloudflareWorkerDeployBundleDigest({
        ...bundle,
        manifest: { ...bundle.manifest, compatibilityDate: "2026-06-02" },
      });

      expect(base).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(changedCode).not.toBe(base);
      expect(changedManifest).not.toBe(base);
    }),
  );

  it.effect("validates resolved artifact material against the staging digest", () =>
    Effect.gen(function* () {
      const digest = yield* cloudflareWorkerDeployBundleDigest(bundle);
      const resolver = {
        resolve: () => Effect.succeed(bundle),
      };
      const resolved = yield* resolveCloudflareWorkerDeployBundle(
        resolver,
        "staging:artifact:worker",
      );
      const validation = yield* validateCloudflareWorkerDeployBundleDigest(resolved, digest);

      expect(validation).toEqual({ ok: true, digest });
    }),
  );

  it("keeps provider handles out of manifest refs", () => {
    expect(validateCloudflareWorkerDeployBundle(bundle)).toEqual({ ok: true, bundle });
    expect(
      validateCloudflareWorkerDeployBundle({
        ...bundle,
        manifest: {
          ...bundle.manifest,
          targetRef: "https://api.cloudflare.com/accounts/acct/workers/scripts/app",
          bindings: [{ name: "DB", bindingRef: "d1://db-primary" }],
          routes: [{ routeRef: "https://app.example.com/*" }],
          secretRefs: { OPENAI_API_KEY: "secret://openai" },
        },
      }),
    ).toEqual({
      ok: false,
      issues: [
        "target_ref_not_symbolic",
        "binding_ref_not_symbolic",
        "route_ref_not_symbolic",
        "secret_ref_not_symbolic",
      ],
    });
  });
});
