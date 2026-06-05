import { Schema } from "effect";
import {
  LlmOutputItemSchema,
  LlmUsageSchema,
  type LlmOutputItem,
  type LlmUsage,
} from "@agent-os/kernel/llm";
import type { LedgerEvent } from "@agent-os/kernel/types";
import type { AuthorityRef, LivedClaim, RejectedClaim, ScopeRef } from "@agent-os/kernel/effect-claim";
import type { ExecutionDomain, ToolExecution } from "@agent-os/kernel/tools";
import { TraceContextSchema, type TraceContext } from "@agent-os/kernel/trace-context";
import { ABORT, type AbortKind } from "./abort";

const positiveInt = Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(1));
const nonNegativeInt = Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0));
const unknownRecord = Schema.Record({ key: Schema.String, value: Schema.Unknown });

export const RUNTIME_EVENT_KIND = {
  AGENT_RUN_STARTED: "agent.run.started",
  CHAT_INGESTED: "chat.ingested",
  LLM_RESPONSE: "llm.response",
  TOOL_EXECUTED: "tool.executed",
  TOOL_REJECTED: "tool.rejected",
  AGENT_RUN_COMPLETED: "agent.run.completed",
  AGENT_ABORTED_BUDGET_TOKENS: "agent.aborted.budget_tokens",
  AGENT_ABORTED_BUDGET_TIME: "agent.aborted.budget_time",
  AGENT_ABORTED_TOOL_ERROR: "agent.aborted.tool_error",
  AGENT_ABORTED_UPSTREAM_FAILURE: "agent.aborted.upstream_failure",
  AGENT_ABORTED_RETRIES: "agent.aborted.retries",
  AGENT_ABORTED_CLIENT_DISCONNECT: "agent.aborted.client_disconnect",
} as const;

export type RuntimeEventKind = (typeof RUNTIME_EVENT_KIND)[keyof typeof RUNTIME_EVENT_KIND];
export type RuntimeAbortEventKind = AbortKind;

export const RUNTIME_ABORT_EVENT_KINDS: ReadonlyArray<RuntimeAbortEventKind> = Object.values(ABORT);

export const RUNTIME_EVENT_KINDS: ReadonlyArray<RuntimeEventKind> =
  Object.values(RUNTIME_EVENT_KIND);

const runtimeEventKindSet = new Set<string>(RUNTIME_EVENT_KINDS);

export const isRuntimeEventKind = (kind: string): kind is RuntimeEventKind =>
  runtimeEventKindSet.has(kind);

export const isRuntimeAbortEventKind = (kind: string): kind is RuntimeAbortEventKind =>
  (RUNTIME_ABORT_EVENT_KINDS as ReadonlyArray<string>).includes(kind);

const TurnRefSchema: Schema.Schema<{
  readonly id: number;
  readonly index: number;
}> = Schema.Struct({
  id: positiveInt,
  index: nonNegativeInt,
});

const ExecutionDomainSchema: Schema.Schema<ExecutionDomain> = Schema.Struct({
  kind: Schema.Literal("host", "sandbox", "workspace", "remote"),
  ref: Schema.String,
  envAllowlist: Schema.optional(Schema.Array(Schema.String)),
});

const ToolExecutionSchema: Schema.Schema<ToolExecution> = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("pure") }),
  Schema.Struct({
    kind: Schema.Literal("effectful"),
    domain: ExecutionDomainSchema,
  }),
);

export type AgentRunStartedPayload = {
  readonly intent: string;
  readonly traceContext?: TraceContext;
};

export type ChatIngestedPayload = {
  readonly runId: number;
  readonly intent: string;
  readonly context: unknown;
  readonly traceContext?: TraceContext;
};

export type LlmResponsePayload = {
  readonly turn: {
    readonly id: number;
    readonly index: number;
  };
  readonly items: ReadonlyArray<LlmOutputItem>;
  readonly usage: LlmUsage;
  readonly traceContext?: TraceContext;
};

export type ToolExecutedPayload = {
  readonly runId: number;
  readonly toolCallId: string;
  readonly name: string;
  readonly args: unknown;
  readonly execution: ToolExecution;
  readonly result: unknown;
  readonly claim: unknown;
  readonly traceContext?: TraceContext;
};

export type ToolRejectedPayload = {
  readonly runId: number;
  readonly toolCallId: string;
  readonly name: string;
  readonly args: unknown;
  readonly execution: ToolExecution;
  readonly claim: unknown;
  readonly traceContext?: TraceContext;
};

export type AgentRunCompletedPayload = {
  readonly runId: number;
  readonly final: string;
  readonly output: unknown;
  readonly outputKind: "text" | "json";
  readonly tokensUsed: number;
  readonly turn?: {
    readonly id: number;
    readonly index: number;
  };
  readonly traceContext?: TraceContext;
};

export type AgentRunAbortedPayload = {
  readonly runId: number;
  readonly tokensUsed: number;
  readonly traceContext?: TraceContext;
} & Readonly<Record<string, unknown>>;

export const AgentRunStartedPayloadSchema: Schema.Schema<AgentRunStartedPayload> = Schema.Struct({
  intent: Schema.String,
  traceContext: Schema.optional(TraceContextSchema),
});

export const ChatIngestedPayloadSchema: Schema.Schema<ChatIngestedPayload> = Schema.Struct({
  runId: positiveInt,
  intent: Schema.String,
  context: Schema.Unknown,
  traceContext: Schema.optional(TraceContextSchema),
});

export const LlmResponsePayloadSchema: Schema.Schema<LlmResponsePayload> = Schema.Struct({
  turn: TurnRefSchema,
  items: Schema.Array(LlmOutputItemSchema),
  usage: LlmUsageSchema,
  traceContext: Schema.optional(TraceContextSchema),
});

export const ToolExecutedPayloadSchema: Schema.Schema<ToolExecutedPayload> = Schema.Struct({
  runId: positiveInt,
  toolCallId: Schema.String,
  name: Schema.String,
  args: Schema.Unknown,
  execution: ToolExecutionSchema,
  result: Schema.Unknown,
  claim: Schema.Unknown,
  traceContext: Schema.optional(TraceContextSchema),
});

export const ToolRejectedPayloadSchema: Schema.Schema<ToolRejectedPayload> = Schema.Struct({
  runId: positiveInt,
  toolCallId: Schema.String,
  name: Schema.String,
  args: Schema.Unknown,
  execution: ToolExecutionSchema,
  claim: Schema.Unknown,
  traceContext: Schema.optional(TraceContextSchema),
});

export const AgentRunCompletedPayloadSchema: Schema.Schema<AgentRunCompletedPayload> =
  Schema.Struct({
    runId: positiveInt,
    final: Schema.String,
    output: Schema.Unknown,
    outputKind: Schema.Literal("text", "json"),
    tokensUsed: nonNegativeInt,
    turn: Schema.optional(TurnRefSchema),
    traceContext: Schema.optional(TraceContextSchema),
  });

export const AgentRunAbortedPayloadSchema: Schema.Schema<AgentRunAbortedPayload> = Schema.Struct({
  runId: positiveInt,
  tokensUsed: nonNegativeInt,
  traceContext: Schema.optional(TraceContextSchema),
}).pipe(Schema.extend(unknownRecord));

export type RuntimeEventPayloadByKind = {
  readonly [RUNTIME_EVENT_KIND.AGENT_RUN_STARTED]: AgentRunStartedPayload;
  readonly [RUNTIME_EVENT_KIND.CHAT_INGESTED]: ChatIngestedPayload;
  readonly [RUNTIME_EVENT_KIND.LLM_RESPONSE]: LlmResponsePayload;
  readonly [RUNTIME_EVENT_KIND.TOOL_EXECUTED]: ToolExecutedPayload;
  readonly [RUNTIME_EVENT_KIND.TOOL_REJECTED]: ToolRejectedPayload;
  readonly [RUNTIME_EVENT_KIND.AGENT_RUN_COMPLETED]: AgentRunCompletedPayload;
  readonly [ABORT.BUDGET_TOKENS]: AgentRunAbortedPayload;
  readonly [ABORT.BUDGET_TIME]: AgentRunAbortedPayload;
  readonly [ABORT.TOOL_ERROR]: AgentRunAbortedPayload;
  readonly [ABORT.UPSTREAM_FAILURE]: AgentRunAbortedPayload;
  readonly [ABORT.RETRIES]: AgentRunAbortedPayload;
  readonly [ABORT.CLIENT_DISCONNECT]: AgentRunAbortedPayload;
};

export type RuntimeLedgerEventByKind<K extends RuntimeEventKind> = Omit<
  LedgerEvent,
  "kind" | "payload"
> & {
  readonly kind: K;
  readonly payload: RuntimeEventPayloadByKind[K];
};

export type RuntimeLedgerEvent = {
  readonly [K in RuntimeEventKind]: RuntimeLedgerEventByKind<K>;
}[RuntimeEventKind];

export type RuntimeEventCommitSpecByKind<K extends RuntimeEventKind> = {
  readonly ts?: number;
  readonly kind: K;
  readonly payload: RuntimeEventPayloadByKind[K];
  readonly scopeRef: ScopeRef;
  readonly effectAuthorityRef: AuthorityRef;
  readonly factOwnerRef?: never;
  readonly scope?: never;
};

export type RuntimeEventCommitSpec = {
  readonly [K in RuntimeEventKind]: RuntimeEventCommitSpecByKind<K>;
}[RuntimeEventKind];

export type DecodeRuntimeLedgerEventResult =
  | {
      readonly _tag: "runtime";
      readonly event: RuntimeLedgerEvent;
    }
  | {
      readonly _tag: "non_runtime";
      readonly event: LedgerEvent;
    };

const decodeRuntimePayload = <K extends RuntimeEventKind>(
  kind: K,
  payload: unknown,
): RuntimeEventPayloadByKind[K] => {
  switch (kind) {
    case RUNTIME_EVENT_KIND.AGENT_RUN_STARTED:
      return Schema.decodeUnknownSync(AgentRunStartedPayloadSchema)(
        payload,
      ) as RuntimeEventPayloadByKind[K];
    case RUNTIME_EVENT_KIND.CHAT_INGESTED:
      return Schema.decodeUnknownSync(ChatIngestedPayloadSchema)(
        payload,
      ) as RuntimeEventPayloadByKind[K];
    case RUNTIME_EVENT_KIND.LLM_RESPONSE:
      return Schema.decodeUnknownSync(LlmResponsePayloadSchema)(
        payload,
      ) as RuntimeEventPayloadByKind[K];
    case RUNTIME_EVENT_KIND.TOOL_EXECUTED:
      return Schema.decodeUnknownSync(ToolExecutedPayloadSchema)(
        payload,
      ) as RuntimeEventPayloadByKind[K];
    case RUNTIME_EVENT_KIND.TOOL_REJECTED:
      return Schema.decodeUnknownSync(ToolRejectedPayloadSchema)(
        payload,
      ) as RuntimeEventPayloadByKind[K];
    case RUNTIME_EVENT_KIND.AGENT_RUN_COMPLETED:
      return Schema.decodeUnknownSync(AgentRunCompletedPayloadSchema)(
        payload,
      ) as RuntimeEventPayloadByKind[K];
    case ABORT.BUDGET_TOKENS:
    case ABORT.BUDGET_TIME:
    case ABORT.TOOL_ERROR:
    case ABORT.UPSTREAM_FAILURE:
    case ABORT.RETRIES:
    case ABORT.CLIENT_DISCONNECT:
      return Schema.decodeUnknownSync(AgentRunAbortedPayloadSchema)(
        payload,
      ) as RuntimeEventPayloadByKind[K];
  }
};

export const decodeRuntimeEventPayload = <K extends RuntimeEventKind>(
  kind: K,
  payload: unknown,
): RuntimeEventPayloadByKind[K] => decodeRuntimePayload(kind, payload);

export const decodeRuntimeLedgerEvent = (event: LedgerEvent): DecodeRuntimeLedgerEventResult => {
  if (!isRuntimeEventKind(event.kind)) {
    return { _tag: "non_runtime", event };
  }
  return {
    _tag: "runtime",
    event: {
      ...event,
      kind: event.kind,
      payload: decodeRuntimePayload(event.kind, event.payload),
    } as RuntimeLedgerEvent,
  };
};

const runtimeEvent = <K extends RuntimeEventKind>(
  identity: RuntimeEventIdentitySpec,
  kind: K,
  payload: RuntimeEventPayloadByKind[K],
): RuntimeEventCommitSpecByKind<K> => ({
  scopeRef: identity.scopeRef,
  effectAuthorityRef: identity.effectAuthorityRef,
  kind,
  payload: decodeRuntimePayload(kind, payload),
});

type RuntimeEventIdentitySpec = {
  readonly scopeRef: ScopeRef;
  readonly effectAuthorityRef: AuthorityRef;
  readonly scope?: never;
  readonly factOwnerRef?: never;
};

export const agentRunStartedEvent = (spec: RuntimeEventIdentitySpec & {
  readonly intent: string;
  readonly traceContext?: TraceContext;
}): RuntimeEventCommitSpecByKind<typeof RUNTIME_EVENT_KIND.AGENT_RUN_STARTED> =>
  runtimeEvent(spec, RUNTIME_EVENT_KIND.AGENT_RUN_STARTED, {
    intent: spec.intent,
    ...(spec.traceContext === undefined ? {} : { traceContext: spec.traceContext }),
  });

export const chatIngestedEvent = (spec: RuntimeEventIdentitySpec & {
  readonly runId: number;
  readonly intent: string;
  readonly context: unknown;
  readonly traceContext?: TraceContext;
}): RuntimeEventCommitSpecByKind<typeof RUNTIME_EVENT_KIND.CHAT_INGESTED> =>
  runtimeEvent(spec, RUNTIME_EVENT_KIND.CHAT_INGESTED, {
    runId: spec.runId,
    intent: spec.intent,
    context: spec.context,
    ...(spec.traceContext === undefined ? {} : { traceContext: spec.traceContext }),
  });

export const llmResponseEvent = (spec: RuntimeEventIdentitySpec & {
  readonly turn: { readonly id: number; readonly index: number };
  readonly items: ReadonlyArray<LlmOutputItem>;
  readonly usage: LlmUsage;
  readonly traceContext?: TraceContext;
}): RuntimeEventCommitSpecByKind<typeof RUNTIME_EVENT_KIND.LLM_RESPONSE> =>
  runtimeEvent(spec, RUNTIME_EVENT_KIND.LLM_RESPONSE, {
    turn: spec.turn,
    items: spec.items,
    usage: spec.usage,
    ...(spec.traceContext === undefined ? {} : { traceContext: spec.traceContext }),
  });

export const toolExecutedEvent = (spec: RuntimeEventIdentitySpec & {
  readonly runId: number;
  readonly toolCallId: string;
  readonly name: string;
  readonly args: unknown;
  readonly execution: ToolExecution;
  readonly result: unknown;
  readonly claim: LivedClaim;
  readonly traceContext?: TraceContext;
}): RuntimeEventCommitSpecByKind<typeof RUNTIME_EVENT_KIND.TOOL_EXECUTED> =>
  runtimeEvent(spec, RUNTIME_EVENT_KIND.TOOL_EXECUTED, {
    runId: spec.runId,
    toolCallId: spec.toolCallId,
    name: spec.name,
    args: spec.args,
    execution: spec.execution,
    result: spec.result,
    claim: spec.claim,
    ...(spec.traceContext === undefined ? {} : { traceContext: spec.traceContext }),
  });

export const toolRejectedEvent = (spec: RuntimeEventIdentitySpec & {
  readonly runId: number;
  readonly toolCallId: string;
  readonly name: string;
  readonly args: unknown;
  readonly execution: ToolExecution;
  readonly claim: RejectedClaim;
  readonly traceContext?: TraceContext;
}): RuntimeEventCommitSpecByKind<typeof RUNTIME_EVENT_KIND.TOOL_REJECTED> =>
  runtimeEvent(spec, RUNTIME_EVENT_KIND.TOOL_REJECTED, {
    runId: spec.runId,
    toolCallId: spec.toolCallId,
    name: spec.name,
    args: spec.args,
    execution: spec.execution,
    claim: spec.claim,
    ...(spec.traceContext === undefined ? {} : { traceContext: spec.traceContext }),
  });

export const agentRunCompletedEvent = (spec: RuntimeEventIdentitySpec & {
  readonly runId: number;
  readonly final: string;
  readonly output: unknown;
  readonly outputKind: "text" | "json";
  readonly tokensUsed: number;
  readonly turn?: { readonly id: number; readonly index: number };
  readonly traceContext?: TraceContext;
}): RuntimeEventCommitSpecByKind<typeof RUNTIME_EVENT_KIND.AGENT_RUN_COMPLETED> =>
  runtimeEvent(spec, RUNTIME_EVENT_KIND.AGENT_RUN_COMPLETED, {
    runId: spec.runId,
    final: spec.final,
    output: spec.output,
    outputKind: spec.outputKind,
    tokensUsed: spec.tokensUsed,
    ...(spec.turn === undefined ? {} : { turn: spec.turn }),
    ...(spec.traceContext === undefined ? {} : { traceContext: spec.traceContext }),
  });

export const agentRunAbortedEvent = (spec: RuntimeEventIdentitySpec & {
  readonly kind: RuntimeAbortEventKind;
  readonly runId: number;
  readonly tokensUsed: number;
  readonly payload?: Record<string, unknown>;
  readonly traceContext?: TraceContext;
}): RuntimeEventCommitSpecByKind<RuntimeAbortEventKind> =>
  runtimeEvent(spec, spec.kind, {
    ...spec.payload,
    runId: spec.runId,
    tokensUsed: spec.tokensUsed,
    ...(spec.traceContext === undefined ? {} : { traceContext: spec.traceContext }),
  });
