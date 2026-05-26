/**
 * gemini-generate-content protocol adapter — contract tests (spec-27 §9.1).
 */

import { describe, expect, it } from "vitest";

import { geminiGenerateContentAdapter } from "../src/llm/protocol/gemini-generate-content";
import type { JsonSchemaObject } from "../src/admission";
import type {
  GeminiGenerateContentRoute,
  LlmMessage,
  ToolDefinition,
} from "../src/llm";

const ROUTE: GeminiGenerateContentRoute = {
  kind: "gemini-generate-content",
  endpointRef: "google",
  credentialRef: "GEMINI_KEY",
  modelId: "gemini-3.1-flash-lite",
};

const SUMMARY_SCHEMA: JsonSchemaObject = {
  type: "object",
  properties: { summary: { type: "string" } },
  required: ["summary"],
  additionalProperties: false,
};

const SCHEMA_CONTRACT = {
  schema: SUMMARY_SCHEMA,
  fingerprint: "test-fingerprint",
};

// ============================================================
// Layer 1 — encode shape
// ============================================================

describe("gemini adapter — encodeTurn", () => {
  it("extracts system messages into top-level systemInstruction.parts[].text", () => {
    const messages: LlmMessage[] = [
      { role: "system", content: "You are a research agent." },
      { role: "user", content: "Find facts." },
    ];
    const body = geminiGenerateContentAdapter.encodeTurn(ROUTE, { messages });
    expect(body.systemInstruction).toEqual({
      parts: [{ text: "You are a research agent." }],
    });
    expect(body.contents).toEqual([
      { role: "user", parts: [{ text: "Find facts." }] },
    ]);
  });

  it("maps assistant role to 'model' (NOT 'assistant')", () => {
    const messages: LlmMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ];
    const body = geminiGenerateContentAdapter.encodeTurn(ROUTE, { messages });
    expect(body.contents[1].role).toBe("model");
  });

  it("folds assistant tool_calls into parts[].functionCall blocks (args as object)", () => {
    const messages: LlmMessage[] = [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: "calling",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "lookup", arguments: '{"q":"X"}' },
          },
        ],
      },
    ];
    const body = geminiGenerateContentAdapter.encodeTurn(ROUTE, { messages });
    const asst = body.contents[1];
    expect(asst.role).toBe("model");
    expect(asst.parts).toEqual([
      { text: "calling" },
      { functionCall: { name: "lookup", args: { q: "X" } } },
    ]);
  });

  it("translates tool definitions into tools[].functionDeclarations[]", () => {
    const tools: ToolDefinition[] = [
      {
        type: "function",
        function: {
          name: "lookup",
          description: "Look up something",
          parameters: { type: "object", properties: { q: { type: "string" } } },
        },
      },
    ];
    const body = geminiGenerateContentAdapter.encodeTurn(ROUTE, {
      messages: [{ role: "user", content: "hi" }],
      tools,
    });
    expect(body.tools).toEqual([
      {
        functionDeclarations: [
          {
            name: "lookup",
            description: "Look up something",
            parameters: { type: "object", properties: { q: { type: "string" } } },
          },
        ],
      },
    ]);
  });

  it("maps tool_choice → toolConfig.functionCallingConfig {mode:ANY, allowedFunctionNames}", () => {
    const body = geminiGenerateContentAdapter.encodeTurn(ROUTE, {
      messages: [{ role: "user", content: "hi" }],
      tool_choice: { type: "function", function: { name: "forced_tool" } },
    });
    expect(body.toolConfig).toEqual({
      functionCallingConfig: {
        mode: "ANY",
        allowedFunctionNames: ["forced_tool"],
      },
    });
  });
});

describe("gemini adapter — encodeStructured", () => {
  it("produces forced-tool-call body with single functionDeclaration + mode:ANY", () => {
    const body = geminiGenerateContentAdapter.encodeStructured(
      ROUTE,
      SCHEMA_CONTRACT,
      { kind: "live", userInput: { userText: "what is X?" } },
      "forced-tool-call",
    );
    expect(body.systemInstruction?.parts?.[0]?.text).toContain("structured");
    expect(body.contents).toEqual([
      { role: "user", parts: [{ text: "what is X?" }] },
    ]);
    expect(body.tools).toHaveLength(1);
    expect(body.tools?.[0].functionDeclarations).toHaveLength(1);
    const decl = body.tools?.[0].functionDeclarations[0];
    expect(decl?.name).toBe("_submit_structured");
    expect(decl?.description).toEqual(expect.any(String));
    // Gemini rejects `additionalProperties` in parameters; the adapter
    // strips it (and other Gemini-unsupported JSON Schema fields) at the
    // wire boundary. The substrate's lease projection still keys on the
    // original schema fingerprint — sanitization is wire translation only.
    expect(decl?.parameters).toEqual({
      type: "object",
      properties: { summary: { type: "string" } },
      required: ["summary"],
    });
    expect(decl?.parameters).not.toHaveProperty("additionalProperties");
    expect(body.toolConfig).toEqual({
      functionCallingConfig: {
        mode: "ANY",
        allowedFunctionNames: ["_submit_structured"],
      },
    });
  });
});

// ============================================================
// Layer 2 — decode shape
// ============================================================

describe("gemini adapter — decodeTurn", () => {
  it("folds text + functionCall parts into unified LlmResponse", () => {
    const raw = {
      candidates: [
        {
          content: {
            role: "model",
            parts: [
              { text: "calling..." },
              { functionCall: { name: "lookup", args: { q: "X" } } },
            ],
          },
          finishReason: "STOP",
        },
      ],
      usageMetadata: {
        promptTokenCount: 10,
        candidatesTokenCount: 20,
        totalTokenCount: 30,
      },
    };
    const resp = geminiGenerateContentAdapter.decodeTurn(raw);
    expect(resp.text).toBe("calling...");
    expect(resp.toolCalls).toHaveLength(1);
    expect(resp.toolCalls[0].function).toEqual({
      name: "lookup",
      arguments: '{"q":"X"}',
    });
    expect(resp.usage).toEqual({
      promptTokens: 10,
      completionTokens: 20,
      totalTokens: 30,
    });
  });

  it("text-only response (no functionCall)", () => {
    const raw = {
      candidates: [
        { content: { role: "model", parts: [{ text: "Just text." }] } },
      ],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 5, totalTokenCount: 10 },
    };
    const resp = geminiGenerateContentAdapter.decodeTurn(raw);
    expect(resp.text).toBe("Just text.");
    expect(resp.toolCalls).toEqual([]);
  });

  it("totalTokens defaults to prompt+completion when totalTokenCount missing", () => {
    const raw = {
      candidates: [{ content: { role: "model", parts: [{ text: "" }] } }],
      usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 4 },
    };
    const resp = geminiGenerateContentAdapter.decodeTurn(raw);
    expect(resp.usage.totalTokens).toBe(7);
  });
});

describe("gemini adapter — decodeStructured", () => {
  it("Supported when exactly one matching functionCall with valid args", () => {
    const raw = {
      candidates: [
        {
          content: {
            role: "model",
            parts: [
              {
                functionCall: {
                  name: "_submit_structured",
                  args: { summary: "ok" },
                },
              },
            ],
          },
        },
      ],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 5, totalTokenCount: 10 },
    };
    const r = geminiGenerateContentAdapter.decodeStructured(
      { raw },
      SCHEMA_CONTRACT,
      "forced-tool-call",
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.decoded).toEqual({ summary: "ok" });
      expect(r.tokensUsed).toBe(10);
    }
  });

  it("BehaviorFailed when zero functionCall parts (model emitted only text)", () => {
    const raw = {
      candidates: [{ content: { role: "model", parts: [{ text: "I refuse." }] } }],
    };
    const r = geminiGenerateContentAdapter.decodeStructured(
      { raw },
      SCHEMA_CONTRACT,
      "forced-tool-call",
    );
    expect(r.ok).toBe(false);
    if (!r.ok && r.outcome.class === "BehaviorFailed") {
      expect(r.outcome.sampleDigest).toContain("no-function-call");
    }
  });

  it("BehaviorFailed when functionCall name mismatches", () => {
    const raw = {
      candidates: [
        {
          content: {
            role: "model",
            parts: [{ functionCall: { name: "other", args: {} } }],
          },
        },
      ],
    };
    const r = geminiGenerateContentAdapter.decodeStructured(
      { raw },
      SCHEMA_CONTRACT,
      "forced-tool-call",
    );
    expect(r.ok).toBe(false);
    if (!r.ok && r.outcome.class === "BehaviorFailed") {
      expect(r.outcome.sampleDigest).toContain("unexpected-function-call");
    }
  });

  it("BehaviorFailed when args violate schema (additionalProperties:false)", () => {
    const raw = {
      candidates: [
        {
          content: {
            role: "model",
            parts: [
              {
                functionCall: {
                  name: "_submit_structured",
                  args: { summary: "ok", extra: "bad" },
                },
              },
            ],
          },
        },
      ],
    };
    const r = geminiGenerateContentAdapter.decodeStructured(
      { raw },
      SCHEMA_CONTRACT,
      "forced-tool-call",
    );
    expect(r.ok).toBe(false);
    if (!r.ok && r.outcome.class === "BehaviorFailed") {
      expect(r.outcome.sampleDigest).toContain("violations");
    }
  });
});

// ============================================================
// Layer 3 — classify
// ============================================================

describe("gemini adapter — classify", () => {
  it("401 → AuthError", () => {
    const e = new Error("HTTP 401 Unauthorized: API key not valid");
    expect(geminiGenerateContentAdapter.classify(e).class).toBe("AuthError");
  });

  it("403 → AuthError", () => {
    const e = new Error("HTTP 403 Forbidden: ...");
    expect(geminiGenerateContentAdapter.classify(e).class).toBe("AuthError");
  });

  it("429 RESOURCE_EXHAUSTED → RateLimited", () => {
    const e = new Error('HTTP 429 Too Many Requests: {"error":{"status":"RESOURCE_EXHAUSTED"}}');
    expect(geminiGenerateContentAdapter.classify(e).class).toBe("RateLimited");
  });

  it("400 INVALID_ARGUMENT with schema/parameter mention → SchemaUnsupported", () => {
    const e = new Error(
      'HTTP 400 Bad Request: {"error":{"status":"INVALID_ARGUMENT","message":"Invalid schema for function parameter"}}',
    );
    expect(geminiGenerateContentAdapter.classify(e).class).toBe(
      "SchemaUnsupported",
    );
  });

  it("400 without schema-related text → ProviderRejected", () => {
    const e = new Error('HTTP 400 Bad Request: {"error":{"message":"Bad request"}}');
    expect(geminiGenerateContentAdapter.classify(e).class).toBe(
      "ProviderRejected",
    );
  });

  it("503 UNAVAILABLE → TransientError", () => {
    const e = new Error('HTTP 503 Service Unavailable: {"error":{"status":"UNAVAILABLE"}}');
    expect(geminiGenerateContentAdapter.classify(e).class).toBe("TransientError");
  });

  it("500 → TransientError", () => {
    const e = new Error("HTTP 500 Internal Server Error");
    expect(geminiGenerateContentAdapter.classify(e).class).toBe("TransientError");
  });

  it("F-1 (spike-05): unwraps `cause` from UpstreamFailure-shape wrapper", () => {
    const wrapped = {
      _tag: "UpstreamFailure",
      cause: new Error("HTTP 401 Unauthorized: API key invalid"),
    };
    expect(geminiGenerateContentAdapter.classify(wrapped).class).toBe(
      "AuthError",
    );
  });

  // ── F-2 regression (spike-06): Gemini returns bad-credential as
  //    HTTP 400 INVALID_ARGUMENT with API_KEY_INVALID in the body,
  //    NOT HTTP 401. Without the special case, AuthError would
  //    mis-classify as ProviderRejected; ops dashboard wouldn't flag
  //    the credential as root cause and AuthError's TTL=0 (not
  //    lease-bearing) semantics wouldn't apply.
  it("F-2: 400 + API_KEY_INVALID → AuthError", () => {
    const e = new Error(
      'HTTP 400 Bad Request: {"error":{"code":400,"message":"API key not valid","status":"INVALID_ARGUMENT","details":[{"reason":"API_KEY_INVALID"}]}}',
    );
    expect(geminiGenerateContentAdapter.classify(e).class).toBe("AuthError");
  });

  it("F-2: 400 + PERMISSION_DENIED → AuthError", () => {
    const e = new Error(
      'HTTP 400 Bad Request: {"error":{"status":"PERMISSION_DENIED"}}',
    );
    expect(geminiGenerateContentAdapter.classify(e).class).toBe("AuthError");
  });
});

// ============================================================
// P2 regression (Codex 2026-05-25): adapter purity
//   `synthesizeGeminiToolCallId` previously used module-mutable state +
//   `Date.now()`, breaking the spec-27 §3 "no IO, no clock" rule. The
//   fix derives ids from candidate/part position when upstream elides
//   `functionCall.id`. Same input → same output, regardless of when or
//   how often decodeTurn is called.
// ============================================================

describe("gemini adapter — P2 purity", () => {
  const rawWithoutUpstreamId = {
    candidates: [
      {
        content: {
          role: "model",
          parts: [
            { functionCall: { name: "lookup", args: { q: "X" } } },
          ],
        },
      },
    ],
    usageMetadata: {
      promptTokenCount: 5,
      candidatesTokenCount: 5,
      totalTokenCount: 10,
    },
  };

  it("synthesized id is deterministic across multiple decodeTurn calls on the same response", () => {
    const a = geminiGenerateContentAdapter.decodeTurn(rawWithoutUpstreamId);
    const b = geminiGenerateContentAdapter.decodeTurn(rawWithoutUpstreamId);
    const c = geminiGenerateContentAdapter.decodeTurn(rawWithoutUpstreamId);
    expect(a.toolCalls[0].id).toBe(b.toolCalls[0].id);
    expect(b.toolCalls[0].id).toBe(c.toolCalls[0].id);
  });

  it("synthesized id is positional (encodes candidate + part index)", () => {
    const r = geminiGenerateContentAdapter.decodeTurn(rawWithoutUpstreamId);
    // Single candidate (idx 0), single part (idx 0).
    expect(r.toolCalls[0].id).toBe("gemini-cand0-part0");
  });

  it("two functionCalls in the same content yield distinct positional ids", () => {
    const raw = {
      candidates: [
        {
          content: {
            role: "model",
            parts: [
              { text: "thinking..." },
              { functionCall: { name: "a", args: {} } },
              { functionCall: { name: "b", args: {} } },
            ],
          },
        },
      ],
    };
    const r = geminiGenerateContentAdapter.decodeTurn(raw);
    expect(r.toolCalls).toHaveLength(2);
    // text occupies part idx 0; functionCalls land at 1 and 2.
    expect(r.toolCalls[0].id).toBe("gemini-cand0-part1");
    expect(r.toolCalls[1].id).toBe("gemini-cand0-part2");
    expect(r.toolCalls[0].id).not.toBe(r.toolCalls[1].id);
  });

  it("upstream-provided functionCall.id is preferred over positional id", () => {
    const raw = {
      candidates: [
        {
          content: {
            role: "model",
            parts: [
              {
                functionCall: { name: "lookup", args: {}, id: "TAeN4yyC" },
              },
            ],
          },
        },
      ],
    };
    const r = geminiGenerateContentAdapter.decodeTurn(raw);
    expect(r.toolCalls[0].id).toBe("TAeN4yyC");
  });
});

// ============================================================
// Layer 4 — text streaming capability (spec-31)
// ============================================================

describe("gemini adapter — textStream", () => {
  it("encodes native streamGenerateContent request body", () => {
    const capability = geminiGenerateContentAdapter.textStream;
    expect(capability.supported).toBe(true);
    if (capability.supported === false) throw new Error("expected support");

    const body = capability.encode(ROUTE, {
      messages: [
        { role: "system", content: "Be terse." },
        { role: "user", content: "hello" },
      ],
    });

    expect(body).toEqual({
      systemInstruction: { parts: [{ text: "Be terse." }] },
      contents: [{ role: "user", parts: [{ text: "hello" }] }],
      tools: undefined,
      toolConfig: undefined,
    });
  });

  it("decodes Gemini streamGenerateContent SSE chunks", async () => {
    const capability = geminiGenerateContentAdapter.textStream;
    if (capability.supported === false) throw new Error("expected support");

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            [
              'data: {"candidates":[{"content":{"parts":[{"text":"Hel"}]}}]}',
              "",
              'data: {"candidates":[{"content":{"parts":[{"text":"lo"}]}}],"usageMetadata":{"promptTokenCount":7,"candidatesTokenCount":2,"totalTokenCount":9}}',
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
        usage: { promptTokens: 7, completionTokens: 2, totalTokens: 9 },
      },
      { type: "done" },
    ]);
  });

  it("fails decode when stream contains no Gemini chunks", async () => {
    const capability = geminiGenerateContentAdapter.textStream;
    if (capability.supported === false) throw new Error("expected support");

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    });

    await expect((async () => {
      for await (const _frame of capability.decodeFrames(stream)) {
        // drain
      }
    })()).rejects.toThrow("stream ended before any Gemini chunk");
  });
});

// ============================================================
// Layer 5 — adapter identity invariants (spec-27 C-1)
// ============================================================

describe("gemini adapter — identity invariants", () => {
  it("kind tag matches registration key", () => {
    expect(geminiGenerateContentAdapter.kind).toBe("gemini-generate-content");
  });

  it("version is semver-like", () => {
    expect(geminiGenerateContentAdapter.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("all 5 methods are functions", () => {
    expect(typeof geminiGenerateContentAdapter.encodeTurn).toBe("function");
    expect(typeof geminiGenerateContentAdapter.decodeTurn).toBe("function");
    expect(typeof geminiGenerateContentAdapter.encodeStructured).toBe("function");
    expect(typeof geminiGenerateContentAdapter.decodeStructured).toBe("function");
    expect(typeof geminiGenerateContentAdapter.classify).toBe("function");
  });
});
