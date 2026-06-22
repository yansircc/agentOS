/**
 * Declares whether an attached stream accepts inbound input or only emits outbound frames.
 * @experimental
 */
export type AttachedStreamMode = "bidi" | "output_only";

/**
 * Folded terminal state for an attached stream outbound frame sequence.
 * @experimental
 */
export type AttachedStreamStatus = "open" | "completed" | "failed" | "cancelled";

/**
 * Reason an outbound frame was excluded from an attached stream projection.
 * @experimental
 */
export type AttachedStreamOmitReason =
  | "malformed"
  | "wrong_stream"
  | "duplicate_or_out_of_order"
  | "duplicate_opened"
  | "after_terminal";

/**
 * Shared identity and sequence fields carried by every attached stream frame.
 * @experimental
 */
export interface AttachedStreamFrameBase {
  readonly streamRef: string;
  readonly seq: number;
}

/**
 * Inbound client payload delivered to a bidirectional attached stream handler.
 * @experimental
 */
export interface AttachedStreamInputFrame extends AttachedStreamFrameBase {
  readonly kind: "input";
  readonly payload: unknown;
}

/**
 * Inbound client cancellation intent for an attached stream.
 * @experimental
 */
export interface AttachedStreamCancelFrame extends AttachedStreamFrameBase {
  readonly kind: "cancel";
  readonly reason?: string;
}

/**
 * Union of inbound frames accepted by the attached stream transport codec.
 * @experimental
 */
export type AttachedStreamInboundFrame = AttachedStreamInputFrame | AttachedStreamCancelFrame;

/**
 * First outbound frame emitted by the server to announce stream identity and mode.
 * @experimental
 */
export interface AttachedStreamOpenedFrame extends AttachedStreamFrameBase {
  readonly kind: "opened";
  readonly mode: AttachedStreamMode;
}

/**
 * Outbound data frame emitted on a named application channel.
 * @experimental
 */
export interface AttachedStreamOutputFrame extends AttachedStreamFrameBase {
  readonly kind: "output";
  readonly channel: string;
  readonly payload: unknown;
}

/**
 * Outbound progress frame for non-terminal stream status updates.
 * @experimental
 */
export interface AttachedStreamProgressFrame extends AttachedStreamFrameBase {
  readonly kind: "progress";
  readonly payload: unknown;
}

/**
 * Outbound acknowledgement that a cancellation intent was ignored by declaration.
 * @experimental
 */
export interface AttachedStreamCancelIgnoredFrame extends AttachedStreamFrameBase {
  readonly kind: "cancel_ignored";
  readonly reason?: string;
}

/**
 * Outbound terminal frame for a completed attached stream.
 * @experimental
 */
export interface AttachedStreamCompletedFrame extends AttachedStreamFrameBase {
  readonly kind: "completed";
  readonly terminal: unknown;
}

/**
 * Outbound terminal frame for a failed attached stream.
 * @experimental
 */
export interface AttachedStreamFailedFrame extends AttachedStreamFrameBase {
  readonly kind: "failed";
  readonly reason: string;
  readonly terminal?: unknown;
}

/**
 * Outbound terminal frame for a cancelled attached stream.
 * @experimental
 */
export interface AttachedStreamCancelledFrame extends AttachedStreamFrameBase {
  readonly kind: "cancelled";
  readonly reason?: string;
  readonly terminal?: unknown;
}

/**
 * Union of outbound frames that close an attached stream projection.
 * @experimental
 */
export type AttachedStreamTerminalFrame =
  | AttachedStreamCompletedFrame
  | AttachedStreamFailedFrame
  | AttachedStreamCancelledFrame;

/**
 * Union of all server-to-client attached stream frames.
 * @experimental
 */
export type AttachedStreamOutboundFrame =
  | AttachedStreamOpenedFrame
  | AttachedStreamOutputFrame
  | AttachedStreamProgressFrame
  | AttachedStreamCancelIgnoredFrame
  | AttachedStreamTerminalFrame;

/**
 * Union of every attached stream frame understood by the JSON text codec.
 * @experimental
 */
export type AttachedStreamFrame = AttachedStreamInboundFrame | AttachedStreamOutboundFrame;

/**
 * Outbound frame payload accepted before substrate assigns stream identity and sequence.
 * @experimental
 */
export type AttachedStreamOutboundBody =
  | Omit<AttachedStreamOpenedFrame, "streamRef" | "seq">
  | Omit<AttachedStreamOutputFrame, "streamRef" | "seq">
  | Omit<AttachedStreamProgressFrame, "streamRef" | "seq">
  | Omit<AttachedStreamCancelIgnoredFrame, "streamRef" | "seq">
  | Omit<AttachedStreamCompletedFrame, "streamRef" | "seq">
  | Omit<AttachedStreamFailedFrame, "streamRef" | "seq">
  | Omit<AttachedStreamCancelledFrame, "streamRef" | "seq">;

/**
 * Projection audit entry for an outbound frame that was not included.
 * @experimental
 */
export interface AttachedStreamOmittedFrame {
  readonly seq?: number;
  readonly reason: AttachedStreamOmitReason;
}

/**
 * Deterministic fold of ordered outbound frames for one stream reference.
 * @experimental
 */
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

/**
 * Checks whether a value is a valid inbound attached stream frame.
 * @experimental
 */
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

/**
 * Checks whether a value is a valid outbound attached stream frame.
 * @experimental
 */
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

/**
 * Checks whether a value is a valid inbound or outbound attached stream frame.
 * @experimental
 */
export const isAttachedStreamFrame = (value: unknown): value is AttachedStreamFrame =>
  isAttachedStreamInboundFrame(value) || isAttachedStreamOutboundFrame(value);

/**
 * Adds stream identity and sequence to an outbound frame body.
 * @experimental
 */
export const attachedStreamOutboundFrame = (
  streamRef: string,
  seq: number,
  body: AttachedStreamOutboundBody,
): AttachedStreamOutboundFrame => ({ ...body, streamRef, seq }) as AttachedStreamOutboundFrame;

/**
 * Checks whether an outbound frame is terminal.
 * @experimental
 */
export const isAttachedStreamTerminalFrame = (
  frame: AttachedStreamOutboundFrame,
): frame is AttachedStreamTerminalFrame =>
  frame.kind === "completed" || frame.kind === "failed" || frame.kind === "cancelled";

/**
 * Folds outbound frames into a stream projection while recording omitted frames.
 * @experimental
 */
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

/**
 * Encodes any attached stream frame as JSON text.
 * @experimental
 */
export const encodeAttachedStreamMessage = (frame: AttachedStreamFrame): string =>
  JSON.stringify(frame);

/**
 * Decodes JSON text into an attached stream frame when it matches the frame algebra.
 * @experimental
 */
export const decodeAttachedStreamMessage = (data: string): AttachedStreamFrame | null => {
  try {
    const parsed = JSON.parse(data) as unknown;
    return isAttachedStreamFrame(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

/**
 * Encodes an outbound attached stream frame as one Server-Sent Events message.
 * @experimental
 */
export const encodeAttachedStreamSse = (frame: AttachedStreamOutboundFrame): string =>
  `event: ${frame.kind}\ndata: ${JSON.stringify(frame)}\n\n`;

/**
 * Decodes JSON text into an outbound attached stream frame when it matches the frame algebra.
 * @experimental
 */
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
