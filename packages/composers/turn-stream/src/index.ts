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

type TurnStreamFrameBody =
  | Omit<TurnTextDeltaFrame, "turnRef" | "seq">
  | Omit<TurnMetadataFrame, "turnRef" | "seq">
  | Omit<TurnDoneFrame, "turnRef" | "seq">
  | Omit<TurnErrorFrame, "turnRef" | "seq">;

export interface TurnStreamDeltaAdapterInput<TChunk = unknown> {
  readonly turnRef: string;
  /** Starting sequence number for the frames derived from this provider chunk. */
  readonly seq: number;
  readonly chunk: TChunk;
}

export interface OpenAiCompatibleDeltaChoice {
  readonly delta?: {
    readonly content?: unknown;
  };
  readonly finish_reason?: unknown;
}

export interface OpenAiCompatibleDeltaChunk {
  readonly choices?: ReadonlyArray<OpenAiCompatibleDeltaChoice>;
  readonly usage?: unknown;
  readonly error?: unknown;
}

export interface AnthropicDeltaChunk {
  readonly type?: unknown;
  readonly delta?: {
    readonly type?: unknown;
    readonly text?: unknown;
    readonly stop_reason?: unknown;
  };
  readonly usage?: unknown;
  readonly message?: {
    readonly usage?: unknown;
  };
  readonly error?: unknown;
}

export interface GeminiDeltaChunk {
  readonly candidates?: ReadonlyArray<{
    readonly content?: {
      readonly parts?: ReadonlyArray<{
        readonly text?: unknown;
      }>;
    };
    readonly finishReason?: unknown;
  }>;
  readonly usageMetadata?: unknown;
  readonly error?: unknown;
}

type ProviderDeltaAdapter = "openai_compatible" | "anthropic" | "gemini";

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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const nonEmptyString = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

const errorFrame = (
  turnRef: string,
  seq: number,
  reason: string,
): ReadonlyArray<TurnStreamFrame> => [{ kind: "error", turnRef, seq, reason }];

const providerErrorReason = (provider: ProviderDeltaAdapter): string =>
  `${provider}_provider_error`;

const malformedReason = (provider: ProviderDeltaAdapter): string => `${provider}_malformed_chunk`;

const unknownReason = (provider: ProviderDeltaAdapter): string => `${provider}_unknown_chunk`;

const unsupportedReason = (provider: ProviderDeltaAdapter): string =>
  `${provider}_unsupported_chunk`;

const numericMetadata = (value: unknown): unknown => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (!isRecord(value)) return undefined;

  const sanitized: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    const next = numericMetadata(entry);
    if (next !== undefined) sanitized[key] = next;
  }

  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
};

const appendFrame = (
  frames: TurnStreamFrame[],
  turnRef: string,
  seq: number,
  frame: TurnStreamFrameBody,
): number => {
  frames.push({ ...frame, turnRef, seq } as TurnStreamFrame);
  return seq + 1;
};

const appendUsageMetadata = (
  frames: TurnStreamFrame[],
  turnRef: string,
  seq: number,
  provider: ProviderDeltaAdapter,
  usage: unknown,
): number => {
  const sanitized = numericMetadata(usage);
  if (sanitized === undefined) return seq;
  return appendFrame(frames, turnRef, seq, {
    kind: "metadata",
    data: { provider, usage: sanitized },
  });
};

const appendFinishMetadata = (
  frames: TurnStreamFrame[],
  turnRef: string,
  seq: number,
  provider: ProviderDeltaAdapter,
  finishReason: unknown,
): number => {
  const reason = nonEmptyString(finishReason);
  if (reason === null) return seq;
  return appendFrame(frames, turnRef, seq, {
    kind: "metadata",
    data: { provider, finishReason: reason },
  });
};

const isFrameBase = (value: Record<string, unknown>): boolean =>
  typeof value.turnRef === "string" &&
  typeof value.seq === "number" &&
  Number.isInteger(value.seq) &&
  value.seq >= 0;

export const isTurnStreamFrame = (value: unknown): value is TurnStreamFrame => {
  if (!isRecord(value) || !isFrameBase(value)) return false;
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

/**
 * Provider delta adapter semantics:
 * - adapters are structural; they do not import provider SDK types or preserve
 *   raw provider bodies.
 * - one provider chunk may produce zero or more TurnStreamFrame values, with
 *   sequence numbers assigned from `seq` in emitted order.
 * - unknown/malformed/unsupported chunks emit a terminal error frame with a
 *   package-owned reason string and no raw provider body.
 * - metadata frames contain only curated numeric usage or string finish reason.
 * - terminal frames are transport-level terminals: OpenAI-compatible `[DONE]`,
 *   Anthropic `message_stop`, Gemini `finishReason`, or provider error chunks.
 * - named provider no-ops are the only empty output: OpenAI-compatible role or
 *   empty text deltas, Anthropic ping/message-start/content-block boundary
 *   events, and Gemini empty text parts.
 */
export const adaptOpenAiCompatibleDeltaChunk = (
  input: TurnStreamDeltaAdapterInput<unknown>,
): ReadonlyArray<TurnStreamFrame> => {
  const provider: ProviderDeltaAdapter = "openai_compatible";
  if (input.chunk === "[DONE]") {
    return [{ kind: "done", turnRef: input.turnRef, seq: input.seq }];
  }
  if (!isRecord(input.chunk)) {
    return errorFrame(input.turnRef, input.seq, malformedReason(provider));
  }

  if ("error" in input.chunk) {
    return errorFrame(input.turnRef, input.seq, providerErrorReason(provider));
  }
  if ("choices" in input.chunk && !Array.isArray(input.chunk.choices)) {
    return errorFrame(input.turnRef, input.seq, malformedReason(provider));
  }

  const frames: TurnStreamFrame[] = [];
  let seq = input.seq;
  let recognized = false;
  const choices = Array.isArray(input.chunk.choices) ? input.chunk.choices : undefined;
  if (choices !== undefined) recognized = true;
  if ("usage" in input.chunk) recognized = true;

  if (choices !== undefined && choices.length === 0 && !("usage" in input.chunk)) {
    return errorFrame(input.turnRef, input.seq, unknownReason(provider));
  }

  for (const choice of choices ?? []) {
    let choiceRecognized = false;
    if (!isRecord(choice)) {
      return errorFrame(input.turnRef, input.seq, malformedReason(provider));
    }

    if ("delta" in choice) {
      if (!isRecord(choice.delta)) {
        return errorFrame(input.turnRef, input.seq, malformedReason(provider));
      }
      const allowedDeltaKeys = new Set(["content", "role"]);
      for (const key of Object.keys(choice.delta)) {
        if (!allowedDeltaKeys.has(key)) {
          return errorFrame(input.turnRef, input.seq, unsupportedReason(provider));
        }
      }

      if ("content" in choice.delta) {
        if (typeof choice.delta.content !== "string") {
          return errorFrame(input.turnRef, input.seq, malformedReason(provider));
        }
        choiceRecognized = true;
        if (choice.delta.content.length > 0) {
          seq = appendFrame(frames, input.turnRef, seq, {
            kind: "text_delta",
            text: choice.delta.content,
          });
        }
      }

      if ("role" in choice.delta) {
        if (typeof choice.delta.role !== "string") {
          return errorFrame(input.turnRef, input.seq, malformedReason(provider));
        }
        choiceRecognized = true;
      }

      if (Object.keys(choice.delta).length === 0) {
        choiceRecognized = true;
      }
    }

    if ("finish_reason" in choice) {
      if (choice.finish_reason !== null && typeof choice.finish_reason !== "string") {
        return errorFrame(input.turnRef, input.seq, malformedReason(provider));
      }
      choiceRecognized = true;
      seq = appendFinishMetadata(
        frames,
        input.turnRef,
        seq,
        "openai_compatible",
        choice.finish_reason,
      );
    }

    if (!choiceRecognized) {
      return errorFrame(input.turnRef, input.seq, unknownReason(provider));
    }
  }
  seq = appendUsageMetadata(frames, input.turnRef, seq, "openai_compatible", input.chunk.usage);

  if (!recognized) {
    return errorFrame(input.turnRef, input.seq, unknownReason(provider));
  }

  return frames;
};

export const adaptAnthropicDeltaChunk = (
  input: TurnStreamDeltaAdapterInput<unknown>,
): ReadonlyArray<TurnStreamFrame> => {
  const provider: ProviderDeltaAdapter = "anthropic";
  if (!isRecord(input.chunk)) {
    return errorFrame(input.turnRef, input.seq, malformedReason(provider));
  }

  if ("error" in input.chunk || input.chunk.type === "error") {
    return errorFrame(input.turnRef, input.seq, providerErrorReason(provider));
  }

  const frames: TurnStreamFrame[] = [];
  let seq = input.seq;
  switch (input.chunk.type) {
    case "ping":
    case "content_block_start":
    case "content_block_stop":
      break;
    case "message_start": {
      const usage = isRecord(input.chunk.message) ? input.chunk.message.usage : undefined;
      seq = appendUsageMetadata(frames, input.turnRef, seq, "anthropic", usage);
      break;
    }
    case "content_block_delta": {
      if (!isRecord(input.chunk.delta)) {
        return errorFrame(input.turnRef, input.seq, malformedReason(provider));
      }
      if (input.chunk.delta.type !== undefined && input.chunk.delta.type !== "text_delta") {
        return errorFrame(input.turnRef, input.seq, unsupportedReason(provider));
      }
      if (typeof input.chunk.delta.text !== "string") {
        return errorFrame(input.turnRef, input.seq, malformedReason(provider));
      }
      if (input.chunk.delta.text.length > 0) {
        seq = appendFrame(frames, input.turnRef, seq, {
          kind: "text_delta",
          text: input.chunk.delta.text,
        });
      }
      break;
    }
    case "message_delta": {
      if (input.chunk.delta !== undefined && !isRecord(input.chunk.delta)) {
        return errorFrame(input.turnRef, input.seq, malformedReason(provider));
      }
      seq = appendUsageMetadata(frames, input.turnRef, seq, "anthropic", input.chunk.usage);
      if (isRecord(input.chunk.delta)) {
        seq = appendFinishMetadata(
          frames,
          input.turnRef,
          seq,
          "anthropic",
          input.chunk.delta.stop_reason,
        );
      }
      break;
    }
    case "message_stop":
      seq = appendFrame(frames, input.turnRef, seq, { kind: "done" });
      break;
    default:
      return errorFrame(input.turnRef, input.seq, unknownReason(provider));
  }

  return frames;
};

export const adaptGeminiDeltaChunk = (
  input: TurnStreamDeltaAdapterInput<unknown>,
): ReadonlyArray<TurnStreamFrame> => {
  const provider: ProviderDeltaAdapter = "gemini";
  if (!isRecord(input.chunk)) {
    return errorFrame(input.turnRef, input.seq, malformedReason(provider));
  }

  if ("error" in input.chunk) {
    return errorFrame(input.turnRef, input.seq, providerErrorReason(provider));
  }
  if ("candidates" in input.chunk && !Array.isArray(input.chunk.candidates)) {
    return errorFrame(input.turnRef, input.seq, malformedReason(provider));
  }

  const frames: TurnStreamFrame[] = [];
  let seq = input.seq;
  let recognized = "usageMetadata" in input.chunk;
  let terminal = false;
  const candidates = Array.isArray(input.chunk.candidates) ? input.chunk.candidates : undefined;
  if (candidates !== undefined) recognized = true;
  if (candidates !== undefined && candidates.length === 0 && !("usageMetadata" in input.chunk)) {
    return errorFrame(input.turnRef, input.seq, unknownReason(provider));
  }

  for (const candidate of candidates ?? []) {
    if (!isRecord(candidate)) {
      return errorFrame(input.turnRef, input.seq, malformedReason(provider));
    }
    const content = candidate.content;
    if (content !== undefined && !isRecord(content)) {
      return errorFrame(input.turnRef, input.seq, malformedReason(provider));
    }
    const parts = content === undefined ? [] : content.parts;
    if (parts !== undefined && !Array.isArray(parts)) {
      return errorFrame(input.turnRef, input.seq, malformedReason(provider));
    }
    for (const part of parts ?? []) {
      if (!isRecord(part)) {
        return errorFrame(input.turnRef, input.seq, malformedReason(provider));
      }
      const allowedPartKeys = new Set(["text"]);
      for (const key of Object.keys(part)) {
        if (!allowedPartKeys.has(key)) {
          return errorFrame(input.turnRef, input.seq, unsupportedReason(provider));
        }
      }
      if (!("text" in part)) {
        return errorFrame(input.turnRef, input.seq, malformedReason(provider));
      }
      if (typeof part.text !== "string") {
        return errorFrame(input.turnRef, input.seq, malformedReason(provider));
      }
      const text = nonEmptyString(part.text);
      if (text !== null) {
        seq = appendFrame(frames, input.turnRef, seq, { kind: "text_delta", text });
      }
    }
    if (candidate.finishReason !== undefined && typeof candidate.finishReason !== "string") {
      return errorFrame(input.turnRef, input.seq, malformedReason(provider));
    }
    if (nonEmptyString(candidate.finishReason) !== null) {
      terminal = true;
      seq = appendFinishMetadata(frames, input.turnRef, seq, "gemini", candidate.finishReason);
    }
  }
  seq = appendUsageMetadata(frames, input.turnRef, seq, "gemini", input.chunk.usageMetadata);
  if (terminal) {
    appendFrame(frames, input.turnRef, seq, { kind: "done" });
  }

  if (!recognized) {
    return errorFrame(input.turnRef, input.seq, unknownReason(provider));
  }

  return frames;
};

export const projectTurnStream = (
  frames: Iterable<unknown>,
  turnRef: string,
): TurnStreamProjection => {
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
