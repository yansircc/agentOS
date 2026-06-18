import { Option, Predicate } from "effect";
import {
  isTurnStreamFrame,
  projectTurnStream,
  type TurnStreamFrame,
  type TurnStreamProjection,
} from "@agent-os/turn-stream";
import { defineProjectionSpec, project, projectionOutputOrFail } from "@agent-os/kernel/projection";
import { decodeRecordedLedgerEventOption, type RecordedLedgerEvent } from "@agent-os/kernel/types";
import { decodeSubmitResult, type SubmitResult } from "@agent-os/runtime-protocol";

export { decodeRecordedLedgerEvent as decodeRunStreamRecordedLedgerEvent } from "@agent-os/kernel/types";
export type { SubmitResult } from "@agent-os/runtime-protocol";

export type RunStreamRecordedLedgerEvent = RecordedLedgerEvent;

export interface RunStreamLedgerEventFrame {
  readonly kind: "ledger_event";
  readonly seq: number;
  readonly event: RunStreamRecordedLedgerEvent;
}

export interface RunStreamTurnFrame {
  readonly kind: "turn_frame";
  readonly seq: number;
  readonly frame: TurnStreamFrame;
}

export interface RunStreamSubmitResultFrame {
  readonly kind: "submit_result";
  readonly seq: number;
  readonly result: SubmitResult;
}

export interface RunStreamErrorFrame {
  readonly kind: "stream_error";
  readonly seq: number;
  readonly reason: string;
}

export type RunStreamFrame =
  | RunStreamLedgerEventFrame
  | RunStreamTurnFrame
  | RunStreamSubmitResultFrame
  | RunStreamErrorFrame;

export type RunStreamStatus = "open" | "succeeded" | "failed" | "error";

export interface RunStreamOmittedFrame {
  readonly seq?: number;
  readonly reason: string;
}

export interface RunStreamProjection {
  readonly status: RunStreamStatus;
  readonly lastSeq: number;
  readonly ledgerEvents: ReadonlyArray<RunStreamRecordedLedgerEvent>;
  readonly turnStreams: Readonly<Record<string, TurnStreamProjection>>;
  readonly result?: SubmitResult;
  readonly errorReason?: string;
  readonly omittedFrames: ReadonlyArray<RunStreamOmittedFrame>;
}

interface RunStreamProjectionInput {
  readonly frames: Iterable<unknown>;
}

export interface ComposeRunStreamSpec {
  readonly submit: SubmitResult;
  readonly ledgerEvents: ReadonlyArray<RunStreamRecordedLedgerEvent>;
  readonly turnFrames?: ReadonlyArray<TurnStreamFrame>;
}

export type RealtimeRunStreamSource<T> =
  | AsyncIterable<T>
  | PromiseLike<AsyncIterable<T> | ReadonlyArray<T>>;

export interface ComposeRealtimeRunStreamSpec {
  readonly ledgerEvents: RealtimeRunStreamSource<RunStreamRecordedLedgerEvent>;
  readonly turnFrames?: RealtimeRunStreamSource<TurnStreamFrame>;
  readonly submitResult: PromiseLike<SubmitResult>;
  readonly signal?: AbortSignal;
}

const isPromiseLike = <T>(value: unknown): value is PromiseLike<T> =>
  (typeof value === "object" || typeof value === "function") &&
  value !== null &&
  typeof (value as { readonly then?: unknown }).then === "function";

const isAsyncIterable = <T>(value: unknown): value is AsyncIterable<T> =>
  (typeof value === "object" || typeof value === "function") &&
  value !== null &&
  typeof (value as { readonly [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] ===
    "function";

const frameSeqOf = (value: Record<string, unknown>): number | null => {
  const seq = value.seq;
  return typeof seq === "number" && Number.isInteger(seq) && seq >= 0 ? seq : null;
};

const recordedLedgerEventFromUnknown = (value: unknown): RunStreamRecordedLedgerEvent | null => {
  const decoded = decodeRecordedLedgerEventOption(value);
  return Option.isSome(decoded) ? decoded.value : null;
};

const runStreamFrameFromUnknown = (value: unknown): RunStreamFrame | null => {
  if (!Predicate.isObject(value)) return null;
  const seq = frameSeqOf(value);
  if (seq === null) return null;
  switch (value.kind) {
    case "ledger_event": {
      const event = recordedLedgerEventFromUnknown(value.event);
      return event === null ? null : { kind: "ledger_event", seq, event };
    }
    case "turn_frame":
      return isTurnStreamFrame(value.frame)
        ? { kind: "turn_frame", seq, frame: value.frame }
        : null;
    case "submit_result":
      const result = decodeSubmitResult(value.result);
      return result !== null ? { kind: "submit_result", seq, result } : null;
    case "stream_error":
      return typeof value.reason === "string"
        ? { kind: "stream_error", seq, reason: value.reason }
        : null;
    default:
      return null;
  }
};

export const isRunStreamFrame = (value: unknown): value is RunStreamFrame =>
  runStreamFrameFromUnknown(value) !== null;

const foldRunStream = (frames: Iterable<unknown>): RunStreamProjection => {
  let status: RunStreamStatus = "open";
  let lastSeq = -1;
  let result: SubmitResult | undefined;
  let errorReason: string | undefined;
  const ledgerEvents: RunStreamRecordedLedgerEvent[] = [];
  const turnFramesByRef = new Map<string, TurnStreamFrame[]>();
  const omittedFrames: RunStreamOmittedFrame[] = [];

  for (const candidate of frames) {
    const frame = runStreamFrameFromUnknown(candidate);
    if (frame === null) {
      omittedFrames.push({ reason: "malformed" });
      continue;
    }
    if (frame.seq <= lastSeq) {
      omittedFrames.push({ seq: frame.seq, reason: "duplicate_or_out_of_order" });
      continue;
    }
    if (status !== "open") {
      omittedFrames.push({ seq: frame.seq, reason: "after_terminal" });
      continue;
    }

    lastSeq = frame.seq;
    switch (frame.kind) {
      case "ledger_event":
        ledgerEvents.push(frame.event);
        break;
      case "turn_frame": {
        const framesForTurn = turnFramesByRef.get(frame.frame.turnRef) ?? [];
        framesForTurn.push(frame.frame);
        turnFramesByRef.set(frame.frame.turnRef, framesForTurn);
        break;
      }
      case "submit_result":
        result = frame.result;
        status = frame.result.ok ? "succeeded" : "failed";
        break;
      case "stream_error":
        errorReason = frame.reason;
        status = "error";
        break;
    }
  }

  const turnStreams: Record<string, TurnStreamProjection> = {};
  for (const [turnRef, turnFrames] of turnFramesByRef) {
    turnStreams[turnRef] = projectTurnStream(turnFrames, turnRef);
  }

  return {
    status,
    lastSeq,
    ledgerEvents,
    turnStreams,
    ...(result === undefined ? {} : { result }),
    ...(errorReason === undefined ? {} : { errorReason }),
    omittedFrames,
  };
};

const runStreamProjection = defineProjectionSpec<RunStreamProjectionInput, RunStreamProjection>({
  id: "run-stream.current",
  version: 1,
  source: {
    kind: "source-set",
    ref: "@agent-os/run-stream/projection-sources",
    sources: [
      { kind: "wire-vocabulary", ref: "@agent-os/run-stream/frames" },
      { kind: "wire-vocabulary", ref: "@agent-os/turn-stream/frames" },
      { kind: "runtime-protocol", ref: "@agent-os/runtime-protocol/submit-result" },
      { kind: "kernel-ledger-recorded", ref: "@agent-os/kernel/types/LedgerEvent" },
    ],
  },
  project: ({ frames }, context) => context.ok(foldRunStream(frames)),
});

export const projectRunStream = (frames: Iterable<unknown>): RunStreamProjection =>
  projectionOutputOrFail(project(runStreamProjection, { frames }));

export const encodeRunStreamSse = (frame: RunStreamFrame): string =>
  `event: ${frame.kind}\ndata: ${JSON.stringify(frame)}\n\n`;

export const decodeRunStreamData = (data: string): RunStreamFrame | null => {
  try {
    const parsed = JSON.parse(data) as unknown;
    return runStreamFrameFromUnknown(parsed);
  } catch {
    return null;
  }
};

export const composeRunStream = (spec: ComposeRunStreamSpec): ReadonlyArray<RunStreamFrame> => {
  const frames: RunStreamFrame[] = [];
  let seq = 0;
  for (const event of spec.ledgerEvents) {
    frames.push({ kind: "ledger_event", seq, event });
    seq += 1;
  }
  for (const frame of spec.turnFrames ?? []) {
    frames.push({ kind: "turn_frame", seq, frame });
    seq += 1;
  }
  frames.push({ kind: "submit_result", seq, result: spec.submit });
  return frames;
};

const errorReason = (cause: unknown): string => {
  if (Predicate.isObject(cause) && typeof cause._tag === "string") return cause._tag;
  if (cause instanceof Error) return cause.name;
  return typeof cause;
};

async function* arraySource<T>(items: ReadonlyArray<T>): AsyncGenerator<T> {
  for (const item of items) yield item;
}

type RealtimeSourceName = "ledger" | "turn";

interface RealtimeSourceState {
  readonly name: RealtimeSourceName;
  iterator?: AsyncIterator<unknown>;
  pending: Promise<RealtimeEvent>;
  done: boolean;
}

type RealtimeEvent =
  | {
      readonly kind: "source_ready";
      readonly state: RealtimeSourceState;
      readonly iterator: AsyncIterator<unknown>;
    }
  | {
      readonly kind: "source_next";
      readonly state: RealtimeSourceState;
      readonly result: IteratorResult<unknown>;
    }
  | {
      readonly kind: "source_failed";
      readonly source: RealtimeSourceName;
      readonly cause: unknown;
    }
  | { readonly kind: "submit_result"; readonly result: unknown }
  | { readonly kind: "submit_failed"; readonly cause: unknown }
  | { readonly kind: "abort" };

const resolveRealtimeSource = async <T>(
  source: RealtimeRunStreamSource<T>,
  sourceName: RealtimeSourceName,
): Promise<AsyncIterator<T>> => {
  let resolved: unknown;
  if (isAsyncIterable<T>(source)) {
    resolved = source;
  } else if (isPromiseLike<AsyncIterable<T> | ReadonlyArray<T>>(source)) {
    resolved = await source;
  } else {
    throw new Error(`${sourceName}_source_malformed`);
  }

  if (isAsyncIterable<T>(resolved)) return resolved[Symbol.asyncIterator]();
  if (Array.isArray(resolved)) return arraySource(resolved)[Symbol.asyncIterator]();
  throw new Error(`${sourceName}_source_malformed`);
};

const nextRealtimeEvent = (state: RealtimeSourceState): Promise<RealtimeEvent> => {
  if (state.iterator === undefined) {
    return Promise.resolve({
      kind: "source_failed",
      source: state.name,
      cause: new Error(`${state.name}_source_malformed`),
    });
  }

  return state.iterator.next().then(
    (result): RealtimeEvent => ({ kind: "source_next", state, result }),
    (cause): RealtimeEvent => ({ kind: "source_failed", source: state.name, cause }),
  );
};

const createRealtimeSourceState = <T>(
  name: RealtimeSourceName,
  source: RealtimeRunStreamSource<T>,
): RealtimeSourceState => {
  const state: RealtimeSourceState = {
    name,
    pending: Promise.resolve({ kind: "abort" as const }),
    done: false,
  };
  state.pending = resolveRealtimeSource(source, name).then(
    (iterator): RealtimeEvent => ({ kind: "source_ready", state, iterator }),
    (cause): RealtimeEvent => ({ kind: "source_failed", source: name, cause }),
  );
  return state;
};

const abortEvent = (signal: AbortSignal | undefined): Promise<RealtimeEvent> | undefined => {
  if (signal === undefined) return undefined;
  if (signal.aborted) return Promise.resolve({ kind: "abort" });
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve({ kind: "abort" }), { once: true });
  });
};

const closeRealtimeSources = async (states: ReadonlyArray<RealtimeSourceState>): Promise<void> => {
  for (const state of states) {
    await state.iterator?.return?.();
  }
};

const sourceFailureReason = (source: RealtimeSourceName, cause: unknown): string =>
  `${source}_source_failed: ${errorReason(cause)}`;

const invalidSourceValueReason = (source: RealtimeSourceName): string =>
  `${source}_source_malformed_frame`;

const frameFromRealtimeSource = (
  source: RealtimeSourceName,
  value: unknown,
  seq: number,
): RunStreamFrame | string => {
  if (source === "ledger") {
    const event = recordedLedgerEventFromUnknown(value);
    return event === null ? invalidSourceValueReason(source) : { kind: "ledger_event", seq, event };
  }

  return isTurnStreamFrame(value)
    ? { kind: "turn_frame", seq, frame: value }
    : invalidSourceValueReason(source);
};

/**
 * Realtime run composition semantics:
 * - the composer consumes only caller-provided ledger/turn/submit sources; it
 *   never calls submit(), events(), or any ledger writer.
 * - ordering is arrival order across sources. `seq` is assigned when a source
 *   value wins the race, so ledger frames can precede submit_result.
 * - submit_result is terminal whether ok=true or ok=false; stream_error is
 *   terminal for source rejection, malformed source values, submit promise
 *   rejection, or caller cancellation.
 * - after a terminal frame, source iterators are closed; iterator.return()
 *   failures propagate instead of falling back. There is no realtime-to-batch
 *   fallback.
 */
export async function* composeRealtimeRunStream(
  spec: ComposeRealtimeRunStreamSpec,
): AsyncGenerator<RunStreamFrame> {
  let seq = 0;
  const states: RealtimeSourceState[] = [
    createRealtimeSourceState("ledger", spec.ledgerEvents),
    ...(spec.turnFrames === undefined ? [] : [createRealtimeSourceState("turn", spec.turnFrames)]),
  ];
  const abort = abortEvent(spec.signal);
  let submitSettled: RealtimeEvent | undefined;
  const submitPending: Promise<RealtimeEvent> = Promise.resolve(spec.submitResult).then(
    (result): RealtimeEvent => {
      submitSettled = { kind: "submit_result", result };
      return submitSettled;
    },
    (cause): RealtimeEvent => {
      submitSettled = { kind: "submit_failed", cause };
      return submitSettled;
    },
  );

  try {
    while (true) {
      if (submitSettled !== undefined) {
        if (submitSettled.kind === "submit_result") {
          const result = decodeSubmitResult(submitSettled.result);
          if (result === null) {
            yield { kind: "stream_error", seq, reason: "submit_result_malformed" };
            return;
          }
          yield { kind: "submit_result", seq, result };
          return;
        }
        if (submitSettled.kind === "submit_failed") {
          yield {
            kind: "stream_error",
            seq,
            reason: `submit_result_failed: ${errorReason(submitSettled.cause)}`,
          };
          return;
        }
      }

      const pending: Array<Promise<RealtimeEvent>> = [
        ...states.filter((state) => !state.done).map((state) => state.pending),
        submitPending,
        ...(abort === undefined ? [] : [abort]),
      ];
      const event = await Promise.race(pending);

      switch (event.kind) {
        case "source_ready":
          event.state.iterator = event.iterator;
          event.state.pending = nextRealtimeEvent(event.state);
          break;
        case "source_next": {
          if (event.result.done === true) {
            event.state.done = true;
            break;
          }
          const frame = frameFromRealtimeSource(event.state.name, event.result.value, seq);
          if (typeof frame === "string") {
            yield { kind: "stream_error", seq, reason: frame };
            return;
          }
          yield frame;
          seq += 1;
          event.state.pending = nextRealtimeEvent(event.state);
          break;
        }
        case "source_failed":
          yield {
            kind: "stream_error",
            seq,
            reason: sourceFailureReason(event.source, event.cause),
          };
          return;
        case "submit_result":
          const result = decodeSubmitResult(event.result);
          if (result === null) {
            yield { kind: "stream_error", seq, reason: "submit_result_malformed" };
            return;
          }
          yield { kind: "submit_result", seq, result };
          return;
        case "submit_failed":
          yield {
            kind: "stream_error",
            seq,
            reason: `submit_result_failed: ${errorReason(event.cause)}`,
          };
          return;
        case "abort":
          yield { kind: "stream_error", seq, reason: "stream_aborted" };
          return;
      }
    }
  } finally {
    await closeRealtimeSources(states);
  }
}
