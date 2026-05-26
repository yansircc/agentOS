/**
 * Chat Completions wire (cf-ai-binding + openai-chat-compatible) —
 * adapter contract tests focused on the structured-decode strictness
 * regression (Codex P1) and the F-1 classify-unwrap regression
 * (spike-05). Encode shape and broader behavior are covered indirectly
 * by admission-contract.test.ts; this file is the dedicated pure-
 * function surface.
 */

import { describe, expect, it } from "vitest";

import {
  cfAiBindingAdapter,
  openaiChatCompatibleAdapter,
} from "../src/llm/protocol/openai-chat";
import { anthropicMessagesAdapter } from "../src/llm/protocol/anthropic-messages";
import { geminiGenerateContentAdapter } from "../src/llm/protocol/gemini-generate-content";
import type { JsonSchemaObject } from "../src/admission";

const SCHEMA: JsonSchemaObject = {
  type: "object",
  properties: { summary: { type: "string" } },
  required: ["summary"],
  additionalProperties: false,
};

const SCHEMA_CONTRACT = {
  schema: SCHEMA,
  fingerprint: "test-fingerprint",
};

// ============================================================
// P1 regression — Codex 2026-05-25:
//   "Chat Completions structured decode still accepts extra tool calls"
// ============================================================

describe("chat-completions decodeStructured — P1 strictness", () => {
  it("BehaviorFailed when zero tool_calls (no-tool-call)", () => {
    const raw = {
      choices: [{ message: { content: "I refuse.", tool_calls: [] } }],
      usage: { total_tokens: 10 },
    };
    const r = cfAiBindingAdapter.decodeStructured(
      { raw },
      SCHEMA_CONTRACT,
      "forced-tool-call",
    );
    expect(r.ok).toBe(false);
    if (!r.ok && r.outcome.class === "BehaviorFailed") {
      expect(r.outcome.sampleDigest).toContain("no-tool-call");
    }
  });

  it("Supported when exactly one matching tool_call with valid args", () => {
    const raw = {
      choices: [
        {
          message: {
            tool_calls: [
              {
                function: {
                  name: "_submit_structured",
                  arguments: '{"summary":"ok"}',
                },
              },
            ],
          },
        },
      ],
      usage: { total_tokens: 42 },
    };
    const r = cfAiBindingAdapter.decodeStructured(
      { raw },
      SCHEMA_CONTRACT,
      "forced-tool-call",
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.decoded).toEqual({ summary: "ok" });
      expect(r.tokensUsed).toBe(42);
    }
  });

  it("BehaviorFailed when 2+ tool_calls — even if first matches forced name", () => {
    // Before the P1 fix the adapter would index [0] and return Supported,
    // writing false evidence for a route that emitted extra calls.
    const raw = {
      choices: [
        {
          message: {
            tool_calls: [
              {
                function: {
                  name: "_submit_structured",
                  arguments: '{"summary":"first"}',
                },
              },
              {
                function: {
                  name: "_submit_structured",
                  arguments: '{"summary":"second"}',
                },
              },
            ],
          },
        },
      ],
    };
    const r = cfAiBindingAdapter.decodeStructured(
      { raw },
      SCHEMA_CONTRACT,
      "forced-tool-call",
    );
    expect(r.ok).toBe(false);
    if (!r.ok && r.outcome.class === "BehaviorFailed") {
      expect(r.outcome.sampleDigest).toContain("unexpected-tool-calls:2");
    }
  });

  it("BehaviorFailed when 1 tool_call but name mismatches forced name", () => {
    const raw = {
      choices: [
        {
          message: {
            tool_calls: [
              { function: { name: "other", arguments: "{}" } },
            ],
          },
        },
      ],
    };
    const r = cfAiBindingAdapter.decodeStructured(
      { raw },
      SCHEMA_CONTRACT,
      "forced-tool-call",
    );
    expect(r.ok).toBe(false);
    if (!r.ok && r.outcome.class === "BehaviorFailed") {
      expect(r.outcome.sampleDigest).toContain("unexpected-tool-calls:1:other");
    }
  });

  it("BehaviorFailed when args violate schema (additionalProperties:false)", () => {
    const raw = {
      choices: [
        {
          message: {
            tool_calls: [
              {
                function: {
                  name: "_submit_structured",
                  arguments: '{"summary":"ok","extra":"bad"}',
                },
              },
            ],
          },
        },
      ],
    };
    const r = cfAiBindingAdapter.decodeStructured(
      { raw },
      SCHEMA_CONTRACT,
      "forced-tool-call",
    );
    expect(r.ok).toBe(false);
    if (!r.ok && r.outcome.class === "BehaviorFailed") {
      expect(r.outcome.sampleDigest).toContain("violations");
    }
  });

  it("openai-chat-compatible shares the same strictness (P1 fix applies to both)", () => {
    const raw = {
      choices: [
        {
          message: {
            tool_calls: [
              { function: { name: "_submit_structured", arguments: "{}" } },
              { function: { name: "_submit_structured", arguments: "{}" } },
            ],
          },
        },
      ],
    };
    const r = openaiChatCompatibleAdapter.decodeStructured(
      { raw },
      SCHEMA_CONTRACT,
      "forced-tool-call",
    );
    expect(r.ok).toBe(false);
    if (!r.ok && r.outcome.class === "BehaviorFailed") {
      expect(r.outcome.sampleDigest).toContain("unexpected-tool-calls:2");
    }
  });
});

// ============================================================
// F-1 carry-over — classify unwraps UpstreamFailure.cause
// ============================================================

describe("chat-completions classify — F-1 unwrap", () => {
  it("unwraps cause from UpstreamFailure-shape wrapper", () => {
    const wrapped = {
      _tag: "UpstreamFailure",
      cause: new Error("HTTP 401 Unauthorized: ..."),
    };
    expect(cfAiBindingAdapter.classify(wrapped).class).toBe("AuthError");
    expect(openaiChatCompatibleAdapter.classify(wrapped).class).toBe(
      "AuthError",
    );
  });

  it("falls through to ProviderRejected when no HTTP signal in cause", () => {
    const wrapped = {
      _tag: "UpstreamFailure",
      cause: new Error("some other error"),
    };
    expect(cfAiBindingAdapter.classify(wrapped).class).toBe("ProviderRejected");
  });
});

describe("textStream capability — spec-31", () => {
  const route = {
    kind: "openai-chat-compatible",
    endpointRef: "openrouter",
    credentialRef: "OPENROUTER_KEY",
    modelId: "test-model",
  } as const;

  it("is explicitly supported only by openai-chat-compatible in v0", () => {
    expect(openaiChatCompatibleAdapter.textStream.supported).toBe(true);
    expect(cfAiBindingAdapter.textStream.supported).toBe(false);
    expect(anthropicMessagesAdapter.textStream.supported).toBe(false);
    expect(geminiGenerateContentAdapter.textStream.supported).toBe(false);
  });

  it("encodes stream=true and include_usage for OpenAI-compatible routes", () => {
    const capability = openaiChatCompatibleAdapter.textStream;
    if (capability.supported === false) {
      throw new Error("expected textStream support");
    }
    const body = capability.encode(route, {
      messages: [{ role: "user", content: "hello" }],
    });
    expect(body).toEqual({
      messages: [{ role: "user", content: "hello" }],
      stream: true,
      stream_options: { include_usage: true },
    });
  });

  it("decodes token, usage, and terminal frames", async () => {
    const capability = openaiChatCompatibleAdapter.textStream;
    if (capability.supported === false) {
      throw new Error("expected textStream support");
    }
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            [
              'data: {"choices":[{"delta":{"content":"Hel"}}]}',
              "",
              'data: {"choices":[{"delta":{"content":"lo"}}]}',
              "",
              'data: {"choices":[],"usage":{"prompt_tokens":2,"completion_tokens":3,"total_tokens":5}}',
              "",
              "data: [DONE]",
              "",
            ].join("\n"),
          ),
        );
        controller.close();
      },
    });

    const frames = [];
    for await (const frame of capability.decodeFrames(stream)) {
      frames.push(frame);
    }

    expect(frames).toEqual([
      { type: "token", delta: "Hel" },
      { type: "token", delta: "lo" },
      {
        type: "usage",
        usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 },
      },
      { type: "done" },
    ]);
  });

  it("fails decode when the stream never terminates with [DONE]", async () => {
    const capability = openaiChatCompatibleAdapter.textStream;
    if (capability.supported === false) {
      throw new Error("expected textStream support");
    }
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n',
          ),
        );
        controller.close();
      },
    });

    await expect((async () => {
      for await (const _frame of capability.decodeFrames(stream)) {
        // drain
      }
    })()).rejects.toThrow("stream ended before [DONE]");
  });
});
