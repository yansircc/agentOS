import { describe, expect, it } from "@effect/vitest";
import { Effect, ManagedRuntime } from "effect";
import { endpointMaterialRef, materialRefKey } from "@agent-os/core/material-ref";
import { openLive } from "@agent-os/core/live-edge";
import { Ledger } from "@agent-os/runtime";
import {
  defineAgentBindings,
  defineAgentManifest,
  installationIntentFromDeployment,
  installationObservation,
  installationReceiptEvent,
  installationReceiptFromObservation,
  INSTALLATION_RECEIPT_EVENT_KIND,
  projectInstallationReceipt,
  RUNTIME_FACT_OWNER,
  type DeploymentSpec,
} from "@agent-os/core/runtime-protocol";
import {
  materializeCloudflareAgentDeployment,
  type CloudflareAgentDeploymentSpec,
  type CloudflareAgentEnv,
} from "../../src/cloudflare/deployment";
import { makeCloudflareBackendCoreLayer } from "../../src/cloudflare/runtime-core";
import { eventIdentity } from "../../src/cloudflare/ledger/identity";
import { makeInMemoryDurableObjectState } from "./_in-memory-do";
import { fixtureMaterialRequest, fixtureRefResolver } from "../_material-resolver-fixture";

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

const observedInstallation = () =>
  installationObservation({
    intent: installationIntentFromDeployment(deployment),
    observedAtMs: 1_700_000_000_000,
    runtimeVersion: "cloudflare-do-test-runtime",
    adapterVersion: "cloudflare-do-test-adapter",
    artifactDigest: "sha256:test-worker",
    bootChecks: [
      { name: "target_module_loaded", status: "passed", observedValue: "AgentOS" },
      { name: "adapter_versions_observed", status: "passed" },
    ],
  });

describe("Cloudflare deployment installation", () => {
  it.effect("materializes a deployment spec into the existing mount and layer inputs", () =>
    Effect.gen(function* () {
      const endpointRef = endpointMaterialRef("llm");
      const spec: CloudflareAgentDeploymentSpec<TestEnv> = {
        deployment,
        agentBindings,
        refResolver: (env) =>
          fixtureRefResolver((ref) =>
            materialRefKey(ref) === materialRefKey(endpointRef) ? env.ENDPOINT : null,
          ),
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
      expect(
        openLive(
          (yield* materialized.refResolver.material(fixtureMaterialRequest(endpointRef))).value,
        ),
      ).toBe("https://llm.example");
      expect(materialized.extensions).toEqual([]);
      expect(materialized.declaredIntents).toEqual([]);
      expect(materialized.dispatchTargets).toEqual({});
      expect(materialized.mount.projectionSinks.materialized).toEqual([]);
    }),
  );

  it.effect("appends and reads InstallationReceipt through the Ledger port", () =>
    Effect.gen(function* () {
      const state = makeInMemoryDurableObjectState();
      const observation = observedInstallation();
      const event = installationReceiptEvent(observation);
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
        installationReceiptFromObservation(observation),
      );
      expect(JSON.stringify(result.read)).not.toContain("https://");
      expect(JSON.stringify(result.read)).not.toContain("secret");
    }),
  );
});
