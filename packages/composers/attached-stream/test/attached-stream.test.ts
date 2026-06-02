import {
  attachedStreamOutboundFrame,
  decodeAttachedStreamMessage,
  decodeAttachedStreamOutboundMessage,
  encodeAttachedStreamMessage,
  encodeAttachedStreamSse,
  projectAttachedStream,
  type AttachedStreamInboundFrame,
  type AttachedStreamOutboundFrame,
} from "../src";

describe("@agent-os/attached-stream", () => {
  it("projects ordered outbound frames into a live stream view", () => {
    const frames: ReadonlyArray<AttachedStreamOutboundFrame> = [
      { kind: "opened", streamRef: "stream/1", seq: 0, mode: "bidi" },
      { kind: "output", streamRef: "stream/1", seq: 1, channel: "stdout", payload: "hel" },
      { kind: "progress", streamRef: "stream/1", seq: 2, payload: { step: "thinking" } },
      { kind: "output", streamRef: "stream/1", seq: 3, channel: "stdout", payload: "lo" },
      { kind: "completed", streamRef: "stream/1", seq: 4, terminal: { ok: true } },
    ];

    expect(projectAttachedStream(frames, "stream/1")).toEqual({
      streamRef: "stream/1",
      status: "completed",
      lastSeq: 4,
      opened: { kind: "opened", streamRef: "stream/1", seq: 0, mode: "bidi" },
      outputs: [
        { kind: "output", streamRef: "stream/1", seq: 1, channel: "stdout", payload: "hel" },
        { kind: "output", streamRef: "stream/1", seq: 3, channel: "stdout", payload: "lo" },
      ],
      progress: [
        { kind: "progress", streamRef: "stream/1", seq: 2, payload: { step: "thinking" } },
      ],
      cancelIgnored: [],
      terminal: { kind: "completed", streamRef: "stream/1", seq: 4, terminal: { ok: true } },
      includedSeqs: [0, 1, 2, 3, 4],
      omittedFrames: [],
    });
  });

  it("omits malformed, wrong-stream, duplicate, duplicate-opened, and post-terminal frames", () => {
    const frames: ReadonlyArray<unknown> = [
      { bad: true },
      { kind: "opened", streamRef: "other", seq: 0, mode: "bidi" },
      { kind: "opened", streamRef: "stream/1", seq: 0, mode: "bidi" },
      { kind: "output", streamRef: "stream/1", seq: 0, channel: "stdout", payload: "dup" },
      { kind: "opened", streamRef: "stream/1", seq: 1, mode: "bidi" },
      { kind: "cancelled", streamRef: "stream/1", seq: 2, reason: "user" },
      { kind: "output", streamRef: "stream/1", seq: 3, channel: "stdout", payload: "late" },
    ];

    expect(projectAttachedStream(frames, "stream/1")).toEqual({
      streamRef: "stream/1",
      status: "cancelled",
      lastSeq: 2,
      opened: { kind: "opened", streamRef: "stream/1", seq: 0, mode: "bidi" },
      outputs: [],
      progress: [],
      cancelIgnored: [],
      terminal: { kind: "cancelled", streamRef: "stream/1", seq: 2, reason: "user" },
      includedSeqs: [0, 2],
      omittedFrames: [
        { reason: "malformed" },
        { seq: 0, reason: "wrong_stream" },
        { seq: 0, reason: "duplicate_or_out_of_order" },
        { seq: 1, reason: "duplicate_opened" },
        { seq: 3, reason: "after_terminal" },
      ],
    });
  });

  it("keeps inbound and outbound sequence spaces independent", () => {
    const inbound: AttachedStreamInboundFrame = {
      kind: "input",
      streamRef: "stream/1",
      seq: 0,
      payload: { text: "hello" },
    };
    const outbound: AttachedStreamOutboundFrame = {
      kind: "opened",
      streamRef: "stream/1",
      seq: 0,
      mode: "bidi",
    };

    expect(decodeAttachedStreamMessage(encodeAttachedStreamMessage(inbound))).toEqual(inbound);
    expect(decodeAttachedStreamMessage(encodeAttachedStreamMessage(outbound))).toEqual(outbound);
  });

  it("encodes output-only SSE frames and rejects inbound data as outbound", () => {
    const frame = attachedStreamOutboundFrame("stream/1", 0, {
      kind: "opened",
      mode: "output_only",
    });

    expect(encodeAttachedStreamSse(frame)).toBe(
      'event: opened\ndata: {"kind":"opened","mode":"output_only","streamRef":"stream/1","seq":0}\n\n',
    );
    expect(decodeAttachedStreamOutboundMessage(JSON.stringify(frame))).toEqual(frame);
    expect(
      decodeAttachedStreamOutboundMessage(
        JSON.stringify({ kind: "input", streamRef: "stream/1", seq: 0, payload: "x" }),
      ),
    ).toBeNull();
  });

  it("uses only JSON text codec and no WebSocket-specific API", () => {
    const original = globalThis.WebSocket;
    try {
      Object.defineProperty(globalThis, "WebSocket", {
        configurable: true,
        value: undefined,
      });
      const frame: AttachedStreamOutboundFrame = {
        kind: "completed",
        streamRef: "stream/no-ws",
        seq: 0,
        terminal: { ok: true },
      };
      expect(decodeAttachedStreamMessage(encodeAttachedStreamMessage(frame))).toEqual(frame);
    } finally {
      Object.defineProperty(globalThis, "WebSocket", {
        configurable: true,
        value: original,
      });
    }
  });
});
