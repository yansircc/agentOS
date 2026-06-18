import { Predicate, Schema } from "effect";
import {
  isTurnStreamFrame,
  projectTurnStream,
  type TurnStreamFrame,
  type TurnStreamProjection,
} from "@agent-os/turn-stream";
import { defineProjectionSpec, project, projectionOutputOrFail } from "@agent-os/kernel/projection";
import { isSymbolicSettlementValue } from "@agent-os/kernel/settlement-contract";
import {
  type EventQueryOptions,
  LedgerEventSchema,
  type LedgerEventRpc,
} from "@agent-os/kernel/types";
import type { SubmitResult, SubmitSpec } from "@agent-os/runtime-protocol";

export type { LedgerEventRpc } from "@agent-os/kernel/types";
export type { SubmitResult, SubmitSpec } from "@agent-os/runtime-protocol";

export interface RunStreamLedgerEventFrame {
  readonly kind: "ledger_event";
  readonly seq: number;
  readonly event: LedgerEventRpc;
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
  readonly ledgerEvents: ReadonlyArray<LedgerEventRpc>;
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
  readonly ledgerEvents: ReadonlyArray<LedgerEventRpc>;
  readonly turnFrames?: ReadonlyArray<TurnStreamFrame>;
}

export interface ComposeBatchedSubmitRunStreamSpec {
  readonly submitSpec: SubmitSpec;
  readonly afterId?: number;
  readonly submit: (spec: SubmitSpec) => Promise<SubmitResult>;
  readonly events: (options?: EventQueryOptions) => Promise<ReadonlyArray<LedgerEventRpc>>;
}

export type RealtimeRunStreamSource<T> =
  | AsyncIterable<T>
  | PromiseLike<AsyncIterable<T> | ReadonlyArray<T>>;

export interface ComposeRealtimeRunStreamSpec {
  readonly ledgerEvents: RealtimeRunStreamSource<LedgerEventRpc>;
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

const isFrameBase = (value: Record<string, unknown>): boolean =>
  typeof value.seq === "number" && Number.isInteger(value.seq) && value.seq >= 0;

const isLedgerEventRpc = Schema.is(LedgerEventSchema);

const isSubmitResult = (value: unknown): value is SubmitResult => {
  if (!Predicate.isRecord(value) || typeof value.runId !== "number") return false;
  if (typeof value.eventCount !== "number" || typeof value.tokensUsed !== "number") return false;
  if (value.ok === true) return value.status === "delivered" && typeof value.final === "string";
  if (value.ok === false && value.status === "failed") return typeof value.reason === "string";
  if (value.ok === false && value.status === "interrupted") {
    return (
      value.reason === "interrupted" &&
      typeof value.interruptId === "string" &&
      typeof value.gateRef === "string" &&
      Predicate.isRecord(value.turn) &&
      typeof value.turn.id === "number" &&
      typeof value.turn.index === "number"
    );
  }
  return false;
};

export const isRunStreamFrame = (value: unknown): value is RunStreamFrame => {
  if (!Predicate.isRecord(value) || !isFrameBase(value)) return false;
  switch (value.kind) {
    case "ledger_event":
      return isLedgerEventRpc(value.event);
    case "turn_frame":
      return isTurnStreamFrame(value.frame);
    case "submit_result":
      return isSubmitResult(value.result);
    case "stream_error":
      return typeof value.reason === "string";
    default:
      return false;
  }
};

const foldRunStream = (frames: Iterable<unknown>): RunStreamProjection => {
  let status: RunStreamStatus = "open";
  let lastSeq = -1;
  let result: SubmitResult | undefined;
  let errorReason: string | undefined;
  const ledgerEvents: LedgerEventRpc[] = [];
  const turnFramesByRef = new Map<string, TurnStreamFrame[]>();
  const omittedFrames: RunStreamOmittedFrame[] = [];

  for (const candidate of frames) {
    if (!isRunStreamFrame(candidate)) {
      omittedFrames.push({ reason: "malformed" });
      continue;
    }
    if (candidate.seq <= lastSeq) {
      omittedFrames.push({ seq: candidate.seq, reason: "duplicate_or_out_of_order" });
      continue;
    }
    if (status !== "open") {
      omittedFrames.push({ seq: candidate.seq, reason: "after_terminal" });
      continue;
    }

    lastSeq = candidate.seq;
    switch (candidate.kind) {
      case "ledger_event":
        ledgerEvents.push(candidate.event);
        break;
      case "turn_frame": {
        const framesForTurn = turnFramesByRef.get(candidate.frame.turnRef) ?? [];
        framesForTurn.push(candidate.frame);
        turnFramesByRef.set(candidate.frame.turnRef, framesForTurn);
        break;
      }
      case "submit_result":
        result = candidate.result;
        status = candidate.result.ok ? "succeeded" : "failed";
        break;
      case "stream_error":
        errorReason = candidate.reason;
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
      { kind: "kernel-ledger-rpc", ref: "@agent-os/kernel/types/LedgerEventRpc" },
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
    return isRunStreamFrame(parsed) ? parsed : null;
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

const maxLedgerEventId = (events: ReadonlyArray<LedgerEventRpc>): number =>
  events.reduce((max, event) => Math.max(max, event.id), 0);

const errorReason = (cause: unknown): string => {
  if (Predicate.isRecord(cause) && cause._tag === "agent_os.provider_http_failure") {
    const provider =
      typeof cause.provider === "string" && isSymbolicSettlementValue(cause.provider)
        ? cause.provider
        : "provider";
    const status = typeof cause.status === "number" ? `http_${cause.status}` : "http_error";
    const flags = Array.isArray(cause.flags)
      ? cause.flags.filter((flag): flag is string => typeof flag === "string").join(":")
      : "";
    return ["provider_http_failure", provider, status, flags].filter(Boolean).join(":");
  }
  if (Predicate.isRecord(cause) && typeof cause.reason === "string") {
    return isSymbolicSettlementValue(cause.reason) ? cause.reason : "object";
  }
  if (Predicate.isRecord(cause) && typeof cause._tag === "string") return cause._tag;
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
    return isLedgerEventRpc(value)
      ? { kind: "ledger_event", seq, event: value }
      : invalidSourceValueReason(source);
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
          if (!isSubmitResult(submitSettled.result)) {
            yield { kind: "stream_error", seq, reason: "submit_result_malformed" };
            return;
          }
          yield { kind: "submit_result", seq, result: submitSettled.result };
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
          if (!isSubmitResult(event.result)) {
            yield { kind: "stream_error", seq, reason: "submit_result_malformed" };
            return;
          }
          yield { kind: "submit_result", seq, result: event.result };
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

/** Batched bridge: submit completes before post-baseline ledger rows are read. */
export const composeBatchedSubmitRunStream = async (
  spec: ComposeBatchedSubmitRunStreamSpec,
): Promise<ReadonlyArray<RunStreamFrame>> => {
  const frames: RunStreamFrame[] = [];
  let seq = 0;

  try {
    const baseline = spec.afterId ?? maxLedgerEventId(await spec.events());
    const result = await spec.submit(spec.submitSpec);
    for (const event of await spec.events({ afterId: baseline })) {
      frames.push({ kind: "ledger_event", seq, event });
      seq += 1;
    }
    frames.push({ kind: "submit_result", seq, result });
  } catch (cause) {
    frames.push({ kind: "stream_error", seq, reason: errorReason(cause) });
  }

  return frames;
};
