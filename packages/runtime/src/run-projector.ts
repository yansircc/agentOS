import type {
  RunListPage,
  RunListSpec,
  RunStatus,
  RunStatusKind,
  RunSummary,
  RunTerminal,
  RunToolCall,
  RunTrace,
  RunTurn,
} from "@agent-os/kernel/types";
import type { LedgerEvent } from "@agent-os/kernel/types";
import { textFromLlmOutputItems } from "@agent-os/kernel/llm";
import { ABORT, reasonOf, type AbortKind } from "./abort";
import type { SubmitResult } from "./submit";
import {
  decodeRuntimeLedgerEvent,
  isRuntimeAbortEventKind,
  RUNTIME_EVENT_KIND,
  type RuntimeAbortEventKind,
  type RuntimeLedgerEvent,
  type RuntimeLedgerEventByKind,
} from "./runtime-events";

export const RUN_BEARING_KINDS: ReadonlyArray<string> = [
  RUNTIME_EVENT_KIND.AGENT_RUN_STARTED,
  RUNTIME_EVENT_KIND.AGENT_RUN_COMPLETED,
  ...Object.values(ABORT),
];

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
    case RUNTIME_EVENT_KIND.LLM_RESPONSE:
      return event.payload.turn.id;
    case RUNTIME_EVENT_KIND.CHAT_INGESTED:
    case RUNTIME_EVENT_KIND.TOOL_EXECUTED:
    case RUNTIME_EVENT_KIND.TOOL_REJECTED:
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

export const projectRunTrace = (
  events: ReadonlyArray<LedgerEvent>,
  rawRunId: number | string,
): RunTrace => {
  const runtimeEvents = runtimeEventsOf(events);
  const runId = normalizeRunId(rawRunId);
  const start = startFor(runtimeEvents, runId);
  if (start === undefined) {
    return {
      runId,
      startedAt: 0,
      turns: [],
      toolCalls: [],
      terminal: null,
    };
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

  return {
    runId,
    startedAt: start.ts,
    turns,
    toolCalls,
    terminal: runTerminal(runtimeEvents, runId),
  };
};

export const projectRunStatus = (
  events: ReadonlyArray<LedgerEvent>,
  rawRunId: number | string,
): RunStatus => {
  const runtimeEvents = runtimeEventsOf(events);
  const runId = normalizeRunId(rawRunId);
  const start = startFor(runtimeEvents, runId);
  const terminal = runTerminal(runtimeEvents, runId);

  if (terminal?.kind === "delivered") {
    return { kind: "delivered", at: terminal.at, event: terminal.event };
  }
  if (terminal?.kind === "aborted") {
    return { kind: "aborted", at: terminal.at, abortKind: terminal.event };
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

type TerminalAcc = {
  readonly kind: "delivered" | "aborted";
  readonly at: number;
  readonly event: string;
};

const summarizeStatus = (startedAt: number, terminal: TerminalAcc | undefined): RunStatus => {
  if (terminal === undefined) {
    return { kind: "open_without_terminal", startedAt };
  }
  if (terminal.kind === "delivered") {
    return { kind: "delivered", at: terminal.at, event: terminal.event };
  }
  return { kind: "aborted", at: terminal.at, abortKind: terminal.event };
};

export const projectRunsPage = (
  events: ReadonlyArray<LedgerEvent>,
  spec: RunListSpec,
): RunListPage => {
  type Acc = {
    runId: number;
    startedAt: number;
    terminal: TerminalAcc | undefined;
  };

  const byRun = new Map<number, Acc>();

  for (const ev of runtimeEventsOf(events)) {
    if (ev.kind === RUNTIME_EVENT_KIND.AGENT_RUN_STARTED) {
      if (!byRun.has(ev.id)) {
        byRun.set(ev.id, { runId: ev.id, startedAt: ev.ts, terminal: undefined });
      }
      continue;
    }
    const runId = runtimeRunId(ev);
    const acc = byRun.get(runId);
    if (acc === undefined || acc.terminal !== undefined) continue;
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
    const status = summarizeStatus(acc.startedAt, acc.terminal);
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
    spec.afterRunId === undefined ? summaries : summaries.filter((s) => s.runId < spec.afterRunId!);

  const limit = Math.max(0, spec.limit);
  const page = afterFiltered.slice(0, limit);
  const nextCursor =
    afterFiltered.length > limit && page.length > 0 ? page[page.length - 1]!.runId : null;

  return { runs: page, nextCursor };
};

export const projectSubmitResult = (
  events: ReadonlyArray<LedgerEvent>,
  rawRunId: number | string,
): SubmitResult | null => {
  const runtimeEvents = runtimeEventsOf(events);
  const runId = normalizeRunId(rawRunId);
  const terminal = runTerminal(runtimeEvents, runId);
  if (terminal === null) {
    return null;
  }
  if (terminal.kind === "delivered") {
    const payload = terminal.payload as RuntimeLedgerEventByKind<
      typeof RUNTIME_EVENT_KIND.AGENT_RUN_COMPLETED
    >["payload"];
    return {
      ok: true,
      runId,
      final: payload.final,
      eventCount: events.length,
      tokensUsed: payload.tokensUsed,
    };
  }
  const payload = terminal.payload as RuntimeLedgerEventByKind<AbortKind>["payload"];
  return {
    ok: false,
    runId,
    reason: reasonOf(terminal.event as AbortKind),
    eventCount: events.length,
    tokensUsed: payload.tokensUsed,
  };
};
