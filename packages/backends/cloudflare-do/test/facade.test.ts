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
import { bindingMaterialRef, materialRefKey } from "@agent-os/kernel/material-ref";
import { makePreClaim } from "@agent-os/kernel/effect-claim";
import { defineTool, effectfulToolExecution, pureToolExecution } from "@agent-os/kernel/tools";
import { Effect, Schema } from "effect";
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
  it("lowers bindings into RefResolver and dispatch targets by MaterialRef shape", () => {
    const materialBindings = [
      endpoint<TestEnv>("llm").from((e) => e.LLM_ENDPOINT),
      credential<TestEnv>("llm-key").from((e) => e.LLM_KEY),
      durableObjectTarget<TestEnv>("peer").from((e) => e.PEER_DO),
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

    expect(lowered.refResolver.material({ kind: "endpoint", ref: "llm" })).toBe(
      "https://llm.example",
    );
    expect(
      lowerMaterialBindings(materialBindings, env).refResolver.material({
        kind: "endpoint",
        ref: "llm",
      }),
    ).toBe("https://llm.example");
    expect(lowered.refResolver.material({ kind: "credential", ref: "llm-key" })).toBe("secret");
    const peerKey = materialRefKey(
      bindingMaterialRef({
        provider: "cloudflare",
        bindingKind: "durable_object",
        ref: "peer",
      }),
    );
    expect(typeof lowered.dispatchTargets[peerKey]?.deliver).toBe("function");
    expect(lowered.defaultSubmit?.route).toEqual({
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

  it("allows pure tools without execution domain declarations", () => {
    const tool = defineTool({
      name: "lookup",
      description: "Lookup",
      args: Schema.Struct({ key: Schema.String }),
      authority: "read",
      admit: allowToolAdmitter,
      execution: pureToolExecution(),
      execute: ({ key }) => Effect.succeed({ key }),
    });

    const lowered = lowerAgentConfig({ tools: [tool] }, env);

    expect(lowered.defaultSubmit).toBe(null);
  });

  it("fails before submit when effectful tools reference undeclared domains", () => {
    const domain = { kind: "workspace" as const, ref: "workspace:default" };
    const tool = defineTool({
      name: "write_file",
      description: "Write",
      args: Schema.Struct({ path: Schema.String }),
      authority: "write",
      admit: allowToolAdmitter,
      execution: effectfulToolExecution(domain),
      execute: ({ path }) => Effect.succeed({ path }),
    });

    expect(() => lowerAgentConfig({ tools: [tool] }, env)).toThrow(
      "missing workspace:workspace:default for write_file",
    );
  });

  it("passes lowering when effectful tool domains are declared", () => {
    const domain = { kind: "workspace" as const, ref: "workspace:default" };
    const tool = defineTool({
      name: "write_file",
      description: "Write",
      args: Schema.Struct({ path: Schema.String }),
      authority: "write",
      admit: allowToolAdmitter,
      execution: effectfulToolExecution(domain),
      execute: ({ path }) => Effect.succeed({ path }),
    });

    const lowered = lowerAgentConfig({ tools: [tool], domains: [{ domain }] }, env);

    expect(lowered.defaultSubmit).toBe(null);
  });

  it("materializes Queue, HTTP, and provider dispatch targets as external receipts", () => {
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
      expect(queueResult.receipt).toEqual({
        anchorId: "dispatch.queue:image-target:job-1",
        anchorKind: "external_receipt",
      });
      expect(httpResult.receipt).toEqual({
        anchorId: "dispatch.http:image-target:job-1",
        anchorKind: "external_receipt",
      });
      expect(providerResult.receipt).toEqual({
        anchorId: "provider:image:receipt-1",
        anchorKind: "external_receipt",
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
