import {
  composeBatchedSubmitRunStream,
  composeRealtimeRunStream,
  composeRunStream,
  createBatchedSubmitRunStreamResponse,
  decodeRunStreamData,
  encodeRunStreamSse,
  projectRunStream,
  type RunStreamFrame,
} from "../src";
import type { LedgerEventRpc, SubmitResult, SubmitSpec } from "../src";
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

const submitSpec: SubmitSpec = {
  intent: "Return a final answer.",
  context: { source: "run-stream-test" },
  route: { kind: "cf-ai-binding", modelId: "@cf/stub/test" },
  tools: {},
  budget: { maxTurns: 1 },
  deliver: { event: "stream.done" },
};

const frameDataFromSse = (text: string): ReadonlyArray<RunStreamFrame> =>
  text
    .split("\n\n")
    .filter((raw) => raw.length > 0)
    .map((raw) => {
      const data = raw
        .split("\n")
        .find((line) => line.startsWith("data: "))
        ?.slice(6);
      const frame = data === undefined ? null : decodeRunStreamData(data);
      expect(frame).not.toBeNull();
      return frame as RunStreamFrame;
    });

const deferred = <T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (cause: unknown) => void;
} => {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const collectRunFrames = async (
  frames: AsyncIterable<RunStreamFrame>,
): Promise<ReadonlyArray<RunStreamFrame>> => {
  const collected: RunStreamFrame[] = [];
  for await (const frame of frames) collected.push(frame);
  return collected;
};

const emptyLedgerEvents = (): Promise<ReadonlyArray<LedgerEventRpc>> => Promise.resolve([]);

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

  it("composes a batched submit stream from post-baseline ledger rows and terminal result", async () => {
    const operations: string[] = [];
    const frames = await composeBatchedSubmitRunStream({
      submitSpec,
      events: async (options) => {
        operations.push(options?.afterId === undefined ? "events:baseline" : "events:after=5");
        return options?.afterId === undefined
          ? [ledgerEvent(5, "seed.before")]
          : [ledgerEvent(6, "agent.run.started"), ledgerEvent(7, "agent.run.completed")];
      },
      submit: async (spec) => {
        operations.push(`submit:${spec.deliver.event}`);
        return okResult;
      },
    });

    expect(operations).toEqual(["events:baseline", "submit:stream.done", "events:after=5"]);
    expect(projectRunStream(frames)).toEqual({
      status: "succeeded",
      lastSeq: 2,
      ledgerEvents: [ledgerEvent(6, "agent.run.started"), ledgerEvent(7, "agent.run.completed")],
      turnStreams: {},
      result: okResult,
      omittedFrames: [],
    });
  });

  it("uses explicit afterId without a baseline read", async () => {
    const operations: string[] = [];
    const frames = await composeBatchedSubmitRunStream({
      submitSpec,
      afterId: 41,
      events: async (options) => {
        operations.push(`events:after=${options?.afterId ?? "none"}`);
        return [ledgerEvent(42, "agent.run.completed")];
      },
      submit: async () => {
        operations.push("submit");
        return okResult;
      },
    });

    expect(operations).toEqual(["submit", "events:after=41"]);
    expect(projectRunStream(frames).ledgerEvents).toEqual([ledgerEvent(42, "agent.run.completed")]);
  });

  it("emits failed submit results as terminal submit_result frames", async () => {
    const frames = await composeBatchedSubmitRunStream({
      submitSpec,
      afterId: 0,
      events: async () => [ledgerEvent(1, "agent.aborted.upstream_failure")],
      submit: async () => failedResult,
    });

    expect(projectRunStream(frames)).toEqual({
      status: "failed",
      lastSeq: 1,
      ledgerEvents: [ledgerEvent(1, "agent.aborted.upstream_failure")],
      turnStreams: {},
      result: failedResult,
      omittedFrames: [],
    });
  });

  it("maps bridge transport failures to stream_error frames", async () => {
    const frames = await composeBatchedSubmitRunStream({
      submitSpec,
      afterId: 0,
      events: async () => [],
      submit: async () => {
        throw new Error("submit transport failed");
      },
    });

    expect(projectRunStream(frames)).toEqual({
      status: "error",
      lastSeq: 0,
      ledgerEvents: [],
      turnStreams: {},
      errorReason: "submit transport failed",
      omittedFrames: [],
    });
  });

  it("creates a batched SSE response without requiring token deltas", async () => {
    const response = await createBatchedSubmitRunStreamResponse({
      submitSpec,
      afterId: 0,
      events: async () => [ledgerEvent(1, "agent.run.completed")],
      submit: async () => okResult,
    });

    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const projection = projectRunStream(frameDataFromSse(await response.text()));
    expect(projection.turnStreams).toEqual({});
    expect(projection.status).toBe("succeeded");
    expect(projection.result).toEqual(okResult);
  });

  it("composes realtime frames in source arrival order before terminal submit_result", async () => {
    const ledgerReady = deferred<LedgerEventRpc>();
    const turnReady = deferred<TurnStreamFrame>();
    const submitReady = deferred<SubmitResult>();
    async function* ledgerEvents(): AsyncGenerator<LedgerEventRpc> {
      yield await ledgerReady.promise;
    }
    async function* turnFrames(): AsyncGenerator<TurnStreamFrame> {
      yield await turnReady.promise;
    }

    const collecting = collectRunFrames(
      composeRealtimeRunStream({
        ledgerEvents: ledgerEvents(),
        turnFrames: turnFrames(),
        submitResult: submitReady.promise,
      }),
    );

    ledgerReady.resolve(ledgerEvent(9, "agent.run.started"));
    turnReady.resolve({ kind: "text_delta", turnRef: "turn/realtime", seq: 0, text: "live" });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    submitReady.resolve(okResult);

    expect(await collecting).toEqual([
      { kind: "ledger_event", seq: 0, event: ledgerEvent(9, "agent.run.started") },
      {
        kind: "turn_frame",
        seq: 1,
        frame: { kind: "text_delta", turnRef: "turn/realtime", seq: 0, text: "live" },
      },
      { kind: "submit_result", seq: 2, result: okResult },
    ]);
  });

  it("emits failed realtime submit results as terminal submit_result frames", async () => {
    const frames = await collectRunFrames(
      composeRealtimeRunStream({
        ledgerEvents: emptyLedgerEvents(),
        submitResult: Promise.resolve(failedResult),
      }),
    );

    expect(projectRunStream(frames)).toEqual({
      status: "failed",
      lastSeq: 0,
      ledgerEvents: [],
      turnStreams: {},
      result: failedResult,
      omittedFrames: [],
    });
  });

  it("maps realtime source and submit transport failures to stream_error", async () => {
    expect(
      await collectRunFrames(
        composeRealtimeRunStream({
          ledgerEvents: Promise.reject(new Error("ledger transport failed")),
          submitResult: new Promise<SubmitResult>(() => undefined),
        }),
      ),
    ).toEqual([
      {
        kind: "stream_error",
        seq: 0,
        reason: "ledger_source_failed: ledger transport failed",
      },
    ]);

    expect(
      await collectRunFrames(
        composeRealtimeRunStream({
          ledgerEvents: emptyLedgerEvents(),
          submitResult: Promise.reject(new Error("submit transport failed")),
        }),
      ),
    ).toEqual([
      {
        kind: "stream_error",
        seq: 0,
        reason: "submit_result_failed: submit transport failed",
      },
    ]);
  });

  it("maps malformed realtime source values to stream_error", async () => {
    async function* malformedLedgerEvents(): AsyncGenerator<LedgerEventRpc> {
      yield { bad: true } as unknown as LedgerEventRpc;
    }

    expect(
      await collectRunFrames(
        composeRealtimeRunStream({
          ledgerEvents: malformedLedgerEvents(),
          submitResult: new Promise<SubmitResult>(() => undefined),
        }),
      ),
    ).toEqual([{ kind: "stream_error", seq: 0, reason: "ledger_source_malformed_frame" }]);
  });

  it("realtime composition only consumes passed sources and never writes ledger facts", async () => {
    const writeLedgerFact = vi.fn();
    const ledgerReady = deferred<LedgerEventRpc>();
    const submitReady = deferred<SubmitResult>();
    async function* ledgerEvents(): AsyncGenerator<LedgerEventRpc> {
      yield await ledgerReady.promise;
    }

    const collecting = collectRunFrames(
      composeRealtimeRunStream({
        ledgerEvents: ledgerEvents(),
        submitResult: submitReady.promise,
      }),
    );

    ledgerReady.resolve(ledgerEvent(11, "agent.run.completed"));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    submitReady.resolve(okResult);

    const frames = await collecting;
    expect(frames).toEqual([
      { kind: "ledger_event", seq: 0, event: ledgerEvent(11, "agent.run.completed") },
      { kind: "submit_result", seq: 1, result: okResult },
    ]);
    expect(writeLedgerFact).not.toHaveBeenCalled();
  });
});
