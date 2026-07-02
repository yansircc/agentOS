import type {
  RunListPage,
  RunListSpec,
  RunCancellationStatus,
  RunInspection,
  RunInspectionDiagnostic,
  RunInterruption,
  RunLastKnownEvent,
  RunProductLink,
  RunRequestStatus,
  RunResume,
  RunStatus,
  RunStatusKind,
  RunSummary,
  RunTerminal,
  RunToolCall,
  RunTrace,
  RunTurn,
} from "@agent-os/core/types";
import type { TelemetryFanoutDiagnostic } from "@agent-os/core/telemetry-protocol";
import type { LedgerEvent } from "@agent-os/core/types";
import { ABORT, reasonOf, type AbortKind } from "@agent-os/core/abort";
import { defineProjectionSpec, project, projectionOutputOrFail } from "@agent-os/core/projection";
import { textFromLlmOutputItems } from "@agent-os/core/llm-protocol";
import {
  continuationRefFromInterruptedEvent,
  decodeRuntimeLedgerEvent,
  inputRequestRefFromInterruptedEvent,
  isRuntimeAbortEventKind,
  RUNTIME_EVENT_KIND,
  type InputRequestDescriptor,
  type RuntimeAbortEventKind,
  type RuntimeLedgerEvent,
  type RuntimeLedgerEventByKind,
  type AgentSessionTurnSubmittedPayload,
  type WorkflowRunSubmittedPayload,
  type SubmitResult,
} from "@agent-os/core/runtime-protocol";
import { RUNTIME_DIAGNOSTIC_EVENT_PREFIX } from "./runtime-diagnostic-carrier/definition";
export { projectInputRequestSettlement } from "./input-request";

export type { RunInspection, RunInspectionDiagnostic } from "@agent-os/core/types";

export const RUN_BEARING_KINDS: ReadonlyArray<string> = [
  RUNTIME_EVENT_KIND.AGENT_RUN_STARTED,
  RUNTIME_EVENT_KIND.AGENT_RUN_INTERRUPTED,
  RUNTIME_EVENT_KIND.AGENT_RUN_RESUMED,
  RUNTIME_EVENT_KIND.AGENT_RUN_COMPLETED,
  ...Object.values(ABORT),
];

const RUNTIME_LEDGER_PROJECTION_SOURCE = {
  kind: "ledger-vocabulary",
  ref: "@agent-os/runtime-protocol/runtime-events",
} as const;

const normalizeRunId = (runId: number | string): number => {
  const n = typeof runId === "number" ? runId : Number(runId);
  return Number.isInteger(n) && n >= 1 ? n : 0;
};

const runtimeEventsOf = (events: ReadonlyArray<LedgerEvent>): ReadonlyArray<RuntimeLedgerEvent> => {
  const decoded: RuntimeLedgerEvent[] = [];
  for (const event of events) {
    const result = decodeRuntimeLedgerEvent(event);
    if (result._tag === "runtime") {
      decoded.push(result.event);
    }
  }
  return decoded;
};

const startFor = (
  events: ReadonlyArray<RuntimeLedgerEvent>,
  runId: number,
): RuntimeLedgerEventByKind<typeof RUNTIME_EVENT_KIND.AGENT_RUN_STARTED> | undefined =>
  events.find(
    (event): event is RuntimeLedgerEventByKind<typeof RUNTIME_EVENT_KIND.AGENT_RUN_STARTED> =>
      event.id === runId && event.kind === RUNTIME_EVENT_KIND.AGENT_RUN_STARTED,
  );

const isScheduleFireEvent = (event: RuntimeLedgerEvent): boolean =>
  event.kind === RUNTIME_EVENT_KIND.SCHEDULE_FIRE_REQUESTED ||
  event.kind === RUNTIME_EVENT_KIND.SCHEDULE_FIRE_DISPATCHED ||
  event.kind === RUNTIME_EVENT_KIND.SCHEDULE_FIRE_FAILED;

const runtimeRunId = (event: RuntimeLedgerEvent): number | undefined => {
  switch (event.kind) {
    case RUNTIME_EVENT_KIND.AGENT_RUN_STARTED:
      return event.id;
    case RUNTIME_EVENT_KIND.AGENT_SESSION_TURN_SUBMITTED:
    case RUNTIME_EVENT_KIND.WORKFLOW_RUN_SUBMITTED:
    case RUNTIME_EVENT_KIND.PRODUCT_RUN_LINKED:
      return event.payload.runtimeRunId;
    case RUNTIME_EVENT_KIND.SCHEDULE_FIRE_REQUESTED:
    case RUNTIME_EVENT_KIND.SCHEDULE_FIRE_DISPATCHED:
    case RUNTIME_EVENT_KIND.SCHEDULE_FIRE_FAILED:
      return undefined;
    case RUNTIME_EVENT_KIND.AGENT_RUN_INTERRUPTED:
    case RUNTIME_EVENT_KIND.AGENT_RUN_RESUMED:
      return event.payload.runId;
    case RUNTIME_EVENT_KIND.LLM_REQUESTED:
    case RUNTIME_EVENT_KIND.LLM_RESPONSE:
      return event.payload.turn.id;
    case RUNTIME_EVENT_KIND.CHAT_INGESTED:
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

const isRuntimeAbortEvent = (
  event: RuntimeLedgerEvent,
): event is RuntimeLedgerEventByKind<RuntimeAbortEventKind> => isRuntimeAbortEventKind(event.kind);

const runTerminal = (
  events: ReadonlyArray<RuntimeLedgerEvent>,
  runId: number,
): RunTerminal | null => {
  const completed = events.find(
    (event): event is RuntimeLedgerEventByKind<typeof RUNTIME_EVENT_KIND.AGENT_RUN_COMPLETED> =>
      event.kind === RUNTIME_EVENT_KIND.AGENT_RUN_COMPLETED && event.payload.runId === runId,
  );
  if (completed !== undefined) {
    return {
      kind: "delivered",
      at: completed.ts,
      event: completed.kind,
      payload: completed.payload,
    };
  }

  const aborted = events.find(
    (event): event is RuntimeLedgerEventByKind<RuntimeAbortEventKind> =>
      isRuntimeAbortEvent(event) && event.payload.runId === runId,
  );
  if (aborted !== undefined) {
    return {
      kind: "aborted",
      at: aborted.ts,
      event: aborted.kind,
      payload: aborted.payload,
    };
  }

  return null;
};

const interruptionKey = (payload: {
  readonly runId: number;
  readonly turn: { readonly id: number; readonly index: number };
  readonly interruptId: string;
}): string => `${payload.runId}:${payload.turn.id}:${payload.turn.index}:${payload.interruptId}`;

const interruptionsFor = (
  events: ReadonlyArray<RuntimeLedgerEvent>,
  runId: number,
): ReadonlyArray<RunInterruption> =>
  events
    .filter(
      (event): event is RuntimeLedgerEventByKind<typeof RUNTIME_EVENT_KIND.AGENT_RUN_INTERRUPTED> =>
        event.kind === RUNTIME_EVENT_KIND.AGENT_RUN_INTERRUPTED && event.payload.runId === runId,
    )
    .map((event) => ({
      at: event.ts,
      event: event.kind,
      interruptId: event.payload.interruptId,
      turn: event.payload.turn,
      reason: event.payload.reason,
      resumeSchema: event.payload.resumeSchema,
      payload: event.payload,
    }));

const resumesFor = (
  events: ReadonlyArray<RuntimeLedgerEvent>,
  runId: number,
): ReadonlyArray<RunResume> =>
  events
    .filter(
      (event): event is RuntimeLedgerEventByKind<typeof RUNTIME_EVENT_KIND.AGENT_RUN_RESUMED> =>
        event.kind === RUNTIME_EVENT_KIND.AGENT_RUN_RESUMED && event.payload.runId === runId,
    )
    .map((event) => ({
      at: event.ts,
      event: event.kind,
      interruptId: event.payload.interruptId,
      turn: event.payload.turn,
      resumedAtEventId: event.payload.resumedAtEventId,
      payload: event.payload,
    }));

type ActiveInterruption = RuntimeLedgerEventByKind<typeof RUNTIME_EVENT_KIND.AGENT_RUN_INTERRUPTED>;

const activeInterruptionFor = (
  events: ReadonlyArray<RuntimeLedgerEvent>,
  runId: number,
): ActiveInterruption | undefined => {
  const active = new Map<string, ActiveInterruption>();
  for (const event of events) {
    if (event.kind === RUNTIME_EVENT_KIND.AGENT_RUN_INTERRUPTED && event.payload.runId === runId) {
      active.set(interruptionKey(event.payload), event);
      continue;
    }
    if (event.kind === RUNTIME_EVENT_KIND.AGENT_RUN_RESUMED && event.payload.runId === runId) {
      active.delete(interruptionKey(event.payload));
    }
  }
  return [...active.values()].sort((left, right) => right.id - left.id)[0];
};

type RunProjectionInput = {
  readonly runtimeEvents: ReadonlyArray<RuntimeLedgerEvent>;
  readonly runId: number;
};

const runTraceProjection = defineProjectionSpec<RunProjectionInput, RunTrace>({
  id: "runtime.run-trace",
  version: 1,
  source: RUNTIME_LEDGER_PROJECTION_SOURCE,
  project: ({ runtimeEvents, runId }, ctx) => {
    const start = startFor(runtimeEvents, runId);
    if (start === undefined) {
      return ctx.ok({
        runId,
        startedAt: 0,
        turns: [],
        toolCalls: [],
        terminal: null,
      });
    }

    const turns: RunTurn[] = runtimeEvents
      .filter(
        (event): event is RuntimeLedgerEventByKind<typeof RUNTIME_EVENT_KIND.LLM_RESPONSE> =>
          event.kind === RUNTIME_EVENT_KIND.LLM_RESPONSE && event.payload.turn.id === runId,
      )
      .map((event) => ({
        index: event.payload.turn.index,
        at: event.ts,
        text: textFromLlmOutputItems(event.payload.items),
        usage: event.payload.usage,
      }));

    const toolCalls: RunToolCall[] = runtimeEvents
      .filter(
        (event): event is RuntimeLedgerEventByKind<typeof RUNTIME_EVENT_KIND.TOOL_EXECUTED> =>
          event.kind === RUNTIME_EVENT_KIND.TOOL_EXECUTED && event.payload.runId === runId,
      )
      .map((event) => ({
        at: event.ts,
        name: event.payload.name,
        args: event.payload.args,
        result: event.payload.result,
      }));
    const interruptions = interruptionsFor(runtimeEvents, runId);
    const resumes = resumesFor(runtimeEvents, runId);

    return ctx.ok({
      runId,
      startedAt: start.ts,
      turns,
      toolCalls,
      ...(interruptions.length === 0 ? {} : { interruptions }),
      ...(resumes.length === 0 ? {} : { resumes }),
      terminal: runTerminal(runtimeEvents, runId),
    });
  },
});

/**
 * Projects runtime ledger facts into a run trace view.
 *
 * @agentosPrimitive primitive.runtime.projectRunTrace
 * @agentosInvariant invariant.d10.truth-identity
 * @agentosDocs docs/concepts/durable-truth.md
 * @public
 */
export const projectRunTrace = (
  events: ReadonlyArray<LedgerEvent>,
  rawRunId: number | string,
): RunTrace =>
  projectionOutputOrFail(
    project(runTraceProjection, {
      runtimeEvents: runtimeEventsOf(events),
      runId: normalizeRunId(rawRunId),
    }),
  );

const runStatusFromRuntimeEvents = (
  runtimeEvents: ReadonlyArray<RuntimeLedgerEvent>,
  runId: number,
): RunStatus => {
  const start = startFor(runtimeEvents, runId);
  const terminal = runTerminal(runtimeEvents, runId);

  if (terminal?.kind === "delivered") {
    return { kind: "delivered", at: terminal.at, event: terminal.event };
  }
  if (terminal?.kind === "aborted") {
    return { kind: "aborted", at: terminal.at, abortKind: terminal.event };
  }

  const activeInterruption = activeInterruptionFor(runtimeEvents, runId);
  if (activeInterruption !== undefined) {
    return {
      kind: "interrupted",
      at: activeInterruption.ts,
      event: RUNTIME_EVENT_KIND.AGENT_RUN_INTERRUPTED,
      interruptId: activeInterruption.payload.interruptId,
      reason: activeInterruption.payload.reason,
    };
  }

  if (start !== undefined) {
    return { kind: "open_without_terminal", startedAt: start.ts };
  }

  const evidence = runtimeEvents.find(
    (event) => !isScheduleFireEvent(event) && runtimeRunId(event) === runId,
  );
  return {
    kind: "orphaned",
    startedAt: evidence?.ts ?? 0,
    evidence: evidence?.kind ?? "no_run_evidence",
  };
};

const runStatusProjection = defineProjectionSpec<RunProjectionInput, RunStatus>({
  id: "runtime.run-status",
  version: 1,
  source: RUNTIME_LEDGER_PROJECTION_SOURCE,
  project: ({ runtimeEvents, runId }, ctx) =>
    ctx.ok(runStatusFromRuntimeEvents(runtimeEvents, runId)),
});

/**
 * Projects runtime ledger facts into a single run status.
 *
 * @agentosPrimitive primitive.runtime.projectRunStatus
 * @agentosInvariant invariant.d10.truth-identity
 * @agentosDocs docs/concepts/durable-truth.md
 * @public
 */
export const projectRunStatus = (
  events: ReadonlyArray<LedgerEvent>,
  rawRunId: number | string,
): RunStatus =>
  projectionOutputOrFail(
    project(runStatusProjection, {
      runtimeEvents: runtimeEventsOf(events),
      runId: normalizeRunId(rawRunId),
    }),
  );

const runLastKnownEvent = (
  runtimeEvents: ReadonlyArray<RuntimeLedgerEvent>,
  runId: number,
): RunLastKnownEvent | undefined => {
  const last = runtimeEvents
    .filter((event) => runtimeRunId(event) === runId)
    .sort((left, right) => right.id - left.id)[0];
  return last === undefined ? undefined : { id: last.id, ts: last.ts, kind: last.kind };
};

const runProductLink = (
  runtimeEvents: ReadonlyArray<RuntimeLedgerEvent>,
  runId: number,
): RunProductLink | undefined => {
  const linked = runtimeEvents.find(
    (
      event,
    ): event is
      | RuntimeLedgerEventByKind<typeof RUNTIME_EVENT_KIND.AGENT_SESSION_TURN_SUBMITTED>
      | RuntimeLedgerEventByKind<typeof RUNTIME_EVENT_KIND.WORKFLOW_RUN_SUBMITTED>
      | RuntimeLedgerEventByKind<typeof RUNTIME_EVENT_KIND.PRODUCT_RUN_LINKED> =>
      (event.kind === RUNTIME_EVENT_KIND.AGENT_SESSION_TURN_SUBMITTED ||
        event.kind === RUNTIME_EVENT_KIND.WORKFLOW_RUN_SUBMITTED ||
        event.kind === RUNTIME_EVENT_KIND.PRODUCT_RUN_LINKED) &&
      event.payload.runtimeRunId === runId,
  );
  if (linked === undefined) return undefined;
  if (linked.kind === RUNTIME_EVENT_KIND.AGENT_SESSION_TURN_SUBMITTED) {
    return {
      kind: "session_turn",
      eventId: linked.id,
      submittedAt: linked.ts,
      sessionRef: linked.payload.sessionRef,
      turnRef: linked.payload.turnRef,
      ...(linked.payload.idempotencyKey === undefined
        ? {}
        : { idempotencyKey: linked.payload.idempotencyKey }),
    };
  }
  if (linked.kind === RUNTIME_EVENT_KIND.PRODUCT_RUN_LINKED) {
    return {
      kind: "opaque",
      eventId: linked.id,
      submittedAt: linked.ts,
      productRef: linked.payload.productRef,
      ...(linked.payload.idempotencyKey === undefined
        ? {}
        : { idempotencyKey: linked.payload.idempotencyKey }),
      ...(linked.payload.inputDigest === undefined
        ? {}
        : { inputDigest: linked.payload.inputDigest }),
    };
  }
  const payload: WorkflowRunSubmittedPayload = linked.payload;
  return {
    kind: "workflow_run",
    eventId: linked.id,
    submittedAt: linked.ts,
    workflowId: payload.workflowId,
    workflowRunId: payload.workflowRunId,
    ...(payload.idempotencyKey === undefined ? {} : { idempotencyKey: payload.idempotencyKey }),
    ...(payload.inputDigest === undefined ? {} : { inputDigest: payload.inputDigest }),
  };
};

const payloadRecord = (payload: unknown): Readonly<Record<string, unknown>> =>
  payload !== null && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as Readonly<Record<string, unknown>>)
    : {};

const stringField = (record: Readonly<Record<string, unknown>>, key: string): string | undefined =>
  typeof record[key] === "string" && record[key].length > 0 ? record[key] : undefined;

const numberField = (record: Readonly<Record<string, unknown>>, key: string): number | undefined =>
  typeof record[key] === "number" && Number.isFinite(record[key])
    ? (record[key] as number)
    : undefined;

const runtimeDiagnosticMessage = (
  kind: string,
  payload: Readonly<Record<string, unknown>>,
): string => {
  const suffix = kind.slice(RUNTIME_DIAGNOSTIC_EVENT_PREFIX.length);
  switch (suffix) {
    case "handler_missing":
      return `handler missing for ${stringField(payload, "eventKind") ?? "unknown_event"}`;
    case "handler_failed":
      return stringField(payload, "reason") ?? "handler failed";
    case "projection_timeout":
      return `projection ${stringField(payload, "projectionKind") ?? "unknown_projection"} timed out`;
    case "preflight_failed":
      return stringField(payload, "reason") ?? "preflight failed";
    default:
      return suffix || kind;
  }
};

const runDiagnostics = (
  events: ReadonlyArray<LedgerEvent>,
  runEventIds: ReadonlySet<number>,
  telemetryDiagnostics: ReadonlyArray<TelemetryFanoutDiagnostic>,
): ReadonlyArray<RunInspectionDiagnostic> => {
  const diagnostics: RunInspectionDiagnostic[] = [];
  for (const diagnostic of telemetryDiagnostics) {
    if (!runEventIds.has(diagnostic.eventId)) continue;
    diagnostics.push({
      source: "telemetry",
      eventId: diagnostic.eventId,
      kind: diagnostic.kind,
      message: diagnostic.message,
      phase: diagnostic.phase,
      identityKey: diagnostic.identityKey,
    });
  }
  for (const event of events) {
    if (!event.kind.startsWith(RUNTIME_DIAGNOSTIC_EVENT_PREFIX)) continue;
    const payload = payloadRecord(event.payload);
    const requestedEventId = numberField(payload, "requestedEventId");
    if (requestedEventId === undefined || !runEventIds.has(requestedEventId)) continue;
    diagnostics.push({
      source: "runtime_diagnostic",
      eventId: event.id,
      kind: event.kind,
      message: runtimeDiagnosticMessage(event.kind, payload),
      requestedEventId,
      payload: event.payload,
    });
  }
  return diagnostics.sort((left, right) => left.eventId - right.eventId);
};

const runRequestStatus = (
  runtimeEvents: ReadonlyArray<RuntimeLedgerEvent>,
  runId: number,
): RunRequestStatus => {
  const activeInterruption = activeInterruptionFor(runtimeEvents, runId);
  if (activeInterruption === undefined) return { kind: "none" };
  const inputRequest = inputRequestRefFromInterruptedEvent(activeInterruption);
  return {
    kind: "waiting_for_input",
    interruptId: activeInterruption.payload.interruptId,
    reason: activeInterruption.payload.reason,
    at: activeInterruption.ts,
    ...(inputRequest.ok ? { descriptor: inputRequest.descriptor } : {}),
  };
};

const cancellationStatus = (
  runtimeEvents: ReadonlyArray<RuntimeLedgerEvent>,
  runId: number,
): RunCancellationStatus => {
  const cancelled = runtimeEvents.find(
    (event): event is RuntimeLedgerEventByKind<typeof ABORT.DECISION_CANCELLED> =>
      event.kind === ABORT.DECISION_CANCELLED && event.payload.runId === runId,
  );
  if (cancelled === undefined) return { kind: "none" };
  const payload = payloadRecord(cancelled.payload);
  return {
    kind: "cancelled",
    at: cancelled.ts,
    event: cancelled.kind,
    ...(stringField(payload, "reason") === undefined
      ? {}
      : { reason: stringField(payload, "reason") }),
  };
};

/**
 * Projects runtime ledger and diagnostic facts into a UI-friendly run inspection view.
 *
 * The projection is read-only: ledger events own lifecycle facts, runtime diagnostics own
 * diagnostic facts, and product links remain evidence correlation only.
 *
 * @public
 */
export const projectRunInspection = (
  events: ReadonlyArray<LedgerEvent>,
  rawRunId: number | string,
  telemetryDiagnostics: ReadonlyArray<TelemetryFanoutDiagnostic> = [],
): RunInspection => {
  const runtimeEvents = runtimeEventsOf(events);
  const runId = normalizeRunId(rawRunId);
  const trace = projectRunTrace(events, runId);
  const runEvents = runtimeEvents.filter((event) => runtimeRunId(event) === runId);
  const runEventIds = new Set(runEvents.map((event) => event.id));
  return {
    runId,
    status: runStatusFromRuntimeEvents(runtimeEvents, runId),
    startedAt: trace.startedAt,
    terminal: trace.terminal,
    ...(runLastKnownEvent(runtimeEvents, runId) === undefined
      ? {}
      : { lastKnownEvent: runLastKnownEvent(runtimeEvents, runId) }),
    request: runRequestStatus(runtimeEvents, runId),
    cancellation: cancellationStatus(runtimeEvents, runId),
    ...(runProductLink(runtimeEvents, runId) === undefined
      ? {}
      : { productLink: runProductLink(runtimeEvents, runId) }),
    diagnostics: runDiagnostics(events, runEventIds, telemetryDiagnostics),
  };
};

type TerminalAcc = {
  readonly kind: "delivered" | "aborted";
  readonly at: number;
  readonly event: string;
};

type InterruptionAcc = {
  readonly at: number;
  readonly interruptId: string;
  readonly reason: string;
};

const summarizeStatus = (
  startedAt: number,
  terminal: TerminalAcc | undefined,
  interruption: InterruptionAcc | undefined,
): RunStatus => {
  if (terminal === undefined) {
    if (interruption !== undefined) {
      return {
        kind: "interrupted",
        at: interruption.at,
        event: RUNTIME_EVENT_KIND.AGENT_RUN_INTERRUPTED,
        interruptId: interruption.interruptId,
        reason: interruption.reason,
      };
    }
    return { kind: "open_without_terminal", startedAt };
  }
  if (terminal.kind === "delivered") {
    return { kind: "delivered", at: terminal.at, event: terminal.event };
  }
  return { kind: "aborted", at: terminal.at, abortKind: terminal.event };
};

type RunsPageProjectionInput = {
  readonly runtimeEvents: ReadonlyArray<RuntimeLedgerEvent>;
  readonly spec: RunListSpec;
};

const runsPageProjection = defineProjectionSpec<RunsPageProjectionInput, RunListPage>({
  id: "runtime.runs-page",
  version: 1,
  source: RUNTIME_LEDGER_PROJECTION_SOURCE,
  project: ({ runtimeEvents, spec }, ctx) => {
    type Acc = {
      runId: number;
      startedAt: number;
      terminal: TerminalAcc | undefined;
      interruptions: Map<string, InterruptionAcc>;
    };

    const byRun = new Map<number, Acc>();

    for (const ev of runtimeEvents) {
      if (isScheduleFireEvent(ev)) continue;
      if (ev.kind === RUNTIME_EVENT_KIND.AGENT_RUN_STARTED) {
        if (!byRun.has(ev.id)) {
          byRun.set(ev.id, {
            runId: ev.id,
            startedAt: ev.ts,
            terminal: undefined,
            interruptions: new Map(),
          });
        }
        continue;
      }
      const runId = runtimeRunId(ev);
      if (runId === undefined) continue;
      const acc = byRun.get(runId);
      if (acc === undefined || acc.terminal !== undefined) continue;
      if (ev.kind === RUNTIME_EVENT_KIND.AGENT_RUN_INTERRUPTED) {
        acc.interruptions.set(interruptionKey(ev.payload), {
          at: ev.ts,
          interruptId: ev.payload.interruptId,
          reason: ev.payload.reason,
        });
        continue;
      }
      if (ev.kind === RUNTIME_EVENT_KIND.AGENT_RUN_RESUMED) {
        acc.interruptions.delete(interruptionKey(ev.payload));
        continue;
      }
      if (ev.kind === RUNTIME_EVENT_KIND.AGENT_RUN_COMPLETED) {
        acc.terminal = {
          kind: "delivered",
          at: ev.ts,
          event: ev.kind,
        };
        continue;
      }
      if (ev.kind.startsWith("agent.aborted.")) {
        acc.terminal = { kind: "aborted", at: ev.ts, event: ev.kind };
      }
    }

    const statusSet =
      spec.statuses !== undefined && spec.statuses.length > 0
        ? new Set<RunStatusKind>(spec.statuses)
        : undefined;

    const summaries: RunSummary[] = [];
    for (const acc of byRun.values()) {
      const activeInterruption = [...acc.interruptions.values()].sort((a, b) => b.at - a.at)[0];
      const status = summarizeStatus(acc.startedAt, acc.terminal, activeInterruption);
      if (statusSet !== undefined && !statusSet.has(status.kind)) continue;
      const summary: RunSummary = {
        runId: acc.runId,
        startedAt: acc.startedAt,
        status,
        ...(acc.terminal !== undefined
          ? { durationMs: Math.max(0, acc.terminal.at - acc.startedAt) }
          : {}),
      };
      summaries.push(summary);
    }

    summaries.sort((a, b) => b.runId - a.runId);

    const afterFiltered =
      spec.afterRunId === undefined
        ? summaries
        : summaries.filter((s) => s.runId < spec.afterRunId!);

    const limit = Math.max(0, spec.limit);
    const page = afterFiltered.slice(0, limit);
    const nextCursor =
      afterFiltered.length > limit && page.length > 0 ? page[page.length - 1]!.runId : null;

    return ctx.ok({ runs: page, nextCursor });
  },
});

export const projectRunsPage = (
  events: ReadonlyArray<LedgerEvent>,
  spec: RunListSpec,
): RunListPage =>
  projectionOutputOrFail(
    project(runsPageProjection, {
      runtimeEvents: runtimeEventsOf(events),
      spec,
    }),
  );

export interface AgentSessionTurnRuntimeLink {
  readonly sessionRef: string;
  readonly turnRef: string;
  readonly runtimeRunId: number;
  readonly eventId: number;
  readonly submittedAt: number;
  readonly idempotencyKey?: string;
}

export interface AgentSessionTurnLinksProjection {
  readonly sessionRef: string;
  readonly turns: ReadonlyArray<AgentSessionTurnRuntimeLink>;
}

export type AgentSessionStatus = "idle" | "running" | "waiting_for_user" | "failed";

export interface AgentSessionTurnProjection extends AgentSessionTurnRuntimeLink {
  readonly status: RunStatus;
}

export interface AgentSessionProjection {
  readonly sessionRef: string;
  readonly status: AgentSessionStatus;
  readonly turns: ReadonlyArray<AgentSessionTurnProjection>;
  readonly activeRunId?: number;
  readonly latestRunId?: number;
  readonly pendingInputRequest?: InputRequestDescriptor;
}

export interface AgentSessionListProjection {
  readonly sessions: ReadonlyArray<AgentSessionProjection>;
}

export interface WorkflowRunRuntimeLink {
  readonly workflowId: string;
  readonly workflowRunId: string;
  readonly runtimeRunId: number;
  readonly eventId: number;
  readonly submittedAt: number;
  readonly idempotencyKey?: string;
  readonly inputDigest?: string;
}

export interface WorkflowRunLinksProjection {
  readonly workflowId: string;
  readonly runs: ReadonlyArray<WorkflowRunRuntimeLink>;
}

export type WorkflowRunStatus = "running" | "succeeded" | "failed" | "cancelled";

export interface WorkflowRunAttemptProjection extends WorkflowRunRuntimeLink {
  readonly status: RunStatus;
}

export interface WorkflowRunError {
  readonly reason: string;
  readonly abortKind?: string;
  readonly evidence?: string;
  readonly payload?: unknown;
}

export interface WorkflowRunProjection {
  readonly workflowId: string;
  readonly workflowRunId: string;
  readonly runtimeRunId: number;
  readonly eventId: number;
  readonly submittedAt: number;
  readonly status: WorkflowRunStatus;
  readonly attempts: ReadonlyArray<WorkflowRunAttemptProjection>;
  readonly idempotencyKey?: string;
  readonly inputDigest?: string;
  readonly output?: unknown;
  readonly outputKind?: "text" | "json";
  readonly error?: WorkflowRunError;
}

export interface WorkflowRunListProjection {
  readonly workflowId: string;
  readonly runs: ReadonlyArray<WorkflowRunProjection>;
}

const sessionTurnRuntimeLinks = (
  runtimeEvents: ReadonlyArray<RuntimeLedgerEvent>,
  sessionRef: string,
): ReadonlyArray<AgentSessionTurnRuntimeLink> =>
  runtimeEvents
    .filter(
      (
        event,
      ): event is RuntimeLedgerEventByKind<
        typeof RUNTIME_EVENT_KIND.AGENT_SESSION_TURN_SUBMITTED
      > =>
        event.kind === RUNTIME_EVENT_KIND.AGENT_SESSION_TURN_SUBMITTED &&
        event.payload.sessionRef === sessionRef,
    )
    .sort((left, right) => left.id - right.id)
    .map((event): AgentSessionTurnRuntimeLink => {
      const payload: AgentSessionTurnSubmittedPayload = event.payload;
      return {
        sessionRef: payload.sessionRef,
        turnRef: payload.turnRef,
        runtimeRunId: payload.runtimeRunId,
        eventId: event.id,
        submittedAt: event.ts,
        ...(payload.idempotencyKey === undefined ? {} : { idempotencyKey: payload.idempotencyKey }),
      };
    });

const pendingInputRequestForRun = (
  runtimeEvents: ReadonlyArray<RuntimeLedgerEvent>,
  runId: number,
): InputRequestDescriptor | undefined => {
  const activeInterruption = activeInterruptionFor(runtimeEvents, runId);
  if (activeInterruption === undefined) return undefined;
  const inputRequest = inputRequestRefFromInterruptedEvent(activeInterruption);
  return inputRequest.ok ? inputRequest.descriptor : undefined;
};

const workflowRunRuntimeLinks = (
  runtimeEvents: ReadonlyArray<RuntimeLedgerEvent>,
  workflowId: string,
): ReadonlyArray<WorkflowRunRuntimeLink> =>
  runtimeEvents
    .filter(
      (
        event,
      ): event is RuntimeLedgerEventByKind<typeof RUNTIME_EVENT_KIND.WORKFLOW_RUN_SUBMITTED> =>
        event.kind === RUNTIME_EVENT_KIND.WORKFLOW_RUN_SUBMITTED &&
        event.payload.workflowId === workflowId,
    )
    .sort((left, right) => left.id - right.id)
    .map((event): WorkflowRunRuntimeLink => {
      const payload: WorkflowRunSubmittedPayload = event.payload;
      return {
        workflowId: payload.workflowId,
        workflowRunId: payload.workflowRunId,
        runtimeRunId: payload.runtimeRunId,
        eventId: event.id,
        submittedAt: event.ts,
        ...(payload.idempotencyKey === undefined ? {} : { idempotencyKey: payload.idempotencyKey }),
        ...(payload.inputDigest === undefined ? {} : { inputDigest: payload.inputDigest }),
      };
    });

const workflowRunProjectionFromLink = (
  runtimeEvents: ReadonlyArray<RuntimeLedgerEvent>,
  link: WorkflowRunRuntimeLink,
): WorkflowRunProjection => {
  const status = runStatusFromRuntimeEvents(runtimeEvents, link.runtimeRunId);
  const attempt = { ...link, status };
  const base = {
    ...link,
    attempts: [attempt],
  };

  if (status.kind === "delivered") {
    const terminal = runTerminal(runtimeEvents, link.runtimeRunId);
    const payload = terminal?.payload as
      | RuntimeLedgerEventByKind<typeof RUNTIME_EVENT_KIND.AGENT_RUN_COMPLETED>["payload"]
      | undefined;
    return {
      ...base,
      status: "succeeded",
      ...(payload === undefined ? {} : { output: payload.output, outputKind: payload.outputKind }),
    };
  }

  if (status.kind === "aborted") {
    const terminal = runTerminal(runtimeEvents, link.runtimeRunId);
    const abortKind = status.abortKind;
    const reason = reasonOf(abortKind as AbortKind);
    return {
      ...base,
      status: reason === "cancelled" ? "cancelled" : "failed",
      error: {
        reason,
        abortKind,
        ...(terminal?.payload === undefined ? {} : { payload: terminal.payload }),
      },
    };
  }

  if (status.kind === "orphaned") {
    return {
      ...base,
      status: "failed",
      error: {
        reason: "runtime_run_orphaned",
        evidence: status.evidence,
      },
    };
  }

  return {
    ...base,
    status: "running",
  };
};

const sessionStatus = (
  runtimeEvents: ReadonlyArray<RuntimeLedgerEvent>,
  turns: ReadonlyArray<AgentSessionTurnProjection>,
): Omit<AgentSessionProjection, "sessionRef" | "turns"> => {
  const latest = turns.at(-1);
  const active = [...turns]
    .reverse()
    .find(
      (turn) => turn.status.kind === "open_without_terminal" || turn.status.kind === "interrupted",
    );

  if (active !== undefined) {
    if (active.status.kind === "interrupted") {
      const pendingInputRequest = pendingInputRequestForRun(runtimeEvents, active.runtimeRunId);
      return {
        status: "waiting_for_user",
        activeRunId: active.runtimeRunId,
        latestRunId: latest?.runtimeRunId,
        ...(pendingInputRequest === undefined ? {} : { pendingInputRequest }),
      };
    }
    return {
      status: "running",
      activeRunId: active.runtimeRunId,
      latestRunId: latest?.runtimeRunId,
    };
  }

  if (latest === undefined || latest.status.kind === "delivered") {
    return {
      status: "idle",
      ...(latest === undefined ? {} : { latestRunId: latest.runtimeRunId }),
    };
  }

  if (latest.status.kind === "aborted" || latest.status.kind === "orphaned") {
    return {
      status: "failed",
      latestRunId: latest.runtimeRunId,
    };
  }

  return {
    status: "idle",
    latestRunId: latest.runtimeRunId,
  };
};

const sessionTurnLinkProjection = defineProjectionSpec<
  {
    readonly runtimeEvents: ReadonlyArray<RuntimeLedgerEvent>;
    readonly sessionRef: string;
  },
  AgentSessionTurnLinksProjection
>({
  id: "runtime.agent-session-turn-links",
  version: 1,
  source: RUNTIME_LEDGER_PROJECTION_SOURCE,
  project: ({ runtimeEvents, sessionRef }, ctx) => {
    const turns = sessionTurnRuntimeLinks(runtimeEvents, sessionRef);

    return ctx.ok({ sessionRef, turns });
  },
});

export const projectAgentSessionTurnLinks = (
  events: ReadonlyArray<LedgerEvent>,
  sessionRef: string,
): AgentSessionTurnLinksProjection =>
  projectionOutputOrFail(
    project(sessionTurnLinkProjection, {
      runtimeEvents: runtimeEventsOf(events),
      sessionRef,
    }),
  );

const agentSessionProjection = defineProjectionSpec<
  {
    readonly runtimeEvents: ReadonlyArray<RuntimeLedgerEvent>;
    readonly sessionRef: string;
  },
  AgentSessionProjection
>({
  id: "runtime.agent-session",
  version: 1,
  source: RUNTIME_LEDGER_PROJECTION_SOURCE,
  project: ({ runtimeEvents, sessionRef }, ctx) => {
    const turns = sessionTurnRuntimeLinks(runtimeEvents, sessionRef).map(
      (turn): AgentSessionTurnProjection => ({
        ...turn,
        status: runStatusFromRuntimeEvents(runtimeEvents, turn.runtimeRunId),
      }),
    );

    return ctx.ok({
      sessionRef,
      ...sessionStatus(runtimeEvents, turns),
      turns,
    });
  },
});

export const projectAgentSession = (
  events: ReadonlyArray<LedgerEvent>,
  sessionRef: string,
): AgentSessionProjection =>
  projectionOutputOrFail(
    project(agentSessionProjection, {
      runtimeEvents: runtimeEventsOf(events),
      sessionRef,
    }),
  );

const agentSessionListProjection = defineProjectionSpec<
  {
    readonly runtimeEvents: ReadonlyArray<RuntimeLedgerEvent>;
  },
  AgentSessionListProjection
>({
  id: "runtime.agent-session-list",
  version: 1,
  source: RUNTIME_LEDGER_PROJECTION_SOURCE,
  project: ({ runtimeEvents }, ctx) => {
    const sessionRefs = [
      ...new Set(
        runtimeEvents
          .filter(
            (
              event,
            ): event is RuntimeLedgerEventByKind<
              typeof RUNTIME_EVENT_KIND.AGENT_SESSION_TURN_SUBMITTED
            > => event.kind === RUNTIME_EVENT_KIND.AGENT_SESSION_TURN_SUBMITTED,
          )
          .map((event) => event.payload.sessionRef),
      ),
    ];
    const sessions = sessionRefs.map((sessionRef): AgentSessionProjection => {
      const turns = sessionTurnRuntimeLinks(runtimeEvents, sessionRef).map(
        (turn): AgentSessionTurnProjection => ({
          ...turn,
          status: runStatusFromRuntimeEvents(runtimeEvents, turn.runtimeRunId),
        }),
      );
      return {
        sessionRef,
        ...sessionStatus(runtimeEvents, turns),
        turns,
      };
    });

    return ctx.ok({ sessions });
  },
});

export const projectAgentSessions = (
  events: ReadonlyArray<LedgerEvent>,
): AgentSessionListProjection =>
  projectionOutputOrFail(
    project(agentSessionListProjection, {
      runtimeEvents: runtimeEventsOf(events),
    }),
  );

const workflowRunLinkProjection = defineProjectionSpec<
  {
    readonly runtimeEvents: ReadonlyArray<RuntimeLedgerEvent>;
    readonly workflowId: string;
  },
  WorkflowRunLinksProjection
>({
  id: "runtime.workflow-run-links",
  version: 1,
  source: RUNTIME_LEDGER_PROJECTION_SOURCE,
  project: ({ runtimeEvents, workflowId }, ctx) => {
    const runs = workflowRunRuntimeLinks(runtimeEvents, workflowId);

    return ctx.ok({ workflowId, runs });
  },
});

export const projectWorkflowRunLinks = (
  events: ReadonlyArray<LedgerEvent>,
  workflowId: string,
): WorkflowRunLinksProjection =>
  projectionOutputOrFail(
    project(workflowRunLinkProjection, {
      runtimeEvents: runtimeEventsOf(events),
      workflowId,
    }),
  );

const workflowRunProjection = defineProjectionSpec<
  {
    readonly runtimeEvents: ReadonlyArray<RuntimeLedgerEvent>;
    readonly workflowId: string;
    readonly workflowRunId: string;
  },
  WorkflowRunProjection | null
>({
  id: "runtime.workflow-run",
  version: 1,
  source: RUNTIME_LEDGER_PROJECTION_SOURCE,
  project: ({ runtimeEvents, workflowId, workflowRunId }, ctx) => {
    const link = workflowRunRuntimeLinks(runtimeEvents, workflowId).find(
      (candidate) => candidate.workflowRunId === workflowRunId,
    );
    return ctx.ok(link === undefined ? null : workflowRunProjectionFromLink(runtimeEvents, link));
  },
});

export const projectWorkflowRun = (
  events: ReadonlyArray<LedgerEvent>,
  workflowId: string,
  workflowRunId: string,
): WorkflowRunProjection | null =>
  projectionOutputOrFail(
    project(workflowRunProjection, {
      runtimeEvents: runtimeEventsOf(events),
      workflowId,
      workflowRunId,
    }),
  );

const workflowRunListProjection = defineProjectionSpec<
  {
    readonly runtimeEvents: ReadonlyArray<RuntimeLedgerEvent>;
    readonly workflowId: string;
  },
  WorkflowRunListProjection
>({
  id: "runtime.workflow-run-list",
  version: 1,
  source: RUNTIME_LEDGER_PROJECTION_SOURCE,
  project: ({ runtimeEvents, workflowId }, ctx) =>
    ctx.ok({
      workflowId,
      runs: workflowRunRuntimeLinks(runtimeEvents, workflowId).map((link) =>
        workflowRunProjectionFromLink(runtimeEvents, link),
      ),
    }),
});

export const projectWorkflowRuns = (
  events: ReadonlyArray<LedgerEvent>,
  workflowId: string,
): WorkflowRunListProjection =>
  projectionOutputOrFail(
    project(workflowRunListProjection, {
      runtimeEvents: runtimeEventsOf(events),
      workflowId,
    }),
  );

type SubmitResultProjectionInput = RunProjectionInput & {
  readonly eventCount: number;
};

const submitResultProjection = defineProjectionSpec<
  SubmitResultProjectionInput,
  SubmitResult | null
>({
  id: "runtime.submit-result",
  version: 1,
  source: RUNTIME_LEDGER_PROJECTION_SOURCE,
  project: ({ runtimeEvents, runId, eventCount }, ctx) => {
    const terminal = runTerminal(runtimeEvents, runId);
    if (terminal?.kind === "delivered") {
      const payload = terminal.payload as RuntimeLedgerEventByKind<
        typeof RUNTIME_EVENT_KIND.AGENT_RUN_COMPLETED
      >["payload"];
      return ctx.ok({
        ok: true,
        status: "delivered",
        runId,
        final: payload.final,
        eventCount,
        tokensUsed: payload.tokensUsed,
      });
    }
    if (terminal?.kind === "aborted") {
      const payload = terminal.payload as RuntimeLedgerEventByKind<AbortKind>["payload"];
      const reason = reasonOf(terminal.event as AbortKind);
      const decisionAbort = reason === "rejected" || reason === "cancelled" || reason === "expired";
      return ctx.ok({
        ok: false,
        status: decisionAbort ? "aborted" : "failed",
        runId,
        reason,
        eventCount,
        tokensUsed: payload.tokensUsed,
      } as SubmitResult);
    }

    const activeInterruption = activeInterruptionFor(runtimeEvents, runId);
    if (activeInterruption === undefined) {
      return ctx.ok(null);
    }
    const continuation = continuationRefFromInterruptedEvent(activeInterruption);
    if (!continuation.ok) {
      return ctx.failure(continuation.reason);
    }
    const inputRequest = inputRequestRefFromInterruptedEvent(activeInterruption);
    return ctx.ok({
      ok: false,
      status: "interrupted",
      runId,
      reason: "interrupted",
      eventCount,
      tokensUsed: activeInterruption.payload.tokensUsed,
      interruptId: activeInterruption.payload.interruptId,
      turn: activeInterruption.payload.turn,
      gateRef: continuation.ref.gateRef,
      continuation: continuation.ref,
      ...(inputRequest.ok ? { inputRequest: inputRequest.descriptor } : {}),
    });
  },
});

/**
 * Reconstructs SubmitResult from terminal runtime ledger facts.
 *
 * @agentosPrimitive primitive.runtime.projectSubmitResult
 * @agentosInvariant invariant.d10.truth-identity
 * @agentosDocs docs/concepts/durable-truth.md
 * @public
 */
export const projectSubmitResult = (
  events: ReadonlyArray<LedgerEvent>,
  rawRunId: number | string,
): SubmitResult | null =>
  projectionOutputOrFail(
    project(submitResultProjection, {
      runtimeEvents: runtimeEventsOf(events),
      runId: normalizeRunId(rawRunId),
      eventCount: events.length,
    }),
  );
