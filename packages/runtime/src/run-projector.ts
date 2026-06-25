import type {
  RunListPage,
  RunListSpec,
  RunInterruption,
  RunResume,
  RunStatus,
  RunStatusKind,
  RunSummary,
  RunTerminal,
  RunToolCall,
  RunTrace,
  RunTurn,
} from "@agent-os/core/types";
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

const runtimeRunId = (event: RuntimeLedgerEvent): number => {
  switch (event.kind) {
    case RUNTIME_EVENT_KIND.AGENT_RUN_STARTED:
      return event.id;
    case RUNTIME_EVENT_KIND.AGENT_SESSION_TURN_SUBMITTED:
    case RUNTIME_EVENT_KIND.WORKFLOW_RUN_SUBMITTED:
      return event.payload.runtimeRunId;
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

  const evidence = runtimeEvents.find((event) => runtimeRunId(event) === runId);
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

const sessionStatus = (
  runtimeEvents: ReadonlyArray<RuntimeLedgerEvent>,
  turns: ReadonlyArray<AgentSessionTurnProjection>,
): Omit<AgentSessionProjection, "sessionRef" | "turns"> => {
  const latest = turns.at(-1);
  const active = [...turns]
    .reverse()
    .find(
      (turn) =>
        turn.status.kind === "open_without_terminal" || turn.status.kind === "interrupted",
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
    const runs = runtimeEvents
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
