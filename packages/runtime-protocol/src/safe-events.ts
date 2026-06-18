import type { SafeLedgerEvent, SafeLedgerValue } from "@agent-os/kernel";
import { redactedSafeSummary, safeLedgerEvent, safeValueFromUnknown } from "@agent-os/kernel";
import type { LedgerEvent } from "@agent-os/kernel/types";
import { validateEffectClaim } from "@agent-os/kernel/effect-claim";
import { ABORT } from "@agent-os/kernel/abort";
import { defineProjectionSpec, project, projectionOutputOrFail } from "@agent-os/kernel/projection";
import { Result, pipe } from "effect";
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

const utf8Bytes = (value: string): number => new TextEncoder().encode(value).byteLength;

const recordFromUnknown = (value: unknown): Readonly<Record<string, unknown>> | undefined => {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Readonly<Record<string, unknown>>;
  }
  if (typeof value !== "string") return undefined;
  return pipe(
    Result.try({ try: () => JSON.parse(value) as unknown, catch: () => undefined }),
    Result.match({
      onFailure: () => undefined,
      onSuccess: (parsed) =>
        parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as Readonly<Record<string, unknown>>)
          : undefined,
    }),
  );
};

const stringField = (
  value: Readonly<Record<string, unknown>> | undefined,
  key: string,
): string | undefined => {
  const field = value?.[key];
  return typeof field === "string" && field.length > 0 ? field : undefined;
};

const numberField = (
  value: Readonly<Record<string, unknown>> | undefined,
  key: string,
): number | undefined => {
  const field = value?.[key];
  return typeof field === "number" && Number.isFinite(field) ? field : undefined;
};

const toolActionFor = (toolName: string): "read" | "write" | "run" => {
  if (toolName === "read_file" || toolName === "list_files") return "read";
  if (
    toolName.includes("write") ||
    toolName.includes("append") ||
    toolName.includes("edit") ||
    toolName.includes("delete")
  ) {
    return "write";
  }
  return "run";
};

const toolIoItem = (input: {
  readonly action: "read" | "write" | "run";
  readonly path: string;
  readonly bytes?: number;
  readonly role?: string;
}): SafeLedgerValue => ({
  action: input.action,
  path: input.path,
  ...(input.bytes === undefined ? {} : { bytes: input.bytes }),
  ...(input.role === undefined ? {} : { role: input.role }),
});

const pushUniqueIoItem = (
  items: SafeLedgerValue[],
  input: {
    readonly action: "read" | "write" | "run";
    readonly path?: string;
    readonly bytes?: number;
    readonly role?: string;
  },
): void => {
  if (input.path === undefined) return;
  const key = `${input.action}:${input.path}:${input.role ?? ""}`;
  const exists = items.some((item) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return false;
    const record = item as Readonly<Record<string, SafeLedgerValue>>;
    const action = typeof record.action === "string" ? record.action : "";
    const path = typeof record.path === "string" ? record.path : "";
    const role = typeof record.role === "string" ? record.role : "";
    return `${action}:${path}:${role}` === key;
  });
  if (!exists) {
    items.push(toolIoItem({ ...input, path: input.path }));
  }
};

const toolIoSummary = (
  toolName: string,
  args: unknown,
  result?: unknown,
): ReadonlyArray<SafeLedgerValue> => {
  const action = toolActionFor(toolName);
  const argRecord = recordFromUnknown(args);
  const resultRecord = recordFromUnknown(result);
  const items: SafeLedgerValue[] = [];

  const path = stringField(resultRecord, "path") ?? stringField(argRecord, "path");
  const bytes =
    numberField(resultRecord, "bytesWritten") ??
    numberField(resultRecord, "bytesRead") ??
    (toolName === "read_file" && typeof resultRecord?.content === "string"
      ? utf8Bytes(resultRecord.content)
      : undefined);
  pushUniqueIoItem(items, { action, path, bytes });

  pushUniqueIoItem(items, {
    action: "write",
    path: stringField(resultRecord, "metadataPath"),
    bytes: numberField(resultRecord, "metadataBytesWritten"),
    role: "metadata",
  });
  pushUniqueIoItem(items, {
    action: "write",
    path: stringField(resultRecord, "htmlPath"),
    bytes: numberField(resultRecord, "htmlBytes"),
    role: "html",
  });
  pushUniqueIoItem(items, {
    action: "write",
    path: stringField(resultRecord, "designMdPath"),
    bytes: numberField(resultRecord, "designMdBytes"),
    role: "designMd",
  });

  return items;
};

const safeToolIoPayload = (
  toolName: string,
  args: unknown,
  result?: unknown,
): SafeLedgerValue | undefined => {
  const io = toolIoSummary(toolName, args, result);
  return io.length === 0 ? undefined : io;
};

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
          const io = safeToolIoPayload(item.call.function.name, item.call.function.arguments);
          items.push({
            type: "tool_call",
            toolCallId: item.call.id,
            toolName: item.call.function.name,
            args: redactedSafeSummary(item.call.function.arguments, "tool_arguments"),
            ...(io === undefined ? {} : { io }),
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
      const io = safeToolIoPayload(event.payload.name, event.payload.args, event.payload.result);
      return safeLedgerEvent(event, {
        runId: event.payload.runId,
        toolCallId: event.payload.toolCallId,
        toolName: event.payload.name,
        args: redactedSafeSummary(event.payload.args, "tool_arguments"),
        result: redactedSafeSummary(event.payload.result, "tool_result"),
        ...(io === undefined ? {} : { io }),
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
