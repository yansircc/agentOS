import type { Tool } from "@agent-os/kernel/tools";
import type { LedgerEvent } from "@agent-os/kernel/types";
import type { SubmitSpec } from "@agent-os/runtime";
import { isRuntimeAbortEventKind } from "@agent-os/runtime/runtime-events";
import {
  decodeRuntimeLedgerEvent,
  RUNTIME_EVENT_KIND,
  type RuntimeLedgerEvent,
  type RuntimeLedgerEventByKind,
} from "@agent-os/runtime/runtime-events";

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

export type AgUiMessage =
  | {
      readonly id: string;
      readonly role: "developer" | "system" | "assistant" | "user" | "tool";
      readonly content?: string;
      readonly name?: string;
    }
  | {
      readonly id: string;
      readonly role: "reasoning" | "activity";
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
  readonly status: "idle" | "running" | "completed" | "aborted";
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

const threadIdFor = (event: RuntimeLedgerEvent, spec: AgUiRuntimeProjectionSpec): string =>
  spec.threadId ?? event.scope;

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
  if (input.resume !== undefined && input.resume.length > 0) {
    throw new TypeError("AG-UI resume is unsupported until agentOS owns interrupt facts");
  }

  const forwardedProps = selectedForwardedProps(input, defaults.forwardedPropAllowlist);
  return {
    ...defaults,
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
  parameters: tool.definition.function.parameters.projections.agUi,
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
          result: { event: event.payload.event },
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
