import { describe, expect, it } from "@effect/vitest";

import {
  binding,
  credential,
  durableObjectTarget,
  endpoint,
  lowerAgentConfig,
  openAIChat,
} from "../src/facade-lowering";
import { bindingMaterialRef, materialRefKey } from "@agent-os/kernel/material-ref";
import type { DispatchTargetNamespace } from "../src/dispatch";

interface TestEnv {
  readonly LLM_ENDPOINT: string;
  readonly LLM_KEY: string;
  readonly PEER_DO: DispatchTargetNamespace;
}

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

describe("defineAgentDO facade lowering", () => {
  it("lowers bindings into RefResolver and dispatch targets by MaterialRef shape", () => {
    const lowered = lowerAgentConfig(
      {
        bindings: [
          endpoint<TestEnv>("llm").from((e) => e.LLM_ENDPOINT),
          credential<TestEnv>("llm-key").from((e) => e.LLM_KEY),
          durableObjectTarget<TestEnv>("peer").from((e) => e.PEER_DO),
        ],
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
});
