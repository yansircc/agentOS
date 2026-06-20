import { describe, expect, it } from "@effect/vitest";
import { Effect, ManagedRuntime } from "effect";
import { endpointMaterialRef } from "@agent-os/kernel/material-ref";
import { Ledger } from "@agent-os/runtime";
import {
  defineAgentBindings,
  defineAgentManifest,
  installationReceiptEvent,
  installationReceiptFromDeployment,
  INSTALLATION_RECEIPT_EVENT_KIND,
  projectInstallationReceipt,
  RUNTIME_FACT_OWNER,
  type DeploymentSpec,
} from "@agent-os/runtime-protocol";
import {
  materializeCloudflareAgentDeployment,
  type CloudflareAgentDeploymentSpec,
  type CloudflareAgentEnv,
} from "../src/deployment";
import { makeCloudflareBackendCoreLayer } from "../src/runtime-core";
import { eventIdentity } from "../src/ledger/identity";
import { makeInMemoryDurableObjectState } from "./_in-memory-do";

interface TestEnv extends CloudflareAgentEnv {
  readonly ENDPOINT: string;
}

const manifest = defineAgentManifest({
  agentId: "agent.cloudflare-deployment",
  version: "1.0.0",
  scope: { kind: "session", idSource: "manifest", stableScopeId: "deployment-session" },
  effectAuthorityRef: {
    authorityClass: "agent",
    authorityId: "cloudflare-deployment",
  },
  handlers: ["user_message"] as const,
  identityFacets: [
    { kind: "deployment", key: "worker", digest: "deploy-v1" },
    { kind: "adapter", key: "cloudflare-do", digest: "adapter-v1" },
  ],
});

const agentBindings = defineAgentBindings<(typeof manifest.handlers)[number]>({
  handlers: {
    user_message: () => ({ ok: true }),
  },
});

const deployment: DeploymentSpec<typeof manifest> = {
  deploymentId: "deployment:cloudflare:test",
  manifest,
  backend: "cloudflare-do",
  adapter: "sse-http",
  codec: "ledger-v1",
  providerStrategy: "effect-ai",
};

describe("Cloudflare deployment installation", () => {
  it("materializes a deployment spec into the existing mount and layer inputs", () => {
    const endpointRef = endpointMaterialRef("llm");
    const spec: CloudflareAgentDeploymentSpec<TestEnv> = {
      deployment,
      agentBindings,
      refResolver: (env) => ({
        material: (ref) => (ref === endpointRef ? env.ENDPOINT : null),
      }),
      projections: () => [],
    };

    const materialized = materializeCloudflareAgentDeployment(spec, {
      ENDPOINT: "https://llm.example",
    });

    expect(materialized.mount.driverConfig.manifest).toBe(manifest);
    expect(materialized.mount.driverConfig.bindings).toBe(agentBindings);
    expect(materialized.mount.projectionSinks.info.agent.agentId).toBe(
      "agent.cloudflare-deployment",
    );
    expect(materialized.refResolver.material(endpointRef)).toBe("https://llm.example");
    expect(materialized.extensions).toEqual([]);
    expect(materialized.declaredIntents).toEqual([]);
    expect(materialized.dispatchTargets).toEqual({});
    expect(materialized.mount.projectionSinks.materialized).toEqual([]);
  });

  it.effect("appends and reads InstallationReceipt through the Ledger port", () =>
    Effect.gen(function* () {
      const state = makeInMemoryDurableObjectState();
      const event = installationReceiptEvent(deployment);
      const truthIdentity = {
        scopeRef: event.scopeRef,
        effectAuthorityRef: event.effectAuthorityRef,
      };
      const identity = eventIdentity(truthIdentity, RUNTIME_FACT_OWNER);
      const runtime = ManagedRuntime.make(
        makeCloudflareBackendCoreLayer(state, {}, event.scopeRef.scopeId, identity, new Map(), {}),
      );

      const result = yield* Effect.promise(() =>
        runtime.runPromise(
          Effect.gen(function* () {
            const ledger = yield* Ledger;
            const committed = yield* ledger.commit([event]);
            const read = yield* ledger.events(truthIdentity, {
              kinds: [INSTALLATION_RECEIPT_EVENT_KIND],
            });
            return { committed, read };
          }),
        ),
      );

      expect(result.committed).toHaveLength(1);
      expect(projectInstallationReceipt(result.read, deployment.deploymentId)).toEqual(
        installationReceiptFromDeployment(deployment),
      );
      expect(JSON.stringify(result.read)).not.toContain("https://");
      expect(JSON.stringify(result.read)).not.toContain("secret");
    }),
  );
});
