import { Predicate } from "effect";
import { defineProjectionSpec, project, projectionOutputOrFail } from "@agent-os/kernel/projection";

export interface TurnTextDeltaFrame {
  readonly kind: "text_delta";
  readonly turnRef: string;
  readonly seq: number;
  readonly text: string;
}

export interface TurnMetadataFrame {
  readonly kind: "metadata";
  readonly turnRef: string;
  readonly seq: number;
  readonly data: unknown;
}

export interface TurnDoneFrame {
  readonly kind: "done";
  readonly turnRef: string;
  readonly seq: number;
}

export interface TurnErrorFrame {
  readonly kind: "error";
  readonly turnRef: string;
  readonly seq: number;
  readonly reason: string;
}

export type TurnStreamFrame =
  | TurnTextDeltaFrame
  | TurnMetadataFrame
  | TurnDoneFrame
  | TurnErrorFrame;

export type TurnStreamStatus = "open" | "done" | "error";

export type TurnStreamOmitReason =
  | "wrong_turn"
  | "duplicate_or_out_of_order"
  | "after_terminal"
  | "malformed";

export interface TurnStreamOmittedFrame {
  readonly seq?: number;
  readonly reason: TurnStreamOmitReason;
}

export interface TurnStreamProjection {
  readonly turnRef: string;
  readonly status: TurnStreamStatus;
  readonly text: string;
  readonly lastSeq: number;
  readonly metadata: ReadonlyArray<TurnMetadataFrame>;
  readonly includedSeqs: ReadonlyArray<number>;
  readonly omittedFrames: ReadonlyArray<TurnStreamOmittedFrame>;
  readonly errorReason?: string;
}

interface TurnStreamProjectionInput {
  readonly frames: Iterable<unknown>;
  readonly turnRef: string;
}

const isFrameBase = (value: Record<string, unknown>): boolean =>
  typeof value.turnRef === "string" &&
  typeof value.seq === "number" &&
  Number.isInteger(value.seq) &&
  value.seq >= 0;

export const isTurnStreamFrame = (value: unknown): value is TurnStreamFrame => {
  if (!Predicate.isRecord(value) || !isFrameBase(value)) return false;
  switch (value.kind) {
    case "text_delta":
      return typeof value.text === "string";
    case "metadata":
      return "data" in value;
    case "done":
      return true;
    case "error":
      return typeof value.reason === "string";
    default:
      return false;
  }
};

const foldTurnStream = (frames: Iterable<unknown>, turnRef: string): TurnStreamProjection => {
  let status: TurnStreamStatus = "open";
  let text = "";
  let lastSeq = -1;
  let errorReason: string | undefined;
  const metadata: TurnMetadataFrame[] = [];
  const includedSeqs: number[] = [];
  const omittedFrames: TurnStreamOmittedFrame[] = [];

  for (const candidate of frames) {
    if (!isTurnStreamFrame(candidate)) {
      omittedFrames.push({ reason: "malformed" });
      continue;
    }
    if (candidate.turnRef !== turnRef) {
      omittedFrames.push({ seq: candidate.seq, reason: "wrong_turn" });
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
    includedSeqs.push(candidate.seq);
    switch (candidate.kind) {
      case "text_delta":
        text += candidate.text;
        break;
      case "metadata":
        metadata.push(candidate);
        break;
      case "done":
        status = "done";
        break;
      case "error":
        status = "error";
        errorReason = candidate.reason;
        break;
    }
  }

  return {
    turnRef,
    status,
    text,
    lastSeq,
    metadata,
    includedSeqs,
    omittedFrames,
    ...(errorReason === undefined ? {} : { errorReason }),
  };
};

const turnStreamProjection = defineProjectionSpec<TurnStreamProjectionInput, TurnStreamProjection>({
  id: "turn-stream.current",
  version: 1,
  source: { kind: "wire-vocabulary", ref: "@agent-os/turn-stream/frames" },
  project: ({ frames, turnRef }, context) => context.ok(foldTurnStream(frames, turnRef)),
});

export const projectTurnStream = (
  frames: Iterable<unknown>,
  turnRef: string,
): TurnStreamProjection =>
  projectionOutputOrFail(project(turnStreamProjection, { frames, turnRef }));

export const encodeTurnStreamSse = (frame: TurnStreamFrame): string =>
  `event: ${frame.kind}\ndata: ${JSON.stringify(frame)}\n\n`;

export const decodeTurnStreamData = (data: string): TurnStreamFrame | null => {
  try {
    const parsed = JSON.parse(data) as unknown;
    return isTurnStreamFrame(parsed) ? parsed : null;
  } catch {
    return null;
  }
};
