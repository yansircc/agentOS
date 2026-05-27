import {
  isTurnStreamFrame,
  projectTurnStream,
  type TurnStreamFrame,
  type TurnStreamProjection,
} from "@agent-os/turn-stream";

export interface LedgerEventRpc {
  id: number;
  ts: number;
  kind: string;
  scope: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload: any;
}

export type SubmitResult =
  | {
      readonly ok: true;
      readonly runId: number;
      readonly final: string;
      readonly eventCount: number;
      readonly tokensUsed: number;
    }
  | {
      readonly ok: false;
      readonly runId: number;
      readonly reason: string;
      readonly eventCount: number;
      readonly tokensUsed: number;
    };

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

export interface ComposeRunStreamSpec {
  readonly submit: SubmitResult;
  readonly ledgerEvents: ReadonlyArray<LedgerEventRpc>;
  readonly turnFrames?: ReadonlyArray<TurnStreamFrame>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isFrameBase = (value: Record<string, unknown>): boolean =>
  typeof value.seq === "number" && Number.isInteger(value.seq) && value.seq >= 0;

const isLedgerEventRpc = (value: unknown): value is LedgerEventRpc =>
  isRecord(value) &&
  typeof value.id === "number" &&
  Number.isInteger(value.id) &&
  value.id >= 0 &&
  typeof value.ts === "number" &&
  typeof value.kind === "string" &&
  typeof value.scope === "string" &&
  "payload" in value;

const isSubmitResult = (value: unknown): value is SubmitResult => {
  if (!isRecord(value) || typeof value.runId !== "number") return false;
  if (typeof value.eventCount !== "number" || typeof value.tokensUsed !== "number") return false;
  if (value.ok === true) return typeof value.final === "string";
  if (value.ok === false) return typeof value.reason === "string";
  return false;
};

export const isRunStreamFrame = (value: unknown): value is RunStreamFrame => {
  if (!isRecord(value) || !isFrameBase(value)) return false;
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

export const projectRunStream = (frames: Iterable<unknown>): RunStreamProjection => {
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
