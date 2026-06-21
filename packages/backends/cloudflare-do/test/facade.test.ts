import { describe, expect, it } from "@effect/vitest";

import {
  binding,
  credential,
  durableObjectTarget,
  endpoint,
  lowerAgentConfig,
  lowerMaterialBindings,
  openAIChat,
} from "../src/facade-lowering";
import { cloudflareAgentMountPort, mountCloudflareAgent } from "../src/mount";
import { bindingMaterialRef, materialRefKey } from "@agent-os/core/material-ref";
import { makePreClaim } from "@agent-os/core/effect-claim";
import {
  defineTool,
  externalToolExecution,
  deterministicToolExecution,
  withToolWriteRequirement,
} from "@agent-os/core/tools";
import { Effect, Schema } from "effect";
import {
  defineAgentBindings,
  defineAgentManifest,
  lowerSubmitRunInput,
} from "@agent-os/core/runtime-protocol";
import type { DispatchTargetNamespace } from "../src/dispatch";
import { httpDispatchTarget, providerDispatchTarget, queueDispatchTarget } from "../src/dispatch";

interface TestEnv {
  readonly LLM_ENDPOINT: string;
  readonly LLM_KEY: string;
  readonly PEER_DO: DispatchTargetNamespace;
}

const allowToolAdmitter = () => Effect.succeed({ ok: true as const });

const target: DispatchTargetNamespace = {
  idFromName: (_name) => ({}) as DurableObjectId,
  get: (_id) => ({
    __agentosReceiveDispatch: () =>
      Promise.resolve({
        deliveredEventId: 1,
        receipt: { anchorId: "dispatch.outbound:peer:1", anchorKind: "ledger_event" as const },
      }),
  }),
};

const env: TestEnv = {
  LLM_ENDPOINT: "https://llm.example",
  LLM_KEY: "secret",
  PEER_DO: target,
};

const dispatchEnvelope = {
  sourceScope: "sender",
  outboundEventId: 1,
  targetScope: "image-target",
  event: "image.job.queued",
  data: { prompt: "test" },
  idempotencyKey: "job-1",
  claim: makePreClaim({
    operationRef: "dispatch:test",
    scopeRef: { kind: "conversation", scopeId: "image-target" },
    effectAuthorityRef: { authorityId: "cap_dispatch", authorityClass: "effect" },
    originRef: { originId: "sender", originKind: "agent_do" },
  }),
};

describe("defineAgentDO facade lowering", () => {
  it("mounts AgentManifest through the Cloudflare backend port and sse-http transport", () => {
    const effectAuthorityRef = {
      authorityClass: "agent" as const,
      authorityId: "cloudflare-mount-test",
    };
    const manifest = defineAgentManifest({
      agentId: "agent.cloudflare-mount-test",
      scope: { kind: "conversation", idSource: "submit_scope" },
      effectAuthorityRef,
      handlers: ["user_message"] as const,
      llmRoutes: {
        default: { bindingRef: "llm.default" },
      },
    });
    const bindings = defineAgentBindings<(typeof manifest.handlers)[number]>({
      handlers: {
        user_message: () => ({ ok: true }),
      },
    });

    const mount = mountCloudflareAgent(manifest, bindings);

    expect(Object.keys(mount).sort()).toEqual(["driverConfig", "projectionSinks"]);
    expect(Object.keys(mount.projectionSinks).sort()).toEqual(["info", "materialized"]);
    expect(mount.driverConfig.manifest).toBe(manifest);
    expect(mount.driverConfig.bindings).toBe(bindings);
    expect(mount.driverConfig.port).toEqual(cloudflareAgentMountPort);
    expect(mount.driverConfig.port).toMatchObject({
      backend: "cloudflare-do",
      backendProtocol: "@agent-os/backend-protocol",
      runtimeProtocol: "@agent-os/runtime-protocol",
      transport: "sse-http",
    });
    expect(mount.projectionSinks.info.source).toEqual({
      kind: "AgentManifest",
      agentId: "agent.cloudflare-mount-test",
    });
    expect(mount.projectionSinks.materialized).toEqual([]);
  });

  it("lowers bindings into RefResolver and dispatch targets by MaterialRef shape", () => {
    const resolved: string[] = [];
    const materialBindings = [
      endpoint<TestEnv>("llm").from((e) => {
        resolved.push("endpoint");
        return e.LLM_ENDPOINT;
      }),
      credential<TestEnv>("llm-key").from((e) => {
        resolved.push("credential");
        return e.LLM_KEY;
      }),
      durableObjectTarget<TestEnv>("peer").from((e) => {
        resolved.push("peer");
        return e.PEER_DO;
      }),
    ];
    const lowered = lowerAgentConfig(
      {
        bindings: materialBindings,
        llms: {
          default: openAIChat({
            model: "gpt-4.1-mini",
            endpoint: "llm",
            credential: "llm-key",
          }),
        },
      },
      env,
    );

    expect(resolved).toEqual([]);
    expect(lowered.refResolver.material({ kind: "endpoint", ref: "llm" })).toBe(
      "https://llm.example",
    );
    expect(resolved).toEqual(["endpoint"]);
    expect(
      lowerMaterialBindings(materialBindings, env).refResolver.material({
        kind: "endpoint",
        ref: "llm",
      }),
    ).toBe("https://llm.example");
    expect(resolved).toEqual(["endpoint", "endpoint"]);
    expect(lowered.refResolver.material({ kind: "credential", ref: "llm-key" })).toBe("secret");
    expect(resolved).toEqual(["endpoint", "endpoint", "credential"]);
    const peerKey = materialRefKey(
      bindingMaterialRef({
        provider: "cloudflare",
        bindingKind: "durable_object",
        ref: "peer",
      }),
    );
    expect(typeof lowered.dispatchTargets[peerKey]?.deliver).toBe("function");
    expect(lowered.submitBindings?.llmRoutes?.default).toEqual({
      kind: "openai-chat-compatible",
      modelId: "gpt-4.1-mini",
      endpointRef: "llm",
      credentialRef: "llm-key",
    });
  });

  it("uses the same material resolver lowering for low-level consumers", () => {
    const bindings = [
      endpoint<TestEnv>("llm").from((e) => e.LLM_ENDPOINT),
      credential<TestEnv>("llm-key").from((e) => e.LLM_KEY),
    ] as const;
    const lowered = lowerAgentConfig({ bindings }, env);
    const materialOnly = lowerMaterialBindings(bindings, env);

    expect(materialOnly.refResolver.material({ kind: "endpoint", ref: "llm" })).toBe(
      lowered.refResolver.material({ kind: "endpoint", ref: "llm" }),
    );
    expect(materialOnly.refResolver.material({ kind: "credential", ref: "llm-key" })).toBe(
      lowered.refResolver.material({ kind: "credential", ref: "llm-key" }),
    );
  });

  it("routes durable object bindings by material shape, not helper choice", () => {
    const lowered = lowerAgentConfig(
      {
        bindings: [
          binding<TestEnv, DispatchTargetNamespace>("cloudflare", "durable_object", "peer").from(
            (e) => e.PEER_DO,
          ),
        ],
      },
      env,
    );
    const peerKey = materialRefKey(
      bindingMaterialRef({
        provider: "cloudflare",
        bindingKind: "durable_object",
        ref: "peer",
      }),
    );
    expect(typeof lowered.dispatchTargets[peerKey]?.deliver).toBe("function");
  });

  it("fails on duplicate material keys", () => {
    expect(() =>
      lowerAgentConfig(
        {
          bindings: [
            endpoint<TestEnv>("llm").from((e) => e.LLM_ENDPOINT),
            endpoint<TestEnv>("llm").from(() => "https://other.example"),
          ],
        },
        env,
      ),
    ).toThrow("duplicate material binding");
  });

  it("fails when an LLM route references unbound material", () => {
    expect(() =>
      lowerAgentConfig(
        {
          llms: {
            default: openAIChat({
              model: "gpt-4.1-mini",
              endpoint: "llm",
              credential: "llm-key",
            }),
          },
        },
        env,
      ),
    ).toThrow("unbound material");
  });

  it("preserves non-default LLM routes for submit lowering", () => {
    const lowered = lowerAgentConfig(
      {
        bindings: [
          endpoint<TestEnv>("llm").from((e) => e.LLM_ENDPOINT),
          credential<TestEnv>("llm-key").from((e) => e.LLM_KEY),
        ],
        llms: {
          default: openAIChat({
            model: "gpt-default",
            endpoint: "llm",
            credential: "llm-key",
          }),
          secondary: openAIChat({
            model: "gpt-secondary",
            endpoint: "llm",
            credential: "llm-key",
          }),
        },
      },
      env,
    );

    expect(lowered.submitBindings?.llmRoutes?.secondary).toEqual({
      kind: "openai-chat-compatible",
      modelId: "gpt-secondary",
      endpointRef: "llm",
      credentialRef: "llm-key",
    });
    expect(
      lowerSubmitRunInput({
        input: { intent: "chat", context: { input: "hello" } },
        bindings: lowered.submitBindings ?? {},
        routeBindingRef: "secondary",
        effectAuthorityRef: {
          authorityClass: "agent",
          authorityId: "cloudflare-facade-test",
        },
      }).route,
    ).toEqual({
      kind: "openai-chat-compatible",
      modelId: "gpt-secondary",
      endpointRef: "llm",
      credentialRef: "llm-key",
    });
  });

  it("allows deterministic tools without execution domain declarations", () => {
    const tool = defineTool({
      name: "lookup",
      description: "Lookup",
      args: Schema.Struct({ key: Schema.String }),
      authority: "read",
      admit: allowToolAdmitter,
      execution: deterministicToolExecution(),
      execute: ({ key }) => Effect.succeed({ key }),
    });

    const lowered = lowerAgentConfig({ tools: [tool] }, env);

    expect(lowered.submitBindings).toBe(null);
  });

  it("fails before submit when external tools reference undeclared domains", () => {
    const domain = { kind: "workspace" as const, ref: "workspace:default" };
    const tool = defineTool({
      name: "write_file",
      description: "Write",
      args: Schema.Struct({ path: Schema.String }),
      authority: "write",
      admit: allowToolAdmitter,
      execution: externalToolExecution("write", domain),
      execute: ({ path }) => withToolWriteRequirement(Effect.succeed({ path })),
    });

    expect(() => lowerAgentConfig({ tools: [tool] }, env)).toThrow(
      "missing workspace:workspace:default:write for write_file",
    );
  });

  it("passes lowering when external tool domains are declared", () => {
    const domain = { kind: "workspace" as const, ref: "workspace:default" };
    const tool = defineTool({
      name: "write_file",
      description: "Write",
      args: Schema.Struct({ path: Schema.String }),
      authority: "write",
      admit: allowToolAdmitter,
      execution: externalToolExecution("write", domain),
      execute: ({ path }) => withToolWriteRequirement(Effect.succeed({ path })),
    });

    const lowered = lowerAgentConfig(
      {
        tools: [tool],
        domains: [{ domain, replay: { access: "write", witness: "receipt" } }],
      },
      env,
    );

    expect(lowered.submitBindings).toBe(null);
  });

  it("materializes Queue, HTTP, and provider dispatch targets as enqueue acknowledgements", () => {
    const queueMessages: unknown[] = [];
    const queue = queueDispatchTarget({
      send: (message) => {
        queueMessages.push(message);
      },
    });
    const http = httpDispatchTarget({
      url: "https://dispatch.example/target",
      fetch: (_input, _init) => Promise.resolve({ ok: true, status: 200 } as Response),
    });
    const provider = providerDispatchTarget({
      providerId: "image",
      invoke: () => ({ receiptId: "provider:image:receipt-1" }),
    });

    return Promise.all([
      queue.deliver(dispatchEnvelope),
      http.deliver(dispatchEnvelope),
      provider.deliver(dispatchEnvelope),
    ]).then(([queueResult, httpResult, providerResult]) => {
      expect(queueMessages).toHaveLength(1);
      expect(queueResult).toEqual({
        _tag: "enqueued",
        acknowledgement: {
          acknowledgementId: "dispatch.queue.enqueued:image-target:job-1",
          acknowledgementKind: "external_enqueue",
        },
      });
      expect(httpResult).toEqual({
        _tag: "enqueued",
        acknowledgement: {
          acknowledgementId: "dispatch.http.enqueued:image-target:job-1",
          acknowledgementKind: "external_enqueue",
        },
      });
      expect(providerResult).toEqual({
        _tag: "enqueued",
        acknowledgement: {
          acknowledgementId: "provider:image:receipt-1",
          acknowledgementKind: "external_enqueue",
        },
      });
    });
  });

  it("sanitizes external dispatch target failures", () =>
    expect(
      queueDispatchTarget({
        send: () => Promise.reject("raw provider body secret"),
      }).deliver(dispatchEnvelope),
    ).rejects.toBe("dispatch queue target failed"));

  it("sanitizes synchronous external dispatch target failures", () =>
    expect(
      providerDispatchTarget({
        providerId: "image",
        invoke: () => JSON.parse("{") as { readonly receiptId?: string },
      }).deliver(dispatchEnvelope),
    ).rejects.toBe("dispatch provider target failed:image"));
});
