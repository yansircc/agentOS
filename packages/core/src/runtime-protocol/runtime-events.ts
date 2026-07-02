import { Data, Option, Predicate, Schema } from "effect";
import {
  LlmOutputItemSchema,
  LlmUsageSchema,
  type LlmOutputItem,
  type LlmUsage,
} from "@agent-os/core/llm-protocol";
import type { LedgerEvent } from "@agent-os/core/types";
import {
  validateEffectClaim,
  type AnchorRef,
  type AuthorityRef,
  type LivedClaim,
  type RejectedClaim,
  type ScopeRef,
} from "@agent-os/core/effect-claim";
import type { AgentSchemaIssue } from "@agent-os/core/agent-schema";
import type { ExecutionDomain, ResolvedToolExecution, ToolExecution } from "@agent-os/core/tools";
import type { Recorded } from "@agent-os/core";
import { TraceContextSchema, type TraceContext } from "@agent-os/core/telemetry-protocol";
import { ABORT, type AbortKind } from "@agent-os/core/abort";
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
const scheduledMinuteString = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((value) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\.000Z$/u.test(value)),
  ),
);

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
  AGENT_SESSION_TURN_SUBMITTED: "agent_session.turn_submitted",
  WORKFLOW_RUN_SUBMITTED: "workflow.run_submitted",
  PRODUCT_RUN_LINKED: "product.run_linked",
  INGRESS_DELIVERY_REQUESTED: "ingress.delivery_requested",
  INGRESS_DELIVERY_ACCEPTED: "ingress.delivery_accepted",
  INGRESS_DELIVERY_FAILED: "ingress.delivery_failed",
  SCHEDULE_FIRE_REQUESTED: "schedule.fire_requested",
  SCHEDULE_FIRE_DISPATCHED: "schedule.fire_dispatched",
  SCHEDULE_FIRE_FAILED: "schedule.fire_failed",
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
  AGENT_ABORTED_DECISION_REJECTED: "agent.aborted.rejected",
  AGENT_ABORTED_DECISION_CANCELLED: "agent.aborted.cancelled",
  AGENT_ABORTED_DECISION_EXPIRED: "agent.aborted.expired",
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

export type AgentSessionTurnSubmittedPayload = {
  readonly sessionRef: string;
  readonly turnRef: string;
  readonly runtimeRunId: number;
  readonly idempotencyKey?: string;
  readonly traceContext?: TraceContext;
};

export type WorkflowRunSubmittedPayload = {
  readonly workflowId: string;
  readonly workflowRunId: string;
  readonly runtimeRunId: number;
  readonly idempotencyKey?: string;
  readonly inputDigest?: string;
  readonly traceContext?: TraceContext;
};

export type ProductRunLinkedPayload = {
  readonly productRef: string;
  readonly runtimeRunId: number;
  readonly idempotencyKey?: string;
  readonly inputDigest?: string;
  readonly traceContext?: TraceContext;
};

export type IngressDeliveryKind = "channel" | "schedule";

export type IngressDeliveryPrincipalPayload = {
  readonly authority: string;
  readonly subject: string;
  readonly claims?: Readonly<Record<string, unknown>>;
};

export type IngressDeliverySlotPayload = {
  readonly kind: IngressDeliveryKind;
  readonly id: string;
  readonly route?: string;
};

export type IngressDeliveryRetryPolicyPayload = {
  readonly maxAttempts: number;
  readonly initialDelayMs: number;
  readonly maxDelayMs: number;
  readonly multiplier: number;
};

export type IngressDeliveryReceiptPayload = Pick<AnchorRef, "anchorId" | "anchorKind"> & {
  readonly carrierRef?: string;
};

export type IngressDeliveryRequestedPayload = {
  readonly deliveryKey: string;
  readonly slot: IngressDeliverySlotPayload;
  readonly principal: IngressDeliveryPrincipalPayload;
  readonly attempt: number;
  readonly retryPolicy?: IngressDeliveryRetryPolicyPayload;
  readonly traceContext?: TraceContext;
};

export type IngressDeliveryAcceptedPayload = {
  readonly requestedEventId: number;
  readonly deliveryKey: string;
  readonly slot: IngressDeliverySlotPayload;
  readonly receipt: IngressDeliveryReceiptPayload;
  readonly attempt: number;
  readonly traceContext?: TraceContext;
};

export type IngressDeliveryFailedPayload = {
  readonly requestedEventId: number;
  readonly deliveryKey: string;
  readonly slot: IngressDeliverySlotPayload;
  readonly attempt: number;
  readonly retryable: boolean;
  readonly reason: string;
  readonly nextAttemptAt?: number;
  readonly traceContext?: TraceContext;
};

export type SchedulePrincipalPayload = {
  readonly authority: string;
  readonly subject: string;
  readonly claims?: Readonly<Record<string, unknown>>;
};

export type ScheduleFireRequestedPayload = {
  readonly scheduleId: string;
  readonly fireId: string;
  readonly scheduledAt: string;
  readonly appPrincipal: SchedulePrincipalPayload;
  readonly traceContext?: TraceContext;
};

export type ScheduleFireProductLink =
  | {
      readonly kind: "session_turn";
      readonly sessionRef: string;
      readonly turnRef: string;
      readonly runtimeRunId: number;
      readonly idempotencyKey: string;
    }
  | {
      readonly kind: "workflow_run";
      readonly workflowId: string;
      readonly workflowRunId: string;
      readonly runtimeRunId: number;
      readonly idempotencyKey: string;
      readonly inputDigest?: string;
    };

export type ScheduleFireDispatchedPayload = {
  readonly scheduleId: string;
  readonly fireId: string;
  readonly scheduledAt: string;
  readonly requestedEventId: number;
  readonly productLink: ScheduleFireProductLink;
  readonly traceContext?: TraceContext;
};

export type ScheduleFireFailedPayload = {
  readonly scheduleId: string;
  readonly fireId: string;
  readonly scheduledAt: string;
  readonly requestedEventId: number;
  readonly phase: "handler" | "product_ingress" | "contract";
  readonly reason: string;
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
  readonly source?: string;
  readonly toolName?: string;
  readonly policyId?: string;
  readonly policyPhase?: string;
  readonly requiredCategory?: string;
  readonly category?: string;
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

export const AgentSessionTurnSubmittedPayloadSchema: Schema.Decoder<AgentSessionTurnSubmittedPayload> =
  Schema.Struct({
    sessionRef: nonEmptyString,
    turnRef: nonEmptyString,
    runtimeRunId: positiveInt,
    idempotencyKey: Schema.optional(nonEmptyString),
    traceContext: Schema.optional(TraceContextSchema),
  });

export const WorkflowRunSubmittedPayloadSchema: Schema.Decoder<WorkflowRunSubmittedPayload> =
  Schema.Struct({
    workflowId: nonEmptyString,
    workflowRunId: nonEmptyString,
    runtimeRunId: positiveInt,
    idempotencyKey: Schema.optional(nonEmptyString),
    inputDigest: Schema.optional(nonEmptyString),
    traceContext: Schema.optional(TraceContextSchema),
  });

export const ProductRunLinkedPayloadSchema: Schema.Decoder<ProductRunLinkedPayload> = Schema.Struct(
  {
    productRef: nonEmptyString,
    runtimeRunId: positiveInt,
    idempotencyKey: Schema.optional(nonEmptyString),
    inputDigest: Schema.optional(nonEmptyString),
    traceContext: Schema.optional(TraceContextSchema),
  },
);

export const IngressDeliveryPrincipalPayloadSchema: Schema.Decoder<IngressDeliveryPrincipalPayload> =
  Schema.Struct({
    authority: nonEmptyString,
    subject: nonEmptyString,
    claims: Schema.optional(unknownRecord),
  });

export const IngressDeliverySlotPayloadSchema: Schema.Decoder<IngressDeliverySlotPayload> =
  Schema.Struct({
    kind: Schema.Literals(["channel", "schedule"]),
    id: nonEmptyString,
    route: Schema.optional(nonEmptyString),
  });

export const IngressDeliveryRetryPolicyPayloadSchema: Schema.Decoder<IngressDeliveryRetryPolicyPayload> =
  Schema.Struct({
    maxAttempts: positiveInt,
    initialDelayMs: positiveInt,
    maxDelayMs: positiveInt,
    multiplier: positiveInt,
  });

const IngressDeliveryReceiptAnchorKindSchema = Schema.Literals([
  "ledger_event",
  "external_receipt",
]);

export const IngressDeliveryReceiptPayloadSchema: Schema.Decoder<IngressDeliveryReceiptPayload> =
  Schema.Struct({
    anchorId: nonEmptyString,
    anchorKind: IngressDeliveryReceiptAnchorKindSchema,
    carrierRef: Schema.optional(nonEmptyString),
  });

export const IngressDeliveryRequestedPayloadSchema: Schema.Decoder<IngressDeliveryRequestedPayload> =
  Schema.Struct({
    deliveryKey: nonEmptyString,
    slot: IngressDeliverySlotPayloadSchema,
    principal: IngressDeliveryPrincipalPayloadSchema,
    attempt: positiveInt,
    retryPolicy: Schema.optional(IngressDeliveryRetryPolicyPayloadSchema),
    traceContext: Schema.optional(TraceContextSchema),
  });

export const IngressDeliveryAcceptedPayloadSchema: Schema.Decoder<IngressDeliveryAcceptedPayload> =
  Schema.Struct({
    requestedEventId: positiveInt,
    deliveryKey: nonEmptyString,
    slot: IngressDeliverySlotPayloadSchema,
    receipt: IngressDeliveryReceiptPayloadSchema,
    attempt: positiveInt,
    traceContext: Schema.optional(TraceContextSchema),
  });

export const IngressDeliveryFailedPayloadSchema: Schema.Decoder<IngressDeliveryFailedPayload> =
  Schema.Struct({
    requestedEventId: positiveInt,
    deliveryKey: nonEmptyString,
    slot: IngressDeliverySlotPayloadSchema,
    attempt: positiveInt,
    retryable: Schema.Boolean,
    reason: nonEmptyString,
    nextAttemptAt: Schema.optional(positiveInt),
    traceContext: Schema.optional(TraceContextSchema),
  });

export const SchedulePrincipalPayloadSchema: Schema.Decoder<SchedulePrincipalPayload> =
  IngressDeliveryPrincipalPayloadSchema;

export const ScheduleFireRequestedPayloadSchema: Schema.Decoder<ScheduleFireRequestedPayload> =
  Schema.Struct({
    scheduleId: nonEmptyString,
    fireId: nonEmptyString,
    scheduledAt: scheduledMinuteString,
    appPrincipal: SchedulePrincipalPayloadSchema,
    traceContext: Schema.optional(TraceContextSchema),
  });

export const ScheduleFireProductLinkSchema: Schema.Decoder<ScheduleFireProductLink> = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("session_turn"),
    sessionRef: nonEmptyString,
    turnRef: nonEmptyString,
    runtimeRunId: positiveInt,
    idempotencyKey: nonEmptyString,
  }),
  Schema.Struct({
    kind: Schema.Literal("workflow_run"),
    workflowId: nonEmptyString,
    workflowRunId: nonEmptyString,
    runtimeRunId: positiveInt,
    idempotencyKey: nonEmptyString,
    inputDigest: Schema.optional(nonEmptyString),
  }),
]);

export const ScheduleFireDispatchedPayloadSchema: Schema.Decoder<ScheduleFireDispatchedPayload> =
  Schema.Struct({
    scheduleId: nonEmptyString,
    fireId: nonEmptyString,
    scheduledAt: scheduledMinuteString,
    requestedEventId: positiveInt,
    productLink: ScheduleFireProductLinkSchema,
    traceContext: Schema.optional(TraceContextSchema),
  });

export const ScheduleFireFailedPayloadSchema: Schema.Decoder<ScheduleFireFailedPayload> =
  Schema.Struct({
    scheduleId: nonEmptyString,
    fireId: nonEmptyString,
    scheduledAt: scheduledMinuteString,
    requestedEventId: positiveInt,
    phase: Schema.Literals(["handler", "product_ingress", "contract"]),
    reason: nonEmptyString,
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
      source: Schema.optional(nonEmptyString),
      toolName: Schema.optional(nonEmptyString),
      policyId: Schema.optional(nonEmptyString),
      policyPhase: Schema.optional(nonEmptyString),
      requiredCategory: Schema.optional(nonEmptyString),
      category: Schema.optional(nonEmptyString),
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
  readonly [RUNTIME_EVENT_KIND.AGENT_SESSION_TURN_SUBMITTED]: AgentSessionTurnSubmittedPayload;
  readonly [RUNTIME_EVENT_KIND.WORKFLOW_RUN_SUBMITTED]: WorkflowRunSubmittedPayload;
  readonly [RUNTIME_EVENT_KIND.PRODUCT_RUN_LINKED]: ProductRunLinkedPayload;
  readonly [RUNTIME_EVENT_KIND.INGRESS_DELIVERY_REQUESTED]: IngressDeliveryRequestedPayload;
  readonly [RUNTIME_EVENT_KIND.INGRESS_DELIVERY_ACCEPTED]: IngressDeliveryAcceptedPayload;
  readonly [RUNTIME_EVENT_KIND.INGRESS_DELIVERY_FAILED]: IngressDeliveryFailedPayload;
  readonly [RUNTIME_EVENT_KIND.SCHEDULE_FIRE_REQUESTED]: ScheduleFireRequestedPayload;
  readonly [RUNTIME_EVENT_KIND.SCHEDULE_FIRE_DISPATCHED]: ScheduleFireDispatchedPayload;
  readonly [RUNTIME_EVENT_KIND.SCHEDULE_FIRE_FAILED]: ScheduleFireFailedPayload;
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
  readonly [ABORT.DECISION_REJECTED]: AgentRunAbortedPayload;
  readonly [ABORT.DECISION_CANCELLED]: AgentRunAbortedPayload;
  readonly [ABORT.DECISION_EXPIRED]: AgentRunAbortedPayload;
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
    case RUNTIME_EVENT_KIND.AGENT_SESSION_TURN_SUBMITTED:
      return Schema.decodeUnknownSync(AgentSessionTurnSubmittedPayloadSchema)(
        payload,
      ) as RuntimeEventPayloadByKind[K];
    case RUNTIME_EVENT_KIND.WORKFLOW_RUN_SUBMITTED:
      return Schema.decodeUnknownSync(WorkflowRunSubmittedPayloadSchema)(
        payload,
      ) as RuntimeEventPayloadByKind[K];
    case RUNTIME_EVENT_KIND.PRODUCT_RUN_LINKED:
      return Schema.decodeUnknownSync(ProductRunLinkedPayloadSchema)(
        payload,
      ) as RuntimeEventPayloadByKind[K];
    case RUNTIME_EVENT_KIND.INGRESS_DELIVERY_REQUESTED:
      return Schema.decodeUnknownSync(IngressDeliveryRequestedPayloadSchema)(
        payload,
      ) as RuntimeEventPayloadByKind[K];
    case RUNTIME_EVENT_KIND.INGRESS_DELIVERY_ACCEPTED:
      return Schema.decodeUnknownSync(IngressDeliveryAcceptedPayloadSchema)(
        payload,
      ) as RuntimeEventPayloadByKind[K];
    case RUNTIME_EVENT_KIND.INGRESS_DELIVERY_FAILED:
      return Schema.decodeUnknownSync(IngressDeliveryFailedPayloadSchema)(
        payload,
      ) as RuntimeEventPayloadByKind[K];
    case RUNTIME_EVENT_KIND.SCHEDULE_FIRE_REQUESTED:
      return Schema.decodeUnknownSync(ScheduleFireRequestedPayloadSchema)(
        payload,
      ) as RuntimeEventPayloadByKind[K];
    case RUNTIME_EVENT_KIND.SCHEDULE_FIRE_DISPATCHED:
      return Schema.decodeUnknownSync(ScheduleFireDispatchedPayloadSchema)(
        payload,
      ) as RuntimeEventPayloadByKind[K];
    case RUNTIME_EVENT_KIND.SCHEDULE_FIRE_FAILED:
      return Schema.decodeUnknownSync(ScheduleFireFailedPayloadSchema)(
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
    case ABORT.DECISION_REJECTED:
    case ABORT.DECISION_CANCELLED:
    case ABORT.DECISION_EXPIRED:
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
    case RUNTIME_EVENT_KIND.AGENT_SESSION_TURN_SUBMITTED:
      return Schema.decodeUnknownOption(AgentSessionTurnSubmittedPayloadSchema)(
        payload,
      ) as Option.Option<RuntimeEventPayloadByKind[K]>;
    case RUNTIME_EVENT_KIND.WORKFLOW_RUN_SUBMITTED:
      return Schema.decodeUnknownOption(WorkflowRunSubmittedPayloadSchema)(
        payload,
      ) as Option.Option<RuntimeEventPayloadByKind[K]>;
    case RUNTIME_EVENT_KIND.PRODUCT_RUN_LINKED:
      return Schema.decodeUnknownOption(ProductRunLinkedPayloadSchema)(payload) as Option.Option<
        RuntimeEventPayloadByKind[K]
      >;
    case RUNTIME_EVENT_KIND.INGRESS_DELIVERY_REQUESTED:
      return Schema.decodeUnknownOption(IngressDeliveryRequestedPayloadSchema)(
        payload,
      ) as Option.Option<RuntimeEventPayloadByKind[K]>;
    case RUNTIME_EVENT_KIND.INGRESS_DELIVERY_ACCEPTED:
      return Schema.decodeUnknownOption(IngressDeliveryAcceptedPayloadSchema)(
        payload,
      ) as Option.Option<RuntimeEventPayloadByKind[K]>;
    case RUNTIME_EVENT_KIND.INGRESS_DELIVERY_FAILED:
      return Schema.decodeUnknownOption(IngressDeliveryFailedPayloadSchema)(
        payload,
      ) as Option.Option<RuntimeEventPayloadByKind[K]>;
    case RUNTIME_EVENT_KIND.SCHEDULE_FIRE_REQUESTED:
      return Schema.decodeUnknownOption(ScheduleFireRequestedPayloadSchema)(
        payload,
      ) as Option.Option<RuntimeEventPayloadByKind[K]>;
    case RUNTIME_EVENT_KIND.SCHEDULE_FIRE_DISPATCHED:
      return Schema.decodeUnknownOption(ScheduleFireDispatchedPayloadSchema)(
        payload,
      ) as Option.Option<RuntimeEventPayloadByKind[K]>;
    case RUNTIME_EVENT_KIND.SCHEDULE_FIRE_FAILED:
      return Schema.decodeUnknownOption(ScheduleFireFailedPayloadSchema)(payload) as Option.Option<
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
    case ABORT.DECISION_REJECTED:
    case ABORT.DECISION_CANCELLED:
    case ABORT.DECISION_EXPIRED:
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
  | "runtime_product_link_duplicate"
  | "runtime_product_link_run_conflict"
  | "runtime_session_active_run_conflict"
  | "runtime_source_event_not_before"
  | "runtime_source_event_missing"
  | "runtime_source_event_not_runtime"
  | "runtime_source_payload_invalid"
  | "runtime_compaction_source_kind_mismatch"
  | "runtime_compaction_source_turn_mismatch"
  | "runtime_resume_consumed_event_kind_mismatch"
  | "runtime_ingress_delivery_attempt_sequence_mismatch"
  | "runtime_ingress_delivery_duplicate_terminal"
  | "runtime_ingress_delivery_outcome_duplicate"
  | "runtime_ingress_delivery_source_kind_mismatch"
  | "runtime_ingress_delivery_source_mismatch"
  | "runtime_schedule_fire_source_kind_mismatch"
  | "runtime_schedule_fire_source_mismatch"
  | "runtime_schedule_fire_product_idempotency_mismatch"
  | "runtime_schedule_fire_outcome_duplicate";

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

export const decodeRuntimeLedgerEventSafe = (
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

type RuntimeProductLinkState = {
  readonly sessionTurns: Set<string>;
  readonly sessionRuns: Map<string, Set<number>>;
  readonly workflowRuns: Set<string>;
  readonly productRefs: Set<string>;
  readonly runtimeRunLinks: Map<
    number,
    {
      readonly eventId: number;
      readonly eventKind: RuntimeEventKind;
    }
  >;
};

type RuntimeScheduleFireState = {
  readonly requests: Map<number, ScheduleFireRequestedPayload>;
  readonly outcomesByRequestedEventId: Map<
    number,
    {
      readonly eventId: number;
      readonly eventKind: RuntimeEventKind;
    }
  >;
};

type RuntimeIngressDeliveryOutcomeEvent =
  | RuntimeLedgerEventByKind<typeof RUNTIME_EVENT_KIND.INGRESS_DELIVERY_ACCEPTED>
  | RuntimeLedgerEventByKind<typeof RUNTIME_EVENT_KIND.INGRESS_DELIVERY_FAILED>;

type RuntimeIngressDeliveryRequestState = {
  readonly eventId: number;
  readonly payload: IngressDeliveryRequestedPayload;
  outcome?:
    | {
        readonly eventId: number;
        readonly eventKind: typeof RUNTIME_EVENT_KIND.INGRESS_DELIVERY_ACCEPTED;
        readonly payload: IngressDeliveryAcceptedPayload;
      }
    | {
        readonly eventId: number;
        readonly eventKind: typeof RUNTIME_EVENT_KIND.INGRESS_DELIVERY_FAILED;
        readonly payload: IngressDeliveryFailedPayload;
      };
};

type RuntimeIngressDeliveryState = {
  readonly requests: Map<number, RuntimeIngressDeliveryRequestState>;
  readonly requestsByKey: Map<string, RuntimeIngressDeliveryRequestState>;
  readonly outcomesByRequestedEventId: Map<
    number,
    {
      readonly eventId: number;
      readonly eventKind: RuntimeEventKind;
    }
  >;
};

const makeRuntimeRunState = (): RuntimeRunState => ({
  interruptions: new Map(),
});

const makeRuntimeProductLinkState = (): RuntimeProductLinkState => ({
  sessionTurns: new Set(),
  sessionRuns: new Map(),
  workflowRuns: new Set(),
  productRefs: new Set(),
  runtimeRunLinks: new Map(),
});

const makeRuntimeScheduleFireState = (): RuntimeScheduleFireState => ({
  requests: new Map(),
  outcomesByRequestedEventId: new Map(),
});

const makeRuntimeIngressDeliveryState = (): RuntimeIngressDeliveryState => ({
  requests: new Map(),
  requestsByKey: new Map(),
  outcomesByRequestedEventId: new Map(),
});

const sessionTurnLinkKey = (payload: AgentSessionTurnSubmittedPayload): string =>
  `${payload.sessionRef}\u0000${payload.turnRef}`;

const workflowRunLinkKey = (payload: WorkflowRunSubmittedPayload): string =>
  `${payload.workflowId}\u0000${payload.workflowRunId}`;

const productRunLinkKey = (payload: ProductRunLinkedPayload): string => payload.productRef;

const isIngressDeliveryEvent = (
  event: RuntimeLedgerEvent,
): event is
  | RuntimeLedgerEventByKind<typeof RUNTIME_EVENT_KIND.INGRESS_DELIVERY_REQUESTED>
  | RuntimeLedgerEventByKind<typeof RUNTIME_EVENT_KIND.INGRESS_DELIVERY_ACCEPTED>
  | RuntimeLedgerEventByKind<typeof RUNTIME_EVENT_KIND.INGRESS_DELIVERY_FAILED> =>
  event.kind === RUNTIME_EVENT_KIND.INGRESS_DELIVERY_REQUESTED ||
  event.kind === RUNTIME_EVENT_KIND.INGRESS_DELIVERY_ACCEPTED ||
  event.kind === RUNTIME_EVENT_KIND.INGRESS_DELIVERY_FAILED;

const isIngressDeliveryOutcomeEvent = (
  event: RuntimeLedgerEvent,
): event is RuntimeIngressDeliveryOutcomeEvent =>
  event.kind === RUNTIME_EVENT_KIND.INGRESS_DELIVERY_ACCEPTED ||
  event.kind === RUNTIME_EVENT_KIND.INGRESS_DELIVERY_FAILED;

const applyIngressDeliveryEvent = (
  ingressDeliveries: RuntimeIngressDeliveryState,
  event: RuntimeLedgerEvent,
): void => {
  if (event.kind === RUNTIME_EVENT_KIND.INGRESS_DELIVERY_REQUESTED) {
    const request = {
      eventId: event.id,
      payload: event.payload,
    };
    ingressDeliveries.requests.set(event.id, request);
    ingressDeliveries.requestsByKey.set(event.payload.deliveryKey, request);
    return;
  }
  if (!isIngressDeliveryOutcomeEvent(event)) return;
  if (!ingressDeliveries.outcomesByRequestedEventId.has(event.payload.requestedEventId)) {
    ingressDeliveries.outcomesByRequestedEventId.set(event.payload.requestedEventId, {
      eventId: event.id,
      eventKind: event.kind,
    });
  }
  const request = ingressDeliveries.requests.get(event.payload.requestedEventId);
  if (request !== undefined && request.outcome === undefined) {
    request.outcome =
      event.kind === RUNTIME_EVENT_KIND.INGRESS_DELIVERY_ACCEPTED
        ? {
            eventId: event.id,
            eventKind: event.kind,
            payload: event.payload,
          }
        : {
            eventId: event.id,
            eventKind: event.kind,
            payload: event.payload,
          };
  }
};

const slotsMatch = (left: IngressDeliverySlotPayload, right: IngressDeliverySlotPayload): boolean =>
  left.kind === right.kind && left.id === right.id && left.route === right.route;

const validateIngressDeliveryRequest = (
  ingressDeliveries: RuntimeIngressDeliveryState,
  event: RuntimeLedgerEventByKind<typeof RUNTIME_EVENT_KIND.INGRESS_DELIVERY_REQUESTED>,
  issues: RuntimeLedgerTransitionIssue[],
): void => {
  const previous = ingressDeliveries.requestsByKey.get(event.payload.deliveryKey);
  if (previous === undefined) {
    if (event.payload.attempt !== 1) {
      issues.push(
        runTransitionIssue(
          "runtime_ingress_delivery_attempt_sequence_mismatch",
          event,
          "first ingress delivery request attempt must be 1",
        ),
      );
      return;
    }
    applyIngressDeliveryEvent(ingressDeliveries, event);
    return;
  }

  const retryableFailure =
    previous.outcome?.eventKind === RUNTIME_EVENT_KIND.INGRESS_DELIVERY_FAILED &&
    previous.outcome.payload.retryable === true;
  if (!retryableFailure) {
    issues.push(
      runTransitionIssue(
        "runtime_ingress_delivery_duplicate_terminal",
        event,
        "ingress delivery key cannot be requested again after an open or terminal delivery",
        previous.outcome?.eventId ?? previous.eventId,
        previous.outcome?.eventKind ?? RUNTIME_EVENT_KIND.INGRESS_DELIVERY_REQUESTED,
      ),
    );
    return;
  }

  if (event.payload.attempt !== previous.payload.attempt + 1) {
    issues.push(
      runTransitionIssue(
        "runtime_ingress_delivery_attempt_sequence_mismatch",
        event,
        "ingress delivery retry attempt must increment the previous attempt",
        previous.eventId,
        RUNTIME_EVENT_KIND.INGRESS_DELIVERY_REQUESTED,
      ),
    );
    return;
  }

  applyIngressDeliveryEvent(ingressDeliveries, event);
};

const validateIngressDeliveryOutcome = (
  priorById: ReadonlyMap<number, LedgerEvent>,
  ingressDeliveries: RuntimeIngressDeliveryState,
  event: RuntimeIngressDeliveryOutcomeEvent,
  issues: RuntimeLedgerTransitionIssue[],
): void => {
  const requestedEventId = event.payload.requestedEventId;
  const existingOutcome = ingressDeliveries.outcomesByRequestedEventId.get(requestedEventId);
  if (existingOutcome !== undefined) {
    issues.push(
      sourceEventIssue(
        "runtime_ingress_delivery_outcome_duplicate",
        event,
        requestedEventId,
        "ingress delivery request can record only one outcome",
        existingOutcome.eventKind,
      ),
    );
  }
  const source = decodedRuntimeSourceEvent(priorById, event, requestedEventId, issues);
  if (source === null) return;
  if (source.kind !== RUNTIME_EVENT_KIND.INGRESS_DELIVERY_REQUESTED) {
    issues.push(
      sourceEventIssue(
        "runtime_ingress_delivery_source_kind_mismatch",
        event,
        requestedEventId,
        "ingress delivery outcome must reference ingress.delivery_requested",
        source.kind,
      ),
    );
    return;
  }
  const requested = source.payload;
  if (
    requested.deliveryKey !== event.payload.deliveryKey ||
    requested.attempt !== event.payload.attempt ||
    !slotsMatch(requested.slot, event.payload.slot)
  ) {
    issues.push(
      sourceEventIssue(
        "runtime_ingress_delivery_source_mismatch",
        event,
        requestedEventId,
        "ingress delivery outcome must preserve deliveryKey, attempt, and slot",
        source.kind,
      ),
    );
    return;
  }
  applyIngressDeliveryEvent(ingressDeliveries, event);
};

const validateIngressDeliveryEvent = (
  priorById: ReadonlyMap<number, LedgerEvent>,
  ingressDeliveries: RuntimeIngressDeliveryState,
  event: RuntimeLedgerEvent,
  issues: RuntimeLedgerTransitionIssue[],
): void => {
  if (event.kind === RUNTIME_EVENT_KIND.INGRESS_DELIVERY_REQUESTED) {
    validateIngressDeliveryRequest(ingressDeliveries, event, issues);
    return;
  }
  if (isIngressDeliveryOutcomeEvent(event)) {
    validateIngressDeliveryOutcome(priorById, ingressDeliveries, event, issues);
  }
};

const isScheduleFireEvent = (
  event: RuntimeLedgerEvent,
): event is
  | RuntimeLedgerEventByKind<typeof RUNTIME_EVENT_KIND.SCHEDULE_FIRE_REQUESTED>
  | RuntimeLedgerEventByKind<typeof RUNTIME_EVENT_KIND.SCHEDULE_FIRE_DISPATCHED>
  | RuntimeLedgerEventByKind<typeof RUNTIME_EVENT_KIND.SCHEDULE_FIRE_FAILED> =>
  event.kind === RUNTIME_EVENT_KIND.SCHEDULE_FIRE_REQUESTED ||
  event.kind === RUNTIME_EVENT_KIND.SCHEDULE_FIRE_DISPATCHED ||
  event.kind === RUNTIME_EVENT_KIND.SCHEDULE_FIRE_FAILED;

const scheduleFireOutcomeRequestedEventId = (
  event:
    | RuntimeLedgerEventByKind<typeof RUNTIME_EVENT_KIND.SCHEDULE_FIRE_DISPATCHED>
    | RuntimeLedgerEventByKind<typeof RUNTIME_EVENT_KIND.SCHEDULE_FIRE_FAILED>,
): number => event.payload.requestedEventId;

const applyScheduleFireEvent = (
  scheduleFires: RuntimeScheduleFireState,
  event: RuntimeLedgerEvent,
): void => {
  if (event.kind === RUNTIME_EVENT_KIND.SCHEDULE_FIRE_REQUESTED) {
    scheduleFires.requests.set(event.id, event.payload);
    return;
  }
  if (
    event.kind === RUNTIME_EVENT_KIND.SCHEDULE_FIRE_DISPATCHED ||
    event.kind === RUNTIME_EVENT_KIND.SCHEDULE_FIRE_FAILED
  ) {
    const requestedEventId = scheduleFireOutcomeRequestedEventId(event);
    if (!scheduleFires.outcomesByRequestedEventId.has(requestedEventId)) {
      scheduleFires.outcomesByRequestedEventId.set(requestedEventId, {
        eventId: event.id,
        eventKind: event.kind,
      });
    }
  }
};

const validateScheduleFireEvent = (
  priorById: ReadonlyMap<number, LedgerEvent>,
  scheduleFires: RuntimeScheduleFireState,
  event: RuntimeLedgerEvent,
  issues: RuntimeLedgerTransitionIssue[],
): void => {
  if (event.kind === RUNTIME_EVENT_KIND.SCHEDULE_FIRE_REQUESTED) {
    applyScheduleFireEvent(scheduleFires, event);
    return;
  }
  if (
    event.kind !== RUNTIME_EVENT_KIND.SCHEDULE_FIRE_DISPATCHED &&
    event.kind !== RUNTIME_EVENT_KIND.SCHEDULE_FIRE_FAILED
  ) {
    return;
  }
  const requestedEventId = scheduleFireOutcomeRequestedEventId(event);
  const existingOutcome = scheduleFires.outcomesByRequestedEventId.get(requestedEventId);
  if (existingOutcome !== undefined) {
    issues.push(
      sourceEventIssue(
        "runtime_schedule_fire_outcome_duplicate",
        event,
        requestedEventId,
        "schedule fire request can record only one handoff outcome",
        existingOutcome.eventKind,
      ),
    );
  }
  const source = decodedRuntimeSourceEvent(priorById, event, requestedEventId, issues);
  if (source === null) return;
  if (source.kind !== RUNTIME_EVENT_KIND.SCHEDULE_FIRE_REQUESTED) {
    issues.push(
      sourceEventIssue(
        "runtime_schedule_fire_source_kind_mismatch",
        event,
        requestedEventId,
        "schedule fire handoff outcome must reference schedule.fire_requested",
        source.kind,
      ),
    );
    return;
  }
  const requested = source.payload;
  if (
    requested.scheduleId !== event.payload.scheduleId ||
    requested.fireId !== event.payload.fireId ||
    requested.scheduledAt !== event.payload.scheduledAt
  ) {
    issues.push(
      sourceEventIssue(
        "runtime_schedule_fire_source_mismatch",
        event,
        requestedEventId,
        "schedule fire handoff outcome must preserve scheduleId, fireId, and scheduledAt",
        source.kind,
      ),
    );
    return;
  }
  if (
    event.kind === RUNTIME_EVENT_KIND.SCHEDULE_FIRE_DISPATCHED &&
    event.payload.productLink.idempotencyKey !== event.payload.fireId
  ) {
    issues.push(
      sourceEventIssue(
        "runtime_schedule_fire_product_idempotency_mismatch",
        event,
        requestedEventId,
        "schedule fire handoff must pass fireId as the product ingress idempotency key",
        source.kind,
      ),
    );
    return;
  }
  applyScheduleFireEvent(scheduleFires, event);
};

const addSessionTurnLink = (
  productLinks: RuntimeProductLinkState,
  payload: AgentSessionTurnSubmittedPayload,
): void => {
  productLinks.sessionTurns.add(sessionTurnLinkKey(payload));
  const existing = productLinks.sessionRuns.get(payload.sessionRef);
  if (existing !== undefined) {
    existing.add(payload.runtimeRunId);
    return;
  }
  productLinks.sessionRuns.set(payload.sessionRef, new Set([payload.runtimeRunId]));
};

const activeSessionRunId = (
  productLinks: RuntimeProductLinkState,
  runStates: ReadonlyMap<number, RuntimeRunState>,
  sessionRef: string,
): number | undefined => {
  for (const runId of productLinks.sessionRuns.get(sessionRef) ?? []) {
    const state = runStates.get(runId);
    if (state?.startedEventId !== undefined && state.terminalEventId === undefined) {
      return runId;
    }
  }
  return undefined;
};

type RuntimeProductLinkEvent =
  | RuntimeLedgerEventByKind<typeof RUNTIME_EVENT_KIND.AGENT_SESSION_TURN_SUBMITTED>
  | RuntimeLedgerEventByKind<typeof RUNTIME_EVENT_KIND.WORKFLOW_RUN_SUBMITTED>
  | RuntimeLedgerEventByKind<typeof RUNTIME_EVENT_KIND.PRODUCT_RUN_LINKED>;

const addRuntimeProductLink = (
  productLinks: RuntimeProductLinkState,
  event: RuntimeProductLinkEvent,
): void => {
  if (!productLinks.runtimeRunLinks.has(event.payload.runtimeRunId)) {
    productLinks.runtimeRunLinks.set(event.payload.runtimeRunId, {
      eventId: event.id,
      eventKind: event.kind,
    });
  }
};

const runtimeProductLinkConflict = (
  productLinks: RuntimeProductLinkState,
  event: RuntimeProductLinkEvent,
): RuntimeLedgerTransitionIssue | null => {
  const existing = productLinks.runtimeRunLinks.get(event.payload.runtimeRunId);
  if (existing === undefined) return null;
  return runTransitionIssue(
    "runtime_product_link_run_conflict",
    event,
    "runtime run cannot be linked to more than one product identity",
    existing.eventId,
    existing.eventKind,
  );
};

const runtimeRunId = (event: RuntimeLedgerEvent): number => {
  switch (event.kind) {
    case RUNTIME_EVENT_KIND.AGENT_RUN_STARTED:
      return event.id;
    case RUNTIME_EVENT_KIND.AGENT_SESSION_TURN_SUBMITTED:
    case RUNTIME_EVENT_KIND.WORKFLOW_RUN_SUBMITTED:
    case RUNTIME_EVENT_KIND.PRODUCT_RUN_LINKED:
      return event.payload.runtimeRunId;
    case RUNTIME_EVENT_KIND.INGRESS_DELIVERY_REQUESTED:
    case RUNTIME_EVENT_KIND.INGRESS_DELIVERY_ACCEPTED:
    case RUNTIME_EVENT_KIND.INGRESS_DELIVERY_FAILED:
      throw new TypeError("ingress delivery events are not runtime run-bound");
    case RUNTIME_EVENT_KIND.SCHEDULE_FIRE_REQUESTED:
    case RUNTIME_EVENT_KIND.SCHEDULE_FIRE_DISPATCHED:
    case RUNTIME_EVENT_KIND.SCHEDULE_FIRE_FAILED:
      throw new TypeError("schedule fire events are not runtime run-bound");
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
    case ABORT.DECISION_REJECTED:
    case ABORT.DECISION_CANCELLED:
    case ABORT.DECISION_EXPIRED:
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
  productLinks: RuntimeProductLinkState,
  ingressDeliveries: RuntimeIngressDeliveryState,
  scheduleFires: RuntimeScheduleFireState,
  event: RuntimeLedgerEvent,
): void => {
  if (isIngressDeliveryEvent(event)) {
    applyIngressDeliveryEvent(ingressDeliveries, event);
    return;
  }
  if (isScheduleFireEvent(event)) {
    applyScheduleFireEvent(scheduleFires, event);
    return;
  }
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
    case RUNTIME_EVENT_KIND.AGENT_SESSION_TURN_SUBMITTED:
      addSessionTurnLink(productLinks, event.payload);
      addRuntimeProductLink(productLinks, event);
      break;
    case RUNTIME_EVENT_KIND.WORKFLOW_RUN_SUBMITTED:
      productLinks.workflowRuns.add(workflowRunLinkKey(event.payload));
      addRuntimeProductLink(productLinks, event);
      break;
    case RUNTIME_EVENT_KIND.PRODUCT_RUN_LINKED:
      productLinks.productRefs.add(productRunLinkKey(event.payload));
      addRuntimeProductLink(productLinks, event);
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
    case ABORT.DECISION_REJECTED:
    case ABORT.DECISION_CANCELLED:
    case ABORT.DECISION_EXPIRED:
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
  const productLinks = makeRuntimeProductLinkState();
  const ingressDeliveries = makeRuntimeIngressDeliveryState();
  const scheduleFires = makeRuntimeScheduleFireState();
  const issues: RuntimeLedgerTransitionIssue[] = [];

  for (const historical of input.history) {
    const decoded = decodeRuntimeLedgerEventSafe(historical);
    if (decoded?._tag === "runtime") {
      applyHistoricalRuntimeRunEvent(
        runStates,
        productLinks,
        ingressDeliveries,
        scheduleFires,
        decoded.event,
      );
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
    if (isIngressDeliveryEvent(event)) {
      validateIngressDeliveryEvent(priorById, ingressDeliveries, event, issues);
      priorById.set(event.id, event);
      continue;
    }
    if (isScheduleFireEvent(event)) {
      validateScheduleFireEvent(priorById, scheduleFires, event, issues);
      priorById.set(event.id, event);
      continue;
    }
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
      case RUNTIME_EVENT_KIND.AGENT_SESSION_TURN_SUBMITTED: {
        const key = sessionTurnLinkKey(event.payload);
        const activeRunId = activeSessionRunId(productLinks, runStates, event.payload.sessionRef);
        const productLinkConflict = runtimeProductLinkConflict(productLinks, event);
        if (productLinks.sessionTurns.has(key)) {
          issues.push(
            runTransitionIssue(
              "runtime_product_link_duplicate",
              event,
              "agent_session.turn_submitted must be the only runtime link for a session turn",
            ),
          );
        } else if (productLinkConflict !== null) {
          issues.push(productLinkConflict);
        } else if (activeRunId !== undefined) {
          issues.push(
            runTransitionIssue(
              "runtime_session_active_run_conflict",
              event,
              "agent_session.turn_submitted cannot start a new session turn while the session " +
                "has an active runtime run",
              activeRunId,
              RUNTIME_EVENT_KIND.AGENT_RUN_STARTED,
            ),
          );
        } else if (hasStarted && !hasTerminal) {
          addSessionTurnLink(productLinks, event.payload);
          addRuntimeProductLink(productLinks, event);
        }
        break;
      }
      case RUNTIME_EVENT_KIND.WORKFLOW_RUN_SUBMITTED: {
        const key = workflowRunLinkKey(event.payload);
        const productLinkConflict = runtimeProductLinkConflict(productLinks, event);
        if (productLinks.workflowRuns.has(key)) {
          issues.push(
            runTransitionIssue(
              "runtime_product_link_duplicate",
              event,
              "workflow.run_submitted must be the only runtime link for a workflow run",
            ),
          );
        } else if (productLinkConflict !== null) {
          issues.push(productLinkConflict);
        } else if (hasStarted && !hasTerminal) {
          productLinks.workflowRuns.add(key);
          addRuntimeProductLink(productLinks, event);
        }
        break;
      }
      case RUNTIME_EVENT_KIND.PRODUCT_RUN_LINKED: {
        const key = productRunLinkKey(event.payload);
        const productLinkConflict = runtimeProductLinkConflict(productLinks, event);
        if (productLinks.productRefs.has(key)) {
          issues.push(
            runTransitionIssue(
              "runtime_product_link_duplicate",
              event,
              "product.run_linked must be the only runtime link for an opaque product ref",
            ),
          );
        } else if (productLinkConflict !== null) {
          issues.push(productLinkConflict);
        } else if (hasStarted && !hasTerminal) {
          productLinks.productRefs.add(key);
          addRuntimeProductLink(productLinks, event);
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
      case ABORT.DECISION_REJECTED:
      case ABORT.DECISION_CANCELLED:
      case ABORT.DECISION_EXPIRED:
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

export type RuntimeEventIdentitySpec = {
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

export const agentSessionTurnSubmittedEvent = (
  spec: RuntimeEventIdentitySpec & {
    readonly sessionRef: string;
    readonly turnRef: string;
    readonly runtimeRunId: number;
    readonly idempotencyKey?: string;
    readonly traceContext?: TraceContext;
  },
): RuntimeEventCommitSpecByKind<typeof RUNTIME_EVENT_KIND.AGENT_SESSION_TURN_SUBMITTED> =>
  runtimeEvent(spec, RUNTIME_EVENT_KIND.AGENT_SESSION_TURN_SUBMITTED, {
    sessionRef: spec.sessionRef,
    turnRef: spec.turnRef,
    runtimeRunId: spec.runtimeRunId,
    ...(spec.idempotencyKey === undefined ? {} : { idempotencyKey: spec.idempotencyKey }),
    ...(spec.traceContext === undefined ? {} : { traceContext: spec.traceContext }),
  });

export const workflowRunSubmittedEvent = (
  spec: RuntimeEventIdentitySpec & {
    readonly workflowId: string;
    readonly workflowRunId: string;
    readonly runtimeRunId: number;
    readonly idempotencyKey?: string;
    readonly inputDigest?: string;
    readonly traceContext?: TraceContext;
  },
): RuntimeEventCommitSpecByKind<typeof RUNTIME_EVENT_KIND.WORKFLOW_RUN_SUBMITTED> =>
  runtimeEvent(spec, RUNTIME_EVENT_KIND.WORKFLOW_RUN_SUBMITTED, {
    workflowId: spec.workflowId,
    workflowRunId: spec.workflowRunId,
    runtimeRunId: spec.runtimeRunId,
    ...(spec.idempotencyKey === undefined ? {} : { idempotencyKey: spec.idempotencyKey }),
    ...(spec.inputDigest === undefined ? {} : { inputDigest: spec.inputDigest }),
    ...(spec.traceContext === undefined ? {} : { traceContext: spec.traceContext }),
  });

export const productRunLinkedEvent = (
  spec: RuntimeEventIdentitySpec & {
    readonly productRef: string;
    readonly runtimeRunId: number;
    readonly idempotencyKey?: string;
    readonly inputDigest?: string;
    readonly traceContext?: TraceContext;
  },
): RuntimeEventCommitSpecByKind<typeof RUNTIME_EVENT_KIND.PRODUCT_RUN_LINKED> =>
  runtimeEvent(spec, RUNTIME_EVENT_KIND.PRODUCT_RUN_LINKED, {
    productRef: spec.productRef,
    runtimeRunId: spec.runtimeRunId,
    ...(spec.idempotencyKey === undefined ? {} : { idempotencyKey: spec.idempotencyKey }),
    ...(spec.inputDigest === undefined ? {} : { inputDigest: spec.inputDigest }),
    ...(spec.traceContext === undefined ? {} : { traceContext: spec.traceContext }),
  });

export const ingressDeliveryRequestedEvent = (
  spec: RuntimeEventIdentitySpec & IngressDeliveryRequestedPayload,
): RuntimeEventCommitSpecByKind<typeof RUNTIME_EVENT_KIND.INGRESS_DELIVERY_REQUESTED> =>
  runtimeEvent(spec, RUNTIME_EVENT_KIND.INGRESS_DELIVERY_REQUESTED, {
    deliveryKey: spec.deliveryKey,
    slot: spec.slot,
    principal: spec.principal,
    attempt: spec.attempt,
    ...(spec.retryPolicy === undefined ? {} : { retryPolicy: spec.retryPolicy }),
    ...(spec.traceContext === undefined ? {} : { traceContext: spec.traceContext }),
  });

export const ingressDeliveryAcceptedEvent = (
  spec: RuntimeEventIdentitySpec & IngressDeliveryAcceptedPayload,
): RuntimeEventCommitSpecByKind<typeof RUNTIME_EVENT_KIND.INGRESS_DELIVERY_ACCEPTED> =>
  runtimeEvent(spec, RUNTIME_EVENT_KIND.INGRESS_DELIVERY_ACCEPTED, {
    requestedEventId: spec.requestedEventId,
    deliveryKey: spec.deliveryKey,
    slot: spec.slot,
    receipt: spec.receipt,
    attempt: spec.attempt,
    ...(spec.traceContext === undefined ? {} : { traceContext: spec.traceContext }),
  });

export const ingressDeliveryFailedEvent = (
  spec: RuntimeEventIdentitySpec & IngressDeliveryFailedPayload,
): RuntimeEventCommitSpecByKind<typeof RUNTIME_EVENT_KIND.INGRESS_DELIVERY_FAILED> =>
  runtimeEvent(spec, RUNTIME_EVENT_KIND.INGRESS_DELIVERY_FAILED, {
    requestedEventId: spec.requestedEventId,
    deliveryKey: spec.deliveryKey,
    slot: spec.slot,
    attempt: spec.attempt,
    retryable: spec.retryable,
    reason: spec.reason,
    ...(spec.nextAttemptAt === undefined ? {} : { nextAttemptAt: spec.nextAttemptAt }),
    ...(spec.traceContext === undefined ? {} : { traceContext: spec.traceContext }),
  });

export type IngressDeliveryStatus = "requested" | "accepted" | "failed";

export type IngressDeliveryProjection = Readonly<{
  deliveryKey: string;
  slot: IngressDeliverySlotPayload;
  principal: IngressDeliveryPrincipalPayload;
  requestedEventId: number;
  requestedAt: number;
  attempt: number;
}> &
  (
    | Readonly<{
        status: "requested";
      }>
    | Readonly<{
        status: "accepted";
        outcomeEventId: number;
        outcomeAt: number;
        receipt: IngressDeliveryReceiptPayload;
      }>
    | Readonly<{
        status: "failed";
        outcomeEventId: number;
        outcomeAt: number;
        retryable: boolean;
        reason: string;
        nextAttemptAt?: number;
      }>
  );

export type IngressDeliveryHistorySpec = Readonly<{
  deliveryKey?: string;
  slotKind?: IngressDeliveryKind;
}>;

export type IngressDeliveryHistoryProjection = Readonly<{
  deliveryKey?: string;
  slotKind?: IngressDeliveryKind;
  deliveries: ReadonlyArray<IngressDeliveryProjection>;
}>;

export type IngressDeliveryAttemptPlan = Readonly<{
  kind: "attempt";
  deliveryKey: string;
  attempt: number;
  requested: RuntimeEventCommitSpecByKind<typeof RUNTIME_EVENT_KIND.INGRESS_DELIVERY_REQUESTED>;
  accept: (
    requestedEventId: number,
    receipt?: IngressDeliveryReceiptPayload,
  ) => RuntimeEventCommitSpecByKind<typeof RUNTIME_EVENT_KIND.INGRESS_DELIVERY_ACCEPTED>;
  fail: (
    requestedEventId: number,
    spec: {
      readonly reason: string;
      readonly retryable?: boolean;
      readonly nextAttemptAt?: number;
    },
  ) => RuntimeEventCommitSpecByKind<typeof RUNTIME_EVENT_KIND.INGRESS_DELIVERY_FAILED>;
}>;

export type IngressDeliveryReplayPlan = Readonly<{
  kind: "replay";
  deliveryKey: string;
  projection: IngressDeliveryProjection;
}>;

export type IngressDeliveryPlan = IngressDeliveryAttemptPlan | IngressDeliveryReplayPlan;

export const ingressDeliveryLedgerReceipt = (spec: {
  readonly deliveryKey: string;
  readonly requestedEventId: number;
}): IngressDeliveryReceiptPayload => ({
  anchorId: `ingress.delivery:${encodeURIComponent(spec.deliveryKey)}:${spec.requestedEventId}`,
  anchorKind: "ledger_event",
});

export const projectIngressDeliveryHistory = (
  events: ReadonlyArray<LedgerEvent>,
  spec: IngressDeliveryHistorySpec = {},
): IngressDeliveryHistoryProjection => {
  const runtimeEvents = [...ingressDeliveryRuntimeEventsOf(events)].sort(
    (left, right) => left.id - right.id,
  );
  const outcomes = new Map<number, RuntimeIngressDeliveryOutcomeEvent>();
  for (const event of runtimeEvents) {
    if (isIngressDeliveryOutcomeEvent(event)) {
      outcomes.set(event.payload.requestedEventId, event);
    }
  }
  const deliveries = runtimeEvents
    .filter(
      (
        event,
      ): event is RuntimeLedgerEventByKind<typeof RUNTIME_EVENT_KIND.INGRESS_DELIVERY_REQUESTED> =>
        event.kind === RUNTIME_EVENT_KIND.INGRESS_DELIVERY_REQUESTED &&
        (spec.deliveryKey === undefined || event.payload.deliveryKey === spec.deliveryKey) &&
        (spec.slotKind === undefined || event.payload.slot.kind === spec.slotKind),
    )
    .map((event) => ingressDeliveryProjectionFromEvent(event, outcomes.get(event.id)))
    .sort((left, right) => right.requestedEventId - left.requestedEventId);

  return {
    ...(spec.deliveryKey === undefined ? {} : { deliveryKey: spec.deliveryKey }),
    ...(spec.slotKind === undefined ? {} : { slotKind: spec.slotKind }),
    deliveries,
  };
};

export const planIngressDelivery = (
  spec: RuntimeEventIdentitySpec & {
    readonly history: ReadonlyArray<LedgerEvent>;
    readonly deliveryKey: string;
    readonly slot: IngressDeliverySlotPayload;
    readonly principal: IngressDeliveryPrincipalPayload;
    readonly retryPolicy?: IngressDeliveryRetryPolicyPayload;
    readonly traceContext?: TraceContext;
  },
): IngressDeliveryPlan => {
  const latest = projectIngressDeliveryHistory(spec.history, {
    deliveryKey: spec.deliveryKey,
  }).deliveries[0];
  if (latest !== undefined) {
    if (latest.status !== "failed" || latest.retryable !== true) {
      return { kind: "replay", deliveryKey: spec.deliveryKey, projection: latest };
    }
  }
  const attempt = latest === undefined ? 1 : latest.attempt + 1;
  const requested = ingressDeliveryRequestedEvent({
    scopeRef: spec.scopeRef,
    effectAuthorityRef: spec.effectAuthorityRef,
    deliveryKey: spec.deliveryKey,
    slot: spec.slot,
    principal: spec.principal,
    attempt,
    ...(spec.retryPolicy === undefined ? {} : { retryPolicy: spec.retryPolicy }),
    ...(spec.traceContext === undefined ? {} : { traceContext: spec.traceContext }),
  });
  return {
    kind: "attempt",
    deliveryKey: spec.deliveryKey,
    attempt,
    requested,
    accept: (
      requestedEventId,
      receipt = ingressDeliveryLedgerReceipt({ deliveryKey: spec.deliveryKey, requestedEventId }),
    ) =>
      ingressDeliveryAcceptedEvent({
        scopeRef: spec.scopeRef,
        effectAuthorityRef: spec.effectAuthorityRef,
        requestedEventId,
        deliveryKey: spec.deliveryKey,
        slot: spec.slot,
        receipt,
        attempt,
        ...(spec.traceContext === undefined ? {} : { traceContext: spec.traceContext }),
      }),
    fail: (requestedEventId, failure) =>
      ingressDeliveryFailedEvent({
        scopeRef: spec.scopeRef,
        effectAuthorityRef: spec.effectAuthorityRef,
        requestedEventId,
        deliveryKey: spec.deliveryKey,
        slot: spec.slot,
        attempt,
        retryable: failure.retryable ?? false,
        reason: failure.reason,
        ...(failure.nextAttemptAt === undefined ? {} : { nextAttemptAt: failure.nextAttemptAt }),
        ...(spec.traceContext === undefined ? {} : { traceContext: spec.traceContext }),
      }),
  };
};

const ingressDeliveryRuntimeEventsOf = (
  events: ReadonlyArray<LedgerEvent>,
): ReadonlyArray<
  | RuntimeLedgerEventByKind<typeof RUNTIME_EVENT_KIND.INGRESS_DELIVERY_REQUESTED>
  | RuntimeLedgerEventByKind<typeof RUNTIME_EVENT_KIND.INGRESS_DELIVERY_ACCEPTED>
  | RuntimeLedgerEventByKind<typeof RUNTIME_EVENT_KIND.INGRESS_DELIVERY_FAILED>
> => {
  const decoded: Array<
    | RuntimeLedgerEventByKind<typeof RUNTIME_EVENT_KIND.INGRESS_DELIVERY_REQUESTED>
    | RuntimeLedgerEventByKind<typeof RUNTIME_EVENT_KIND.INGRESS_DELIVERY_ACCEPTED>
    | RuntimeLedgerEventByKind<typeof RUNTIME_EVENT_KIND.INGRESS_DELIVERY_FAILED>
  > = [];
  for (const event of events) {
    const result = decodeRuntimeLedgerEvent(event);
    if (result._tag === "runtime" && isIngressDeliveryEvent(result.event)) {
      decoded.push(result.event);
    }
  }
  return decoded;
};

const ingressDeliveryProjectionFromEvent = (
  requested: RuntimeLedgerEventByKind<typeof RUNTIME_EVENT_KIND.INGRESS_DELIVERY_REQUESTED>,
  outcome: RuntimeIngressDeliveryOutcomeEvent | undefined,
): IngressDeliveryProjection => {
  const base = {
    deliveryKey: requested.payload.deliveryKey,
    slot: requested.payload.slot,
    principal: requested.payload.principal,
    requestedEventId: requested.id,
    requestedAt: requested.ts,
    attempt: requested.payload.attempt,
  } as const;

  if (outcome === undefined) {
    return {
      ...base,
      status: "requested",
    };
  }

  if (outcome.kind === RUNTIME_EVENT_KIND.INGRESS_DELIVERY_ACCEPTED) {
    return {
      ...base,
      status: "accepted",
      outcomeEventId: outcome.id,
      outcomeAt: outcome.ts,
      receipt: outcome.payload.receipt,
    };
  }

  return {
    ...base,
    status: "failed",
    outcomeEventId: outcome.id,
    outcomeAt: outcome.ts,
    retryable: outcome.payload.retryable,
    reason: outcome.payload.reason,
    ...(outcome.payload.nextAttemptAt === undefined
      ? {}
      : { nextAttemptAt: outcome.payload.nextAttemptAt }),
  };
};

export const scheduleFireRequestedEvent = (
  spec: RuntimeEventIdentitySpec & {
    readonly scheduleId: string;
    readonly fireId: string;
    readonly scheduledAt: string;
    readonly appPrincipal: SchedulePrincipalPayload;
    readonly traceContext?: TraceContext;
  },
): RuntimeEventCommitSpecByKind<typeof RUNTIME_EVENT_KIND.SCHEDULE_FIRE_REQUESTED> =>
  runtimeEvent(spec, RUNTIME_EVENT_KIND.SCHEDULE_FIRE_REQUESTED, {
    scheduleId: spec.scheduleId,
    fireId: spec.fireId,
    scheduledAt: spec.scheduledAt,
    appPrincipal: spec.appPrincipal,
    ...(spec.traceContext === undefined ? {} : { traceContext: spec.traceContext }),
  });

export const scheduleFireDispatchedEvent = (
  spec: RuntimeEventIdentitySpec & {
    readonly scheduleId: string;
    readonly fireId: string;
    readonly scheduledAt: string;
    readonly requestedEventId: number;
    readonly productLink: ScheduleFireProductLink;
    readonly traceContext?: TraceContext;
  },
): RuntimeEventCommitSpecByKind<typeof RUNTIME_EVENT_KIND.SCHEDULE_FIRE_DISPATCHED> =>
  runtimeEvent(spec, RUNTIME_EVENT_KIND.SCHEDULE_FIRE_DISPATCHED, {
    scheduleId: spec.scheduleId,
    fireId: spec.fireId,
    scheduledAt: spec.scheduledAt,
    requestedEventId: spec.requestedEventId,
    productLink: spec.productLink,
    ...(spec.traceContext === undefined ? {} : { traceContext: spec.traceContext }),
  });

export const scheduleFireFailedEvent = (
  spec: RuntimeEventIdentitySpec & {
    readonly scheduleId: string;
    readonly fireId: string;
    readonly scheduledAt: string;
    readonly requestedEventId: number;
    readonly phase: "handler" | "product_ingress" | "contract";
    readonly reason: string;
    readonly traceContext?: TraceContext;
  },
): RuntimeEventCommitSpecByKind<typeof RUNTIME_EVENT_KIND.SCHEDULE_FIRE_FAILED> =>
  runtimeEvent(spec, RUNTIME_EVENT_KIND.SCHEDULE_FIRE_FAILED, {
    scheduleId: spec.scheduleId,
    fireId: spec.fireId,
    scheduledAt: spec.scheduledAt,
    requestedEventId: spec.requestedEventId,
    phase: spec.phase,
    reason: spec.reason,
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
