import type { SafeLedgerEvent, SafeLedgerValue } from "@agent-os/core";
import { redactedSafeSummary, safeLedgerEvent, safeValueFromUnknown } from "@agent-os/core";
import type { LedgerEvent } from "@agent-os/core/types";
import { validateEffectClaim } from "@agent-os/core/effect-claim";
import { ABORT } from "@agent-os/core/abort";
import { defineProjectionSpec, project, projectionOutputOrFail } from "@agent-os/core/projection";
import {
  decodeRuntimeLedgerEvent,
  isRuntimeAbortEventKind,
  RUNTIME_EVENT_KIND,
  type RuntimeAbortEventKind,
  type RuntimeLedgerEvent,
  type RuntimeLedgerEventByKind,
} from "./runtime-events";

const RUNTIME_SAFE_LEDGER_EVENT_PROJECTION_SOURCE = {
  kind: "ledger-vocabulary",
  ref: "@agent-os/runtime-protocol/runtime-events",
} as const;

const safeUsage = (usage: {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}): SafeLedgerValue => ({
  promptTokens: usage.promptTokens,
  completionTokens: usage.completionTokens,
  totalTokens: usage.totalTokens,
});

const safeToolRejectionClaim = (claim: unknown): SafeLedgerValue | undefined => {
  const validation = validateEffectClaim(claim);
  if (!validation.ok || validation.claim.phase !== "rejected") return undefined;
  return {
    rejectionKind: validation.claim.rejectionRef.rejectionKind,
    ...(validation.claim.rejectionRef.reason === undefined
      ? {}
      : { reason: validation.claim.rejectionRef.reason }),
  };
};

const safeRuntimeAbortPayload = (
  event: RuntimeLedgerEventByKind<RuntimeAbortEventKind>,
): SafeLedgerEvent => {
  const reason =
    event.kind === ABORT.TOOL_ERROR && typeof event.payload.cause === "string"
      ? event.payload.cause
      : event.kind;
  const toolName =
    typeof event.payload.toolName === "string" && event.payload.toolName.length > 0
      ? event.payload.toolName
      : undefined;
  return safeLedgerEvent(event, {
    abortKind: event.kind,
    runId: event.payload.runId,
    tokensUsed: event.payload.tokensUsed,
    reason,
    ...(toolName === undefined ? {} : { toolName }),
  });
};

const projectRuntimeSafeEvent = (event: RuntimeLedgerEvent): SafeLedgerEvent => {
  switch (event.kind) {
    case RUNTIME_EVENT_KIND.AGENT_RUN_STARTED:
      return safeLedgerEvent(event, {
        runId: event.id,
        intent: redactedSafeSummary(event.payload.intent, "run_input"),
      });
    case RUNTIME_EVENT_KIND.CHAT_INGESTED:
      return safeLedgerEvent(event, {
        runId: event.payload.runId,
        intent: redactedSafeSummary(event.payload.intent, "run_input"),
      });
    case RUNTIME_EVENT_KIND.AGENT_SESSION_TURN_SUBMITTED:
      return safeLedgerEvent(event, {
        sessionRef: event.payload.sessionRef,
        turnRef: event.payload.turnRef,
        runtimeRunId: event.payload.runtimeRunId,
      });
    case RUNTIME_EVENT_KIND.WORKFLOW_RUN_SUBMITTED:
      return safeLedgerEvent(event, {
        workflowId: event.payload.workflowId,
        workflowRunId: event.payload.workflowRunId,
        runtimeRunId: event.payload.runtimeRunId,
        ...(event.payload.idempotencyKey === undefined
          ? {}
          : { idempotencyKey: event.payload.idempotencyKey }),
        ...(event.payload.inputDigest === undefined ? {} : { inputDigest: event.payload.inputDigest }),
      });
    case RUNTIME_EVENT_KIND.AGENT_RUN_INTERRUPTED:
      return safeLedgerEvent(event, {
        runId: event.payload.runId,
        turnIndex: event.payload.turn.index,
        interruptId: event.payload.interruptId,
        reason: event.payload.reason,
        hasResumeSchema: true,
        tokensUsed: event.payload.tokensUsed,
        ...(event.payload.decision === undefined
          ? {}
          : {
              decision: {
                gateRef: event.payload.decision.gateRef,
                subjectRef: event.payload.decision.subjectRef,
                toolCallId: event.payload.decision.toolCallId,
                toolName: event.payload.decision.toolName,
              },
            }),
      });
    case RUNTIME_EVENT_KIND.AGENT_RUN_RESUMED:
      return safeLedgerEvent(event, {
        runId: event.payload.runId,
        turnIndex: event.payload.turn.index,
        interruptId: event.payload.interruptId,
        resumedAtEventId: event.payload.resumedAtEventId,
      });
    case RUNTIME_EVENT_KIND.LLM_REQUESTED:
      return safeLedgerEvent(event, {
        runId: event.payload.runId,
        turnIndex: event.payload.turn.index,
        ...(event.payload.modelId === undefined ? {} : { modelId: event.payload.modelId }),
        toolNames: event.payload.toolNames,
        ...(event.payload.toolChoice === undefined ? {} : { toolChoice: event.payload.toolChoice }),
      });
    case RUNTIME_EVENT_KIND.LLM_RESPONSE: {
      const items: SafeLedgerValue[] = [];
      for (const item of event.payload.items) {
        if (item.type === "message") {
          items.push({ type: "message", text: item.text });
          continue;
        }
        if (item.type === "tool_call") {
          items.push({
            type: "tool_call",
            toolCallId: item.call.id,
            toolName: item.call.function.name,
            args: redactedSafeSummary(item.call.function.arguments, "tool_arguments"),
          });
          continue;
        }
        if (item.type === "tool_result") {
          items.push({
            type: "tool_result",
            toolCallId: item.callId,
            result: redactedSafeSummary(item.content, "tool_result"),
          });
          continue;
        }
        if (item.type === "reasoning") {
          items.push({
            type: "reasoning",
            summary: item.summaryRef ?? "[redacted reasoning]",
          });
          continue;
        }
        if (item.type === "refusal") {
          items.push({
            type: "refusal",
            refusal: redactedSafeSummary(item.reason, "provider_error"),
          });
          continue;
        }
        if (item.type === "error") {
          items.push({
            type: "error",
            error: redactedSafeSummary(item.message, "provider_error"),
          });
        }
      }
      return safeLedgerEvent(event, {
        runId: event.payload.turn.id,
        turnIndex: event.payload.turn.index,
        items,
        usage: safeUsage(event.payload.usage),
      });
    }
    case RUNTIME_EVENT_KIND.RUNTIME_COMPLETED_AFTER_TOOLS:
      return safeLedgerEvent(event, {
        runId: event.payload.runId,
        turnIndex: event.payload.turn.index,
        toolNames: event.payload.toolNames,
        tokensUsed: event.payload.tokensUsed,
      });
    case RUNTIME_EVENT_KIND.RUNTIME_HISTORY_COMPACTED:
      return safeLedgerEvent(event, {
        runId: event.payload.runId,
        turnIndex: event.payload.turn.index,
        sourceEventId: event.payload.sourceEventId,
        target: {
          kind: event.payload.target.kind,
          toolCallId: event.payload.target.toolCallId,
          toolName: event.payload.target.toolName,
        },
        strategy: event.payload.strategy,
        originalBytes: event.payload.originalBytes,
        compactedBytes: event.payload.compactedBytes,
      });
    case RUNTIME_EVENT_KIND.RUNTIME_REKEYED:
      return safeLedgerEvent(event, {
        runId: event.payload.runId,
        sourceEventId: event.payload.sourceEventId,
        sourceKeyRef: event.payload.sourceKeyRef,
        targetKeyRef: event.payload.targetKeyRef,
        purpose: event.payload.purpose,
      });
    case RUNTIME_EVENT_KIND.TOOL_EXECUTED: {
      return safeLedgerEvent(event, {
        runId: event.payload.runId,
        toolCallId: event.payload.toolCallId,
        toolName: event.payload.name,
        args: redactedSafeSummary(event.payload.args, "tool_arguments"),
        result: redactedSafeSummary(event.payload.result, "tool_result"),
      });
    }
    case RUNTIME_EVENT_KIND.TOOL_REJECTED: {
      const claim = safeToolRejectionClaim(event.payload.claim);
      const diagnostics = safeValueFromUnknown(event.payload.diagnostics);
      return safeLedgerEvent(event, {
        runId: event.payload.runId,
        toolCallId: event.payload.toolCallId,
        toolName: event.payload.name,
        args: redactedSafeSummary(event.payload.args, "tool_arguments"),
        ...(claim === undefined ? {} : { claim }),
        ...(diagnostics === undefined ? {} : { diagnostics }),
      });
    }
    case RUNTIME_EVENT_KIND.AGENT_RUN_COMPLETED:
      return safeLedgerEvent(event, {
        runId: event.payload.runId,
        final: redactedSafeSummary(event.payload.final, "run_output"),
        output: redactedSafeSummary(event.payload.output, "run_output"),
        outputKind: event.payload.outputKind,
        tokensUsed: event.payload.tokensUsed,
        ...(event.payload.turn === undefined ? {} : { turnIndex: event.payload.turn.index }),
      });
    default:
      return isRuntimeAbortEventKind(event.kind)
        ? safeRuntimeAbortPayload(event as RuntimeLedgerEventByKind<RuntimeAbortEventKind>)
        : safeLedgerEvent(event, {});
  }
};

const runtimeSafeLedgerEventProjection = defineProjectionSpec<RuntimeLedgerEvent, SafeLedgerEvent>({
  id: "runtime-protocol.safe-ledger-event",
  version: 1,
  source: RUNTIME_SAFE_LEDGER_EVENT_PROJECTION_SOURCE,
  project: (event, ctx) => ctx.ok(projectRuntimeSafeEvent(event)),
});

export const projectRuntimeSafeLedgerEvent = (event: LedgerEvent): SafeLedgerEvent | undefined => {
  const decoded = decodeRuntimeLedgerEvent(event);
  return decoded._tag === "runtime"
    ? projectionOutputOrFail(project(runtimeSafeLedgerEventProjection, decoded.event))
    : undefined;
};
