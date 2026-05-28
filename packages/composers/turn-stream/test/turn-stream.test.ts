import {
  adaptAnthropicDeltaChunk,
  adaptGeminiDeltaChunk,
  adaptOpenAiCompatibleDeltaChunk,
  decodeTurnStreamData,
  encodeTurnStreamSse,
  projectTurnStream,
  type TurnStreamFrame,
} from "../src";

describe("@agent-os/turn-stream", () => {
  it("projects ordered text deltas into current non-durable text", () => {
    const frames: ReadonlyArray<TurnStreamFrame> = [
      { kind: "text_delta", turnRef: "turn/1", seq: 0, text: "hel" },
      { kind: "metadata", turnRef: "turn/1", seq: 1, data: { model: "test" } },
      { kind: "text_delta", turnRef: "turn/1", seq: 2, text: "lo" },
      { kind: "done", turnRef: "turn/1", seq: 3 },
    ];

    expect(projectTurnStream(frames, "turn/1")).toEqual({
      turnRef: "turn/1",
      status: "done",
      text: "hello",
      lastSeq: 3,
      metadata: [{ kind: "metadata", turnRef: "turn/1", seq: 1, data: { model: "test" } }],
      includedSeqs: [0, 1, 2, 3],
      omittedFrames: [],
    });
  });

  it("omits malformed, wrong-turn, duplicate, and post-terminal frames", () => {
    const frames: ReadonlyArray<unknown> = [
      { bad: true },
      { kind: "text_delta", turnRef: "other", seq: 0, text: "x" },
      { kind: "text_delta", turnRef: "turn/1", seq: 0, text: "a" },
      { kind: "text_delta", turnRef: "turn/1", seq: 0, text: "dup" },
      { kind: "done", turnRef: "turn/1", seq: 1 },
      { kind: "text_delta", turnRef: "turn/1", seq: 2, text: "late" },
    ];

    expect(projectTurnStream(frames, "turn/1")).toEqual({
      turnRef: "turn/1",
      status: "done",
      text: "a",
      lastSeq: 1,
      metadata: [],
      includedSeqs: [0, 1],
      omittedFrames: [
        { reason: "malformed" },
        { seq: 0, reason: "wrong_turn" },
        { seq: 0, reason: "duplicate_or_out_of_order" },
        { seq: 2, reason: "after_terminal" },
      ],
    });
  });

  it("preserves provider error terminal frames without ledger writes", () => {
    expect(
      projectTurnStream(
        [
          { kind: "text_delta", turnRef: "turn/1", seq: 0, text: "partial" },
          { kind: "error", turnRef: "turn/1", seq: 1, reason: "provider disconnected" },
        ],
        "turn/1",
      ),
    ).toEqual({
      turnRef: "turn/1",
      status: "error",
      text: "partial",
      lastSeq: 1,
      metadata: [],
      includedSeqs: [0, 1],
      omittedFrames: [],
      errorReason: "provider disconnected",
    });
  });

  it("encodes and decodes data-only SSE frames", () => {
    const frame: TurnStreamFrame = {
      kind: "text_delta",
      turnRef: "turn/1",
      seq: 0,
      text: "hello",
    };

    expect(encodeTurnStreamSse(frame)).toBe(
      'event: text_delta\ndata: {"kind":"text_delta","turnRef":"turn/1","seq":0,"text":"hello"}\n\n',
    );
    expect(
      decodeTurnStreamData('{"kind":"text_delta","turnRef":"turn/1","seq":0,"text":"hello"}'),
    ).toEqual(frame);
    expect(decodeTurnStreamData('{"kind":"text_delta","turnRef":"turn/1","seq":0}')).toBeNull();
  });

  it("maps OpenAI-compatible deltas into text, curated metadata, and terminal frames", () => {
    expect(
      adaptOpenAiCompatibleDeltaChunk({
        turnRef: "turn/openai",
        seq: 4,
        chunk: {
          choices: [
            { delta: { role: "assistant" } },
            { delta: { content: "hel" } },
            { delta: {}, finish_reason: "stop" },
          ],
          usage: {
            prompt_tokens: 1,
            completion_tokens: 2,
            total_tokens: 3,
            raw_body: "not copied",
          },
        },
      }),
    ).toEqual([
      { kind: "text_delta", turnRef: "turn/openai", seq: 4, text: "hel" },
      {
        kind: "metadata",
        turnRef: "turn/openai",
        seq: 5,
        data: { provider: "openai_compatible", finishReason: "stop" },
      },
      {
        kind: "metadata",
        turnRef: "turn/openai",
        seq: 6,
        data: {
          provider: "openai_compatible",
          usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
        },
      },
    ]);

    expect(
      adaptOpenAiCompatibleDeltaChunk({
        turnRef: "turn/openai",
        seq: 7,
        chunk: "[DONE]",
      }),
    ).toEqual([{ kind: "done", turnRef: "turn/openai", seq: 7 }]);
  });

  it("maps Anthropic deltas and named no-op events", () => {
    expect(
      adaptAnthropicDeltaChunk({
        turnRef: "turn/anthropic",
        seq: 0,
        chunk: { type: "ping" },
      }),
    ).toEqual([]);

    expect(
      adaptAnthropicDeltaChunk({
        turnRef: "turn/anthropic",
        seq: 1,
        chunk: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "hi" },
        },
      }),
    ).toEqual([{ kind: "text_delta", turnRef: "turn/anthropic", seq: 1, text: "hi" }]);

    expect(
      adaptAnthropicDeltaChunk({
        turnRef: "turn/anthropic",
        seq: 2,
        chunk: {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { output_tokens: 5, raw_body: "not copied" },
        },
      }),
    ).toEqual([
      {
        kind: "metadata",
        turnRef: "turn/anthropic",
        seq: 2,
        data: { provider: "anthropic", usage: { output_tokens: 5 } },
      },
      {
        kind: "metadata",
        turnRef: "turn/anthropic",
        seq: 3,
        data: { provider: "anthropic", finishReason: "end_turn" },
      },
    ]);

    expect(
      adaptAnthropicDeltaChunk({
        turnRef: "turn/anthropic",
        seq: 4,
        chunk: { type: "message_stop" },
      }),
    ).toEqual([{ kind: "done", turnRef: "turn/anthropic", seq: 4 }]);
  });

  it("maps Gemini deltas into text, curated metadata, and done on finishReason", () => {
    expect(
      adaptGeminiDeltaChunk({
        turnRef: "turn/gemini",
        seq: 10,
        chunk: {
          candidates: [
            {
              content: { parts: [{ text: "" }, { text: "ok" }] },
              finishReason: "STOP",
            },
          ],
          usageMetadata: {
            promptTokenCount: 1,
            candidatesTokenCount: 2,
            totalTokenCount: 3,
            raw_body: "not copied",
          },
        },
      }),
    ).toEqual([
      { kind: "text_delta", turnRef: "turn/gemini", seq: 10, text: "ok" },
      {
        kind: "metadata",
        turnRef: "turn/gemini",
        seq: 11,
        data: { provider: "gemini", finishReason: "STOP" },
      },
      {
        kind: "metadata",
        turnRef: "turn/gemini",
        seq: 12,
        data: {
          provider: "gemini",
          usage: { promptTokenCount: 1, candidatesTokenCount: 2, totalTokenCount: 3 },
        },
      },
      { kind: "done", turnRef: "turn/gemini", seq: 13 },
    ]);
  });

  it("turns unknown or unsupported content-bearing provider chunks into safe errors", () => {
    const frames = [
      ...adaptOpenAiCompatibleDeltaChunk({
        turnRef: "turn/openai",
        seq: 0,
        chunk: { choices: [{ delta: { tool_calls: [{ secret: "not copied" }] } }] },
      }),
      ...adaptAnthropicDeltaChunk({
        turnRef: "turn/anthropic",
        seq: 1,
        chunk: {
          type: "content_block_delta",
          delta: { type: "input_json_delta", partial_json: '{"secret":true}' },
        },
      }),
      ...adaptGeminiDeltaChunk({
        turnRef: "turn/gemini",
        seq: 2,
        chunk: { candidates: [{ content: { parts: [{ inlineData: { data: "secret" } }] } }] },
      }),
      ...adaptGeminiDeltaChunk({
        turnRef: "turn/gemini",
        seq: 3,
        chunk: { object: "unknown", body: "secret" },
      }),
    ];

    expect(frames).toEqual([
      {
        kind: "error",
        turnRef: "turn/openai",
        seq: 0,
        reason: "openai_compatible_unsupported_chunk",
      },
      {
        kind: "error",
        turnRef: "turn/anthropic",
        seq: 1,
        reason: "anthropic_unsupported_chunk",
      },
      { kind: "error", turnRef: "turn/gemini", seq: 2, reason: "gemini_unsupported_chunk" },
      { kind: "error", turnRef: "turn/gemini", seq: 3, reason: "gemini_unknown_chunk" },
    ]);
    expect(JSON.stringify(frames)).not.toContain("secret");
  });
});
