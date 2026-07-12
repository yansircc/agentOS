import { Context, Effect, Option, Schema, Stream } from "effect";
import type { Effect as EffectType } from "effect";
import type { Stream as StreamType } from "effect";
import type { AgentSchema } from "@agent-os/core/agent-schema";
import { UpstreamFailure } from "@agent-os/core/errors";
import type { MaterialRef } from "@agent-os/core/material-ref";
import type {
  MaterialResolutionReceipt,
  MaterialResolutionRequest,
  RefResolutionFailed,
} from "@agent-os/core/ref-resolver";
import type { ToolDefinition } from "@agent-os/core/tools";
export * from "./provider-continuation";
import { markerFromProviderContinuation } from "./provider-continuation";
import type {
  LlmProviderContinuation,
  LlmProviderContinuationCallContext,
  LlmProviderContinuationMarker,
} from "./provider-continuation";

export const LLM_WIRE_DESCRIPTOR_VERSION = "llm-wire-descriptor-v1";
export const LLM_CALL_SNAPSHOT_VERSION = "llm-call-snapshot-v1";

export type LlmJsonSchemaObject = AgentSchema<unknown>["jsonSchema"];

export interface LlmRoute {
  readonly endpointRef?: string;
  readonly credentialRef?: string;
  readonly [key: string]: unknown;
}

export interface LlmWireDescriptor {
  readonly method: "POST";
  readonly url: string;
  readonly headers: ReadonlyArray<readonly [name: string, value: string]>;
  readonly bodySchema?: LlmJsonSchemaObject;
}

export interface LlmCallOptions {
  readonly signal?: AbortSignal;
}

export interface LlmTransportRouteDescriptor {
  readonly wireDescriptor: LlmWireDescriptor;
  readonly providerOutputAdapterId: string;
  readonly providerOutputAdapterVersion: string;
  readonly transportAdapterId: string;
  readonly transportAdapterVersion: string;
}

/**
 * Provider-neutral port for resolving and calling an LLM route.
 *
 * @agentosPrimitive primitive.llm_protocol.LlmTransport
 * @agentosInvariant invariant.boundary.runtime-validation-external-only
 * @agentosDocs docs/packages/core.md
 * @public
 */
export class LlmTransport extends Context.Service<
  LlmTransport,
  {
    readonly resolveRoute: (
      route: LlmRoute,
    ) => EffectType.Effect<LlmTransportRouteDescriptor, UpstreamFailure>;
    readonly stream: (
      request: LlmRequest,
      options?: LlmCallOptions,
    ) => StreamType.Stream<LlmStreamFrame, UpstreamFailure>;
  }
>()("@agent-os/LlmTransport") {}

export const llmRouteMaterialRefs = (route: LlmRoute): ReadonlyArray<MaterialRef> => [
  ...(typeof route.endpointRef === "string"
    ? [{ kind: "endpoint" as const, ref: route.endpointRef }]
    : []),
  ...(typeof route.credentialRef === "string"
    ? [{ kind: "credential" as const, ref: route.credentialRef }]
    : []),
];

export const llmRouteFingerprint = (route: LlmRoute): string =>
  `llm-route-v1:${JSON.stringify(canonicalize(route))}`;

const unknownRecord = Schema.Record(Schema.String, Schema.Unknown);
const nonNegativeInt = Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)));

export interface LlmToolCall {
  readonly id: string;
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly arguments: string;
  };
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface LlmMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string | null;
  readonly tool_calls?: ReadonlyArray<LlmToolCall>;
  readonly tool_call_id?: string;
  readonly name?: string;
  readonly continuation?: LlmProviderContinuation;
}

export interface LlmUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}

export const LlmUsageSchema: Schema.Decoder<LlmUsage> = Schema.Struct({
  promptTokens: nonNegativeInt,
  completionTokens: nonNegativeInt,
  totalTokens: nonNegativeInt,
});

export const LlmToolCallSchema: Schema.Decoder<LlmToolCall> = Schema.Struct({
  id: Schema.String,
  type: Schema.Literal("function"),
  function: Schema.Struct({
    name: Schema.String,
    arguments: Schema.String,
  }),
  metadata: Schema.optional(unknownRecord),
});

export const STRUCTURED_OUTPUT_TOOL_NAME = "_submit_structured";

export type LlmOutputItem =
  | { readonly type: "message"; readonly text: string }
  | {
      readonly type: "reasoning";
      readonly summaryRef?: string;
      readonly redacted?: true;
      readonly metadata?: Readonly<Record<string, unknown>>;
    }
  | { readonly type: "tool_call"; readonly call: LlmToolCall }
  | {
      readonly type: "tool_result";
      readonly callId: string;
      readonly name?: string;
      readonly content: string;
    }
  | { readonly type: "refusal"; readonly reason: string }
  | { readonly type: "error"; readonly message: string };

export const LlmOutputItemSchema: Schema.Decoder<LlmOutputItem> = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("message"),
    text: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("reasoning"),
    summaryRef: Schema.optional(Schema.String),
    redacted: Schema.optional(Schema.Literal(true)),
    metadata: Schema.optional(unknownRecord),
  }),
  Schema.Struct({
    type: Schema.Literal("tool_call"),
    call: LlmToolCallSchema,
  }),
  Schema.Struct({
    type: Schema.Literal("tool_result"),
    callId: Schema.String,
    name: Schema.optional(Schema.String),
    content: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("refusal"),
    reason: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("error"),
    message: Schema.String,
  }),
]);

export type LlmResponseContinuation =
  | {
      readonly kind: "available";
      readonly value: LlmProviderContinuation;
    }
  | {
      readonly kind: "recorded";
      readonly marker: LlmProviderContinuationMarker;
    };

export interface LlmResponse {
  readonly items: ReadonlyArray<LlmOutputItem>;
  readonly usage: LlmUsage;
  readonly continuation?: LlmResponseContinuation;
}

/**
 * Provider-neutral live projection emitted before the terminal response.
 * Provider-native stream parts never cross this boundary.
 *
 * @public
 */
export type LlmStreamDelta =
  | { readonly type: "text_start"; readonly id: string }
  | { readonly type: "text_delta"; readonly id: string; readonly text: string }
  | { readonly type: "text_end"; readonly id: string }
  | {
      readonly type: "reasoning";
      readonly item: Extract<LlmOutputItem, { readonly type: "reasoning" }>;
    }
  | {
      readonly type: "tool_call";
      readonly item: Extract<LlmOutputItem, { readonly type: "tool_call" }>;
    }
  | {
      readonly type: "tool_result";
      readonly item: Extract<LlmOutputItem, { readonly type: "tool_result" }>;
    }
  | {
      readonly type: "refusal";
      readonly item: Extract<LlmOutputItem, { readonly type: "refusal" }>;
    }
  | {
      readonly type: "error";
      readonly item: Extract<LlmOutputItem, { readonly type: "error" }>;
    };

/**
 * Ordered output for one provider invocation. Exactly one terminal frame must
 * end the stream; deltas are ephemeral projections and never durable truth.
 *
 * @public
 */
export type LlmStreamFrame =
  | {
      readonly sequence: number;
      readonly kind: "delta";
      readonly delta: LlmStreamDelta;
    }
  | {
      readonly sequence: number;
      readonly kind: "terminal";
      readonly response: LlmResponse;
    };

const llmResponseShape = Schema.Struct({
  items: Schema.Array(LlmOutputItemSchema),
  usage: LlmUsageSchema,
});

const hasValidResponseShape = (value: unknown): value is Pick<LlmResponse, "items" | "usage"> =>
  Option.isSome(Schema.decodeUnknownOption(llmResponseShape)(value));

const llmStreamFailure = (reason: string, detail?: unknown): UpstreamFailure =>
  new UpstreamFailure({ cause: { reason, ...(detail === undefined ? {} : { detail }) } });

/** Builds an ordered ephemeral delta frame. @public */
export const llmStreamDeltaFrame = (sequence: number, delta: LlmStreamDelta): LlmStreamFrame => ({
  sequence,
  kind: "delta",
  delta,
});

/**
 * Positively validates the terminal consumer shape before constructing the
 * sole terminal frame for an invocation.
 *
 * @public
 */
export const llmStreamTerminalFrame = (
  sequence: number,
  response: LlmResponse,
): Effect.Effect<LlmStreamFrame, UpstreamFailure> =>
  hasValidResponseShape(response)
    ? Effect.succeed({ sequence, kind: "terminal", response })
    : Effect.fail(llmStreamFailure("llm_stream_terminal_decode_failed"));

/** Projects a complete fixture response through the same public frame algebra. @public */
export const llmStreamFramesFromResponse = (
  response: LlmResponse,
): Effect.Effect<ReadonlyArray<LlmStreamFrame>, UpstreamFailure> =>
  Effect.gen(function* () {
    const frames: LlmStreamFrame[] = [];
    let sequence = 0;
    let textIndex = 0;
    for (const item of response.items) {
      if (item.type === "message") {
        const id = `text-${textIndex++}`;
        frames.push(llmStreamDeltaFrame(sequence++, { type: "text_start", id }));
        if (item.text.length > 0) {
          frames.push(llmStreamDeltaFrame(sequence++, { type: "text_delta", id, text: item.text }));
        }
        frames.push(llmStreamDeltaFrame(sequence++, { type: "text_end", id }));
        continue;
      }
      if (item.type === "reasoning") {
        frames.push(llmStreamDeltaFrame(sequence++, { type: "reasoning", item }));
      } else if (item.type === "tool_call") {
        frames.push(llmStreamDeltaFrame(sequence++, { type: "tool_call", item }));
      } else if (item.type === "tool_result") {
        frames.push(llmStreamDeltaFrame(sequence++, { type: "tool_result", item }));
      } else if (item.type === "refusal") {
        frames.push(llmStreamDeltaFrame(sequence++, { type: "refusal", item }));
      } else {
        frames.push(llmStreamDeltaFrame(sequence++, { type: "error", item }));
      }
    }
    frames.push(yield* llmStreamTerminalFrame(sequence, response));
    return frames;
  });

/** Lifts a terminal fixture/interpreter effect into the sole stream algebra. @public */
export const llmStreamFromResponse = (
  response: Effect.Effect<LlmResponse, UpstreamFailure>,
): StreamType.Stream<LlmStreamFrame, UpstreamFailure> =>
  Stream.fromIterableEffect(response.pipe(Effect.flatMap(llmStreamFramesFromResponse)));

/**
 * Folds the sole stream primitive for terminal-only consumers. Sequence gaps,
 * duplicate terminals, post-terminal frames, and close-before-terminal fail
 * closed instead of producing a partial response.
 *
 * @public
 */
export const drainLlmStream = (
  stream: StreamType.Stream<LlmStreamFrame, UpstreamFailure>,
  onFrame?: (frame: LlmStreamFrame) => Effect.Effect<void, UpstreamFailure>,
): Effect.Effect<LlmResponse, UpstreamFailure> =>
  Stream.runFoldEffect(
    stream,
    (): { readonly expectedSequence: number; readonly terminal: LlmResponse | undefined } => ({
      expectedSequence: 0,
      terminal: undefined,
    }),
    (state, frame) => {
      if (frame.sequence !== state.expectedSequence) {
        return Effect.fail(
          llmStreamFailure("llm_stream_sequence_gap", {
            expected: state.expectedSequence,
            actual: frame.sequence,
          }),
        );
      }
      if (state.terminal !== undefined) {
        return Effect.fail(llmStreamFailure("llm_stream_frame_after_terminal"));
      }
      if (frame.kind === "delta") {
        return (onFrame?.(frame) ?? Effect.void).pipe(
          Effect.as({
            expectedSequence: state.expectedSequence + 1,
            terminal: undefined,
          }),
        );
      }
      if (!hasValidResponseShape(frame.response)) {
        return Effect.fail(llmStreamFailure("llm_stream_terminal_decode_failed"));
      }
      return (onFrame?.(frame) ?? Effect.void).pipe(
        Effect.as({
          expectedSequence: state.expectedSequence + 1,
          terminal: frame.response,
        }),
      );
    },
  ).pipe(
    Effect.flatMap((state) =>
      state.terminal === undefined
        ? Effect.fail(llmStreamFailure("llm_stream_closed_without_terminal"))
        : Effect.succeed(state.terminal),
    ),
    Effect.withSpan("agentos.llm_transport.drain_stream"),
  );

export interface LlmSnapshotToolDefinition {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: LlmJsonSchemaObject;
  };
}

export interface LlmSnapshotRequest {
  readonly messages: ReadonlyArray<LlmMessage>;
  readonly tools?: ReadonlyArray<LlmSnapshotToolDefinition>;
  readonly traceContext?: unknown;
  readonly tool_choice?: LlmToolChoice;
}

export interface LlmCallSnapshot {
  readonly kind: "llm.call";
  readonly wireDescriptor: LlmWireDescriptor;
  readonly wireDescriptorFingerprint: string;
  readonly request: LlmSnapshotRequest;
  readonly requestFingerprint: string;
  readonly response: LlmRecordedResponse;
}

export interface LlmRecordedResponse {
  readonly items: ReadonlyArray<LlmOutputItem>;
  readonly usage: LlmUsage;
  readonly continuationMarker?: LlmProviderContinuationMarker;
}

export const llmSnapshotToolDefinitionFromToolDefinition = (
  tool: ToolDefinition,
): LlmSnapshotToolDefinition => ({
  type: "function",
  function: {
    name: tool.function.name,
    description: tool.function.description,
    parameters: projectAgentSchemaForLlmTool(tool.function.parameters),
  },
});

export const llmSnapshotRequestFromRequest = (request: LlmRequest): LlmSnapshotRequest => ({
  messages: request.messages.map(({ continuation: _continuation, ...message }) => message),
  ...(request.tools === undefined
    ? {}
    : { tools: request.tools.map(llmSnapshotToolDefinitionFromToolDefinition) }),
  ...(request.traceContext === undefined ? {} : { traceContext: request.traceContext }),
  ...(request.tool_choice === undefined ? {} : { tool_choice: request.tool_choice }),
});

export const canonicalLlmSnapshotRequestJson = (request: LlmSnapshotRequest): string =>
  JSON.stringify(canonicalize(request));

export const llmSnapshotRequestFingerprint = (request: LlmSnapshotRequest): string =>
  `${LLM_CALL_SNAPSHOT_VERSION}:request:${canonicalLlmSnapshotRequestJson(request)}`;

export const llmCallSnapshotFromResponse = (spec: {
  readonly wireDescriptor: LlmWireDescriptor;
  readonly request: LlmRequest;
  readonly response: LlmResponse;
}): LlmCallSnapshot => {
  const snapshotRequest = llmSnapshotRequestFromRequest(spec.request);
  return {
    kind: "llm.call",
    wireDescriptor: canonicalizeWireDescriptor(spec.wireDescriptor),
    wireDescriptorFingerprint: llmWireDescriptorFingerprint(spec.wireDescriptor),
    request: snapshotRequest,
    requestFingerprint: llmSnapshotRequestFingerprint(snapshotRequest),
    response: {
      items: spec.response.items,
      usage: spec.response.usage,
      ...(spec.response.continuation === undefined
        ? {}
        : {
            continuationMarker:
              spec.response.continuation.kind === "available"
                ? markerFromProviderContinuation(spec.response.continuation.value)
                : spec.response.continuation.marker,
          }),
    },
  };
};

export const replayLlmResponseFromSnapshot = (snapshot: LlmCallSnapshot): LlmResponse => ({
  items: snapshot.response.items,
  usage: snapshot.response.usage,
  ...(snapshot.response.continuationMarker === undefined
    ? {}
    : {
        continuation: {
          kind: "recorded" as const,
          marker: snapshot.response.continuationMarker,
        },
      }),
});

export const textFromLlmOutputItems = (items: ReadonlyArray<LlmOutputItem>): string =>
  items
    .filter(
      (item): item is Extract<LlmOutputItem, { readonly type: "message" }> =>
        item.type === "message",
    )
    .map((item) => item.text)
    .join("");

export const toolCallsFromLlmOutputItems = (
  items: ReadonlyArray<LlmOutputItem>,
): ReadonlyArray<LlmToolCall> =>
  items
    .filter(
      (item): item is Extract<LlmOutputItem, { readonly type: "tool_call" }> =>
        item.type === "tool_call",
    )
    .map((item) => item.call);

export const llmOutputItemsFromTextAndToolCalls = (
  text: string,
  toolCalls: ReadonlyArray<LlmToolCall>,
): ReadonlyArray<LlmOutputItem> => [
  ...(text.length === 0 ? [] : [{ type: "message" as const, text }]),
  ...toolCalls.map((call) => ({ type: "tool_call" as const, call })),
];

export interface LlmRequest {
  readonly route: LlmRoute;
  readonly messages: ReadonlyArray<LlmMessage>;
  readonly tools?: ReadonlyArray<ToolDefinition>;
  readonly traceContext?: unknown;
  readonly tool_choice?: LlmToolChoice;
  /** Runtime-only provider continuation identity; excluded from provider and snapshot projections. */
  readonly continuationContext?: LlmProviderContinuationCallContext;
  /** Runtime-only resolution context; excluded from provider and snapshot projections. */
  readonly materialResolution?: Omit<MaterialResolutionRequest, "materialRef"> & {
    readonly expectedVersions?: Readonly<Record<string, string>>;
    readonly onResolved?: (
      receipt: MaterialResolutionReceipt,
    ) => EffectType.Effect<void, RefResolutionFailed>;
  };
}

export type LlmToolChoice =
  | "required"
  | {
      readonly type: "function";
      readonly function: { readonly name: string };
    };

export const projectAgentSchemaForLlmTool = (schema: AgentSchema<unknown>): LlmJsonSchemaObject =>
  schema.projections.canonical;

const canonicalizeWireDescriptor = (descriptor: LlmWireDescriptor): LlmWireDescriptor => ({
  ...descriptor,
  headers: [...descriptor.headers]
    .map(([name, value]) => [name.toLowerCase(), value] as const)
    .sort(
      ([leftName, leftValue], [rightName, rightValue]) =>
        leftName.localeCompare(rightName) || leftValue.localeCompare(rightValue),
    ),
});

export const canonicalLlmWireDescriptorJson = (descriptor: LlmWireDescriptor): string =>
  JSON.stringify(canonicalize(canonicalizeWireDescriptor(descriptor)));

export const llmWireDescriptorFingerprint = (descriptor: LlmWireDescriptor): string =>
  `${LLM_WIRE_DESCRIPTOR_VERSION}:${canonicalLlmWireDescriptorJson(descriptor)}`;

const canonicalize = (node: unknown): unknown => {
  if (node === null || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map((item) => canonicalize(item));
  const obj = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) out[key] = canonicalize(obj[key]);
  return out;
};
