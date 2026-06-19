import { Schema } from "effect";
import type {
  SafeLedgerEvent,
  SafeLedgerEventProjector,
  SafeLedgerPayloadShape,
  SafeLedgerValue,
} from "@agent-os/kernel";
import { scopeRefKey } from "@agent-os/kernel/effect-claim";
import type { Tool } from "@agent-os/kernel/tools";
import { decodeRecordedLedgerEvent, type RecordedLedgerEvent } from "@agent-os/kernel/types";
import {
  inputRequestKindFromReason,
  parseInputRequestResumePayload,
  projectRuntimeSafeLedgerEvent,
  RUNTIME_FACT_OWNER,
  submitResumeDecisionFromInputRequestRef,
  type InputRequestDescriptor,
  type SubmitRunInput,
  type SubmitResumeDecision,
} from "@agent-os/runtime-protocol";
import {
  projectWorkspaceJobSafeLedgerEvent,
  WORKSPACE_JOB_FACT_OWNER,
} from "@agent-os/workspace-job";
import {
  projectWorkspaceOperationSafeLedgerEvent,
  WORKSPACE_OP_FACT_OWNER,
} from "@agent-os/workspace-op";
import { decodeSseHttpEvents, encodeSseHttpJsonEvent, type SseHttpChunk } from "@agent-os/sse-http";

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

export type AgUiSafeValue = SafeLedgerValue;
export type AgUiSafeLedgerEvent = SafeLedgerEvent;
export type AgUiRecordedLedgerEvent = RecordedLedgerEvent;
export type AgUiSafeEventFrameProjector = (
  event: AgUiSafeLedgerEvent,
  spec: AgUiRuntimeProjectionSpec,
) => ReadonlyArray<AgUiFrame>;

export type AgUiSafeEventProjector = {
  readonly factOwnerRef: string;
  readonly projectSafeEvent: SafeLedgerEventProjector;
  readonly projectFrames?: AgUiSafeEventFrameProjector;
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

const unknownRecord = Schema.Record(Schema.String, Schema.Unknown);

export const AgUiMessageRoleSchema: Schema.Decoder<AgUiMessageRole> = Schema.Literals([
  "developer",
  "system",
  "assistant",
  "user",
  "tool",
  "reasoning",
  "activity",
]);

export const AgUiMessageSchema: Schema.Decoder<AgUiMessage> = Schema.Struct({
  id: Schema.String,
  role: AgUiMessageRoleSchema,
  content: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
});

export const AgUiContextSchema: Schema.Decoder<AgUiContext> = Schema.Struct({
  description: Schema.String,
  value: Schema.String,
});

export const AgUiToolSchema: Schema.Decoder<AgUiTool> = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  parameters: Schema.optional(Schema.Unknown),
  metadata: Schema.optional(unknownRecord),
});

export const AgUiResumeEntrySchema: Schema.Decoder<
  AgUiRunAgentInput["resume"] extends ReadonlyArray<infer Entry> | undefined ? Entry : never
> = Schema.Struct({
  interruptId: Schema.String,
  status: Schema.Literals(["resolved", "cancelled"]),
  payload: Schema.optional(Schema.Unknown),
});

export const AgUiRunAgentInputSchema: Schema.Decoder<AgUiRunAgentInput> = Schema.Struct({
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

export const decodeAgUiRecordedLedgerEvent = (value: unknown): AgUiRecordedLedgerEvent =>
  decodeRecordedLedgerEvent(value);

export type AgUiRunStartedFrame = BaseAgUiFrame<"RUN_STARTED"> & {
  readonly threadId: string;
  readonly runId: string;
  readonly parentRunId?: string;
};

export type AgUiRunFinishedFrame = BaseAgUiFrame<"RUN_FINISHED"> & {
  readonly threadId: string;
  readonly runId: string;
  readonly result?: AgUiSafeValue;
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
  readonly value: AgUiSafeValue;
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
};

export type AgUiLedgerProjectionSpec = AgUiRuntimeProjectionSpec & {
  readonly safeEventProjectors?: ReadonlyArray<AgUiSafeEventProjector>;
};

export type AgUiInputRequestResumeBinding = {
  readonly request: InputRequestDescriptor;
  readonly decisionRef: string;
};

export type AgUiSubmitDefaults = Omit<SubmitRunInput, "intent" | "context"> & {
  readonly system?: string;
  readonly context?: Record<string, unknown>;
  readonly forwardedPropAllowlist?: ReadonlyArray<string>;
  readonly inputRequests?: ReadonlyArray<AgUiInputRequestResumeBinding>;
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

export type AgUiLedgerEnvelopeProjectionSpec = AgUiLedgerProjectionSpec;

export type AgUiLedgerEventEnvelope = {
  readonly id: number;
  readonly ts: number;
  readonly kind: string;
  readonly scopeKey: string;
  readonly agUiFrames: ReadonlyArray<AgUiFrame>;
};

export type AgUiLedgerEnvelopeFrame = {
  readonly eventId: number;
  readonly eventTs: number;
  readonly eventKind: string;
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
      readonly result?: AgUiSafeValue;
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
      readonly value: AgUiSafeValue;
      readonly at?: number;
    };

const BUILT_IN_SAFE_EVENT_PROJECTOR_OWNERS = new Set<string>([
  RUNTIME_FACT_OWNER,
  WORKSPACE_JOB_FACT_OWNER,
  WORKSPACE_OP_FACT_OWNER,
]);

const BUILT_IN_SAFE_EVENT_PROJECTORS: ReadonlyArray<AgUiSafeEventProjector> = [
  {
    factOwnerRef: RUNTIME_FACT_OWNER,
    projectSafeEvent: projectRuntimeSafeLedgerEvent,
    projectFrames: (event, spec) => projectSafeLedgerEventToAgUiFrames(event, spec),
  },
  {
    factOwnerRef: WORKSPACE_JOB_FACT_OWNER,
    projectSafeEvent: projectWorkspaceJobSafeLedgerEvent,
    projectFrames: (event, spec) => projectSafeLedgerEventToAgUiFrames(event, spec),
  },
  {
    factOwnerRef: WORKSPACE_OP_FACT_OWNER,
    projectSafeEvent: projectWorkspaceOperationSafeLedgerEvent,
    projectFrames: (event, spec) => projectSafeLedgerEventToAgUiFrames(event, spec),
  },
];

type OwnerProjectedSafeEvent = {
  readonly factOwnerRef: string;
  readonly safeEvent: AgUiSafeLedgerEvent;
  readonly projectFrames?: AgUiSafeEventFrameProjector;
};

const ownerSafeEventProjectors = (
  spec: AgUiLedgerProjectionSpec,
): ReadonlyArray<AgUiSafeEventProjector> => {
  const seen = new Set<string>();
  const duplicateOwnerRefs = new Set<string>();
  for (const projector of spec.safeEventProjectors ?? []) {
    if (seen.has(projector.factOwnerRef)) {
      duplicateOwnerRefs.add(projector.factOwnerRef);
    }
    seen.add(projector.factOwnerRef);
  }
  return [
    ...BUILT_IN_SAFE_EVENT_PROJECTORS,
    ...(spec.safeEventProjectors ?? []).filter(
      (projector) =>
        !BUILT_IN_SAFE_EVENT_PROJECTOR_OWNERS.has(projector.factOwnerRef) &&
        !duplicateOwnerRefs.has(projector.factOwnerRef),
    ),
  ];
};

const safeEventMatchesOwner = (
  event: AgUiRecordedLedgerEvent,
  factOwnerRef: string,
  safeEvent: AgUiSafeLedgerEvent,
): boolean =>
  !(
    safeEvent.id !== event.id ||
    safeEvent.ts !== event.ts ||
    safeEvent.kind !== event.kind ||
    safeEvent.scopeKey !== scopeRefKey(event.scopeRef) ||
    safeEvent.factOwnerRef !== factOwnerRef ||
    safeEvent.factOwnerRef !== event.factOwnerRef
  );

const projectOwnerSafeLedgerEvent = (
  event: AgUiRecordedLedgerEvent,
  projectors: ReadonlyArray<AgUiSafeEventProjector>,
): OwnerProjectedSafeEvent | undefined => {
  for (const projector of projectors) {
    if (projector.factOwnerRef !== event.factOwnerRef) continue;
    const safeEvent = projector.projectSafeEvent(event);
    if (safeEvent === undefined) return undefined;
    if (!safeEventMatchesOwner(event, projector.factOwnerRef, safeEvent)) return undefined;
    return {
      factOwnerRef: projector.factOwnerRef,
      safeEvent,
      ...(projector.projectFrames === undefined ? {} : { projectFrames: projector.projectFrames }),
    };
  }
  return undefined;
};

const stringOf = (value: AgUiSafeValue | undefined): string | undefined =>
  typeof value === "string" ? value : undefined;

const numberOf = (value: AgUiSafeValue | undefined): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const recordOf = (
  value: AgUiSafeValue | undefined,
): Readonly<Record<string, AgUiSafeValue>> | undefined => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Readonly<Record<string, AgUiSafeValue>>;
};

const arrayOf = (value: AgUiSafeValue | undefined): ReadonlyArray<AgUiSafeValue> | undefined =>
  Array.isArray(value) ? value : undefined;

const payloadOf = (event: SafeLedgerEvent): SafeLedgerPayloadShape => event.safePayload ?? {};

const safeJsonText = (value: AgUiSafeValue | undefined): string => JSON.stringify(value ?? null);

const safeInputRequestForInterrupted = (
  event: SafeLedgerEvent,
  payload: SafeLedgerPayloadShape,
): AgUiSafeValue | undefined => {
  const reason = stringOf(payload.reason);
  const requestKind = reason === undefined ? null : inputRequestKindFromReason(reason);
  const decision = recordOf(payload.decision);
  const interruptId = stringOf(payload.interruptId);
  const gateRef = stringOf(decision?.gateRef);
  const subjectRef = stringOf(decision?.subjectRef);
  const toolCallId = stringOf(decision?.toolCallId);
  const toolName = stringOf(decision?.toolName);
  if (
    requestKind === null ||
    interruptId === undefined ||
    gateRef === undefined ||
    subjectRef === undefined ||
    toolCallId === undefined ||
    toolName === undefined
  ) {
    return undefined;
  }
  const runId = numberOf(payload.runId) ?? event.id;
  const turnIndex = numberOf(payload.turnIndex) ?? 0;
  return {
    kind: requestKind,
    subjectRef,
    toolCallId,
    toolName,
    ref: {
      kind: "agent.run.input_request",
      scopeKey: event.scopeKey,
      afterEventId: event.id,
      runId,
      turnIndex,
      interruptId,
      interruptionEventId: event.id,
      gateRef,
      requestKind,
    },
  };
};

const threadIdForSafe = (event: SafeLedgerEvent, spec: AgUiRuntimeProjectionSpec): string =>
  spec.threadId ?? event.scopeKey;

const runIdString = (value: AgUiSafeValue | undefined, fallback: string | number): string =>
  String(typeof value === "string" || typeof value === "number" ? value : fallback);

const messageIdFor = (runId: string | number, turnIndex: number, ordinal: number): string =>
  `agent-os:run:${runId}:turn:${turnIndex}:message:${ordinal}`;

const reasoningIdFor = (runId: string | number, turnIndex: number, ordinal: number): string =>
  `agent-os:run:${runId}:turn:${turnIndex}:reasoning:${ordinal}`;

const toolResultMessageIdFor = (runId: string | number, toolCallId: string): string =>
  `agent-os:run:${runId}:tool-result:${toolCallId}`;

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

const singleResumeEntry = (
  resume: ReadonlyArray<NonNullable<AgUiRunAgentInput["resume"]>[number]>,
): NonNullable<AgUiRunAgentInput["resume"]>[number] | undefined => {
  if (resume.length === 0) return undefined;
  if (resume.length !== 1) {
    throw new TypeError("AG-UI resume input must contain exactly one resume entry");
  }
  return resume[0];
};

const inputRequestBindingFor = (
  bindings: ReadonlyArray<AgUiInputRequestResumeBinding> | undefined,
  interruptId: string,
): AgUiInputRequestResumeBinding => {
  const matches = (bindings ?? []).filter(
    (binding) => binding.request.ref.interruptId === interruptId,
  );
  if (matches.length !== 1) {
    throw new TypeError("AG-UI resume input has no unique runtime InputRequest binding");
  }
  return matches[0]!;
};

const submitResumeForAgUiInput = (
  input: AgUiRunAgentInput,
  defaults: AgUiSubmitDefaults,
): SubmitResumeDecision | undefined => {
  const entry = singleResumeEntry(input.resume ?? []);
  if (entry === undefined) return defaults.resume;
  if (defaults.resume !== undefined) {
    throw new TypeError("AG-UI resume input cannot be combined with defaults.resume");
  }
  if (entry.status !== "resolved") {
    throw new TypeError(
      "AG-UI resume input must be resolved before it can become SubmitSpec.resume",
    );
  }
  const binding = inputRequestBindingFor(defaults.inputRequests, entry.interruptId);
  const parsed = parseInputRequestResumePayload(binding.request.kind, entry.payload);
  if (!parsed.ok) {
    throw new TypeError(`AG-UI resume input failed InputRequest contract: ${parsed.reason}`);
  }
  return submitResumeDecisionFromInputRequestRef(binding.request.ref, {
    decisionRef: binding.decisionRef,
    resume: parsed.resume,
  });
};

export const agUiRunAgentInputToSubmitInput = (
  input: AgUiRunAgentInput,
  defaults: AgUiSubmitDefaults,
): SubmitRunInput => {
  const resume = submitResumeForAgUiInput(input, defaults);
  const forwardedProps = selectedForwardedProps(input, defaults.forwardedPropAllowlist);
  return {
    ...(defaults.system === undefined ? {} : { system: defaults.system }),
    ...(defaults.budget === undefined ? {} : { budget: defaults.budget }),
    ...(defaults.outputSchema === undefined ? {} : { outputSchema: defaults.outputSchema }),
    ...(defaults.traceContext === undefined ? {} : { traceContext: defaults.traceContext }),
    ...(defaults.materials === undefined ? {} : { materials: defaults.materials }),
    ...(defaults.toolContext === undefined ? {} : { toolContext: defaults.toolContext }),
    ...(defaults.toolPolicy === undefined ? {} : { toolPolicy: defaults.toolPolicy }),
    ...(defaults.decisionInterrupts === undefined
      ? {}
      : { decisionInterrupts: defaults.decisionInterrupts }),
    ...(resume === undefined ? {} : { resume }),
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

const projectSafeLlmResponse = (event: SafeLedgerEvent): ReadonlyArray<AgUiFrame> => {
  const payload = payloadOf(event);
  const runId = runIdString(payload.runId, event.id);
  const turnIndex = numberOf(payload.turnIndex) ?? 0;
  const frames: AgUiFrame[] = [];
  let messageOrdinal = 0;
  let reasoningOrdinal = 0;

  for (const value of arrayOf(payload.items) ?? []) {
    const item = recordOf(value);
    const type = stringOf(item?.type);
    if (item === undefined || type === undefined) continue;

    if (type === "message") {
      const text = stringOf(item.text) ?? "";
      const messageId = messageIdFor(runId, turnIndex, messageOrdinal);
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
          delta: text,
        },
        {
          type: "TEXT_MESSAGE_END",
          timestamp: event.ts,
          messageId,
        },
      );
      continue;
    }

    if (type === "tool_call") {
      const toolCallId = stringOf(item.toolCallId);
      const toolName = stringOf(item.toolName);
      if (toolCallId === undefined || toolName === undefined) continue;
      frames.push(
        {
          type: "CUSTOM",
          timestamp: event.ts,
          name: "agent-os.tool.started",
          value: {
            runId,
            turnIndex,
            toolCallId,
            toolName,
            ...(item.io === undefined ? {} : { io: item.io }),
          },
        },
        {
          type: "TOOL_CALL_START",
          timestamp: event.ts,
          toolCallId,
          toolCallName: toolName,
        },
        {
          type: "TOOL_CALL_ARGS",
          timestamp: event.ts,
          toolCallId,
          delta: safeJsonText(item.args),
        },
        {
          type: "TOOL_CALL_END",
          timestamp: event.ts,
          toolCallId,
        },
      );
      continue;
    }

    if (type === "tool_result") {
      const toolCallId = stringOf(item.toolCallId);
      if (toolCallId === undefined) continue;
      frames.push({
        type: "TOOL_CALL_RESULT",
        timestamp: event.ts,
        messageId: toolResultMessageIdFor(runId, toolCallId),
        toolCallId,
        content: safeJsonText(item.result),
        role: "tool",
      });
      continue;
    }

    if (type === "reasoning") {
      const messageId = reasoningIdFor(runId, turnIndex, reasoningOrdinal);
      reasoningOrdinal += 1;
      frames.push(
        { type: "REASONING_START", timestamp: event.ts, messageId },
        { type: "REASONING_MESSAGE_START", timestamp: event.ts, messageId },
        {
          type: "REASONING_MESSAGE_CONTENT",
          timestamp: event.ts,
          messageId,
          delta: stringOf(item.summary) ?? "[redacted reasoning]",
        },
        { type: "REASONING_MESSAGE_END", timestamp: event.ts, messageId },
        { type: "REASONING_END", timestamp: event.ts, messageId },
      );
      continue;
    }

    if (type === "refusal" || type === "error") {
      frames.push({
        type: "CUSTOM",
        timestamp: event.ts,
        name: `agent-os.llm.${type}`,
        value: {
          runId,
          turnIndex,
          ...(type === "refusal"
            ? { refusal: item.refusal ?? null }
            : { error: item.error ?? null }),
        },
      });
    }
  }

  frames.push({
    type: "CUSTOM",
    timestamp: event.ts,
    name: "agent-os.llm.completed",
    value: {
      runId: typeof payload.runId === "number" ? payload.runId : runId,
      turnIndex,
      usage: payload.usage ?? null,
    },
  });

  frames.push({
    type: "CUSTOM",
    timestamp: event.ts,
    name: "agent-os.llm.usage",
    value: {
      runId: typeof payload.runId === "number" ? payload.runId : runId,
      turnIndex,
      usage: payload.usage ?? null,
    },
  });
  return frames;
};

const defaultCustomFrame = (event: SafeLedgerEvent): AgUiCustomFrame => ({
  type: "CUSTOM",
  timestamp: event.ts,
  name: event.kind,
  value: {
    id: event.id,
    kind: event.kind,
    safePayload: event.safePayload ?? null,
  },
});

const projectCustomSafeLedgerEventToAgUiFrames = (
  event: AgUiSafeLedgerEvent,
): ReadonlyArray<AgUiFrame> => [defaultCustomFrame(event)];

const ownerAgUiFrames = (
  factOwnerRef: string,
  frames: ReadonlyArray<AgUiFrame>,
): ReadonlyArray<AgUiFrame> =>
  BUILT_IN_SAFE_EVENT_PROJECTOR_OWNERS.has(factOwnerRef)
    ? frames
    : frames.filter((frame) => frame.type !== "CUSTOM" || !frame.name.startsWith("agent-os."));

export const projectSafeLedgerEventToAgUiFrames = (
  event: AgUiSafeLedgerEvent,
  spec: AgUiRuntimeProjectionSpec = {},
): ReadonlyArray<AgUiFrame> => {
  if (!BUILT_IN_SAFE_EVENT_PROJECTOR_OWNERS.has(event.factOwnerRef)) {
    const frames = projectCustomSafeLedgerEventToAgUiFrames(event);
    return ownerAgUiFrames(event.factOwnerRef, frames);
  }

  const payload = payloadOf(event);
  switch (event.kind) {
    case "agent.run.started":
      return [
        {
          type: "RUN_STARTED",
          timestamp: event.ts,
          threadId: threadIdForSafe(event, spec),
          runId: runIdString(payload.runId, event.id),
          ...(spec.parentRunId === undefined ? {} : { parentRunId: spec.parentRunId }),
        },
      ];
    case "chat.ingested":
      return [
        {
          type: "CUSTOM",
          timestamp: event.ts,
          name: "agent-os.chat.ingested",
          value: {
            runId: payload.runId ?? event.id,
            intent: payload.intent ?? null,
          },
        },
      ];
    case "agent.run.interrupted": {
      const inputRequest = safeInputRequestForInterrupted(event, payload);
      return [
        {
          type: "CUSTOM",
          timestamp: event.ts,
          name: "agent-os.run.interrupted",
          value: {
            ...payload,
            ...(inputRequest === undefined ? {} : { inputRequest }),
          },
        },
      ];
    }
    case "agent.run.resumed":
      return [
        {
          type: "CUSTOM",
          timestamp: event.ts,
          name: "agent-os.run.resumed",
          value: payload,
        },
      ];
    case "llm.requested":
      return [
        {
          type: "CUSTOM",
          timestamp: event.ts,
          name: "agent-os.llm.requested",
          value: payload,
        },
      ];
    case "llm.response":
      return projectSafeLlmResponse(event);
    case "runtime.completed_after_tools":
      return [
        {
          type: "CUSTOM",
          timestamp: event.ts,
          name: "agent-os.runtime.completed_after_tools",
          value: payload,
        },
      ];
    case "tool.executed": {
      const toolCallId = stringOf(payload.toolCallId);
      if (toolCallId === undefined) return [];
      const toolName = stringOf(payload.toolName);
      const runId = runIdString(payload.runId, event.id);
      return [
        {
          type: "TOOL_CALL_RESULT",
          timestamp: event.ts,
          messageId: toolResultMessageIdFor(runId, toolCallId),
          toolCallId,
          content: safeJsonText(payload.result),
          role: "tool",
        },
        {
          type: "CUSTOM",
          timestamp: event.ts,
          name: "agent-os.tool.completed",
          value: {
            runId,
            toolCallId,
            ...(toolName === undefined ? {} : { toolName }),
            ...(payload.io === undefined ? {} : { io: payload.io }),
          },
        },
      ];
    }
    case "tool.rejected": {
      const toolName = stringOf(payload.toolName) ?? "unknown";
      const diagnostics = recordOf(payload.diagnostics);
      const phase = stringOf(diagnostics?.phase);
      if (phase === "policy") {
        return [
          {
            type: "CUSTOM",
            timestamp: event.ts,
            name: "agent-os.tool.policy_rejected",
            value: {
              runId: payload.runId ?? event.id,
              toolCallId: payload.toolCallId ?? null,
              toolName,
              diagnostics: diagnostics ?? null,
            },
          },
        ];
      }
      return [
        {
          type: "RUN_ERROR",
          timestamp: event.ts,
          threadId: threadIdForSafe(event, spec),
          runId: runIdString(payload.runId, event.id),
          message: `tool rejected: ${toolName}`,
          code: "tool.rejected",
        },
      ];
    }
    case "agent.run.completed":
      return [
        {
          type: "RUN_FINISHED",
          timestamp: event.ts,
          threadId: threadIdForSafe(event, spec),
          runId: runIdString(payload.runId, event.id),
          result: {
            final: payload.final ?? null,
            output: payload.output ?? null,
            outputKind: payload.outputKind ?? null,
            tokensUsed: payload.tokensUsed ?? null,
          },
          outcome: { type: "success" },
        },
      ];
    default:
      if (event.kind.startsWith("agent.aborted.")) {
        return [
          {
            type: "RUN_ERROR",
            timestamp: event.ts,
            threadId: threadIdForSafe(event, spec),
            runId: runIdString(payload.runId, event.id),
            message: stringOf(payload.reason) ?? event.kind,
            code: event.kind,
          },
        ];
      }
      return [defaultCustomFrame(event)];
  }
};

export const projectLedgerEventsToAgUiFrames = (
  events: ReadonlyArray<AgUiRecordedLedgerEvent>,
  spec: AgUiLedgerProjectionSpec = {},
): ReadonlyArray<AgUiFrame> => {
  const frames: AgUiFrame[] = [];
  const projectors = ownerSafeEventProjectors(spec);
  for (const event of [...events].sort((left, right) => left.id - right.id)) {
    const projected = projectOwnerSafeLedgerEvent(event, projectors);
    if (projected === undefined) continue;
    const eventFrames =
      projected.projectFrames?.(projected.safeEvent, spec) ??
      projectCustomSafeLedgerEventToAgUiFrames(projected.safeEvent);
    frames.push(...ownerAgUiFrames(projected.factOwnerRef, eventFrames));
  }
  return frames;
};

/**
 * Projects one typed ledger event into a browser-safe AG-UI envelope.
 *
 * @agentosPrimitive primitive.ag-ui.projectLedgerEventToAgUiEnvelope
 * @agentosInvariant invariant.boundary.owner-owned-safe-projection
 * @agentosDocs docs/concepts/ag-ui-wire-adapter.md
 * @public
 */
export const projectLedgerEventToAgUiEnvelope = (
  event: AgUiRecordedLedgerEvent,
  spec: AgUiLedgerEnvelopeProjectionSpec = {},
): AgUiLedgerEventEnvelope => {
  const agUiFrames = projectLedgerEventsToAgUiFrames([event], spec);
  return {
    id: event.id,
    ts: event.ts,
    kind: event.kind,
    scopeKey: scopeRefKey(event.scopeRef),
    agUiFrames,
  };
};

export const decodeLedgerEventToAgUiEnvelope = (
  value: unknown,
  spec: AgUiLedgerEnvelopeProjectionSpec = {},
): AgUiLedgerEventEnvelope =>
  projectLedgerEventToAgUiEnvelope(decodeAgUiRecordedLedgerEvent(value), spec);

export const projectLedgerEventsToAgUiEnvelopes = (
  events: ReadonlyArray<AgUiRecordedLedgerEvent>,
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
    eventScopeKey: envelope.scopeKey,
    frame,
  }));

export const framesForAgUiLedgerEnvelopes = (
  envelopes: ReadonlyArray<AgUiLedgerEventEnvelope>,
): ReadonlyArray<AgUiLedgerEnvelopeFrame> => envelopes.flatMap(framesForAgUiLedgerEnvelope);

export type AgUiFrameSafetyIssue = {
  readonly kind: "literal" | "pattern";
  readonly frameIndex: number;
  readonly path: string;
  readonly match: string;
};

export type AgUiFrameSafetySpec = {
  readonly forbiddenLiterals?: ReadonlyArray<string>;
  readonly forbiddenPatterns?: ReadonlyArray<RegExp>;
};

const visitFrameValue = (
  value: unknown,
  path: string,
  visit: (value: unknown, path: string) => void,
): void => {
  visit(value, path);
  if (Array.isArray(value)) {
    value.forEach((item, index) => visitFrameValue(item, `${path}[${index}]`, visit));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      visitFrameValue(item, `${path}.${key}`, visit);
    }
  }
};

/**
 * Regression verifier for fixture-owned forbidden values.
 *
 * Projection safety is provided by owner-owned SafeLedgerEvent projectors. This
 * scanner is secondary evidence for tests and fixtures.
 *
 * @public
 */
export const verifyAgUiFrameSafety = (
  frames: ReadonlyArray<AgUiFrame>,
  spec: AgUiFrameSafetySpec = {},
): ReadonlyArray<AgUiFrameSafetyIssue> => {
  const literals = spec.forbiddenLiterals ?? [];
  const patterns = spec.forbiddenPatterns ?? [];
  const issues: AgUiFrameSafetyIssue[] = [];
  frames.forEach((frame, frameIndex) => {
    visitFrameValue(frame, "$", (value, path) => {
      if (typeof value !== "string") return;
      for (const literal of literals) {
        if (literal.length > 0 && value.includes(literal)) {
          issues.push({ kind: "literal", frameIndex, path, match: literal });
        }
      }
      for (const pattern of patterns) {
        pattern.lastIndex = 0;
        if (pattern.test(value)) {
          issues.push({ kind: "pattern", frameIndex, path, match: pattern.source });
        }
      }
    });
  });
  return issues;
};

export const encodeAgUiLedgerEventEnvelopeSse = (
  envelope: AgUiLedgerEventEnvelope,
  eventName = "ag_ui",
): string => encodeSseHttpJsonEvent(eventName, envelope);

export type AgUiSseChunk = SseHttpChunk;

export async function* projectLedgerSseToAgUiEnvelopes(
  chunks: AsyncIterable<AgUiSseChunk>,
  spec: AgUiLedgerEnvelopeProjectionSpec = {},
): AsyncGenerator<AgUiLedgerEventEnvelope> {
  for await (const parsed of decodeSseHttpEvents(chunks)) {
    if (parsed.event !== "ledger" || parsed.data.length === 0) continue;
    yield decodeLedgerEventToAgUiEnvelope(JSON.parse(parsed.data) as unknown, spec);
  }
}

/**
 * Transports ledger SSE events as AG-UI SSE envelopes.
 *
 * @agentosPrimitive primitive.ag-ui.projectLedgerSseToAgUiSse
 * @agentosInvariant invariant.boundary.owner-owned-safe-projection
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
