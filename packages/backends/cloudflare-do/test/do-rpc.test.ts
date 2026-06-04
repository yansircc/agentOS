import { describe, expect, it } from "@effect/vitest";

import { durableObjectRpcClient, type DurableObjectRpcClient } from "../src/do-rpc";

interface ExampleClient {
  readonly ping: (input: { readonly value: string }) => Promise<string>;
  readonly bad: (input: { readonly fn: () => void }) => Promise<void>;
}

describe("durableObjectRpcClient", () => {
  it("centralizes named Durable Object stub lookup", async () => {
    const stub = {
      ping: async (input: { readonly value: string }) => input.value,
    };
    const namespace = {
      idFromName: (name: string) => ({ name }) as unknown as DurableObjectId,
      get: () => stub,
    } as unknown as DurableObjectNamespace;

    const client = durableObjectRpcClient<ExampleClient>(namespace, "scope-1");

    await expect(client.ping({ value: "pong" })).resolves.toBe("pong");
  });

  it("rejects function-bearing method input at type level", () => {
    const invalid: Parameters<DurableObjectRpcClient<ExampleClient>["bad"]>[0] = {
      // @ts-expect-error DO RPC payloads must be structured data, not functions.
      fn: () => undefined,
    };
    void invalid;
    expect(true).toBe(true);
  });
});
