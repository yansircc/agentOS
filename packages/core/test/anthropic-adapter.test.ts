/**
 * anthropic-messages protocol adapter — contract tests (spec-27 §9.1).
 *
 * Three pure layers (no network):
 *   1. encode shape:    encodeTurn / encodeStructured produce wire-correct
 *                       AnthropicMessagesBody (system extraction,
 *                       tool_choice.{type:"tool",name}, tools[].input_schema,
 *                       max_tokens present)
 *   2. decode shape:    decodeTurn folds content[].{text,tool_use} into
 *                       unified LlmResponse; decodeStructured enforces
 *                       exactly-one matching tool_use
 *   3. classify:        401/403 → AuthError, 429 → RateLimited,
 *                       400-schema → SchemaUnsupported, 400-other →
 *                       ProviderRejected, 529/5xx → TransientError,
 *                       network → TransientError
 */

import { describe, expect, it } from "@effect/vitest";
import { Chunk, Effect, Stream } from "effect";

import {
  anthropicMessagesAdapter,
} from "../src/llm/protocol/anthropic-messages";
import type { JsonSchemaObject } from "../src/admission";
import type {
  AnthropicMessagesRoute,
  LlmMessage,
  ToolDefinition,
} from "../src/llm";

const ROUTE: AnthropicMessagesRoute = {
  kind: "anthropic-messages",
  endpointRef: "test-anthropic",
  credentialRef: "TEST_KEY",
  modelId: "claude-sonnet-4-6",
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

const collectFramesEffect = <A, E>(
  stream: Stream.Stream<A, E>,
): Effect.Effect<ReadonlyArray<A>, E> =>
  Stream.runCollect(stream).pipe(
    Effect.map((chunk) => Chunk.toReadonlyArray(chunk)),
  );

const collectFramesEitherEffect = <A, E>(stream: Stream.Stream<A, E>) =>
  collectFramesEffect(stream).pipe(Effect.either);

// ============================================================
// Layer 1 — encode shape
// ============================================================

describe("anthropic adapter — encodeTurn", () => {
  it("extracts system messages into top-level `system` field", () => {
    const messages: LlmMessage[] = [
      { role: "system", content: "You are a research agent." },
      { role: "user", content: "Find facts about X." },
    ];
    const body = anthropicMessagesAdapter.encodeTurn(ROUTE, { messages });
    expect(body.system).toBe("You are a research agent.");
    expect(body.messages).toEqual([
      { role: "user", content: "Find facts about X." },
    ]);
    expect(body.max_tokens).toBeGreaterThan(0);
  });

  it("concatenates multiple system messages with double newline", () => {
    const messages: LlmMessage[] = [
      { role: "system", content: "Rule A." },
      { role: "system", content: "Rule B." },
      { role: "user", content: "hi" },
    ];
    const body = anthropicMessagesAdapter.encodeTurn(ROUTE, { messages });
    expect(body.system).toBe("Rule A.\n\nRule B.");
  });

  it("folds assistant tool_calls into content[].tool_use blocks", () => {
    const messages: LlmMessage[] = [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: "looking up",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "lookup", arguments: '{"q":"X"}' },
          },
        ],
      },
    ];
    const body = anthropicMessagesAdapter.encodeTurn(ROUTE, { messages });
    expect(body.messages).toHaveLength(2);
    const asstMsg = body.messages[1];
    expect(asstMsg.role).toBe("assistant");
    const blocks = asstMsg.content as ReadonlyArray<{ type: string }>;
    expect(blocks).toEqual([
      { type: "text", text: "looking up" },
      {
        type: "tool_use",
        id: "call_1",
        name: "lookup",
        input: { q: "X" },
      },
    ]);
  });

  it("collapses consecutive tool messages into a single user turn with tool_result blocks", () => {
    const messages: LlmMessage[] = [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "c1", type: "function", function: { name: "a", arguments: "{}" } },
          { id: "c2", type: "function", function: { name: "b", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "c1", content: "result-a" },
      { role: "tool", tool_call_id: "c2", content: "result-b" },
    ];
    const body = anthropicMessagesAdapter.encodeTurn(ROUTE, { messages });
    // Expect: [user, assistant, user(with-2-tool-results)]
    expect(body.messages).toHaveLength(3);
    const last = body.messages[2];
    expect(last.role).toBe("user");
    expect(last.content).toEqual([
      { type: "tool_result", tool_use_id: "c1", content: "result-a" },
      { type: "tool_result", tool_use_id: "c2", content: "result-b" },
    ]);
  });

  it("translates tool definitions to Anthropic shape with input_schema", () => {
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
    const body = anthropicMessagesAdapter.encodeTurn(ROUTE, {
      messages: [{ role: "user", content: "hi" }],
      tools,
    });
    expect(body.tools).toEqual([
      {
        name: "lookup",
        description: "Look up something",
        input_schema: { type: "object", properties: { q: { type: "string" } } },
      },
    ]);
  });

  it("maps tool_choice {type:function, function:{name}} → {type:tool, name}", () => {
    const body = anthropicMessagesAdapter.encodeTurn(ROUTE, {
      messages: [{ role: "user", content: "hi" }],
      tool_choice: { type: "function", function: { name: "forced_tool" } },
    });
    expect(body.tool_choice).toEqual({ type: "tool", name: "forced_tool" });
  });
});

describe("anthropic adapter — encodeStructured", () => {
  it("produces forced-tool-call body with single _submit_structured tool", () => {
    const body = anthropicMessagesAdapter.encodeStructured(
      ROUTE,
      SCHEMA_CONTRACT,
      { kind: "live", userInput: { userText: "what is X?" } },
      "forced-tool-call",
    );
    expect(body.system).toBeDefined();
    expect(body.system).toContain("structured");
    expect(body.messages).toEqual([
      { role: "user", content: "what is X?" },
    ]);
    expect(body.tools).toHaveLength(1);
    expect(body.tools?.[0]).toEqual({
      name: "_submit_structured",
      description: expect.any(String),
      input_schema: SUMMARY_SCHEMA,
    });
    expect(body.tool_choice).toEqual({
      type: "tool",
      name: "_submit_structured",
    });
    expect(body.max_tokens).toBeGreaterThan(0);
  });

  it("uses synthetic input under probe stimulus", () => {
    const body = anthropicMessagesAdapter.encodeStructured(
      ROUTE,
      SCHEMA_CONTRACT,
      { kind: "probe", synthetic: { synthetic: "PROBE_INPUT" } },
      "forced-tool-call",
    );
    const userMsg = body.messages[0];
    expect(userMsg.content).toBe("PROBE_INPUT");
  });
});

// ============================================================
// Layer 2 — decode shape
// ============================================================

describe("anthropic adapter — decodeTurn", () => {
  it("folds text + tool_use blocks; usage maps to unified shape", () => {
    const raw = {
      content: [
        { type: "text", text: "looking up..." },
        {
          type: "tool_use",
          id: "tu_1",
          name: "lookup",
          input: { q: "X" },
        },
      ],
      usage: { input_tokens: 10, output_tokens: 20 },
    };
    const resp = anthropicMessagesAdapter.decodeTurn(raw);
    expect(resp.text).toBe("looking up...");
    expect(resp.toolCalls).toEqual([
      {
        id: "tu_1",
        type: "function",
        function: { name: "lookup", arguments: '{"q":"X"}' },
      },
    ]);
    expect(resp.usage).toEqual({
      promptTokens: 10,
      completionTokens: 20,
      totalTokens: 30,
    });
  });

  it("handles text-only response (no tool_calls)", () => {
    const raw = {
      content: [{ type: "text", text: "Just an answer." }],
      usage: { input_tokens: 5, output_tokens: 10 },
    };
    const resp = anthropicMessagesAdapter.decodeTurn(raw);
    expect(resp.text).toBe("Just an answer.");
    expect(resp.toolCalls).toEqual([]);
  });

  it("handles tool-use-only response (no text)", () => {
    const raw = {
      content: [
        { type: "tool_use", id: "tu_1", name: "x", input: {} },
      ],
      usage: { input_tokens: 5, output_tokens: 3 },
    };
    const resp = anthropicMessagesAdapter.decodeTurn(raw);
    expect(resp.text).toBe("");
    expect(resp.toolCalls).toHaveLength(1);
  });

  it("returns zero usage when fields missing", () => {
    const raw = { content: [{ type: "text", text: "" }] };
    const resp = anthropicMessagesAdapter.decodeTurn(raw);
    expect(resp.usage).toEqual({
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    });
  });
});

describe("anthropic adapter — decodeStructured", () => {
  it("Supported when exactly one _submit_structured tool_use with valid args", () => {
    const raw = {
      content: [
        {
          type: "tool_use",
          id: "tu_1",
          name: "_submit_structured",
          input: { summary: "ok" },
        },
      ],
      usage: { input_tokens: 5, output_tokens: 10 },
    };
    const r = anthropicMessagesAdapter.decodeStructured(
      { raw },
      SCHEMA_CONTRACT,
      "forced-tool-call",
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.decoded).toEqual({ summary: "ok" });
      expect(r.tokensUsed).toBe(15);
    }
  });

  it("BehaviorFailed when zero tool_use blocks", () => {
    const raw = {
      content: [{ type: "text", text: "I refuse." }],
      usage: { input_tokens: 5, output_tokens: 5 },
    };
    const r = anthropicMessagesAdapter.decodeStructured(
      { raw },
      SCHEMA_CONTRACT,
      "forced-tool-call",
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.outcome.class).toBe("BehaviorFailed");
      if (r.outcome.class === "BehaviorFailed") {
        expect(r.outcome.sampleDigest).toContain("no-tool-use");
      }
    }
  });

  it("BehaviorFailed when tool_use name mismatches forced name", () => {
    const raw = {
      content: [
        { type: "tool_use", id: "x", name: "other_tool", input: {} },
      ],
    };
    const r = anthropicMessagesAdapter.decodeStructured(
      { raw },
      SCHEMA_CONTRACT,
      "forced-tool-call",
    );
    expect(r.ok).toBe(false);
    if (!r.ok && r.outcome.class === "BehaviorFailed") {
      expect(r.outcome.sampleDigest).toContain("unexpected-tool-use");
    }
  });

  it("BehaviorFailed when more than one tool_use block emitted (model ignored forcing)", () => {
    const raw = {
      content: [
        { type: "tool_use", id: "a", name: "_submit_structured", input: { summary: "x" } },
        { type: "tool_use", id: "b", name: "_submit_structured", input: { summary: "y" } },
      ],
    };
    const r = anthropicMessagesAdapter.decodeStructured(
      { raw },
      SCHEMA_CONTRACT,
      "forced-tool-call",
    );
    expect(r.ok).toBe(false);
    if (!r.ok && r.outcome.class === "BehaviorFailed") {
      expect(r.outcome.sampleDigest).toContain("unexpected-tool-use:2");
    }
  });

  it("BehaviorFailed when args violate schema (additionalProperties:false)", () => {
    const raw = {
      content: [
        {
          type: "tool_use",
          id: "x",
          name: "_submit_structured",
          input: { summary: "ok", extra: "bad" },
        },
      ],
    };
    const r = anthropicMessagesAdapter.decodeStructured(
      { raw },
      SCHEMA_CONTRACT,
      "forced-tool-call",
    );
    expect(r.ok).toBe(false);
    if (!r.ok && r.outcome.class === "BehaviorFailed") {
      expect(r.outcome.sampleDigest).toContain("violations");
    }
  });

  it("test-decode-mismatch mode short-circuits to BehaviorFailed", () => {
    const r = anthropicMessagesAdapter.decodeStructured(
      { raw: {} },
      SCHEMA_CONTRACT,
      "forced-tool-call",
      "test-decode-mismatch",
    );
    expect(r.ok).toBe(false);
    if (!r.ok && r.outcome.class === "BehaviorFailed") {
      expect(r.outcome.sampleDigest).toContain("synthetic-test-decode-mismatch");
    }
  });
});

// ============================================================
// Layer 3 — classify
// ============================================================

describe("anthropic adapter — classify", () => {
  it("401 → AuthError", () => {
    const e = new Error('HTTP 401 Unauthorized: {"error":{"type":"authentication_error"}}');
    expect(anthropicMessagesAdapter.classify(e).class).toBe("AuthError");
  });

  it("403 → AuthError", () => {
    const e = new Error("HTTP 403 Forbidden: ...");
    expect(anthropicMessagesAdapter.classify(e).class).toBe("AuthError");
  });

  it("429 → RateLimited", () => {
    const e = new Error("HTTP 429 Too Many Requests: ...");
    expect(anthropicMessagesAdapter.classify(e).class).toBe("RateLimited");
  });

  it("400 with schema mention → SchemaUnsupported", () => {
    const e = new Error(
      'HTTP 400 Bad Request: {"error":{"type":"invalid_request_error","message":"tools.0.input_schema: invalid"}}',
    );
    const o = anthropicMessagesAdapter.classify(e);
    expect(o.class).toBe("SchemaUnsupported");
  });

  it("400 without schema mention → ProviderRejected", () => {
    const e = new Error(
      'HTTP 400 Bad Request: {"error":{"type":"invalid_request_error","message":"max_tokens too high"}}',
    );
    const o = anthropicMessagesAdapter.classify(e);
    expect(o.class).toBe("ProviderRejected");
  });

  it("529 (overloaded) → TransientError", () => {
    const e = new Error("HTTP 529 Overloaded: {}");
    expect(anthropicMessagesAdapter.classify(e).class).toBe("TransientError");
  });

  it("500 → TransientError", () => {
    const e = new Error("HTTP 500 Internal Server Error");
    expect(anthropicMessagesAdapter.classify(e).class).toBe("TransientError");
  });

  it("network/timeout error (no HTTP code) → TransientError", () => {
    const e = new Error("network connection timeout");
    expect(anthropicMessagesAdapter.classify(e).class).toBe("TransientError");
  });

  it("non-Error value (string) still classifies", () => {
    const o = anthropicMessagesAdapter.classify("HTTP 401 plain string");
    expect(o.class).toBe("AuthError");
  });

  // ── F-1 regression (spike-05): classify MUST unwrap one level when
  //    the error comes from `dispatchProvider` wrapped as
  //    UpstreamFailure{cause: Error("HTTP ...")}. Without unwrap,
  //    error.message reads the tag ("UpstreamFailure") and falls
  //    through to ProviderRejected — observed live on spike-05's
  //    bogus-credential test.
  it("F-1: unwraps `cause` from wrapped error (UpstreamFailure-shaped)", () => {
    const wrapped = {
      _tag: "UpstreamFailure",
      cause: new Error('HTTP 401 Unauthorized: {"error":"bad key"}'),
    };
    const o = anthropicMessagesAdapter.classify(wrapped);
    expect(o.class).toBe("AuthError");
  });

  it("F-1: also unwraps when cause is a plain string", () => {
    const wrapped = {
      _tag: "UpstreamFailure",
      cause: "HTTP 429 Too Many Requests",
    };
    const o = anthropicMessagesAdapter.classify(wrapped);
    expect(o.class).toBe("RateLimited");
  });
});

// ============================================================
// Layer 4 — text streaming capability (spec-31)
// ============================================================

describe("anthropic adapter — textStream", () => {
  it("encodes native Messages stream=true request", () => {
    const capability = anthropicMessagesAdapter.textStream;
    expect(capability.supported).toBe(true);
    if (capability.supported === false) throw new Error("expected support");

    const body = capability.encode(ROUTE, {
      messages: [
        { role: "system", content: "Be terse." },
        { role: "user", content: "hello" },
      ],
    });

    expect(body).toMatchObject({
      system: "Be terse.",
      messages: [{ role: "user", content: "hello" }],
      max_tokens: expect.any(Number),
      stream: true,
    });
  });

  it.effect("decodes Anthropic SSE text_delta, usage, and message_stop", () =>
    Effect.gen(function* () {
      const capability = anthropicMessagesAdapter.textStream;
      if (capability.supported === false) throw new Error("expected support");

      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              [
                'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":11,"output_tokens":0}}}',
                "",
                'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hel"}}',
                "",
                'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"lo"}}',
                "",
                'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":2}}',
                "",
                'event: message_stop\ndata: {"type":"message_stop"}',
                "",
              ].join("\n"),
            ),
          );
          controller.close();
        },
      });

      const frames = yield* collectFramesEffect(capability.decodeFrames(stream));

      expect(frames).toEqual([
        {
          type: "usage",
          usage: { promptTokens: 11, completionTokens: 0, totalTokens: 11 },
        },
        { type: "token", delta: "Hel" },
        { type: "token", delta: "lo" },
        {
          type: "usage",
          usage: { promptTokens: 11, completionTokens: 2, totalTokens: 13 },
        },
        { type: "done" },
      ]);
    }),
  );

  it.effect("fails decode when stream ends before message_stop", () =>
    Effect.gen(function* () {
      const capability = anthropicMessagesAdapter.textStream;
      if (capability.supported === false) throw new Error("expected support");

      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"partial"}}\n\n',
            ),
          );
          controller.close();
        },
      });

      const result = yield* collectFramesEitherEffect(
        capability.decodeFrames(stream),
      );
      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        expect(result.left.cause).toBe("stream ended before message_stop");
      }
    }),
  );
});

// ============================================================
// Layer 5 — adapter identity invariants (spec-27 C-1)
// ============================================================

describe("anthropic adapter — identity invariants", () => {
  it("kind tag matches registration key", () => {
    expect(anthropicMessagesAdapter.kind).toBe("anthropic-messages");
  });

  it("version is non-empty semver-like string", () => {
    expect(anthropicMessagesAdapter.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("all 5 methods are functions (no partial adapter)", () => {
    expect(typeof anthropicMessagesAdapter.encodeTurn).toBe("function");
    expect(typeof anthropicMessagesAdapter.decodeTurn).toBe("function");
    expect(typeof anthropicMessagesAdapter.encodeStructured).toBe("function");
    expect(typeof anthropicMessagesAdapter.decodeStructured).toBe("function");
    expect(typeof anthropicMessagesAdapter.classify).toBe("function");
  });
});
