import { Schema } from "effect";
import {
  scopeRefKey,
  type AuthorityRef,
  type FactOwnerRef,
  type ScopeRef,
} from "@agent-os/kernel/effect-claim";
import type { Tool } from "@agent-os/kernel/tools";
import { decodeLedgerEvent, type LedgerEvent } from "@agent-os/kernel/types";
import type { SubmitSpec } from "@agent-os/runtime-protocol";
import { isRuntimeAbortEventKind } from "@agent-os/runtime-protocol";
import {
  decodeRuntimeLedgerEvent,
  RUNTIME_EVENT_KIND,
  type RuntimeLedgerEvent,
  type RuntimeLedgerEventByKind,
} from "@agent-os/runtime-protocol";

export const AG_UI_WIRE_COMPATIBILITY = {
  core: "@ag-ui/core@0.0.55",
  client: "@ag-ui/client@0.0.55",
} as const;

export type AgUiEventType =
  | "RUN_STARTED"
  | "RUN_FINISHED"
  | "RUN_ERROR"
  | "TEXT_MESSAGE_START"
  | "TEXT_MESSAGE_CONTENT"
  | "TEXT_MESSAGE_END"
  | "TOOL_CALL_START"
  | "TOOL_CALL_ARGS"
  | "TOOL_CALL_END"
  | "TOOL_CALL_RESULT"
  | "REASONING_START"
  | "REASONING_MESSAGE_START"
  | "REASONING_MESSAGE_CONTENT"
  | "REASONING_MESSAGE_END"
  | "REASONING_END"
  | "CUSTOM";

type BaseAgUiFrame<T extends AgUiEventType> = {
  readonly type: T;
  readonly timestamp?: number;
};

export type AgUiMessageRole =
  | "developer"
  | "system"
  | "assistant"
  | "user"
  | "tool"
  | "reasoning"
  | "activity";

export type AgUiMessage = {
  readonly id: string;
  readonly role: AgUiMessageRole;
  readonly content?: string;
  readonly name?: string;
};

export type AgUiContext = {
  readonly description: string;
  readonly value: string;
};

export type AgUiTool = {
  readonly name: string;
  readonly description: string;
  readonly parameters?: unknown;
  readonly metadata?: Readonly<Record<string, unknown>>;
};

export type AgUiRunAgentInput = {
  readonly threadId: string;
  readonly runId: string;
  readonly parentRunId?: string;
  readonly state?: unknown;
  readonly messages: ReadonlyArray<AgUiMessage>;
  readonly tools?: ReadonlyArray<AgUiTool>;
  readonly context?: ReadonlyArray<AgUiContext>;
  readonly forwardedProps?: Readonly<Record<string, unknown>>;
  readonly resume?: ReadonlyArray<{
    readonly interruptId: string;
    readonly status: "resolved" | "cancelled";
    readonly payload?: unknown;
  }>;
};

const unknownRecord = Schema.Record({ key: Schema.String, value: Schema.Unknown });

export const AgUiMessageRoleSchema: Schema.Schema<AgUiMessageRole> = Schema.Literal(
  "developer",
  "system",
  "assistant",
  "user",
  "tool",
  "reasoning",
  "activity",
);

export const AgUiMessageSchema: Schema.Schema<AgUiMessage> = Schema.Struct({
  id: Schema.String,
  role: AgUiMessageRoleSchema,
  content: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
});

export const AgUiContextSchema: Schema.Schema<AgUiContext> = Schema.Struct({
  description: Schema.String,
  value: Schema.String,
});

export const AgUiToolSchema: Schema.Schema<AgUiTool> = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  parameters: Schema.optional(Schema.Unknown),
  metadata: Schema.optional(unknownRecord),
});

export const AgUiResumeEntrySchema: Schema.Schema<
  AgUiRunAgentInput["resume"] extends ReadonlyArray<infer Entry> | undefined ? Entry : never
> = Schema.Struct({
  interruptId: Schema.String,
  status: Schema.Literal("resolved", "cancelled"),
  payload: Schema.optional(Schema.Unknown),
});

export const AgUiRunAgentInputSchema: Schema.Schema<AgUiRunAgentInput> = Schema.Struct({
  threadId: Schema.String,
  runId: Schema.String,
  parentRunId: Schema.optional(Schema.String),
  state: Schema.optional(Schema.Unknown),
  messages: Schema.Array(AgUiMessageSchema),
  tools: Schema.optional(Schema.Array(AgUiToolSchema)),
  context: Schema.optional(Schema.Array(AgUiContextSchema)),
  forwardedProps: Schema.optional(unknownRecord),
  resume: Schema.optional(Schema.Array(AgUiResumeEntrySchema)),
});

export const decodeAgUiRunAgentInput = Schema.decodeUnknownSync(AgUiRunAgentInputSchema);

export type AgUiRunStartedFrame = BaseAgUiFrame<"RUN_STARTED"> & {
  readonly threadId: string;
  readonly runId: string;
  readonly parentRunId?: string;
  readonly input?: AgUiRunAgentInput;
};

export type AgUiRunFinishedFrame = BaseAgUiFrame<"RUN_FINISHED"> & {
  readonly threadId: string;
  readonly runId: string;
  readonly result?: unknown;
  readonly outcome?: { readonly type: "success" };
};

export type AgUiRunErrorFrame = BaseAgUiFrame<"RUN_ERROR"> & {
  readonly threadId?: string;
  readonly runId?: string;
  readonly message: string;
  readonly code?: string;
};

export type AgUiTextMessageStartFrame = BaseAgUiFrame<"TEXT_MESSAGE_START"> & {
  readonly messageId: string;
  readonly role: "assistant";
};

export type AgUiTextMessageContentFrame = BaseAgUiFrame<"TEXT_MESSAGE_CONTENT"> & {
  readonly messageId: string;
  readonly delta: string;
};

export type AgUiTextMessageEndFrame = BaseAgUiFrame<"TEXT_MESSAGE_END"> & {
  readonly messageId: string;
};

export type AgUiToolCallStartFrame = BaseAgUiFrame<"TOOL_CALL_START"> & {
  readonly toolCallId: string;
  readonly toolCallName: string;
  readonly parentMessageId?: string;
};

export type AgUiToolCallArgsFrame = BaseAgUiFrame<"TOOL_CALL_ARGS"> & {
  readonly toolCallId: string;
  readonly delta: string;
};

export type AgUiToolCallEndFrame = BaseAgUiFrame<"TOOL_CALL_END"> & {
  readonly toolCallId: string;
};

export type AgUiToolCallResultFrame = BaseAgUiFrame<"TOOL_CALL_RESULT"> & {
  readonly messageId: string;
  readonly toolCallId: string;
  readonly content: string;
  readonly role?: "tool";
};

export type AgUiReasoningFrame =
  | (BaseAgUiFrame<"REASONING_START"> & { readonly messageId: string })
  | (BaseAgUiFrame<"REASONING_MESSAGE_START"> & { readonly messageId: string })
  | (BaseAgUiFrame<"REASONING_MESSAGE_CONTENT"> & {
      readonly messageId: string;
      readonly delta: string;
    })
  | (BaseAgUiFrame<"REASONING_MESSAGE_END"> & { readonly messageId: string })
  | (BaseAgUiFrame<"REASONING_END"> & { readonly messageId: string });

export type AgUiCustomFrame = BaseAgUiFrame<"CUSTOM"> & {
  readonly name: string;
  readonly value: unknown;
};

export type AgUiFrame =
  | AgUiRunStartedFrame
  | AgUiRunFinishedFrame
  | AgUiRunErrorFrame
  | AgUiTextMessageStartFrame
  | AgUiTextMessageContentFrame
  | AgUiTextMessageEndFrame
  | AgUiToolCallStartFrame
  | AgUiToolCallArgsFrame
  | AgUiToolCallEndFrame
  | AgUiToolCallResultFrame
  | AgUiReasoningFrame
  | AgUiCustomFrame;

export type AgUiRuntimeProjectionSpec = {
  readonly threadId?: string;
  readonly parentRunId?: string;
  readonly includeRunInput?: boolean;
  readonly inputForRun?: (
    event: RuntimeLedgerEventByKind<"agent.run.started">,
  ) => AgUiRunAgentInput;
};

export type AgUiLedgerProjectionSpec = AgUiRuntimeProjectionSpec & {
  readonly projectExtensionEvent?: (event: LedgerEvent) => ReadonlyArray<AgUiCustomFrame>;
};

export type AgUiSubmitDefaults = Omit<SubmitSpec, "intent" | "context"> & {
  readonly system?: string;
  readonly context?: Record<string, unknown>;
  readonly forwardedPropAllowlist?: ReadonlyArray<string>;
};

export type AgUiFrameProjection = {
  readonly runId: string | null;
  readonly threadId: string | null;
  readonly status: "idle" | "running" | "interrupted" | "completed" | "aborted";
  readonly text: string;
  readonly textMessages: ReadonlyArray<{
    readonly messageId: string;
    readonly role: "assistant";
    readonly text: string;
  }>;
  readonly toolCalls: ReadonlyArray<{
    readonly toolCallId: string;
    readonly name: string;
    readonly args: string;
    readonly result: string | null;
  }>;
  readonly custom: ReadonlyArray<AgUiCustomFrame>;
};

export type AgUiFrameStore = {
  readonly getSnapshot: () => AgUiFrameProjection;
  readonly getFrames: () => ReadonlyArray<AgUiFrame>;
  readonly subscribe: (listener: () => void) => () => void;
  readonly append: (frame: AgUiFrame) => void;
  readonly appendMany: (frames: Iterable<AgUiFrame>) => void;
  readonly reset: (frames?: Iterable<AgUiFrame>) => void;
};

export type AgUiFrameMapper = (
  frame: AgUiFrame,
  event: LedgerEvent,
) => AgUiFrame | null | undefined;

export type AgUiLedgerEnvelopeProjectionSpec = AgUiLedgerProjectionSpec & {
  readonly mapFrame?: AgUiFrameMapper;
};

export type AgUiLedgerEventEnvelope = {
  readonly id: number;
  readonly ts: number;
  readonly kind: string;
  readonly scopeRef: ScopeRef;
  readonly scopeKey: string;
  readonly factOwnerRef: FactOwnerRef;
  readonly effectAuthorityRef: AuthorityRef;
  readonly agUiFrames: ReadonlyArray<AgUiFrame>;
};

export type AgUiLedgerEnvelopeFrame = {
  readonly eventId: number;
  readonly eventTs: number;
  readonly eventKind: string;
  readonly eventScopeRef: ScopeRef;
  readonly eventScopeKey: string;
  readonly frame: AgUiFrame;
};

export type AgUiActivity =
  | {
      readonly kind: "run";
      readonly id: string;
      readonly status: "started" | "finished" | "error";
      readonly runId?: string;
      readonly threadId?: string;
      readonly at?: number;
      readonly message?: string;
      readonly code?: string;
      readonly result?: unknown;
    }
  | {
      readonly kind: "message";
      readonly id: string;
      readonly role: "assistant";
      readonly text: string;
      readonly startedAt?: number;
      readonly updatedAt?: number;
      readonly endedAt?: number;
    }
  | {
      readonly kind: "reasoning";
      readonly id: string;
      readonly text: string;
      readonly startedAt?: number;
      readonly updatedAt?: number;
      readonly endedAt?: number;
    }
  | {
      readonly kind: "tool_call";
      readonly id: string;
      readonly toolCallId: string;
      readonly name: string;
      readonly args: string;
      readonly result: string | null;
      readonly status: "running" | "completed";
      readonly startedAt?: number;
      readonly updatedAt?: number;
      readonly completedAt?: number;
    }
  | {
      readonly kind: "custom";
      readonly id: string;
      readonly name: string;
      readonly value: unknown;
      readonly at?: number;
    };

const threadIdFor = (event: RuntimeLedgerEvent, spec: AgUiRuntimeProjectionSpec): string =>
  spec.threadId ?? scopeRefKey(event.scopeRef);

const messageIdFor = (runId: number, turnIndex: number, ordinal: number): string =>
  `agent-os:run:${runId}:turn:${turnIndex}:message:${ordinal}`;

const reasoningIdFor = (runId: number, turnIndex: number, ordinal: number): string =>
  `agent-os:run:${runId}:turn:${turnIndex}:reasoning:${ordinal}`;

const toolResultMessageIdFor = (runId: number, toolCallId: string): string =>
  `agent-os:run:${runId}:tool-result:${toolCallId}`;

const stringifyWireValue = (value: unknown): string => {
  if (typeof value === "string") return value;
  const encoded = JSON.stringify(value);
  return encoded === undefined ? String(value) : encoded;
};

const latestUserText = (messages: ReadonlyArray<AgUiMessage>): string => {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role === "user" && typeof message.content === "string") {
      return message.content;
    }
  }
  return "";
};

const selectedForwardedProps = (
  input: AgUiRunAgentInput,
  allowlist: ReadonlyArray<string> | undefined,
): Record<string, unknown> => {
  if (allowlist === undefined || allowlist.length === 0 || input.forwardedProps === undefined) {
    return {};
  }
  const selected: Record<string, unknown> = {};
  for (const key of allowlist) {
    if (Object.hasOwn(input.forwardedProps, key)) {
      selected[key] = input.forwardedProps[key];
    }
  }
  return selected;
};

export const agUiRunAgentInputToSubmitSpec = (
  input: AgUiRunAgentInput,
  defaults: AgUiSubmitDefaults,
): SubmitSpec => {
  const forwardedProps = selectedForwardedProps(input, defaults.forwardedPropAllowlist);
  return {
    route: defaults.route,
    tools: defaults.tools,
    ...(defaults.system === undefined ? {} : { system: defaults.system }),
    ...(defaults.budget === undefined ? {} : { budget: defaults.budget }),
    ...(defaults.outputSchema === undefined ? {} : { outputSchema: defaults.outputSchema }),
    ...(defaults.traceContext === undefined ? {} : { traceContext: defaults.traceContext }),
    effectAuthorityRef: defaults.effectAuthorityRef,
    intent: latestUserText(input.messages),
    context: {
      ...defaults.context,
      agUi: {
        threadId: input.threadId,
        clientRunId: input.runId,
        parentRunId: input.parentRunId,
        messages: input.messages,
        context: input.context ?? [],
        state: input.state,
        clientToolNames: (input.tools ?? []).map((tool) => tool.name),
        forwardedProps,
        resume: input.resume ?? [],
      },
    },
  };
};

export const projectToolToAgUiTool = (tool: Tool): AgUiTool => ({
  name: tool.definition.function.name,
  description: tool.definition.function.description,
  parameters: tool.definition.function.parameters.projections.canonical,
});

export const projectToolsToAgUiTools = (
  tools: Readonly<Record<string, Tool>>,
): ReadonlyArray<AgUiTool> =>
  Object.values(tools)
    .map(projectToolToAgUiTool)
    .sort((left, right) => left.name.localeCompare(right.name));

const projectLlmResponse = (
  event: RuntimeLedgerEventByKind<"llm.response">,
): ReadonlyArray<AgUiFrame> => {
  const frames: AgUiFrame[] = [];
  let messageOrdinal = 0;
  let reasoningOrdinal = 0;
  for (const item of event.payload.items) {
    if (item.type === "message") {
      const messageId = messageIdFor(
        event.payload.turn.id,
        event.payload.turn.index,
        messageOrdinal,
      );
      messageOrdinal += 1;
      frames.push(
        {
          type: "TEXT_MESSAGE_START",
          timestamp: event.ts,
          messageId,
          role: "assistant",
        },
        {
          type: "TEXT_MESSAGE_CONTENT",
          timestamp: event.ts,
          messageId,
          delta: item.text,
        },
        {
          type: "TEXT_MESSAGE_END",
          timestamp: event.ts,
          messageId,
        },
      );
      continue;
    }

    if (item.type === "tool_call") {
      frames.push(
        {
          type: "TOOL_CALL_START",
          timestamp: event.ts,
          toolCallId: item.call.id,
          toolCallName: item.call.function.name,
        },
        {
          type: "TOOL_CALL_ARGS",
          timestamp: event.ts,
          toolCallId: item.call.id,
          delta: item.call.function.arguments,
        },
        {
          type: "TOOL_CALL_END",
          timestamp: event.ts,
          toolCallId: item.call.id,
        },
      );
      continue;
    }

    if (item.type === "tool_result") {
      frames.push({
        type: "TOOL_CALL_RESULT",
        timestamp: event.ts,
        messageId: toolResultMessageIdFor(event.payload.turn.id, item.callId),
        toolCallId: item.callId,
        content: item.content,
        role: "tool",
      });
      continue;
    }

    if (item.type === "reasoning") {
      const messageId = reasoningIdFor(
        event.payload.turn.id,
        event.payload.turn.index,
        reasoningOrdinal,
      );
      reasoningOrdinal += 1;
      const summary = item.summaryRef === undefined ? "[redacted reasoning]" : item.summaryRef;
      frames.push(
        { type: "REASONING_START", timestamp: event.ts, messageId },
        { type: "REASONING_MESSAGE_START", timestamp: event.ts, messageId },
        {
          type: "REASONING_MESSAGE_CONTENT",
          timestamp: event.ts,
          messageId,
          delta: summary,
        },
        { type: "REASONING_MESSAGE_END", timestamp: event.ts, messageId },
        { type: "REASONING_END", timestamp: event.ts, messageId },
      );
      continue;
    }

    if (item.type === "refusal" || item.type === "error") {
      frames.push({
        type: "CUSTOM",
        timestamp: event.ts,
        name: `agent-os.llm.${item.type}`,
        value:
          item.type === "refusal"
            ? {
                runId: event.payload.turn.id,
                turnIndex: event.payload.turn.index,
                reason: item.reason,
              }
            : {
                runId: event.payload.turn.id,
                turnIndex: event.payload.turn.index,
                message: item.message,
              },
      });
    }
  }

  frames.push({
    type: "CUSTOM",
    timestamp: event.ts,
    name: "agent-os.llm.usage",
    value: {
      runId: event.payload.turn.id,
      turnIndex: event.payload.turn.index,
      usage: event.payload.usage,
    },
  });
  return frames;
};

export const projectRuntimeEventToAgUiFrames = (
  event: RuntimeLedgerEvent,
  spec: AgUiRuntimeProjectionSpec = {},
): ReadonlyArray<AgUiFrame> => {
  switch (event.kind) {
    case RUNTIME_EVENT_KIND.AGENT_RUN_STARTED: {
      const input = spec.inputForRun?.(event);
      return [
        {
          type: "RUN_STARTED",
          timestamp: event.ts,
          threadId: threadIdFor(event, spec),
          runId: String(event.id),
          ...(spec.parentRunId === undefined ? {} : { parentRunId: spec.parentRunId }),
          ...(spec.includeRunInput === true && input !== undefined ? { input } : {}),
        },
      ];
    }
    case RUNTIME_EVENT_KIND.CHAT_INGESTED:
      return [
        {
          type: "CUSTOM",
          timestamp: event.ts,
          name: "agent-os.chat.ingested",
          value: {
            runId: event.payload.runId,
            intent: event.payload.intent,
          },
        },
      ];
    case RUNTIME_EVENT_KIND.AGENT_RUN_INTERRUPTED:
      return [
        {
          type: "CUSTOM",
          timestamp: event.ts,
          name: "agent-os.run.interrupted",
          value: {
            runId: event.payload.runId,
            turn: event.payload.turn,
            interruptId: event.payload.interruptId,
            reason: event.payload.reason,
            resumeSchema: event.payload.resumeSchema,
            tokensUsed: event.payload.tokensUsed,
          },
        },
      ];
    case RUNTIME_EVENT_KIND.AGENT_RUN_RESUMED:
      return [
        {
          type: "CUSTOM",
          timestamp: event.ts,
          name: "agent-os.run.resumed",
          value: {
            runId: event.payload.runId,
            turn: event.payload.turn,
            interruptId: event.payload.interruptId,
            resumedAtEventId: event.payload.resumedAtEventId,
          },
        },
      ];
    case RUNTIME_EVENT_KIND.LLM_RESPONSE:
      return projectLlmResponse(event);
    case RUNTIME_EVENT_KIND.TOOL_EXECUTED:
      return [
        {
          type: "TOOL_CALL_RESULT",
          timestamp: event.ts,
          messageId: toolResultMessageIdFor(event.payload.runId, event.payload.toolCallId),
          toolCallId: event.payload.toolCallId,
          content: stringifyWireValue(event.payload.result),
          role: "tool",
        },
      ];
    case RUNTIME_EVENT_KIND.TOOL_REJECTED:
      return [
        {
          type: "RUN_ERROR",
          timestamp: event.ts,
          threadId: threadIdFor(event, spec),
          runId: String(event.payload.runId),
          message: `tool rejected: ${event.payload.name}`,
          code: "tool.rejected",
        },
      ];
    case RUNTIME_EVENT_KIND.AGENT_RUN_COMPLETED:
      return [
        {
          type: "RUN_FINISHED",
          timestamp: event.ts,
          threadId: threadIdFor(event, spec),
          runId: String(event.payload.runId),
          result: {
            final: event.payload.final,
            output: event.payload.output,
            outputKind: event.payload.outputKind,
            tokensUsed: event.payload.tokensUsed,
          },
          outcome: { type: "success" },
        },
      ];
    default:
      if (isRuntimeAbortEventKind(event.kind)) {
        return [
          {
            type: "RUN_ERROR",
            timestamp: event.ts,
            threadId: threadIdFor(event, spec),
            runId: String(event.payload.runId),
            message: event.kind,
            code: event.kind,
          },
        ];
      }
      return [];
  }
};

export const projectLedgerEventsToAgUiFrames = (
  events: ReadonlyArray<LedgerEvent>,
  spec: AgUiLedgerProjectionSpec = {},
): ReadonlyArray<AgUiFrame> => {
  const frames: AgUiFrame[] = [];
  for (const event of [...events].sort((left, right) => left.id - right.id)) {
    const decoded = decodeRuntimeLedgerEvent(event);
    if (decoded._tag === "runtime") {
      frames.push(...projectRuntimeEventToAgUiFrames(decoded.event, spec));
      continue;
    }
    frames.push(...(spec.projectExtensionEvent?.(decoded.event) ?? []));
  }
  return frames;
};

export const redactAgUiToolPayloadFrame = (
  frame: AgUiFrame,
  replacement = "[redacted]",
): AgUiFrame => {
  if (frame.type === "TOOL_CALL_ARGS") return { ...frame, delta: replacement };
  if (frame.type === "TOOL_CALL_RESULT") return { ...frame, content: replacement };
  return frame;
};

const mapEnvelopeFrames = (
  event: LedgerEvent,
  frames: ReadonlyArray<AgUiFrame>,
  mapFrame: AgUiFrameMapper | undefined,
): ReadonlyArray<AgUiFrame> => {
  if (mapFrame === undefined) return frames;
  const mapped: AgUiFrame[] = [];
  for (const frame of frames) {
    const next = mapFrame(frame, event);
    if (next !== null && next !== undefined) mapped.push(next);
  }
  return mapped;
};

/**
 * Projects one typed ledger event into a browser-safe AG-UI envelope.
 *
 * @agentosPrimitive primitive.ag-ui.projectLedgerEventToAgUiEnvelope
 * @agentosInvariant invariant.algebra.single-code-source
 * @agentosDocs docs/concepts/ag-ui-wire-adapter.md
 * @public
 */
export const projectLedgerEventToAgUiEnvelope = (
  event: LedgerEvent,
  spec: AgUiLedgerEnvelopeProjectionSpec = {},
): AgUiLedgerEventEnvelope => {
  const agUiFrames = projectLedgerEventsToAgUiFrames([event], spec);
  return {
    id: event.id,
    ts: event.ts,
    kind: event.kind,
    scopeRef: event.scopeRef,
    scopeKey: scopeRefKey(event.scopeRef),
    factOwnerRef: event.factOwnerRef,
    effectAuthorityRef: event.effectAuthorityRef,
    agUiFrames: mapEnvelopeFrames(event, agUiFrames, spec.mapFrame),
  };
};

export const decodeLedgerEventToAgUiEnvelope = (
  value: unknown,
  spec: AgUiLedgerEnvelopeProjectionSpec = {},
): AgUiLedgerEventEnvelope => projectLedgerEventToAgUiEnvelope(decodeLedgerEvent(value), spec);

export const projectLedgerEventsToAgUiEnvelopes = (
  events: ReadonlyArray<LedgerEvent>,
  spec: AgUiLedgerEnvelopeProjectionSpec = {},
): ReadonlyArray<AgUiLedgerEventEnvelope> =>
  [...events]
    .sort((left, right) => left.id - right.id)
    .map((event) => projectLedgerEventToAgUiEnvelope(event, spec));

export const framesForAgUiLedgerEnvelope = (
  envelope: AgUiLedgerEventEnvelope,
): ReadonlyArray<AgUiLedgerEnvelopeFrame> =>
  envelope.agUiFrames.map((frame) => ({
    eventId: envelope.id,
    eventTs: envelope.ts,
    eventKind: envelope.kind,
    eventScopeRef: envelope.scopeRef,
    eventScopeKey: envelope.scopeKey,
    frame,
  }));

export const framesForAgUiLedgerEnvelopes = (
  envelopes: ReadonlyArray<AgUiLedgerEventEnvelope>,
): ReadonlyArray<AgUiLedgerEnvelopeFrame> => envelopes.flatMap(framesForAgUiLedgerEnvelope);

const encodeSseData = (value: unknown): string =>
  JSON.stringify(value)
    .split(/\r?\n/)
    .map((line) => `data: ${line}`)
    .join("\n");

export const encodeAgUiLedgerEventEnvelopeSse = (
  envelope: AgUiLedgerEventEnvelope,
  eventName = "ag_ui",
): string => `event: ${eventName}\n${encodeSseData(envelope)}\n\n`;

type ParsedSseBlock = {
  readonly event?: string;
  readonly data: string;
};

const parseSseBlock = (block: string): ParsedSseBlock => {
  let event: string | undefined;
  const data: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith("event:")) {
      event = line.slice("event:".length).trim();
      continue;
    }
    if (line.startsWith("data:")) data.push(line.slice("data:".length).trimStart());
  }
  return { event, data: data.join("\n") };
};

export type AgUiSseChunk = string | Uint8Array;

export async function* projectLedgerSseToAgUiEnvelopes(
  chunks: AsyncIterable<AgUiSseChunk>,
  spec: AgUiLedgerEnvelopeProjectionSpec = {},
): AsyncGenerator<AgUiLedgerEventEnvelope> {
  const decoder = new TextDecoder();
  let buffer = "";

  const flushBlock = (block: string): AgUiLedgerEventEnvelope | null => {
    const parsed = parseSseBlock(block);
    if (parsed.event !== "ledger" || parsed.data.length === 0) return null;
    return decodeLedgerEventToAgUiEnvelope(JSON.parse(parsed.data) as unknown, spec);
  };

  const flushBuffered = function* (): Generator<AgUiLedgerEventEnvelope> {
    while (true) {
      const boundary = buffer.indexOf("\n\n");
      if (boundary < 0) return;
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const envelope = flushBlock(block);
      if (envelope !== null) yield envelope;
    }
  };

  for await (const chunk of chunks) {
    buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    yield* flushBuffered();
  }
  buffer += decoder.decode();
  const tail = buffer.trim().length > 0 ? flushBlock(buffer) : null;
  buffer = "";
  if (tail !== null) yield tail;
}

/**
 * Transports ledger SSE events as AG-UI SSE envelopes.
 *
 * @agentosPrimitive primitive.ag-ui.projectLedgerSseToAgUiSse
 * @agentosInvariant invariant.algebra.single-code-source
 * @agentosDocs docs/concepts/ag-ui-wire-adapter.md
 * @public
 */
export async function* projectLedgerSseToAgUiSse(
  chunks: AsyncIterable<AgUiSseChunk>,
  spec: AgUiLedgerEnvelopeProjectionSpec = {},
): AsyncGenerator<string> {
  for await (const envelope of projectLedgerSseToAgUiEnvelopes(chunks, spec)) {
    yield encodeAgUiLedgerEventEnvelopeSse(envelope);
  }
}

/**
 * Folds AG-UI frames into a neutral run projection.
 *
 * @agentosPrimitive primitive.ag-ui.projectAgUiFrames
 * @agentosInvariant invariant.algebra.single-code-source
 * @agentosDocs docs/concepts/ag-ui-wire-adapter.md
 * @public
 */
export const projectAgUiFrames = (frames: Iterable<AgUiFrame>): AgUiFrameProjection => {
  const textMessages = new Map<string, { messageId: string; role: "assistant"; text: string }>();
  const toolCalls = new Map<
    string,
    { toolCallId: string; name: string; args: string; result: string | null }
  >();
  const custom: AgUiCustomFrame[] = [];
  let runId: string | null = null;
  let threadId: string | null = null;
  let status: AgUiFrameProjection["status"] = "idle";

  for (const frame of frames) {
    switch (frame.type) {
      case "RUN_STARTED":
        runId = frame.runId;
        threadId = frame.threadId;
        status = "running";
        break;
      case "RUN_FINISHED":
        runId = frame.runId;
        threadId = frame.threadId;
        status = "completed";
        break;
      case "RUN_ERROR":
        runId = frame.runId ?? runId;
        threadId = frame.threadId ?? threadId;
        status = "aborted";
        break;
      case "TEXT_MESSAGE_START":
        textMessages.set(frame.messageId, {
          messageId: frame.messageId,
          role: frame.role,
          text: "",
        });
        break;
      case "TEXT_MESSAGE_CONTENT": {
        const existing =
          textMessages.get(frame.messageId) ??
          ({ messageId: frame.messageId, role: "assistant", text: "" } as const);
        textMessages.set(frame.messageId, { ...existing, text: `${existing.text}${frame.delta}` });
        break;
      }
      case "TOOL_CALL_START":
        toolCalls.set(frame.toolCallId, {
          toolCallId: frame.toolCallId,
          name: frame.toolCallName,
          args: "",
          result: null,
        });
        break;
      case "TOOL_CALL_ARGS": {
        const existing =
          toolCalls.get(frame.toolCallId) ??
          ({ toolCallId: frame.toolCallId, name: "", args: "", result: null } as const);
        toolCalls.set(frame.toolCallId, { ...existing, args: `${existing.args}${frame.delta}` });
        break;
      }
      case "TOOL_CALL_RESULT": {
        const existing =
          toolCalls.get(frame.toolCallId) ??
          ({ toolCallId: frame.toolCallId, name: "", args: "", result: null } as const);
        toolCalls.set(frame.toolCallId, { ...existing, result: frame.content });
        break;
      }
      case "CUSTOM":
        if (frame.name === "agent-os.run.interrupted") {
          status = "interrupted";
        }
        if (frame.name === "agent-os.run.resumed") {
          status = "running";
        }
        custom.push(frame);
        break;
    }
  }

  const messages = [...textMessages.values()];
  return {
    runId,
    threadId,
    status,
    text: messages.map((message) => message.text).join(""),
    textMessages: messages,
    toolCalls: [...toolCalls.values()],
    custom,
  };
};

/**
 * Folds AG-UI frames into a UI-neutral activity list.
 *
 * @agentosPrimitive primitive.ag-ui.projectAgUiFramesToActivities
 * @agentosInvariant invariant.algebra.single-code-source
 * @agentosDocs docs/concepts/ag-ui-wire-adapter.md
 * @public
 */
export const projectAgUiFramesToActivities = (
  frames: Iterable<AgUiFrame>,
): ReadonlyArray<AgUiActivity> => {
  const activities: AgUiActivity[] = [];
  const messageIndexes = new Map<string, number>();
  const reasoningIndexes = new Map<string, number>();
  const toolIndexes = new Map<string, number>();

  const upsertMessage = (
    messageId: string,
    patch: Partial<Extract<AgUiActivity, { readonly kind: "message" }>>,
  ): void => {
    const existingIndex = messageIndexes.get(messageId);
    if (existingIndex === undefined) {
      messageIndexes.set(messageId, activities.length);
      activities.push({
        kind: "message",
        id: messageId,
        role: "assistant",
        text: "",
        ...patch,
      });
      return;
    }
    const existing = activities[existingIndex];
    if (existing?.kind === "message") {
      activities[existingIndex] = { ...existing, ...patch };
    }
  };

  const upsertReasoning = (
    messageId: string,
    patch: Partial<Extract<AgUiActivity, { readonly kind: "reasoning" }>>,
  ): void => {
    const existingIndex = reasoningIndexes.get(messageId);
    if (existingIndex === undefined) {
      reasoningIndexes.set(messageId, activities.length);
      activities.push({ kind: "reasoning", id: messageId, text: "", ...patch });
      return;
    }
    const existing = activities[existingIndex];
    if (existing?.kind === "reasoning") {
      activities[existingIndex] = { ...existing, ...patch };
    }
  };

  const upsertTool = (
    toolCallId: string,
    patch: Partial<Extract<AgUiActivity, { readonly kind: "tool_call" }>>,
  ): void => {
    const existingIndex = toolIndexes.get(toolCallId);
    if (existingIndex === undefined) {
      toolIndexes.set(toolCallId, activities.length);
      activities.push({
        kind: "tool_call",
        id: toolCallId,
        toolCallId,
        name: "",
        args: "",
        result: null,
        status: "running",
        ...patch,
      });
      return;
    }
    const existing = activities[existingIndex];
    if (existing?.kind === "tool_call") {
      activities[existingIndex] = { ...existing, ...patch };
    }
  };

  let customOrdinal = 0;
  let runOrdinal = 0;
  for (const frame of frames) {
    switch (frame.type) {
      case "RUN_STARTED":
        activities.push({
          kind: "run",
          id: `run:${runOrdinal++}:started`,
          status: "started",
          runId: frame.runId,
          threadId: frame.threadId,
          at: frame.timestamp,
        });
        break;
      case "RUN_FINISHED":
        activities.push({
          kind: "run",
          id: `run:${runOrdinal++}:finished`,
          status: "finished",
          runId: frame.runId,
          threadId: frame.threadId,
          at: frame.timestamp,
          result: frame.result,
        });
        break;
      case "RUN_ERROR":
        activities.push({
          kind: "run",
          id: `run:${runOrdinal++}:error`,
          status: "error",
          runId: frame.runId,
          threadId: frame.threadId,
          at: frame.timestamp,
          message: frame.message,
          code: frame.code,
        });
        break;
      case "TEXT_MESSAGE_START":
        upsertMessage(frame.messageId, { startedAt: frame.timestamp });
        break;
      case "TEXT_MESSAGE_CONTENT": {
        const existingIndex = messageIndexes.get(frame.messageId);
        const existing = existingIndex === undefined ? undefined : activities[existingIndex];
        const text = existing?.kind === "message" ? existing.text : "";
        upsertMessage(frame.messageId, {
          text: `${text}${frame.delta}`,
          updatedAt: frame.timestamp,
        });
        break;
      }
      case "TEXT_MESSAGE_END":
        upsertMessage(frame.messageId, { endedAt: frame.timestamp });
        break;
      case "REASONING_START":
      case "REASONING_MESSAGE_START":
        upsertReasoning(frame.messageId, { startedAt: frame.timestamp });
        break;
      case "REASONING_MESSAGE_CONTENT": {
        const existingIndex = reasoningIndexes.get(frame.messageId);
        const existing = existingIndex === undefined ? undefined : activities[existingIndex];
        const text = existing?.kind === "reasoning" ? existing.text : "";
        upsertReasoning(frame.messageId, {
          text: `${text}${frame.delta}`,
          updatedAt: frame.timestamp,
        });
        break;
      }
      case "REASONING_MESSAGE_END":
      case "REASONING_END":
        upsertReasoning(frame.messageId, { endedAt: frame.timestamp });
        break;
      case "TOOL_CALL_START":
        upsertTool(frame.toolCallId, {
          name: frame.toolCallName,
          startedAt: frame.timestamp,
          updatedAt: frame.timestamp,
        });
        break;
      case "TOOL_CALL_ARGS": {
        const existingIndex = toolIndexes.get(frame.toolCallId);
        const existing = existingIndex === undefined ? undefined : activities[existingIndex];
        const args = existing?.kind === "tool_call" ? existing.args : "";
        upsertTool(frame.toolCallId, { args: `${args}${frame.delta}`, updatedAt: frame.timestamp });
        break;
      }
      case "TOOL_CALL_END":
        upsertTool(frame.toolCallId, { updatedAt: frame.timestamp });
        break;
      case "TOOL_CALL_RESULT":
        upsertTool(frame.toolCallId, {
          result: frame.content,
          status: "completed",
          completedAt: frame.timestamp,
          updatedAt: frame.timestamp,
        });
        break;
      case "CUSTOM":
        activities.push({
          kind: "custom",
          id: `custom:${customOrdinal++}:${frame.name}`,
          name: frame.name,
          value: frame.value,
          at: frame.timestamp,
        });
        break;
    }
  }

  return activities;
};

export const createAgUiFrameStore = (initialFrames: Iterable<AgUiFrame> = []): AgUiFrameStore => {
  let frames = [...initialFrames];
  const listeners = new Set<() => void>();
  const notify = (): void => {
    for (const listener of listeners) listener();
  };
  return {
    getSnapshot: () => projectAgUiFrames(frames),
    getFrames: () => frames,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    append: (frame) => {
      frames = [...frames, frame];
      notify();
    },
    appendMany: (nextFrames) => {
      frames = [...frames, ...nextFrames];
      notify();
    },
    reset: (nextFrames = []) => {
      frames = [...nextFrames];
      notify();
    },
  };
};
