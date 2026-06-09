import { describe, expect, it } from "@effect/vitest";

import {
  canonicalLlmWireDescriptorJson,
  llmRouteMaterialRefs,
  textFromLlmOutputItems,
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
