import { Data, Effect, Option, Schema } from "effect";
import {
  LlmOutputItemSchema,
  LlmProviderContinuationMarkerSchema,
  LlmToolCallSchema,
  LlmUsageSchema,
  markerFromProviderContinuation,
  type LlmRecordedResponse,
  type LlmStreamFrame,
} from "@agent-os/core/llm-protocol";
import {
  decodeSubmitResult,
  type SubmitResult,
  type TurnRef,
} from "@agent-os/core/runtime-protocol";

export const SUBMIT_LIVE_MAX_FRAME_BYTES = 65_536;

export type RecordedLlmStreamFrame =
  | Extract<LlmStreamFrame, { readonly kind: "delta" }>
  | {
      readonly sequence: number;
      readonly kind: "terminal";
      readonly response: LlmRecordedResponse;
    };

/**
 * Invocation-coupled live projection. `llm` frames are ephemeral and the final
 * `result` is a projection of the durable run settlement.
 *
 * @public
 */
export type SubmitLiveFrame =
  | {
      readonly kind: "llm";
      readonly turn: TurnRef;
      readonly frame: RecordedLlmStreamFrame;
    }
  | { readonly kind: "result"; readonly result: SubmitResult };

export class SubmitLiveFrameError extends Data.TaggedError("agent_os.submit_live_frame_error")<{
  readonly reason: "encode_failed" | "frame_too_large" | "decode_failed";
  readonly bytes?: number;
}> {}

const textEncoder = new TextEncoder();
const nonNegativeInt = Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)));
const unknownRecord = Schema.Record(Schema.String, Schema.Unknown);
const streamDeltaSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal("text_start"), id: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("text_delta"),
    id: Schema.String,
    text: Schema.String,
  }),
  Schema.Struct({ type: Schema.Literal("text_end"), id: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("reasoning"),
    item: Schema.Struct({
      type: Schema.Literal("reasoning"),
      summaryRef: Schema.optional(Schema.String),
      redacted: Schema.optional(Schema.Literal(true)),
      metadata: Schema.optional(unknownRecord),
    }),
  }),
  Schema.Struct({
    type: Schema.Literal("tool_call"),
    item: Schema.Struct({ type: Schema.Literal("tool_call"), call: LlmToolCallSchema }),
  }),
  Schema.Struct({
    type: Schema.Literal("tool_result"),
    item: Schema.Struct({
      type: Schema.Literal("tool_result"),
      callId: Schema.String,
      name: Schema.optional(Schema.String),
      content: Schema.String,
    }),
  }),
  Schema.Struct({
    type: Schema.Literal("refusal"),
    item: Schema.Struct({ type: Schema.Literal("refusal"), reason: Schema.String }),
  }),
  Schema.Struct({
    type: Schema.Literal("error"),
    item: Schema.Struct({ type: Schema.Literal("error"), message: Schema.String }),
  }),
]);
const recordedResponseSchema = Schema.Struct({
  items: Schema.Array(LlmOutputItemSchema),
  usage: LlmUsageSchema,
  continuationMarker: Schema.optional(LlmProviderContinuationMarkerSchema),
});
const recordedFrameSchema = Schema.Union([
  Schema.Struct({
    sequence: nonNegativeInt,
    kind: Schema.Literal("delta"),
    delta: streamDeltaSchema,
  }),
  Schema.Struct({
    sequence: nonNegativeInt,
    kind: Schema.Literal("terminal"),
    response: recordedResponseSchema,
  }),
]);
const llmEnvelopeSchema = Schema.Struct({
  kind: Schema.Literal("llm"),
  turn: Schema.Struct({ id: Schema.Int, index: nonNegativeInt }),
  frame: recordedFrameSchema,
});

export const recordLlmStreamFrame = (frame: LlmStreamFrame): RecordedLlmStreamFrame =>
  frame.kind === "delta"
    ? frame
    : {
        sequence: frame.sequence,
        kind: "terminal",
        response: {
          items: frame.response.items,
          usage: frame.response.usage,
          ...(frame.response.continuation === undefined
            ? {}
            : {
                continuationMarker:
                  frame.response.continuation.kind === "available"
                    ? markerFromProviderContinuation(frame.response.continuation.value)
                    : frame.response.continuation.marker,
              }),
        },
      };

export const encodeSubmitLiveFrame = (
  frame: SubmitLiveFrame,
): Effect.Effect<string, SubmitLiveFrameError> =>
  Effect.try({
    try: () => JSON.stringify(frame),
    catch: () => new SubmitLiveFrameError({ reason: "encode_failed" }),
  }).pipe(
    Effect.flatMap((json) => {
      const encoded = `data: ${json}\n\n`;
      const bytes = textEncoder.encode(encoded).byteLength;
      return bytes > SUBMIT_LIVE_MAX_FRAME_BYTES
        ? Effect.fail(new SubmitLiveFrameError({ reason: "frame_too_large", bytes }))
        : Effect.succeed(encoded);
    }),
  );

export const decodeSubmitLiveFrame = (value: unknown): SubmitLiveFrame | null => {
  const llm = Schema.decodeUnknownOption(llmEnvelopeSchema)(value);
  if (Option.isSome(llm)) return llm.value as SubmitLiveFrame;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Readonly<Record<string, unknown>>;
  if (record.kind !== "result") return null;
  const result = decodeSubmitResult(record.result);
  return result === null ? null : { kind: "result", result };
};
