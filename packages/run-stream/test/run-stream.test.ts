import {
  composeRunStream,
  decodeRunStreamData,
  encodeRunStreamSse,
  projectRunStream,
  type RunStreamFrame,
} from "../src";
import type { LedgerEventRpc, SubmitResult } from "../src";
import type { TurnStreamFrame } from "@agent-os/turn-stream";

const ledgerEvent = (id: number, kind = "agent.started"): LedgerEventRpc => ({
  id,
  ts: 1_700_000_000_000 + id,
  kind,
  scope: "session/run-stream",
  payload: { id },
});

const okResult: SubmitResult = {
  ok: true,
  runId: 1,
  final: "done",
  eventCount: 2,
  tokensUsed: 3,
};

const failedResult: SubmitResult = {
  ok: false,
  runId: 2,
  reason: "agent.aborted.retries",
  eventCount: 3,
  tokensUsed: 4,
};

describe("@agent-os/run-stream", () => {
  it("projects ordered ledger and turn frames into one run view", () => {
    const turnFrames: ReadonlyArray<TurnStreamFrame> = [
      { kind: "text_delta", turnRef: "turn/1", seq: 0, text: "hel" },
      { kind: "metadata", turnRef: "turn/1", seq: 1, data: { model: "test" } },
      { kind: "text_delta", turnRef: "turn/1", seq: 2, text: "lo" },
      { kind: "done", turnRef: "turn/1", seq: 3 },
    ];
    const frames = composeRunStream({
      submit: okResult,
      ledgerEvents: [ledgerEvent(1), ledgerEvent(2, "tool.executed")],
      turnFrames,
    });

    expect(projectRunStream(frames)).toEqual({
      status: "succeeded",
      lastSeq: 6,
      ledgerEvents: [ledgerEvent(1), ledgerEvent(2, "tool.executed")],
      turnStreams: {
        "turn/1": {
          turnRef: "turn/1",
          status: "done",
          text: "hello",
          lastSeq: 3,
          metadata: [{ kind: "metadata", turnRef: "turn/1", seq: 1, data: { model: "test" } }],
          includedSeqs: [0, 1, 2, 3],
          omittedFrames: [],
        },
      },
      result: okResult,
      omittedFrames: [],
    });
  });

  it("omits malformed, duplicate/out-of-order, and post-terminal frames", () => {
    const frames: ReadonlyArray<unknown> = [
      { bad: true },
      { kind: "ledger_event", seq: 0, event: ledgerEvent(1) },
      { kind: "ledger_event", seq: 0, event: ledgerEvent(2) },
      { kind: "submit_result", seq: 1, result: okResult },
      { kind: "ledger_event", seq: 2, event: ledgerEvent(3) },
    ];

    expect(projectRunStream(frames)).toEqual({
      status: "succeeded",
      lastSeq: 1,
      ledgerEvents: [ledgerEvent(1)],
      turnStreams: {},
      result: okResult,
      omittedFrames: [
        { reason: "malformed" },
        { seq: 0, reason: "duplicate_or_out_of_order" },
        { seq: 2, reason: "after_terminal" },
      ],
    });
  });

  it("projects failed submit results as failed", () => {
    const frames: ReadonlyArray<RunStreamFrame> = [
      { kind: "ledger_event", seq: 0, event: ledgerEvent(1, "agent.started") },
      { kind: "submit_result", seq: 1, result: failedResult },
    ];

    expect(projectRunStream(frames)).toEqual({
      status: "failed",
      lastSeq: 1,
      ledgerEvents: [ledgerEvent(1, "agent.started")],
      turnStreams: {},
      result: failedResult,
      omittedFrames: [],
    });
  });

  it("projects stream errors as terminal errors", () => {
    const frames: ReadonlyArray<RunStreamFrame> = [
      { kind: "ledger_event", seq: 0, event: ledgerEvent(1) },
      { kind: "stream_error", seq: 1, reason: "stream writer failed" },
    ];

    expect(projectRunStream(frames)).toEqual({
      status: "error",
      lastSeq: 1,
      ledgerEvents: [ledgerEvent(1)],
      turnStreams: {},
      errorReason: "stream writer failed",
      omittedFrames: [],
    });
  });

  it("encodes and decodes SSE data frames", () => {
    const frame: RunStreamFrame = {
      kind: "ledger_event",
      seq: 0,
      event: ledgerEvent(1),
    };

    expect(encodeRunStreamSse(frame)).toBe(
      `event: ledger_event\ndata: ${JSON.stringify(frame)}\n\n`,
    );
    expect(decodeRunStreamData(JSON.stringify(frame))).toEqual(frame);
    expect(decodeRunStreamData('{"kind":"ledger_event","seq":0}')).toBeNull();
  });
});
