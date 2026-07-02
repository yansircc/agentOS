import { describe, expect, it } from "@effect/vitest";

import {
  DURABLE_OBJECT_RPC_INVOKE,
  DurableObjectRpcRejected,
  durableObjectRpcClient,
  durableObjectRpcInvoke,
  type DurableObjectRpcClient,
} from "../../src/cloudflare/do-rpc";
import type { SubmitDecisionInterrupt } from "@agent-os/core/runtime-protocol";

interface ExampleClient {
  readonly ping: (input: { readonly value: string }) => Promise<string>;
  readonly status: (input: { readonly status: number }) => { readonly status: number };
  readonly rejectBoundary: () => Promise<void>;
  readonly rejectUntyped: () => Promise<void>;
  readonly bad: (input: { readonly fn: () => void }) => Promise<void>;
  readonly submitWithInterrupts: (input: {
    readonly decisionInterrupts?: ReadonlyArray<SubmitDecisionInterrupt>;
  }) => Promise<void>;
}

class BoundaryRejectedFixture extends Error {
  readonly _tag = "agent_os.boundary_commit_rejected";
  readonly ownerId = "@agent-os/proof";
  readonly event = "proof.recorded";
  readonly issue = "claim_missing";

  constructor() {
    super("boundary commit rejected");
  }
}

const stub = {
  ping: async (input: { readonly value: string }) => input.value,
  status: (input: { readonly status: number }) => ({ status: input.status }),
  rejectBoundary: () => Promise.reject(new BoundaryRejectedFixture()),
  rejectUntyped: () => Promise.reject("plain failure"),
  [DURABLE_OBJECT_RPC_INVOKE](method: string, args: ReadonlyArray<unknown>) {
    return durableObjectRpcInvoke(this, method, args);
  },
};

const namespace = {
  idFromName: (name: string) => ({ name }) as unknown as DurableObjectId,
  get: () => stub,
} as unknown as DurableObjectNamespace;

describe("durableObjectRpcClient", () => {
  it("centralizes named Durable Object stub lookup and unwraps successful envelopes", async () => {
    const client = durableObjectRpcClient<ExampleClient>(namespace, "scope-1");

    await expect(client.ping({ value: "pong" })).resolves.toBe("pong");
    const statusPromise: Promise<{ readonly status: number }> = client.status({ status: 201 });
    const status = await statusPromise;
    expect(status.status).toBe(201);
  });

  it("preserves tagged error details through the supported RPC envelope", async () => {
    const client = durableObjectRpcClient<ExampleClient>(namespace, "scope-1");

    await expect(client.rejectBoundary()).rejects.toMatchObject({
      _tag: "agent_os.boundary_commit_rejected",
      code: "agent_os.boundary_commit_rejected",
      ownerId: "@agent-os/proof",
      event: "proof.recorded",
      issue: "claim_missing",
      message: "boundary commit rejected",
      details: {
        _tag: "agent_os.boundary_commit_rejected",
        ownerId: "@agent-os/proof",
        event: "proof.recorded",
        issue: "claim_missing",
      },
    });
    await client.rejectBoundary().catch((cause) => {
      expect(cause).toBeInstanceOf(DurableObjectRpcRejected);
    });
  });

  it("classifies untyped failures without fabricating domain fields", async () => {
    const client = durableObjectRpcClient<ExampleClient>(namespace, "scope-1");

    await expect(client.rejectUntyped()).rejects.toMatchObject({
      _tag: "agent_os.rpc_untyped_error",
      code: "agent_os.rpc_untyped_error",
      message: "plain failure",
      details: {},
    });
  });

  it("leaves direct stub calls outside the supported error-bearing contract", async () => {
    await expect(stub.rejectBoundary()).rejects.toBeInstanceOf(BoundaryRejectedFixture);
  });

  it("rejects function-bearing method input at type level", () => {
    const invalid: Parameters<DurableObjectRpcClient<ExampleClient>["bad"]>[0] = {
      // @ts-expect-error DO RPC payloads must be structured data, not functions.
      fn: () => undefined,
    };
    void invalid;
    expect(true).toBe(true);
  });

  it("preserves branded primitive unions in method input DTOs", () => {
    const input = {
      decisionInterrupts: [
        {
          toolName: "apply",
          reason: "custom_gate" as SubmitDecisionInterrupt["reason"],
        },
      ],
    } satisfies Parameters<ExampleClient["submitWithInterrupts"]>[0];

    const rpcInput: Parameters<DurableObjectRpcClient<ExampleClient>["submitWithInterrupts"]>[0] =
      input;

    expect(rpcInput.decisionInterrupts?.[0]?.reason).toBe("custom_gate");
  });
});
