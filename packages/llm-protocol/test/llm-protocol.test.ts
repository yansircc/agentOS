import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";
import { ensureAgentSchema } from "@agent-os/kernel/agent-schema";

import {
  canonicalLlmWireDescriptorJson,
  llmCallSnapshotFromResponse,
  llmSnapshotRequestFingerprint,
  llmWireDescriptorFingerprint,
  llmRouteMaterialRefs,
  replayLlmResponseFromSnapshot,
  textFromLlmOutputItems,
  type LlmRequest,
  type LlmResponse,
  type LlmWireDescriptor,
} from "../src/index";

describe("@agent-os/llm-protocol", () => {
  it("derives material refs from route material handles without provider vocabulary", () => {
    expect(llmRouteMaterialRefs({ endpointRef: "llm", credentialRef: "llm-key" })).toEqual([
      { kind: "endpoint", ref: "llm" },
      { kind: "credential", ref: "llm-key" },
    ]);
  });

  it("canonicalizes wire descriptors without header order sensitivity", () => {
    const left = canonicalLlmWireDescriptorJson({
      method: "POST",
      url: "https://llm.example/v1",
      headers: [
        ["x-z", "2"],
        ["x-a", "1"],
      ],
    });
    const right = canonicalLlmWireDescriptorJson({
      method: "POST",
      url: "https://llm.example/v1",
      headers: [
        ["x-a", "1"],
        ["x-z", "2"],
      ],
    });
    expect(left).toBe(right);
  });

  it("fingerprints only provider-neutral wire descriptor shape", () => {
    const descriptor: LlmWireDescriptor = {
      method: "POST" as const,
      url: "https://llm.example/v1",
      headers: [
        ["Authorization", "Bearer ${credential:llm-key}"],
        ["Content-Type", "application/json"],
      ],
      bodySchema: {
        type: "object" as const,
        properties: { model: { type: "string" as const } },
        required: ["model"],
        additionalProperties: true,
      },
    };
    expect(llmWireDescriptorFingerprint(descriptor)).toBe(
      `llm-wire-descriptor-v1:${canonicalLlmWireDescriptorJson(descriptor)}`,
    );
    expect(llmWireDescriptorFingerprint(descriptor)).toContain("authorization");
  });

  it("keeps distinct resolved wire bodies distinct without provider route fields", () => {
    const descriptor = (modelId: string): LlmWireDescriptor => ({
      method: "POST" as const,
      url: "https://llm.example/v1/chat",
      headers: [
        ["Authorization", "Bearer ${credential:primary}"],
        ["Content-Type", "application/json"],
      ],
      bodySchema: {
        type: "object" as const,
        properties: {
          model: { type: "string" as const, enum: [modelId] },
          messages: {
            type: "array" as const,
            items: { type: "object" as const, properties: {}, additionalProperties: true },
          },
        },
        required: ["model", "messages"],
        additionalProperties: true,
      },
    });
    expect(llmWireDescriptorFingerprint(descriptor("model-a"))).not.toBe(
      llmWireDescriptorFingerprint(descriptor("model-b")),
    );
  });

  it("snapshots an LLM call without route fields and replays the response", () => {
    const descriptor: LlmWireDescriptor = {
      method: "POST" as const,
      url: "https://llm.example/v1/chat",
      headers: [
        ["Content-Type", "application/json"],
        ["Authorization", "Bearer ${credential:primary}"],
      ],
      bodySchema: {
        type: "object" as const,
        properties: {
          model: { type: "string" as const, enum: ["model-a"] },
          messages: {
            type: "array" as const,
            items: { type: "object" as const, properties: {}, additionalProperties: true },
          },
        },
        required: ["model", "messages"],
        additionalProperties: true,
      },
    };
    const request: LlmRequest = {
      route: {
        kind: "test-route",
        endpointRef: "llm",
        credentialRef: "llm-key",
        modelId: "model-a",
      },
      messages: [{ role: "user", content: "hello" }],
      tools: [
        {
          type: "function",
          function: {
            name: "lookup",
            description: "Look up a value.",
            parameters: ensureAgentSchema(Schema.Struct({ q: Schema.String })),
          },
        },
      ],
    };
    const response: LlmResponse = {
      items: [{ type: "message", text: "done" }],
      usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
    };

    const snapshot = llmCallSnapshotFromResponse({ wireDescriptor: descriptor, request, response });

    expect(snapshot.kind).toBe("llm.call");
    expect(snapshot.wireDescriptorFingerprint).toBe(llmWireDescriptorFingerprint(descriptor));
    expect(snapshot.requestFingerprint).toBe(llmSnapshotRequestFingerprint(snapshot.request));
    expect(snapshot.request).toMatchObject({
      messages: request.messages,
      tools: [
        {
          type: "function",
          function: {
            name: "lookup",
            description: "Look up a value.",
            parameters: {
              type: "object",
              required: ["q"],
            },
          },
        },
      ],
    });
    expect(JSON.stringify(snapshot.request)).not.toContain("test-route");
    expect(JSON.stringify(snapshot.request)).not.toContain("parse");
    expect(replayLlmResponseFromSnapshot(snapshot)).toEqual(response);
  });

  it("replay mode live LLM provider adapter not called when call snapshot is present", () => {
    let liveLlmProviderAdapterCalled = false;
    const liveProviderAdapter = {
      call: () => {
        liveLlmProviderAdapterCalled = true;
        throw new Error("live LLM provider adapter should not be called in replay");
      },
    };
    const replayed = replayLlmResponseFromSnapshot({
      kind: "llm.call",
      wireDescriptor: {
        method: "POST",
        url: "https://llm.example/v1/chat",
        headers: [["Content-Type", "application/json"]],
      },
      wireDescriptorFingerprint: "llm-wire-descriptor-v1:{}",
      request: { messages: [{ role: "user", content: "hello" }] },
      requestFingerprint: "llm-call-snapshot-v1:request:{}",
      response: {
        items: [{ type: "message", text: "from-snapshot" }],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      },
    });

    expect(replayed.items).toEqual([{ type: "message", text: "from-snapshot" }]);
    expect(liveLlmProviderAdapterCalled).toBe(false);
    expect(liveProviderAdapter.call).toBeDefined();
  });

  it("projects message text from output items", () => {
    expect(
      textFromLlmOutputItems([
        { type: "message", text: "a" },
        { type: "reasoning", summaryRef: "s" },
        { type: "message", text: "b" },
      ]),
    ).toBe("ab");
  });
});
