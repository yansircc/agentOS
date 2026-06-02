export type AttachedStreamMode = "bidi" | "output_only";

export type AttachedStreamStatus = "open" | "completed" | "failed" | "cancelled";

export type AttachedStreamOmitReason =
  | "malformed"
  | "wrong_stream"
  | "duplicate_or_out_of_order"
  | "duplicate_opened"
  | "after_terminal";

export interface AttachedStreamFrameBase {
  readonly streamRef: string;
  readonly seq: number;
}

export interface AttachedStreamInputFrame extends AttachedStreamFrameBase {
  readonly kind: "input";
  readonly payload: unknown;
}

export interface AttachedStreamCancelFrame extends AttachedStreamFrameBase {
  readonly kind: "cancel";
  readonly reason?: string;
}

export type AttachedStreamInboundFrame = AttachedStreamInputFrame | AttachedStreamCancelFrame;

export interface AttachedStreamOpenedFrame extends AttachedStreamFrameBase {
  readonly kind: "opened";
  readonly mode: AttachedStreamMode;
}

export interface AttachedStreamOutputFrame extends AttachedStreamFrameBase {
  readonly kind: "output";
  readonly channel: string;
  readonly payload: unknown;
}

export interface AttachedStreamProgressFrame extends AttachedStreamFrameBase {
  readonly kind: "progress";
  readonly payload: unknown;
}

export interface AttachedStreamCancelIgnoredFrame extends AttachedStreamFrameBase {
  readonly kind: "cancel_ignored";
  readonly reason?: string;
}

export interface AttachedStreamCompletedFrame extends AttachedStreamFrameBase {
  readonly kind: "completed";
  readonly terminal: unknown;
}

export interface AttachedStreamFailedFrame extends AttachedStreamFrameBase {
  readonly kind: "failed";
  readonly reason: string;
  readonly terminal?: unknown;
}

export interface AttachedStreamCancelledFrame extends AttachedStreamFrameBase {
  readonly kind: "cancelled";
  readonly reason?: string;
  readonly terminal?: unknown;
}

export type AttachedStreamTerminalFrame =
  | AttachedStreamCompletedFrame
  | AttachedStreamFailedFrame
  | AttachedStreamCancelledFrame;

export type AttachedStreamOutboundFrame =
  | AttachedStreamOpenedFrame
  | AttachedStreamOutputFrame
  | AttachedStreamProgressFrame
  | AttachedStreamCancelIgnoredFrame
  | AttachedStreamTerminalFrame;

export type AttachedStreamFrame = AttachedStreamInboundFrame | AttachedStreamOutboundFrame;

export type AttachedStreamOutboundBody =
  | Omit<AttachedStreamOpenedFrame, "streamRef" | "seq">
  | Omit<AttachedStreamOutputFrame, "streamRef" | "seq">
  | Omit<AttachedStreamProgressFrame, "streamRef" | "seq">
  | Omit<AttachedStreamCancelIgnoredFrame, "streamRef" | "seq">
  | Omit<AttachedStreamCompletedFrame, "streamRef" | "seq">
  | Omit<AttachedStreamFailedFrame, "streamRef" | "seq">
  | Omit<AttachedStreamCancelledFrame, "streamRef" | "seq">;

export interface AttachedStreamOmittedFrame {
  readonly seq?: number;
  readonly reason: AttachedStreamOmitReason;
}

export interface AttachedStreamProjection {
  readonly streamRef: string;
  readonly status: AttachedStreamStatus;
  readonly lastSeq: number;
  readonly opened?: AttachedStreamOpenedFrame;
  readonly outputs: ReadonlyArray<AttachedStreamOutputFrame>;
  readonly progress: ReadonlyArray<AttachedStreamProgressFrame>;
  readonly cancelIgnored: ReadonlyArray<AttachedStreamCancelIgnoredFrame>;
  readonly terminal?: AttachedStreamTerminalFrame;
  readonly includedSeqs: ReadonlyArray<number>;
  readonly omittedFrames: ReadonlyArray<AttachedStreamOmittedFrame>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isFrameBase = (value: Record<string, unknown>): boolean =>
  typeof value.streamRef === "string" &&
  value.streamRef.length > 0 &&
  typeof value.seq === "number" &&
  Number.isInteger(value.seq) &&
  value.seq >= 0;

const optionalString = (value: unknown): boolean =>
  value === undefined || typeof value === "string";

export const isAttachedStreamInboundFrame = (
  value: unknown,
): value is AttachedStreamInboundFrame => {
  if (!isRecord(value) || !isFrameBase(value)) return false;
  switch (value.kind) {
    case "input":
      return "payload" in value;
    case "cancel":
      return optionalString(value.reason);
    default:
      return false;
  }
};

export const isAttachedStreamOutboundFrame = (
  value: unknown,
): value is AttachedStreamOutboundFrame => {
  if (!isRecord(value) || !isFrameBase(value)) return false;
  switch (value.kind) {
    case "opened":
      return value.mode === "bidi" || value.mode === "output_only";
    case "output":
      return typeof value.channel === "string" && value.channel.length > 0 && "payload" in value;
    case "progress":
      return "payload" in value;
    case "cancel_ignored":
      return optionalString(value.reason);
    case "completed":
      return "terminal" in value;
    case "failed":
      return typeof value.reason === "string";
    case "cancelled":
      return optionalString(value.reason);
    default:
      return false;
  }
};

export const isAttachedStreamFrame = (value: unknown): value is AttachedStreamFrame =>
  isAttachedStreamInboundFrame(value) || isAttachedStreamOutboundFrame(value);

export const attachedStreamOutboundFrame = (
  streamRef: string,
  seq: number,
  body: AttachedStreamOutboundBody,
): AttachedStreamOutboundFrame => ({ ...body, streamRef, seq }) as AttachedStreamOutboundFrame;

export const isAttachedStreamTerminalFrame = (
  frame: AttachedStreamOutboundFrame,
): frame is AttachedStreamTerminalFrame =>
  frame.kind === "completed" || frame.kind === "failed" || frame.kind === "cancelled";

export const projectAttachedStream = (
  frames: Iterable<unknown>,
  streamRef: string,
): AttachedStreamProjection => {
  let status: AttachedStreamStatus = "open";
  let lastSeq = -1;
  let opened: AttachedStreamOpenedFrame | undefined;
  let terminal: AttachedStreamTerminalFrame | undefined;
  const outputs: AttachedStreamOutputFrame[] = [];
  const progress: AttachedStreamProgressFrame[] = [];
  const cancelIgnored: AttachedStreamCancelIgnoredFrame[] = [];
  const includedSeqs: number[] = [];
  const omittedFrames: AttachedStreamOmittedFrame[] = [];

  for (const candidate of frames) {
    if (!isAttachedStreamOutboundFrame(candidate)) {
      omittedFrames.push({ reason: "malformed" });
      continue;
    }
    if (candidate.streamRef !== streamRef) {
      omittedFrames.push({ seq: candidate.seq, reason: "wrong_stream" });
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
    if (candidate.kind === "opened" && opened !== undefined) {
      omittedFrames.push({ seq: candidate.seq, reason: "duplicate_opened" });
      continue;
    }

    lastSeq = candidate.seq;
    includedSeqs.push(candidate.seq);
    switch (candidate.kind) {
      case "opened":
        opened = candidate;
        break;
      case "output":
        outputs.push(candidate);
        break;
      case "progress":
        progress.push(candidate);
        break;
      case "cancel_ignored":
        cancelIgnored.push(candidate);
        break;
      case "completed":
        terminal = candidate;
        status = "completed";
        break;
      case "failed":
        terminal = candidate;
        status = "failed";
        break;
      case "cancelled":
        terminal = candidate;
        status = "cancelled";
        break;
    }
  }

  return {
    streamRef,
    status,
    lastSeq,
    ...(opened === undefined ? {} : { opened }),
    outputs,
    progress,
    cancelIgnored,
    ...(terminal === undefined ? {} : { terminal }),
    includedSeqs,
    omittedFrames,
  };
};

export const encodeAttachedStreamMessage = (frame: AttachedStreamFrame): string =>
  JSON.stringify(frame);

export const decodeAttachedStreamMessage = (data: string): AttachedStreamFrame | null => {
  try {
    const parsed = JSON.parse(data) as unknown;
    return isAttachedStreamFrame(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

export const encodeAttachedStreamSse = (frame: AttachedStreamOutboundFrame): string =>
  `event: ${frame.kind}\ndata: ${JSON.stringify(frame)}\n\n`;

export const decodeAttachedStreamOutboundMessage = (
  data: string,
): AttachedStreamOutboundFrame | null => {
  try {
    const parsed = JSON.parse(data) as unknown;
    return isAttachedStreamOutboundFrame(parsed) ? parsed : null;
  } catch {
    return null;
  }
};
