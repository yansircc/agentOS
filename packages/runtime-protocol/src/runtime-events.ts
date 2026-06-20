import { Data, Option, Predicate, Schema } from "effect";
import {
  LlmOutputItemSchema,
  LlmUsageSchema,
  type LlmOutputItem,
  type LlmUsage,
} from "@agent-os/llm-protocol";
import type { LedgerEvent } from "@agent-os/kernel/types";
import {
  validateEffectClaim,
  type AnchorRef,
  type AuthorityRef,
  type LivedClaim,
  type RejectedClaim,
  type ScopeRef,
} from "@agent-os/kernel/effect-claim";
import type { AgentSchemaIssue } from "@agent-os/kernel/agent-schema";
import type { ExecutionDomain, ResolvedToolExecution, ToolExecution } from "@agent-os/kernel/tools";
import type { Recorded } from "@agent-os/kernel";
import { TraceContextSchema, type TraceContext } from "@agent-os/telemetry-protocol";
import { ABORT, type AbortKind } from "@agent-os/kernel/abort";
import { recordRuntimeProtocolValue } from "./recorded";
import {
  parseInputRequestResumePayload,
  type InputRequestKind,
  type InputRequestResumePayload,
} from "./input-request";
import { ExecutionIdentitySchema, type ExecutionIdentity } from "./execution-identity";

const positiveInt = Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(1)));
const nonNegativeInt = Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)));
const nonEmptyString = Schema.String.pipe(
  Schema.check(Schema.makeFilter((value) => value.length > 0)),
);
const unknownRecord = Schema.Record(Schema.String, Schema.Unknown);

const INPUT_REQUEST_KINDS = new Set<InputRequestKind>(["approval", "question", "authorization"]);

const isInputRequestKind = (value: unknown): value is InputRequestKind =>
  typeof value === "string" && INPUT_REQUEST_KINDS.has(value as InputRequestKind);

const isInputRequestResumePayload = (value: unknown): value is InputRequestResumePayload =>
  Predicate.isObject(value) &&
  isInputRequestKind(value.kind) &&
  parseInputRequestResumePayload(value.kind, value).ok;

const InputRequestResumePayloadSchema: Schema.Decoder<InputRequestResumePayload> =
  Schema.declare<InputRequestResumePayload>(isInputRequestResumePayload);

export const RUNTIME_EVENT_KIND = {
  AGENT_RUN_STARTED: "agent.run.started",
  AGENT_RUN_INTERRUPTED: "agent.run.interrupted",
  AGENT_RUN_RESUMED: "agent.run.resumed",
  CHAT_INGESTED: "chat.ingested",
  LLM_REQUESTED: "llm.requested",
  LLM_RESPONSE: "llm.response",
  TOOL_EXECUTED: "tool.executed",
  TOOL_REJECTED: "tool.rejected",
  RUNTIME_HISTORY_COMPACTED: "runtime.history_compacted",
  RUNTIME_REKEYED: "runtime.rekeyed",
  RUNTIME_COMPLETED_AFTER_TOOLS: "runtime.completed_after_tools",
  AGENT_RUN_COMPLETED: "agent.run.completed",
  AGENT_ABORTED_BUDGET_TOKENS: "agent.aborted.budget_tokens",
  AGENT_ABORTED_BUDGET_TIME: "agent.aborted.budget_time",
  AGENT_ABORTED_TOOL_ERROR: "agent.aborted.tool_error",
  AGENT_ABORTED_UPSTREAM_FAILURE: "agent.aborted.upstream_failure",
  AGENT_ABORTED_RETRIES: "agent.aborted.retries",
  AGENT_ABORTED_CLIENT_DISCONNECT: "agent.aborted.client_disconnect",
} as const;

export const TOOL_RESULT_SNAPSHOT_VERSION = "tool-result-snapshot-v1";
export const EXTERNAL_TOOL_EXECUTION_RECEIPT_VERSION = "external-tool-execution-receipt-v1";
export const RECEIPT_BACKED_TOOL_RESULT_VERSION = "receipt-backed-tool-result-v1";
export const EXTERNAL_TOOL_REPLAY_REQUIRES_RECEIPT_REASON = "external_tool_replay_requires_receipt";
export const TOOL_EXECUTION_CLAIM_MUST_BE_LIVED_REASON = "tool_execution_claim_must_be_lived";
export const EXTERNAL_TOOL_EXECUTION_REQUIRES_RECEIPT_REASON =
  "external_tool_execution_requires_receipt";

export type RuntimeEventKind = (typeof RUNTIME_EVENT_KIND)[keyof typeof RUNTIME_EVENT_KIND];
export type RuntimeAbortEventKind = AbortKind;

export const RUNTIME_ABORT_EVENT_KINDS: ReadonlyArray<RuntimeAbortEventKind> = Object.values(ABORT);

export const RUNTIME_EVENT_KINDS: ReadonlyArray<RuntimeEventKind> =
  Object.values(RUNTIME_EVENT_KIND);

const runtimeEventKindSet = new Set<string>(RUNTIME_EVENT_KINDS);
const DECISION_GATE_CONSUMED_EVENT_KIND = "decision_gate.consumed";

export const isRuntimeEventKind = (kind: string): kind is RuntimeEventKind =>
  runtimeEventKindSet.has(kind);

export const isRuntimeAbortEventKind = (kind: string): kind is RuntimeAbortEventKind =>
  (RUNTIME_ABORT_EVENT_KINDS as ReadonlyArray<string>).includes(kind);

const TurnRefSchema: Schema.Decoder<{
  readonly id: number;
  readonly index: number;
}> = Schema.Struct({
  id: positiveInt,
  index: nonNegativeInt,
});

const ExecutionDomainSchema: Schema.Decoder<ExecutionDomain> = Schema.Struct({
  kind: Schema.Literals(["host", "sandbox", "workspace", "remote"]),
  ref: Schema.String,
  envAllowlist: Schema.optional(Schema.Array(Schema.String)),
});

const ToolExecutionSchema: Schema.Decoder<ToolExecution> = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("deterministic") }),
  Schema.Struct({
    kind: Schema.Literal("external"),
    access: Schema.Literals(["read", "write"]),
    domain: ExecutionDomainSchema,
  }),
]);

export type AgentRunStartedPayload = {
  readonly intent: string;
  readonly executionIdentity?: ExecutionIdentity;
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

export type LlmRequestedPayload = {
  readonly runId: number;
  readonly turn: {
    readonly id: number;
    readonly index: number;
  };
  readonly modelId?: string;
  readonly toolNames: ReadonlyArray<string>;
  readonly toolChoice?: string;
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

export type DeterministicToolExecution = Extract<ToolExecution, { readonly kind: "deterministic" }>;
export type ExternalToolExecution = Extract<ToolExecution, { readonly kind: "external" }>;
export type ExternalReceiptAnchorRef = AnchorRef & { readonly anchorKind: "external_receipt" };

export type DeterministicToolExecutedPayload = Omit<ToolExecutedPayload, "execution" | "claim"> & {
  readonly execution: DeterministicToolExecution;
  readonly claim: LivedClaim;
};

export type ExternalToolExecutedPayload = Omit<ToolExecutedPayload, "execution" | "claim"> & {
  readonly execution: ExternalToolExecution;
  readonly claim: LivedClaim;
};

export interface ToolResultSnapshot {
  readonly kind: "tool.result";
  readonly version: typeof TOOL_RESULT_SNAPSHOT_VERSION;
  readonly runId: number;
  readonly toolCallId: string;
  readonly name: string;
  readonly args: unknown;
  readonly execution: ToolExecution;
  readonly result: unknown;
  readonly claim: LivedClaim;
  readonly traceContext?: TraceContext;
}

export interface ExternalToolExecutionReceipt {
  readonly kind: "tool.execution.receipt";
  readonly version: typeof EXTERNAL_TOOL_EXECUTION_RECEIPT_VERSION;
  readonly runId: number;
  readonly toolCallId: string;
  readonly name: string;
  readonly args: unknown;
  readonly execution: ExternalToolExecution;
  readonly result: unknown;
  readonly claim: LivedClaim;
  readonly idempotencyKey: string;
  readonly receipt: ExternalReceiptAnchorRef;
  readonly traceContext?: TraceContext;
}

export interface ReceiptBackedToolResult {
  readonly kind: "tool.receipt_backed_result";
  readonly version: typeof RECEIPT_BACKED_TOOL_RESULT_VERSION;
  readonly result: unknown;
  readonly claim: LivedClaim;
  readonly idempotencyKey: string;
  readonly receipt: ExternalReceiptAnchorRef;
}

export type ToolReplayArtifact = ToolResultSnapshot | ExternalToolExecutionReceipt;

export type ExternalToolExecutionReceiptFromExecutedPayloadResult =
  | {
      readonly ok: true;
      readonly artifact: ExternalToolExecutionReceipt;
    }
  | {
      readonly ok: false;
      readonly reason: typeof EXTERNAL_TOOL_REPLAY_REQUIRES_RECEIPT_REASON;
      readonly execution: ExternalToolExecution;
      readonly claim: LivedClaim;
    };

export type ToolResultReplayOutcome = {
  readonly ok: true;
  readonly result: unknown;
  readonly claim: LivedClaim;
};

export type ExternalToolReceiptReplayOutcome = {
  readonly ok: true;
  readonly result: unknown;
  readonly claim: LivedClaim;
  readonly idempotencyKey: string;
  readonly receipt: ExternalReceiptAnchorRef;
};

export type ToolReplayArtifactFromExecutedPayloadResult =
  | {
      readonly ok: true;
      readonly artifact: ToolReplayArtifact;
    }
  | {
      readonly ok: false;
      readonly reason: typeof TOOL_EXECUTION_CLAIM_MUST_BE_LIVED_REASON;
      readonly claim: unknown;
    }
  | {
      readonly ok: false;
      readonly reason: typeof EXTERNAL_TOOL_REPLAY_REQUIRES_RECEIPT_REASON;
      readonly execution: ExternalToolExecution;
      readonly claim: LivedClaim;
    };

export type ToolReplayOutcome = ToolResultReplayOutcome | ExternalToolReceiptReplayOutcome;

export type ToolRejectedPayload = {
  readonly runId: number;
  readonly toolCallId: string;
  readonly name: string;
  readonly args: unknown;
  readonly execution: ToolExecution;
  readonly claim: unknown;
  readonly diagnostics?: ToolRejectedDiagnostics;
  readonly traceContext?: TraceContext;
};

export const TOOL_REJECTED_DIAGNOSTICS_PHASES = [
  "parse",
  "decode",
  "policy",
  "material",
  "admit",
  "execution",
] as const;

export type ToolRejectedDiagnosticsPhase = (typeof TOOL_REJECTED_DIAGNOSTICS_PHASES)[number];

export interface ToolArgumentSummary {
  readonly type: string;
  readonly keys?: ReadonlyArray<string>;
  readonly bytes?: number;
  readonly truncated?: boolean;
}

export interface ToolRejectedDiagnostics {
  readonly phase: ToolRejectedDiagnosticsPhase;
  readonly reason: string;
  readonly argumentSummary?: ToolArgumentSummary;
  readonly schemaIssues?: ReadonlyArray<AgentSchemaIssue>;
}

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

export type RuntimeCompletedAfterToolsPayload = {
  readonly runId: number;
  readonly turn: {
    readonly id: number;
    readonly index: number;
  };
  readonly toolNames: ReadonlyArray<string>;
  readonly tokensUsed: number;
  readonly traceContext?: TraceContext;
};

export type RuntimeHistoryCompactedPayload = {
  readonly runId: number;
  readonly turn: {
    readonly id: number;
    readonly index: number;
  };
  readonly sourceEventId: number;
  readonly target: {
    readonly kind: "tool_call_arguments";
    readonly toolCallId: string;
    readonly toolName: string;
  };
  readonly strategy: "provider_history_string_redaction";
  readonly originalBytes: number;
  readonly compactedBytes: number;
  readonly traceContext?: TraceContext;
};

export type RuntimeRekeyedPayload = {
  readonly runId: number;
  readonly sourceEventId: number;
  readonly sourceKeyRef: string;
  readonly targetKeyRef: string;
  readonly purpose: string;
  readonly traceContext?: TraceContext;
};

export type AgentRunInterruptedPayload = {
  readonly runId: number;
  readonly turn: {
    readonly id: number;
    readonly index: number;
  };
  readonly interruptId: string;
  readonly reason: string;
  readonly resumeSchema: unknown;
  readonly tokensUsed: number;
  readonly decision?: {
    readonly gateRef: string;
    readonly subjectRef: string;
    readonly toolCallId: string;
    readonly toolName: string;
  };
  readonly traceContext?: TraceContext;
};

export type AgentRunResumedPayload = {
  readonly runId: number;
  readonly turn: {
    readonly id: number;
    readonly index: number;
  };
  readonly interruptId: string;
  readonly resume: InputRequestResumePayload;
  readonly resumedAtEventId: number;
  readonly traceContext?: TraceContext;
};

export type AgentRunAbortedPayload = {
  readonly runId: number;
  readonly tokensUsed: number;
  readonly traceContext?: TraceContext;
} & Readonly<Record<string, unknown>>;

export const AgentRunStartedPayloadSchema: Schema.Decoder<AgentRunStartedPayload> = Schema.Struct({
  intent: Schema.String,
  executionIdentity: Schema.optional(ExecutionIdentitySchema),
  traceContext: Schema.optional(TraceContextSchema),
});

export const ChatIngestedPayloadSchema: Schema.Decoder<ChatIngestedPayload> = Schema.Struct({
  runId: positiveInt,
  intent: Schema.String,
  context: Schema.Unknown,
  traceContext: Schema.optional(TraceContextSchema),
});

export const LlmResponsePayloadSchema: Schema.Decoder<LlmResponsePayload> = Schema.Struct({
  turn: TurnRefSchema,
  items: Schema.Array(LlmOutputItemSchema),
  usage: LlmUsageSchema,
  traceContext: Schema.optional(TraceContextSchema),
});

export const LlmRequestedPayloadSchema: Schema.Decoder<LlmRequestedPayload> = Schema.Struct({
  runId: positiveInt,
  turn: TurnRefSchema,
  modelId: Schema.optional(nonEmptyString),
  toolNames: Schema.Array(nonEmptyString),
  toolChoice: Schema.optional(nonEmptyString),
  traceContext: Schema.optional(TraceContextSchema),
}).pipe(Schema.check(Schema.makeFilter((payload) => payload.runId === payload.turn.id)));

export const ToolExecutedPayloadSchema: Schema.Decoder<ToolExecutedPayload> = Schema.Struct({
  runId: positiveInt,
  toolCallId: Schema.String,
  name: Schema.String,
  args: Schema.Unknown,
  execution: ToolExecutionSchema,
  result: Schema.Unknown,
  claim: Schema.Unknown,
  traceContext: Schema.optional(TraceContextSchema),
});

export const ToolRejectedPayloadSchema: Schema.Decoder<ToolRejectedPayload> = Schema.Struct({
  runId: positiveInt,
  toolCallId: Schema.String,
  name: Schema.String,
  args: Schema.Unknown,
  execution: ToolExecutionSchema,
  claim: Schema.Unknown,
  diagnostics: Schema.optional(
    Schema.Struct({
      phase: Schema.Literals(TOOL_REJECTED_DIAGNOSTICS_PHASES),
      reason: nonEmptyString,
      argumentSummary: Schema.optional(
        Schema.Struct({
          type: nonEmptyString,
          keys: Schema.optional(Schema.Array(Schema.String)),
          bytes: Schema.optional(nonNegativeInt),
          truncated: Schema.optional(Schema.Boolean),
        }),
      ),
      schemaIssues: Schema.optional(
        Schema.Array(Schema.Struct({ path: Schema.String, issue: Schema.String })),
      ),
    }),
  ),
  traceContext: Schema.optional(TraceContextSchema),
});

export const AgentRunCompletedPayloadSchema: Schema.Decoder<AgentRunCompletedPayload> =
  Schema.Struct({
    runId: positiveInt,
    final: Schema.String,
    output: Schema.Unknown,
    outputKind: Schema.Literals(["text", "json"]),
    tokensUsed: nonNegativeInt,
    turn: Schema.optional(TurnRefSchema),
    traceContext: Schema.optional(TraceContextSchema),
  });

export const RuntimeCompletedAfterToolsPayloadSchema: Schema.Decoder<RuntimeCompletedAfterToolsPayload> =
  Schema.Struct({
    runId: positiveInt,
    turn: TurnRefSchema,
    toolNames: Schema.Array(nonEmptyString),
    tokensUsed: nonNegativeInt,
    traceContext: Schema.optional(TraceContextSchema),
  }).pipe(Schema.check(Schema.makeFilter((payload) => payload.runId === payload.turn.id)));

export const RuntimeHistoryCompactedPayloadSchema: Schema.Decoder<RuntimeHistoryCompactedPayload> =
  Schema.Struct({
    runId: positiveInt,
    turn: TurnRefSchema,
    sourceEventId: positiveInt,
    target: Schema.Struct({
      kind: Schema.Literal("tool_call_arguments"),
      toolCallId: nonEmptyString,
      toolName: nonEmptyString,
    }),
    strategy: Schema.Literal("provider_history_string_redaction"),
    originalBytes: positiveInt,
    compactedBytes: nonNegativeInt,
    traceContext: Schema.optional(TraceContextSchema),
  }).pipe(
    Schema.check(
      Schema.makeFilter(
        (payload) =>
          payload.runId === payload.turn.id && payload.compactedBytes < payload.originalBytes,
      ),
    ),
  );

export const RuntimeRekeyedPayloadSchema: Schema.Decoder<RuntimeRekeyedPayload> = Schema.Struct({
  runId: positiveInt,
  sourceEventId: positiveInt,
  sourceKeyRef: nonEmptyString,
  targetKeyRef: nonEmptyString,
  purpose: nonEmptyString,
  traceContext: Schema.optional(TraceContextSchema),
}).pipe(
  Schema.check(Schema.makeFilter((payload) => payload.sourceKeyRef !== payload.targetKeyRef)),
);

export const AgentRunInterruptedPayloadSchema: Schema.Decoder<AgentRunInterruptedPayload> =
  Schema.Struct({
    runId: positiveInt,
    turn: TurnRefSchema,
    interruptId: nonEmptyString,
    reason: nonEmptyString,
    resumeSchema: Schema.Unknown,
    tokensUsed: nonNegativeInt,
    decision: Schema.optional(
      Schema.Struct({
        gateRef: nonEmptyString,
        subjectRef: nonEmptyString,
        toolCallId: nonEmptyString,
        toolName: nonEmptyString,
      }),
    ),
    traceContext: Schema.optional(TraceContextSchema),
  }).pipe(Schema.check(Schema.makeFilter((payload) => payload.runId === payload.turn.id)));

export const AgentRunResumedPayloadSchema: Schema.Decoder<AgentRunResumedPayload> = Schema.Struct({
  runId: positiveInt,
  turn: TurnRefSchema,
  interruptId: nonEmptyString,
  resume: InputRequestResumePayloadSchema,
  resumedAtEventId: positiveInt,
  traceContext: Schema.optional(TraceContextSchema),
}).pipe(Schema.check(Schema.makeFilter((payload) => payload.runId === payload.turn.id)));

export const AgentRunAbortedPayloadSchema: Schema.Decoder<AgentRunAbortedPayload> =
  Schema.StructWithRest(
    Schema.Struct({
      runId: positiveInt,
      tokensUsed: nonNegativeInt,
      traceContext: Schema.optional(TraceContextSchema),
    }),
    [unknownRecord],
  );

export type RuntimeEventPayloadByKind = {
  readonly [RUNTIME_EVENT_KIND.AGENT_RUN_STARTED]: AgentRunStartedPayload;
  readonly [RUNTIME_EVENT_KIND.AGENT_RUN_INTERRUPTED]: AgentRunInterruptedPayload;
  readonly [RUNTIME_EVENT_KIND.AGENT_RUN_RESUMED]: AgentRunResumedPayload;
  readonly [RUNTIME_EVENT_KIND.CHAT_INGESTED]: ChatIngestedPayload;
  readonly [RUNTIME_EVENT_KIND.LLM_REQUESTED]: LlmRequestedPayload;
  readonly [RUNTIME_EVENT_KIND.LLM_RESPONSE]: LlmResponsePayload;
  readonly [RUNTIME_EVENT_KIND.TOOL_EXECUTED]: ToolExecutedPayload;
  readonly [RUNTIME_EVENT_KIND.TOOL_REJECTED]: ToolRejectedPayload;
  readonly [RUNTIME_EVENT_KIND.RUNTIME_HISTORY_COMPACTED]: RuntimeHistoryCompactedPayload;
  readonly [RUNTIME_EVENT_KIND.RUNTIME_REKEYED]: RuntimeRekeyedPayload;
  readonly [RUNTIME_EVENT_KIND.RUNTIME_COMPLETED_AFTER_TOOLS]: RuntimeCompletedAfterToolsPayload;
  readonly [RUNTIME_EVENT_KIND.AGENT_RUN_COMPLETED]: AgentRunCompletedPayload;
  readonly [ABORT.BUDGET_TOKENS]: AgentRunAbortedPayload;
  readonly [ABORT.BUDGET_TIME]: AgentRunAbortedPayload;
  readonly [ABORT.TOOL_ERROR]: AgentRunAbortedPayload;
  readonly [ABORT.UPSTREAM_FAILURE]: AgentRunAbortedPayload;
  readonly [ABORT.RETRIES]: AgentRunAbortedPayload;
  readonly [ABORT.CLIENT_DISCONNECT]: AgentRunAbortedPayload;
};

type RuntimeLedgerEventShapeByKind<K extends RuntimeEventKind> = Omit<
  LedgerEvent,
  "kind" | "payload"
> & {
  readonly kind: K;
  readonly payload: RuntimeEventPayloadByKind[K];
};

export type RuntimeLedgerEventByKind<K extends RuntimeEventKind> = K extends RuntimeEventKind
  ? RuntimeLedgerEventShapeByKind<K> & Recorded<RuntimeLedgerEventShapeByKind<K>>
  : never;

export type RuntimeLedgerEvent = {
  readonly [K in RuntimeEventKind]: RuntimeLedgerEventByKind<K>;
}[RuntimeEventKind];

type RuntimeEventCommitSpecShapeByKind<K extends RuntimeEventKind> = {
  readonly ts?: number;
  readonly kind: K;
  readonly payload: RuntimeEventPayloadByKind[K];
  readonly scopeRef: ScopeRef;
  readonly effectAuthorityRef: AuthorityRef;
  readonly factOwnerRef?: never;
  readonly scope?: never;
};

export type RuntimeEventCommitSpecByKind<K extends RuntimeEventKind> = K extends RuntimeEventKind
  ? RuntimeEventCommitSpecShapeByKind<K> & Recorded<RuntimeEventCommitSpecShapeByKind<K>>
  : never;

export type RuntimeEventCommitSpec = {
  readonly [K in RuntimeEventKind]: RuntimeEventCommitSpecByKind<K>;
}[RuntimeEventKind];

const recordRuntimeEventCommitSpec = <K extends RuntimeEventKind>(
  value: RuntimeEventCommitSpecShapeByKind<K>,
): RuntimeEventCommitSpecByKind<K> =>
  recordRuntimeProtocolValue(value) as RuntimeEventCommitSpecByKind<K>;

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
    case RUNTIME_EVENT_KIND.AGENT_RUN_INTERRUPTED:
      return Schema.decodeUnknownSync(AgentRunInterruptedPayloadSchema)(
        payload,
      ) as RuntimeEventPayloadByKind[K];
    case RUNTIME_EVENT_KIND.AGENT_RUN_RESUMED:
      return Schema.decodeUnknownSync(AgentRunResumedPayloadSchema)(
        payload,
      ) as RuntimeEventPayloadByKind[K];
    case RUNTIME_EVENT_KIND.CHAT_INGESTED:
      return Schema.decodeUnknownSync(ChatIngestedPayloadSchema)(
        payload,
      ) as RuntimeEventPayloadByKind[K];
    case RUNTIME_EVENT_KIND.LLM_REQUESTED:
      return Schema.decodeUnknownSync(LlmRequestedPayloadSchema)(
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
    case RUNTIME_EVENT_KIND.RUNTIME_HISTORY_COMPACTED:
      return Schema.decodeUnknownSync(RuntimeHistoryCompactedPayloadSchema)(
        payload,
      ) as RuntimeEventPayloadByKind[K];
    case RUNTIME_EVENT_KIND.RUNTIME_REKEYED:
      return Schema.decodeUnknownSync(RuntimeRekeyedPayloadSchema)(
        payload,
      ) as RuntimeEventPayloadByKind[K];
    case RUNTIME_EVENT_KIND.RUNTIME_COMPLETED_AFTER_TOOLS:
      return Schema.decodeUnknownSync(RuntimeCompletedAfterToolsPayloadSchema)(
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

const decodeRuntimePayloadOption = <K extends RuntimeEventKind>(
  kind: K,
  payload: unknown,
): Option.Option<RuntimeEventPayloadByKind[K]> => {
  switch (kind) {
    case RUNTIME_EVENT_KIND.AGENT_RUN_STARTED:
      return Schema.decodeUnknownOption(AgentRunStartedPayloadSchema)(payload) as Option.Option<
        RuntimeEventPayloadByKind[K]
      >;
    case RUNTIME_EVENT_KIND.AGENT_RUN_INTERRUPTED:
      return Schema.decodeUnknownOption(AgentRunInterruptedPayloadSchema)(payload) as Option.Option<
        RuntimeEventPayloadByKind[K]
      >;
    case RUNTIME_EVENT_KIND.AGENT_RUN_RESUMED:
      return Schema.decodeUnknownOption(AgentRunResumedPayloadSchema)(payload) as Option.Option<
        RuntimeEventPayloadByKind[K]
      >;
    case RUNTIME_EVENT_KIND.CHAT_INGESTED:
      return Schema.decodeUnknownOption(ChatIngestedPayloadSchema)(payload) as Option.Option<
        RuntimeEventPayloadByKind[K]
      >;
    case RUNTIME_EVENT_KIND.LLM_REQUESTED:
      return Schema.decodeUnknownOption(LlmRequestedPayloadSchema)(payload) as Option.Option<
        RuntimeEventPayloadByKind[K]
      >;
    case RUNTIME_EVENT_KIND.LLM_RESPONSE:
      return Schema.decodeUnknownOption(LlmResponsePayloadSchema)(payload) as Option.Option<
        RuntimeEventPayloadByKind[K]
      >;
    case RUNTIME_EVENT_KIND.TOOL_EXECUTED:
      return Schema.decodeUnknownOption(ToolExecutedPayloadSchema)(payload) as Option.Option<
        RuntimeEventPayloadByKind[K]
      >;
    case RUNTIME_EVENT_KIND.TOOL_REJECTED:
      return Schema.decodeUnknownOption(ToolRejectedPayloadSchema)(payload) as Option.Option<
        RuntimeEventPayloadByKind[K]
      >;
    case RUNTIME_EVENT_KIND.RUNTIME_HISTORY_COMPACTED:
      return Schema.decodeUnknownOption(RuntimeHistoryCompactedPayloadSchema)(
        payload,
      ) as Option.Option<RuntimeEventPayloadByKind[K]>;
    case RUNTIME_EVENT_KIND.RUNTIME_REKEYED:
      return Schema.decodeUnknownOption(RuntimeRekeyedPayloadSchema)(payload) as Option.Option<
        RuntimeEventPayloadByKind[K]
      >;
    case RUNTIME_EVENT_KIND.RUNTIME_COMPLETED_AFTER_TOOLS:
      return Schema.decodeUnknownOption(RuntimeCompletedAfterToolsPayloadSchema)(
        payload,
      ) as Option.Option<RuntimeEventPayloadByKind[K]>;
    case RUNTIME_EVENT_KIND.AGENT_RUN_COMPLETED:
      return Schema.decodeUnknownOption(AgentRunCompletedPayloadSchema)(payload) as Option.Option<
        RuntimeEventPayloadByKind[K]
      >;
    case ABORT.BUDGET_TOKENS:
    case ABORT.BUDGET_TIME:
    case ABORT.TOOL_ERROR:
    case ABORT.UPSTREAM_FAILURE:
    case ABORT.RETRIES:
    case ABORT.CLIENT_DISCONNECT:
      return Schema.decodeUnknownOption(AgentRunAbortedPayloadSchema)(payload) as Option.Option<
        RuntimeEventPayloadByKind[K]
      >;
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
  const decodedEvent = recordRuntimeProtocolValue({
    ...event,
    kind: event.kind,
    payload: decodeRuntimePayload(event.kind, event.payload),
  } as RuntimeLedgerEventShapeByKind<typeof event.kind>);
  return {
    _tag: "runtime",
    event: decodedEvent as RuntimeLedgerEvent,
  };
};

export type RuntimeLedgerTransitionIssueCode =
  | "runtime_payload_invalid"
  | "runtime_interrupt_duplicate"
  | "runtime_resume_consumed_gate_mismatch"
  | "runtime_resume_interruption_already_consumed"
  | "runtime_resume_interruption_missing"
  | "runtime_resume_interruption_turn_mismatch"
  | "runtime_run_already_terminal"
  | "runtime_run_duplicate_start"
  | "runtime_run_duplicate_terminal"
  | "runtime_run_missing_start"
  | "runtime_source_event_not_before"
  | "runtime_source_event_missing"
  | "runtime_source_event_not_runtime"
  | "runtime_source_payload_invalid"
  | "runtime_compaction_source_kind_mismatch"
  | "runtime_compaction_source_turn_mismatch"
  | "runtime_resume_consumed_event_kind_mismatch";

export type RuntimeLedgerTransitionIssue = {
  readonly code: RuntimeLedgerTransitionIssueCode;
  readonly eventId: number;
  readonly eventKind: string;
  readonly sourceEventId?: number;
  readonly sourceKind?: string;
  readonly message: string;
};

export type RuntimeLedgerTransitionValidation =
  | {
      readonly ok: true;
    }
  | {
      readonly ok: false;
      readonly issues: ReadonlyArray<RuntimeLedgerTransitionIssue>;
    };

export class RuntimeLedgerTransitionRejected extends Data.TaggedError(
  "agent_os.runtime_ledger_transition_rejected",
)<{
  readonly issues: ReadonlyArray<RuntimeLedgerTransitionIssue>;
}> {}

const decodeRuntimeLedgerEventSafe = (
  event: LedgerEvent,
): DecodeRuntimeLedgerEventResult | null => {
  if (!isRuntimeEventKind(event.kind)) {
    return { _tag: "non_runtime", event };
  }
  const payload = decodeRuntimePayloadOption(event.kind, event.payload);
  if (Option.isNone(payload)) return null;
  const decodedEvent = recordRuntimeProtocolValue({
    ...event,
    kind: event.kind,
    payload: payload.value,
  } as RuntimeLedgerEventShapeByKind<typeof event.kind>);
  return {
    _tag: "runtime",
    event: decodedEvent as RuntimeLedgerEvent,
  };
};

const sourceEventIssue = (
  code: RuntimeLedgerTransitionIssueCode,
  event: RuntimeLedgerEvent,
  sourceEventId: number,
  message: string,
  sourceKind?: string,
): RuntimeLedgerTransitionIssue => ({
  code,
  eventId: event.id,
  eventKind: event.kind,
  sourceEventId,
  ...(sourceKind === undefined ? {} : { sourceKind }),
  message,
});

const transitionSourceEvent = (
  priorById: ReadonlyMap<number, LedgerEvent>,
  event: RuntimeLedgerEvent,
  sourceEventId: number,
  issues: RuntimeLedgerTransitionIssue[],
): LedgerEvent | null => {
  if (sourceEventId >= event.id) {
    issues.push(
      sourceEventIssue(
        "runtime_source_event_not_before",
        event,
        sourceEventId,
        "runtime source event must be committed before the referencing event",
      ),
    );
    return null;
  }
  const source = priorById.get(sourceEventId);
  if (source === undefined) {
    issues.push(
      sourceEventIssue(
        "runtime_source_event_missing",
        event,
        sourceEventId,
        "runtime source event must exist before the referencing event",
      ),
    );
    return null;
  }
  return source;
};

const decodedRuntimeSourceEvent = (
  priorById: ReadonlyMap<number, LedgerEvent>,
  event: RuntimeLedgerEvent,
  sourceEventId: number,
  issues: RuntimeLedgerTransitionIssue[],
): RuntimeLedgerEvent | null => {
  const source = transitionSourceEvent(priorById, event, sourceEventId, issues);
  if (source === null) return null;
  const decoded = decodeRuntimeLedgerEventSafe(source);
  if (decoded === null) {
    issues.push(
      sourceEventIssue(
        "runtime_source_payload_invalid",
        event,
        sourceEventId,
        "runtime transition source payload must decode as runtime event payload",
        source.kind,
      ),
    );
    return null;
  }
  if (decoded._tag === "non_runtime") {
    issues.push(
      sourceEventIssue(
        "runtime_source_event_not_runtime",
        event,
        sourceEventId,
        "runtime transition source must be a runtime event",
        source.kind,
      ),
    );
    return null;
  }
  return decoded.event;
};

const sameTurn = (
  left: { readonly id: number; readonly index: number },
  right: { readonly id: number; readonly index: number },
): boolean => left.id === right.id && left.index === right.index;

type RuntimeRunInterruptionState = {
  readonly eventId: number;
  readonly turn: { readonly id: number; readonly index: number };
  readonly decision?: { readonly gateRef: string };
  consumedEventId?: number;
};

type RuntimeRunState = {
  startedEventId?: number;
  terminalEventId?: number;
  terminalKind?: string;
  readonly interruptions: Map<string, RuntimeRunInterruptionState>;
};

const makeRuntimeRunState = (): RuntimeRunState => ({
  interruptions: new Map(),
});

const runtimeRunId = (event: RuntimeLedgerEvent): number => {
  switch (event.kind) {
    case RUNTIME_EVENT_KIND.AGENT_RUN_STARTED:
      return event.id;
    case RUNTIME_EVENT_KIND.LLM_RESPONSE:
      return event.payload.turn.id;
    case RUNTIME_EVENT_KIND.AGENT_RUN_INTERRUPTED:
    case RUNTIME_EVENT_KIND.AGENT_RUN_RESUMED:
    case RUNTIME_EVENT_KIND.CHAT_INGESTED:
    case RUNTIME_EVENT_KIND.LLM_REQUESTED:
    case RUNTIME_EVENT_KIND.TOOL_EXECUTED:
    case RUNTIME_EVENT_KIND.TOOL_REJECTED:
    case RUNTIME_EVENT_KIND.RUNTIME_HISTORY_COMPACTED:
    case RUNTIME_EVENT_KIND.RUNTIME_REKEYED:
    case RUNTIME_EVENT_KIND.RUNTIME_COMPLETED_AFTER_TOOLS:
    case RUNTIME_EVENT_KIND.AGENT_RUN_COMPLETED:
    case ABORT.BUDGET_TOKENS:
    case ABORT.BUDGET_TIME:
    case ABORT.TOOL_ERROR:
    case ABORT.UPSTREAM_FAILURE:
    case ABORT.RETRIES:
    case ABORT.CLIENT_DISCONNECT:
      return event.payload.runId;
  }
};

const isRunTerminalKind = (kind: RuntimeEventKind): boolean =>
  kind === RUNTIME_EVENT_KIND.AGENT_RUN_COMPLETED || isRuntimeAbortEventKind(kind);

const runTransitionIssue = (
  code: RuntimeLedgerTransitionIssueCode,
  event: RuntimeLedgerEvent,
  message: string,
  sourceEventId?: number,
  sourceKind?: string,
): RuntimeLedgerTransitionIssue => ({
  code,
  eventId: event.id,
  eventKind: event.kind,
  ...(sourceEventId === undefined ? {} : { sourceEventId }),
  ...(sourceKind === undefined ? {} : { sourceKind }),
  message,
});

const runStateFor = (states: Map<number, RuntimeRunState>, runId: number): RuntimeRunState => {
  const existing = states.get(runId);
  if (existing !== undefined) return existing;
  const state = makeRuntimeRunState();
  states.set(runId, state);
  return state;
};

const consumedGateRef = (event: LedgerEvent): string | null => {
  if (!Predicate.isObject(event.payload)) return null;
  const gateRef = (event.payload as { readonly gateRef?: unknown }).gateRef;
  return typeof gateRef === "string" && gateRef.length > 0 ? gateRef : null;
};

const consumedDecisionRef = (event: LedgerEvent): string | null => {
  if (!Predicate.isObject(event.payload)) return null;
  const decisionRef = (event.payload as { readonly decisionRef?: unknown }).decisionRef;
  return typeof decisionRef === "string" && decisionRef.length > 0 ? decisionRef : null;
};

const applyHistoricalRuntimeRunEvent = (
  states: Map<number, RuntimeRunState>,
  event: RuntimeLedgerEvent,
): void => {
  const runId = runtimeRunId(event);
  const state = runStateFor(states, runId);
  switch (event.kind) {
    case RUNTIME_EVENT_KIND.AGENT_RUN_STARTED:
      state.startedEventId ??= event.id;
      break;
    case RUNTIME_EVENT_KIND.AGENT_RUN_INTERRUPTED:
      if (!state.interruptions.has(event.payload.interruptId)) {
        state.interruptions.set(event.payload.interruptId, {
          eventId: event.id,
          turn: event.payload.turn,
          ...(event.payload.decision === undefined
            ? {}
            : { decision: { gateRef: event.payload.decision.gateRef } }),
        });
      }
      break;
    case RUNTIME_EVENT_KIND.AGENT_RUN_RESUMED: {
      const interruption = state.interruptions.get(event.payload.interruptId);
      if (interruption !== undefined && sameTurn(interruption.turn, event.payload.turn)) {
        interruption.consumedEventId ??= event.payload.resumedAtEventId;
      }
      break;
    }
    case RUNTIME_EVENT_KIND.AGENT_RUN_COMPLETED:
    case ABORT.BUDGET_TOKENS:
    case ABORT.BUDGET_TIME:
    case ABORT.TOOL_ERROR:
    case ABORT.UPSTREAM_FAILURE:
    case ABORT.RETRIES:
    case ABORT.CLIENT_DISCONNECT:
      state.terminalEventId ??= event.id;
      state.terminalKind ??= event.kind;
      break;
    default:
      break;
  }
};

/**
 * Runtime L0 transition interpreter.
 *
 * The payload schemas above validate event-local shape. This predicate validates
 * cross-event laws for newly appended runtime facts against already-recorded
 * facts plus earlier events in the same append batch.
 */
export const validateRuntimeLedgerTransitions = (input: {
  readonly history: ReadonlyArray<LedgerEvent>;
  readonly events: ReadonlyArray<LedgerEvent>;
}): RuntimeLedgerTransitionValidation => {
  const priorById = new Map(input.history.map((event) => [event.id, event] as const));
  const runStates = new Map<number, RuntimeRunState>();
  const issues: RuntimeLedgerTransitionIssue[] = [];

  for (const historical of input.history) {
    const decoded = decodeRuntimeLedgerEventSafe(historical);
    if (decoded?._tag === "runtime") {
      applyHistoricalRuntimeRunEvent(runStates, decoded.event);
    }
  }

  for (const candidate of input.events) {
    const decoded = decodeRuntimeLedgerEventSafe(candidate);
    if (decoded === null) {
      issues.push({
        code: "runtime_payload_invalid",
        eventId: candidate.id,
        eventKind: candidate.kind,
        message: "runtime event payload must decode before ledger append",
      });
      continue;
    }
    if (decoded._tag === "non_runtime") {
      priorById.set(candidate.id, candidate);
      continue;
    }

    const event = decoded.event;
    const runId = runtimeRunId(event);
    const runState = runStateFor(runStates, runId);
    const hasStarted = runState.startedEventId !== undefined;
    const hasTerminal = runState.terminalEventId !== undefined;

    switch (event.kind) {
      case RUNTIME_EVENT_KIND.AGENT_RUN_STARTED:
        if (hasStarted) {
          issues.push(
            runTransitionIssue(
              "runtime_run_duplicate_start",
              event,
              "agent.run.started must be the first and only start fact for a run",
              runState.startedEventId,
            ),
          );
        } else if (hasTerminal) {
          issues.push(
            runTransitionIssue(
              "runtime_run_already_terminal",
              event,
              "runtime run cannot start after a terminal fact",
              runState.terminalEventId,
              runState.terminalKind,
            ),
          );
        } else {
          runState.startedEventId = event.id;
        }
        break;
      default:
        if (!hasStarted) {
          issues.push(
            runTransitionIssue(
              "runtime_run_missing_start",
              event,
              "runtime run-bound event requires a prior agent.run.started fact",
            ),
          );
        }
        if (hasTerminal) {
          issues.push(
            runTransitionIssue(
              isRunTerminalKind(event.kind)
                ? "runtime_run_duplicate_terminal"
                : "runtime_run_already_terminal",
              event,
              isRunTerminalKind(event.kind)
                ? "runtime run cannot record more than one terminal fact"
                : "runtime run-bound event cannot be recorded after a terminal fact",
              runState.terminalEventId,
              runState.terminalKind,
            ),
          );
        }
        break;
    }

    switch (event.kind) {
      case RUNTIME_EVENT_KIND.RUNTIME_HISTORY_COMPACTED: {
        const source = decodedRuntimeSourceEvent(
          priorById,
          event,
          event.payload.sourceEventId,
          issues,
        );
        if (source !== null) {
          if (source.kind !== RUNTIME_EVENT_KIND.LLM_RESPONSE) {
            issues.push(
              sourceEventIssue(
                "runtime_compaction_source_kind_mismatch",
                event,
                event.payload.sourceEventId,
                "runtime history compaction source must be the llm.response that carried the tool call arguments",
                source.kind,
              ),
            );
          } else if (!sameTurn(source.payload.turn, event.payload.turn)) {
            issues.push(
              sourceEventIssue(
                "runtime_compaction_source_turn_mismatch",
                event,
                event.payload.sourceEventId,
                "runtime history compaction source turn must match the compaction turn",
                source.kind,
              ),
            );
          }
        }
        break;
      }
      case RUNTIME_EVENT_KIND.RUNTIME_REKEYED: {
        transitionSourceEvent(priorById, event, event.payload.sourceEventId, issues);
        break;
      }
      case RUNTIME_EVENT_KIND.AGENT_RUN_RESUMED: {
        const source = transitionSourceEvent(
          priorById,
          event,
          event.payload.resumedAtEventId,
          issues,
        );
        if (source !== null && source.kind !== DECISION_GATE_CONSUMED_EVENT_KIND) {
          issues.push(
            sourceEventIssue(
              "runtime_resume_consumed_event_kind_mismatch",
              event,
              event.payload.resumedAtEventId,
              "agent.run.resumed must reference the decision_gate.consumed event that authorized resume",
              source.kind,
            ),
          );
        }
        const interruption = runState.interruptions.get(event.payload.interruptId);
        if (interruption === undefined) {
          issues.push(
            runTransitionIssue(
              "runtime_resume_interruption_missing",
              event,
              "agent.run.resumed must match a prior agent.run.interrupted fact for the same run",
            ),
          );
        } else {
          if (!sameTurn(interruption.turn, event.payload.turn)) {
            issues.push(
              runTransitionIssue(
                "runtime_resume_interruption_turn_mismatch",
                event,
                "agent.run.resumed turn must match the interrupted turn",
                interruption.eventId,
                RUNTIME_EVENT_KIND.AGENT_RUN_INTERRUPTED,
              ),
            );
          }
          if (interruption.consumedEventId !== undefined) {
            issues.push(
              runTransitionIssue(
                "runtime_resume_interruption_already_consumed",
                event,
                "agent.run.resumed cannot consume the same interruption more than once",
                interruption.consumedEventId,
                DECISION_GATE_CONSUMED_EVENT_KIND,
              ),
            );
          }
          if (
            source !== null &&
            source.kind === DECISION_GATE_CONSUMED_EVENT_KIND &&
            interruption.decision !== undefined &&
            (consumedGateRef(source) !== interruption.decision.gateRef ||
              consumedDecisionRef(source) === null)
          ) {
            issues.push(
              runTransitionIssue(
                "runtime_resume_consumed_gate_mismatch",
                event,
                "agent.run.resumed must reference the decision_gate.consumed fact for the interrupted gate",
                source.id,
                source.kind,
              ),
            );
          }
          if (
            sameTurn(interruption.turn, event.payload.turn) &&
            interruption.consumedEventId === undefined &&
            source !== null &&
            source.kind === DECISION_GATE_CONSUMED_EVENT_KIND &&
            (interruption.decision === undefined ||
              (consumedGateRef(source) === interruption.decision.gateRef &&
                consumedDecisionRef(source) !== null))
          ) {
            interruption.consumedEventId = event.payload.resumedAtEventId;
          }
        }
        break;
      }
      case RUNTIME_EVENT_KIND.AGENT_RUN_INTERRUPTED: {
        const existing = runState.interruptions.get(event.payload.interruptId);
        if (existing !== undefined) {
          issues.push(
            runTransitionIssue(
              "runtime_interrupt_duplicate",
              event,
              "agent.run.interrupted interruptId must be unique within a run",
              existing.eventId,
              RUNTIME_EVENT_KIND.AGENT_RUN_INTERRUPTED,
            ),
          );
        } else if (hasStarted && !hasTerminal) {
          runState.interruptions.set(event.payload.interruptId, {
            eventId: event.id,
            turn: event.payload.turn,
            ...(event.payload.decision === undefined
              ? {}
              : { decision: { gateRef: event.payload.decision.gateRef } }),
          });
        }
        break;
      }
      case RUNTIME_EVENT_KIND.AGENT_RUN_COMPLETED:
      case ABORT.BUDGET_TOKENS:
      case ABORT.BUDGET_TIME:
      case ABORT.TOOL_ERROR:
      case ABORT.UPSTREAM_FAILURE:
      case ABORT.RETRIES:
      case ABORT.CLIENT_DISCONNECT:
        if (hasStarted && !hasTerminal) {
          runState.terminalEventId = event.id;
          runState.terminalKind = event.kind;
        }
        break;
      default:
        break;
    }
    priorById.set(event.id, event);
  }

  return issues.length === 0 ? { ok: true } : { ok: false, issues };
};

export const assertRuntimeLedgerTransitions = (input: {
  readonly history: ReadonlyArray<LedgerEvent>;
  readonly events: ReadonlyArray<LedgerEvent>;
}): void => {
  const validation = validateRuntimeLedgerTransitions(input);
  if (validation.ok) return;
  return Option.getOrThrowWith(
    Option.none(),
    () => new RuntimeLedgerTransitionRejected({ issues: validation.issues }),
  );
};

const runtimeEvent = <K extends RuntimeEventKind>(
  identity: RuntimeEventIdentitySpec,
  kind: K,
  payload: RuntimeEventPayloadByKind[K],
): RuntimeEventCommitSpecByKind<K> =>
  recordRuntimeEventCommitSpec({
    scopeRef: identity.scopeRef,
    effectAuthorityRef: identity.effectAuthorityRef,
    kind,
    payload: decodeRuntimePayload(kind, payload),
  } as RuntimeEventCommitSpecShapeByKind<K>);

type RuntimeEventIdentitySpec = {
  readonly scopeRef: ScopeRef;
  readonly effectAuthorityRef: AuthorityRef;
  readonly scope?: never;
  readonly factOwnerRef?: never;
};

export const agentRunStartedEvent = (
  spec: RuntimeEventIdentitySpec & {
    readonly intent: string;
    readonly executionIdentity?: ExecutionIdentity;
    readonly traceContext?: TraceContext;
  },
): RuntimeEventCommitSpecByKind<typeof RUNTIME_EVENT_KIND.AGENT_RUN_STARTED> =>
  runtimeEvent(spec, RUNTIME_EVENT_KIND.AGENT_RUN_STARTED, {
    intent: spec.intent,
    ...(spec.executionIdentity === undefined ? {} : { executionIdentity: spec.executionIdentity }),
    ...(spec.traceContext === undefined ? {} : { traceContext: spec.traceContext }),
  });

export const chatIngestedEvent = (
  spec: RuntimeEventIdentitySpec & {
    readonly runId: number;
    readonly intent: string;
    readonly context: unknown;
    readonly traceContext?: TraceContext;
  },
): RuntimeEventCommitSpecByKind<typeof RUNTIME_EVENT_KIND.CHAT_INGESTED> =>
  runtimeEvent(spec, RUNTIME_EVENT_KIND.CHAT_INGESTED, {
    runId: spec.runId,
    intent: spec.intent,
    context: spec.context,
    ...(spec.traceContext === undefined ? {} : { traceContext: spec.traceContext }),
  });

export const agentRunInterruptedEvent = (
  spec: RuntimeEventIdentitySpec & {
    readonly runId: number;
    readonly turn: { readonly id: number; readonly index: number };
    readonly interruptId: string;
    readonly reason: string;
    readonly resumeSchema: unknown;
    readonly tokensUsed: number;
    readonly decision?: {
      readonly gateRef: string;
      readonly subjectRef: string;
      readonly toolCallId: string;
      readonly toolName: string;
    };
    readonly traceContext?: TraceContext;
  },
): RuntimeEventCommitSpecByKind<typeof RUNTIME_EVENT_KIND.AGENT_RUN_INTERRUPTED> =>
  runtimeEvent(spec, RUNTIME_EVENT_KIND.AGENT_RUN_INTERRUPTED, {
    runId: spec.runId,
    turn: spec.turn,
    interruptId: spec.interruptId,
    reason: spec.reason,
    resumeSchema: spec.resumeSchema,
    tokensUsed: spec.tokensUsed,
    ...(spec.decision === undefined ? {} : { decision: spec.decision }),
    ...(spec.traceContext === undefined ? {} : { traceContext: spec.traceContext }),
  });

export const agentRunResumedEvent = (
  spec: RuntimeEventIdentitySpec & {
    readonly runId: number;
    readonly turn: { readonly id: number; readonly index: number };
    readonly interruptId: string;
    readonly resume: InputRequestResumePayload;
    readonly resumedAtEventId: number;
    readonly traceContext?: TraceContext;
  },
): RuntimeEventCommitSpecByKind<typeof RUNTIME_EVENT_KIND.AGENT_RUN_RESUMED> =>
  runtimeEvent(spec, RUNTIME_EVENT_KIND.AGENT_RUN_RESUMED, {
    runId: spec.runId,
    turn: spec.turn,
    interruptId: spec.interruptId,
    resume: spec.resume,
    resumedAtEventId: spec.resumedAtEventId,
    ...(spec.traceContext === undefined ? {} : { traceContext: spec.traceContext }),
  });

export const llmResponseEvent = (
  spec: RuntimeEventIdentitySpec & {
    readonly turn: { readonly id: number; readonly index: number };
    readonly items: ReadonlyArray<LlmOutputItem>;
    readonly usage: LlmUsage;
    readonly traceContext?: TraceContext;
  },
): RuntimeEventCommitSpecByKind<typeof RUNTIME_EVENT_KIND.LLM_RESPONSE> =>
  runtimeEvent(spec, RUNTIME_EVENT_KIND.LLM_RESPONSE, {
    turn: spec.turn,
    items: spec.items,
    usage: spec.usage,
    ...(spec.traceContext === undefined ? {} : { traceContext: spec.traceContext }),
  });

export const llmRequestedEvent = (
  spec: RuntimeEventIdentitySpec & {
    readonly runId: number;
    readonly turn: { readonly id: number; readonly index: number };
    readonly modelId?: string;
    readonly toolNames: ReadonlyArray<string>;
    readonly toolChoice?: string;
    readonly traceContext?: TraceContext;
  },
): RuntimeEventCommitSpecByKind<typeof RUNTIME_EVENT_KIND.LLM_REQUESTED> =>
  runtimeEvent(spec, RUNTIME_EVENT_KIND.LLM_REQUESTED, {
    runId: spec.runId,
    turn: spec.turn,
    ...(spec.modelId === undefined ? {} : { modelId: spec.modelId }),
    toolNames: spec.toolNames,
    ...(spec.toolChoice === undefined ? {} : { toolChoice: spec.toolChoice }),
    ...(spec.traceContext === undefined ? {} : { traceContext: spec.traceContext }),
  });

export const toolExecutedEvent = (
  spec: RuntimeEventIdentitySpec & {
    readonly runId: number;
    readonly toolCallId: string;
    readonly name: string;
    readonly args: unknown;
    readonly execution: ToolExecution;
    readonly result: unknown;
    readonly claim: LivedClaim;
    readonly traceContext?: TraceContext;
  },
): RuntimeEventCommitSpecByKind<typeof RUNTIME_EVENT_KIND.TOOL_EXECUTED> =>
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

const livedClaimFromUnknown = (claim: unknown): LivedClaim | null => {
  const validation = validateEffectClaim(claim);
  return validation.ok && validation.claim.phase === "lived" ? validation.claim : null;
};

const externalReceiptAnchorFromClaim = (claim: LivedClaim): ExternalReceiptAnchorRef | null =>
  claim.anchorRef.anchorKind === "external_receipt"
    ? (claim.anchorRef as ExternalReceiptAnchorRef)
    : null;

const failToolReplayArtifact = (message: string): never =>
  Option.getOrThrowWith(Option.none(), () => new TypeError(message));

export const receiptBackedToolResult = (spec: {
  readonly result: unknown;
  readonly claim: LivedClaim;
  readonly idempotencyKey?: string;
  readonly receipt?: ExternalReceiptAnchorRef;
}): ReceiptBackedToolResult => {
  const receipt = spec.receipt ?? externalReceiptAnchorFromClaim(spec.claim);
  if (receipt === null || receipt.anchorKind !== "external_receipt") {
    return failToolReplayArtifact("receipt-backed tool result requires external_receipt anchor");
  }
  const externalReceipt: ExternalReceiptAnchorRef = receipt;
  return {
    kind: "tool.receipt_backed_result",
    version: RECEIPT_BACKED_TOOL_RESULT_VERSION,
    result: spec.result,
    claim: spec.claim,
    idempotencyKey: spec.idempotencyKey ?? spec.claim.operationRef,
    receipt: externalReceipt,
  };
};

export const receiptBackedToolResultFromUnknown = (
  value: unknown,
): ReceiptBackedToolResult | null => {
  if (!Predicate.isObject(value)) return null;
  if (value.kind !== "tool.receipt_backed_result") return null;
  if (value.version !== RECEIPT_BACKED_TOOL_RESULT_VERSION) return null;
  if (typeof value.idempotencyKey !== "string" || value.idempotencyKey.length === 0) return null;
  const claim = livedClaimFromUnknown(value.claim);
  if (claim === null) return null;
  const receipt = externalReceiptAnchorFromClaim(claim);
  if (receipt === null) return null;
  const declaredReceipt = value.receipt;
  if (
    declaredReceipt !== undefined &&
    (!Predicate.isObject(declaredReceipt) ||
      declaredReceipt.anchorId !== receipt.anchorId ||
      declaredReceipt.anchorKind !== receipt.anchorKind ||
      declaredReceipt.carrierRef !== receipt.carrierRef)
  ) {
    return null;
  }
  return {
    kind: "tool.receipt_backed_result",
    version: RECEIPT_BACKED_TOOL_RESULT_VERSION,
    result: value.result,
    claim,
    idempotencyKey: value.idempotencyKey,
    receipt,
  };
};

export const toolResultSnapshotFromExecutedPayload = (
  payload: Omit<ToolExecutedPayload, "claim"> & { readonly claim: LivedClaim },
  resolved: ResolvedToolExecution,
): ToolResultSnapshot => ({
  kind: "tool.result",
  version: TOOL_RESULT_SNAPSHOT_VERSION,
  runId: payload.runId,
  toolCallId: payload.toolCallId,
  name: payload.name,
  args: payload.args,
  execution: resolved.execution,
  result: payload.result,
  claim: payload.claim,
  ...(payload.traceContext === undefined ? {} : { traceContext: payload.traceContext }),
});

export const externalToolExecutionReceiptFromExecutedPayload = (
  payload: ExternalToolExecutedPayload,
  resolved: Extract<ResolvedToolExecution, { readonly kind: "external" }>,
): ExternalToolExecutionReceiptFromExecutedPayloadResult => {
  const receipt = externalReceiptAnchorFromClaim(payload.claim);
  if (receipt === null) {
    return {
      ok: false,
      reason: EXTERNAL_TOOL_REPLAY_REQUIRES_RECEIPT_REASON,
      execution: payload.execution,
      claim: payload.claim,
    };
  }
  return {
    ok: true,
    artifact: {
      kind: "tool.execution.receipt",
      version: EXTERNAL_TOOL_EXECUTION_RECEIPT_VERSION,
      runId: payload.runId,
      toolCallId: payload.toolCallId,
      name: payload.name,
      args: payload.args,
      execution: resolved.execution,
      result: payload.result,
      claim: payload.claim,
      idempotencyKey: payload.claim.operationRef,
      receipt,
      ...(payload.traceContext === undefined ? {} : { traceContext: payload.traceContext }),
    },
  };
};

export const toolReplayArtifactFromExecutedPayload = (
  payload: ToolExecutedPayload,
  resolved: ResolvedToolExecution,
): ToolReplayArtifactFromExecutedPayloadResult => {
  const claim = livedClaimFromUnknown(payload.claim);
  if (claim === null) {
    return { ok: false, reason: TOOL_EXECUTION_CLAIM_MUST_BE_LIVED_REASON, claim: payload.claim };
  }
  if (resolved.witness === "snapshot") {
    return {
      ok: true,
      artifact: toolResultSnapshotFromExecutedPayload(
        {
          ...payload,
          claim,
        },
        resolved,
      ),
    };
  }
  if (payload.execution.kind === "deterministic") {
    return failToolReplayArtifact("receipt replay witness requires external tool execution");
  }
  if (resolved.kind !== "external") {
    return failToolReplayArtifact(
      "receipt replay witness requires resolved external tool execution",
    );
  }
  return externalToolExecutionReceiptFromExecutedPayload(
    {
      ...payload,
      execution: payload.execution,
      claim,
    },
    resolved,
  );
};

export const replayToolResultFromSnapshot = (
  snapshot: ToolResultSnapshot,
): ToolResultReplayOutcome => ({
  ok: true,
  result: snapshot.result,
  claim: snapshot.claim,
});

export const replayExternalToolExecutionFromReceipt = (
  receipt: ExternalToolExecutionReceipt,
): ExternalToolReceiptReplayOutcome => ({
  ok: true,
  result: receipt.result,
  claim: receipt.claim,
  idempotencyKey: receipt.idempotencyKey,
  receipt: receipt.receipt,
});

export const replayToolFromArtifact = (artifact: ToolReplayArtifact): ToolReplayOutcome =>
  artifact.kind === "tool.result"
    ? replayToolResultFromSnapshot(artifact)
    : replayExternalToolExecutionFromReceipt(artifact);

export const toolRejectedEvent = (
  spec: RuntimeEventIdentitySpec & {
    readonly runId: number;
    readonly toolCallId: string;
    readonly name: string;
    readonly args: unknown;
    readonly execution: ToolExecution;
    readonly claim: RejectedClaim;
    readonly diagnostics?: ToolRejectedDiagnostics;
    readonly traceContext?: TraceContext;
  },
): RuntimeEventCommitSpecByKind<typeof RUNTIME_EVENT_KIND.TOOL_REJECTED> =>
  runtimeEvent(spec, RUNTIME_EVENT_KIND.TOOL_REJECTED, {
    runId: spec.runId,
    toolCallId: spec.toolCallId,
    name: spec.name,
    args: spec.args,
    execution: spec.execution,
    claim: spec.claim,
    ...(spec.diagnostics === undefined ? {} : { diagnostics: spec.diagnostics }),
    ...(spec.traceContext === undefined ? {} : { traceContext: spec.traceContext }),
  });

export const runtimeHistoryCompactedEvent = (
  spec: RuntimeEventIdentitySpec & {
    readonly runId: number;
    readonly turn: { readonly id: number; readonly index: number };
    readonly sourceEventId: number;
    readonly toolCallId: string;
    readonly toolName: string;
    readonly originalBytes: number;
    readonly compactedBytes: number;
    readonly traceContext?: TraceContext;
  },
): RuntimeEventCommitSpecByKind<typeof RUNTIME_EVENT_KIND.RUNTIME_HISTORY_COMPACTED> =>
  runtimeEvent(spec, RUNTIME_EVENT_KIND.RUNTIME_HISTORY_COMPACTED, {
    runId: spec.runId,
    turn: spec.turn,
    sourceEventId: spec.sourceEventId,
    target: {
      kind: "tool_call_arguments",
      toolCallId: spec.toolCallId,
      toolName: spec.toolName,
    },
    strategy: "provider_history_string_redaction",
    originalBytes: spec.originalBytes,
    compactedBytes: spec.compactedBytes,
    ...(spec.traceContext === undefined ? {} : { traceContext: spec.traceContext }),
  });

export const runtimeRekeyedEvent = (
  spec: RuntimeEventIdentitySpec & {
    readonly runId: number;
    readonly sourceEventId: number;
    readonly sourceKeyRef: string;
    readonly targetKeyRef: string;
    readonly purpose: string;
    readonly traceContext?: TraceContext;
  },
): RuntimeEventCommitSpecByKind<typeof RUNTIME_EVENT_KIND.RUNTIME_REKEYED> =>
  runtimeEvent(spec, RUNTIME_EVENT_KIND.RUNTIME_REKEYED, {
    runId: spec.runId,
    sourceEventId: spec.sourceEventId,
    sourceKeyRef: spec.sourceKeyRef,
    targetKeyRef: spec.targetKeyRef,
    purpose: spec.purpose,
    ...(spec.traceContext === undefined ? {} : { traceContext: spec.traceContext }),
  });

export const agentRunCompletedEvent = (
  spec: RuntimeEventIdentitySpec & {
    readonly runId: number;
    readonly final: string;
    readonly output: unknown;
    readonly outputKind: "text" | "json";
    readonly tokensUsed: number;
    readonly turn?: { readonly id: number; readonly index: number };
    readonly traceContext?: TraceContext;
  },
): RuntimeEventCommitSpecByKind<typeof RUNTIME_EVENT_KIND.AGENT_RUN_COMPLETED> =>
  runtimeEvent(spec, RUNTIME_EVENT_KIND.AGENT_RUN_COMPLETED, {
    runId: spec.runId,
    final: spec.final,
    output: spec.output,
    outputKind: spec.outputKind,
    tokensUsed: spec.tokensUsed,
    ...(spec.turn === undefined ? {} : { turn: spec.turn }),
    ...(spec.traceContext === undefined ? {} : { traceContext: spec.traceContext }),
  });

export const runtimeCompletedAfterToolsEvent = (
  spec: RuntimeEventIdentitySpec & {
    readonly runId: number;
    readonly turn: { readonly id: number; readonly index: number };
    readonly toolNames: ReadonlyArray<string>;
    readonly tokensUsed: number;
    readonly traceContext?: TraceContext;
  },
): RuntimeEventCommitSpecByKind<typeof RUNTIME_EVENT_KIND.RUNTIME_COMPLETED_AFTER_TOOLS> =>
  runtimeEvent(spec, RUNTIME_EVENT_KIND.RUNTIME_COMPLETED_AFTER_TOOLS, {
    runId: spec.runId,
    turn: spec.turn,
    toolNames: spec.toolNames,
    tokensUsed: spec.tokensUsed,
    ...(spec.traceContext === undefined ? {} : { traceContext: spec.traceContext }),
  });

export const agentRunAbortedEvent = (
  spec: RuntimeEventIdentitySpec & {
    readonly kind: RuntimeAbortEventKind;
    readonly runId: number;
    readonly tokensUsed: number;
    readonly payload?: Record<string, unknown>;
    readonly traceContext?: TraceContext;
  },
): RuntimeEventCommitSpecByKind<RuntimeAbortEventKind> =>
  runtimeEvent(spec, spec.kind, {
    ...spec.payload,
    runId: spec.runId,
    tokensUsed: spec.tokensUsed,
    ...(spec.traceContext === undefined ? {} : { traceContext: spec.traceContext }),
  });
