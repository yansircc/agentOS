import {
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
});
