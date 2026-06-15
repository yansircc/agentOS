import { ABORT, reasonOf } from "@agent-os/kernel/abort";
import type { LedgerEvent } from "@agent-os/kernel/types";
import { validateEffectClaim } from "@agent-os/kernel/effect-claim";
import {
  decodeRuntimeLedgerEvent,
  EXTERNAL_TOOL_EXECUTION_REQUIRES_RECEIPT_REASON,
  EXTERNAL_TOOL_REPLAY_REQUIRES_RECEIPT_REASON,
  isRuntimeAbortEventKind,
  RUNTIME_EVENT_KIND,
  type RuntimeAbortEventKind,
  type RuntimeLedgerEvent,
  type RuntimeLedgerEventByKind,
  type ToolArgumentSummary,
  type ToolRejectedDiagnosticsPhase,
} from "./runtime-events";

export type FailureDiagnosticCategory =
  | "invalid_args"
  | "unknown_tool"
  | "missing_execution_path"
  | "missing_material"
  | "missing_runtime_capability"
  | "rate_limited"
  | "budget"
  | "provider_failure"
  | "tool_execution"
  | "tool_rejected";

export type FailureDiagnosticOwner =
  | "model"
  | "integrator"
  | "tool_author"
  | "runtime"
  | "provider";

export interface FailureDiagnosticInternalFacts {
  readonly source: "tool" | "run";
  readonly eventId: number;
  readonly phase: ToolRejectedDiagnosticsPhase | "terminal";
  readonly reason: string;
  readonly terminalReason?: string;
  readonly toolName?: string;
  readonly toolCallId?: string;
  readonly argumentSummary?: ToolArgumentSummary;
  readonly schemaIssues?: ReadonlyArray<{
    readonly path: string;
    readonly issue: string;
  }>;
}

export interface FailureDiagnosticEnvelope {
  readonly category: FailureDiagnosticCategory;
  readonly owner: FailureDiagnosticOwner;
  readonly retryable: boolean;
  readonly publicMessage: string;
}

export interface FailureDiagnostic {
  readonly source: "tool" | "run";
  readonly eventId: number;
  readonly phase: ToolRejectedDiagnosticsPhase | "terminal";
  readonly reason: string;
  readonly category: FailureDiagnosticEnvelope["category"];
  readonly owner: FailureDiagnosticEnvelope["owner"];
  readonly retryable: FailureDiagnosticEnvelope["retryable"];
  readonly publicMessage: FailureDiagnosticEnvelope["publicMessage"];
  readonly internalFacts: FailureDiagnosticInternalFacts;
  readonly toolName?: string;
  readonly toolCallId?: string;
  readonly argumentSummary?: ToolArgumentSummary;
  readonly schemaIssues?: ReadonlyArray<{
    readonly path: string;
    readonly issue: string;
  }>;
}

/**
 * Redacted failure diagnostics derived from runtime ledger facts.
 *
 * @agentosPrimitive primitive.runtime.projectFailureDiagnostics
 * @agentosInvariant invariant.d10.truth-identity
 * @agentosDocs docs/concepts/durable-truth.md
 * @public
 */
export interface FailureDiagnostics {
  readonly runId: number;
  readonly terminalReason?: string;
  readonly diagnostics: ReadonlyArray<FailureDiagnostic>;
}

const normalizeRunId = (runId: number | string): number => {
  const n = typeof runId === "number" ? runId : Number(runId);
  return Number.isInteger(n) && n >= 1 ? n : 0;
};

const runtimeEventsOf = (events: ReadonlyArray<LedgerEvent>): ReadonlyArray<RuntimeLedgerEvent> => {
  const decoded: RuntimeLedgerEvent[] = [];
  for (const event of events) {
    const result = decodeRuntimeLedgerEvent(event);
    if (result._tag === "runtime") decoded.push(result.event);
  }
  return decoded;
};

type RuntimeAbortLedgerEvent = RuntimeLedgerEventByKind<RuntimeAbortEventKind>;

const isRuntimeAbortLedgerEvent = (event: RuntimeLedgerEvent): event is RuntimeAbortLedgerEvent =>
  isRuntimeAbortEventKind(event.kind);

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const claimReason = (claim: unknown): string | undefined => {
  const validation = validateEffectClaim(claim);
  if (!validation.ok || validation.claim.phase !== "rejected") return undefined;
  return validation.claim.rejectionRef.reason ?? validation.claim.rejectionRef.rejectionKind;
};

const terminalToolName = (payload: unknown): string | undefined =>
  isRecord(payload) && typeof payload.toolName === "string" ? payload.toolName : undefined;

const terminalCauseReason = (payload: unknown): string | undefined =>
  isRecord(payload) && typeof payload.cause === "string" ? payload.cause : undefined;

const categoryForReason = (reason: string): FailureDiagnosticCategory => {
  if (reason === "invalid_args") return "invalid_args";
  if (reason === "unknown_tool") return "unknown_tool";
  if (
    reason === EXTERNAL_TOOL_EXECUTION_REQUIRES_RECEIPT_REASON ||
    reason === EXTERNAL_TOOL_REPLAY_REQUIRES_RECEIPT_REASON
  ) {
    return "missing_execution_path";
  }
  if (reason.startsWith("material_missing:")) return "missing_material";
  if (
    reason === "missing_emit_intent" ||
    reason === "missing_await_projection" ||
    reason === "undeclared_intent"
  ) {
    return "missing_runtime_capability";
  }
  if (reason === "rate_limited") return "rate_limited";
  if (
    reason === "budget_time" ||
    reason === "budget_tokens" ||
    reason.startsWith("invalid_quota_")
  ) {
    return "budget";
  }
  if (
    reason === "provider_timeout" ||
    reason === "upstream_failure" ||
    reason === "retries" ||
    reason === "seed_write_failed" ||
    reason === "terminal_write_failed" ||
    reason === "terminal_read_failed" ||
    reason === "data_plane_failed" ||
    reason === "verifier_failed" ||
    reason.startsWith("provider_http_failure")
  ) {
    return "provider_failure";
  }
  if (
    reason === "candidate_missing" ||
    reason === "run_id_mismatch" ||
    reason === "terminal_build_failed"
  ) {
    return "missing_runtime_capability";
  }
  return "tool_execution";
};

const ownerForCategory = (category: FailureDiagnosticCategory): FailureDiagnosticOwner => {
  switch (category) {
    case "invalid_args":
    case "unknown_tool":
      return "model";
    case "missing_execution_path":
    case "missing_material":
    case "missing_runtime_capability":
      return "integrator";
    case "rate_limited":
    case "budget":
      return "runtime";
    case "provider_failure":
      return "provider";
    case "tool_execution":
    case "tool_rejected":
      return "tool_author";
  }
};

const retryableForCategory = (category: FailureDiagnosticCategory): boolean => {
  switch (category) {
    case "invalid_args":
    case "unknown_tool":
    case "rate_limited":
    case "provider_failure":
      return true;
    case "missing_execution_path":
    case "missing_material":
    case "missing_runtime_capability":
    case "budget":
    case "tool_execution":
    case "tool_rejected":
      return false;
  }
};

const publicMessageForCategory = (category: FailureDiagnosticCategory): string => {
  switch (category) {
    case "invalid_args":
      return "Tool arguments did not match the tool schema.";
    case "unknown_tool":
      return "The model requested a tool that is not available.";
    case "missing_execution_path":
      return "This tool requires a receipt-backed execution path before it can run.";
    case "missing_material":
      return "A required material binding is missing.";
    case "missing_runtime_capability":
      return "A required runtime capability is not bound.";
    case "rate_limited":
      return "The run exceeded a quota or rate limit.";
    case "budget":
      return "The run exhausted its configured budget.";
    case "provider_failure":
      return "The upstream provider failed or timed out.";
    case "tool_execution":
      return "Tool execution failed.";
    case "tool_rejected":
      return "The tool call was rejected.";
  }
};

export const failureDiagnosticEnvelopeForReason = (reason: string): FailureDiagnosticEnvelope => {
  const category = categoryForReason(reason);
  return {
    category,
    owner: ownerForCategory(category),
    retryable: retryableForCategory(category),
    publicMessage: publicMessageForCategory(category),
  };
};

const failureEnvelope = (
  facts: FailureDiagnosticInternalFacts,
): Pick<
  FailureDiagnostic,
  "category" | "owner" | "retryable" | "publicMessage" | "internalFacts"
> => {
  return {
    ...failureDiagnosticEnvelopeForReason(facts.reason),
    internalFacts: facts,
  };
};

/**
 * Projects the diagnostic view for a failed run from ledger facts only.
 */
export const projectFailureDiagnostics = (
  events: ReadonlyArray<LedgerEvent>,
  rawRunId: number | string,
): FailureDiagnostics | null => {
  const runId = normalizeRunId(rawRunId);
  const runtimeEvents = runtimeEventsOf(events);
  const diagnostics: FailureDiagnostic[] = [];

  for (const event of runtimeEvents) {
    if (event.kind !== RUNTIME_EVENT_KIND.TOOL_REJECTED || event.payload.runId !== runId) {
      continue;
    }
    const detail = event.payload.diagnostics;
    const reason = detail?.reason ?? claimReason(event.payload.claim) ?? "tool_rejected";
    const facts: FailureDiagnosticInternalFacts = {
      source: "tool",
      eventId: event.id,
      phase: detail?.phase ?? "execution",
      reason,
      toolName: event.payload.name,
      toolCallId: event.payload.toolCallId,
      ...(detail?.argumentSummary === undefined ? {} : { argumentSummary: detail.argumentSummary }),
      ...(detail?.schemaIssues === undefined ? {} : { schemaIssues: detail.schemaIssues }),
    };
    diagnostics.push({
      source: "tool",
      eventId: event.id,
      phase: facts.phase,
      reason,
      ...failureEnvelope(facts),
      toolName: event.payload.name,
      toolCallId: event.payload.toolCallId,
      ...(detail?.argumentSummary === undefined ? {} : { argumentSummary: detail.argumentSummary }),
      ...(detail?.schemaIssues === undefined ? {} : { schemaIssues: detail.schemaIssues }),
    });
  }

  const terminal = runtimeEvents.find(
    (event): event is RuntimeAbortLedgerEvent =>
      isRuntimeAbortLedgerEvent(event) && event.payload.runId === runId,
  );
  if (terminal === undefined) {
    return diagnostics.length === 0 ? null : { runId, diagnostics };
  }

  const terminalReason = reasonOf(terminal.kind);
  const cause = terminalCauseReason(terminal.payload) ?? terminalReason;
  const toolName =
    terminal.kind === ABORT.TOOL_ERROR ? terminalToolName(terminal.payload) : undefined;
  const alreadyExplained =
    toolName !== undefined &&
    diagnostics.some(
      (diagnostic) => diagnostic.source === "tool" && diagnostic.toolName === toolName,
    );
  if (!alreadyExplained) {
    const facts: FailureDiagnosticInternalFacts = {
      source: "run",
      eventId: terminal.id,
      phase: "terminal",
      reason: cause,
      terminalReason,
      ...(toolName === undefined ? {} : { toolName }),
    };
    diagnostics.push({
      source: "run",
      eventId: terminal.id,
      phase: "terminal",
      reason: cause,
      ...failureEnvelope(facts),
      ...(toolName === undefined ? {} : { toolName }),
    });
  }

  return { runId, terminalReason, diagnostics };
};
