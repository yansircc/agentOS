import { describe, expect, it } from "@effect/vitest";

import {
  canonicalLlmWireDescriptorJson,
  llmWireDescriptorFingerprint,
  llmRouteMaterialRefs,
  textFromLlmOutputItems,
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
