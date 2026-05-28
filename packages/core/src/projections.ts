import { Effect } from "effect";
import { ABORT, SqlError } from "./errors";
import type {
  LedgerEvent,
  QuotaState,
  QuotaStateSpec,
  ResourceState,
  RunListPage,
  RunListSpec,
  RunStatus,
  RunStatusKind,
  RunSummary,
  RunTerminal,
  RunTrace,
  RunTurn,
  RunToolCall,
} from "./types";
import { decodeConsumedPayloadSync } from "./quota/payload";
import { projectRows } from "./resources/projection";
import { type AttemptKey, type CapabilityLease, projectLease } from "./admission";
import { loadAdmissionRows } from "./admission/payload";
import {
  validateEffectClaim,
  type AnchorRef,
  type AuthorityRef,
  type EffectClaim,
  type LivedClaim,
  type OriginRef,
  type PreClaim,
  type RejectedClaim,
  type RejectionRef,
  type ScopeRef,
} from "./effect-claim";

const abortKinds = new Set<string>(Object.values(ABORT));

const normalizeRunId = (runId: number | string): number => {
  const n = typeof runId === "number" ? runId : Number(runId);
  return Number.isInteger(n) && n >= 1 ? n : 0;
};

const payloadObject = (payload: unknown): Record<string, unknown> =>
  payload !== null && typeof payload === "object" ? (payload as Record<string, unknown>) : {};

export interface ClaimTraceSpec {
  readonly operationRef?: string;
  readonly phases?: ReadonlyArray<EffectClaim["phase"]>;
}

interface ClaimTraceBase {
  readonly eventId: number;
  readonly eventKind: string;
  readonly scope: string;
  readonly ts: number;
  readonly operationRef: string;
  readonly scopeRef: ScopeRef;
  readonly authorityRef: AuthorityRef;
  readonly originRef: OriginRef;
}

export interface PreClaimTraceEntry extends ClaimTraceBase {
  readonly phase: PreClaim["phase"];
}

export interface LivedClaimTraceEntry extends ClaimTraceBase {
  readonly phase: LivedClaim["phase"];
  readonly anchorRef: AnchorRef;
}

export interface RejectedClaimTraceEntry extends ClaimTraceBase {
  readonly phase: RejectedClaim["phase"];
  readonly rejectionRef: RejectionRef;
}

export type ClaimTraceEntry = PreClaimTraceEntry | LivedClaimTraceEntry | RejectedClaimTraceEntry;

interface FailurePlaneBase {
  readonly eventId: number;
  readonly eventKind: string;
  readonly scope: string;
  readonly ts: number;
}

export interface ClaimRejectedFailurePlaneEntry extends FailurePlaneBase {
  readonly plane: "claim_rejected";
  readonly operationRef: string;
  readonly rejectionRef: RejectionRef;
  readonly reason?: string;
}

export interface RunAbortedFailurePlaneEntry extends FailurePlaneBase {
  readonly plane: "run_aborted";
  readonly reason?: string;
}

export type FailurePlaneEntry = ClaimRejectedFailurePlaneEntry | RunAbortedFailurePlaneEntry;

const claimFromEvent = (event: LedgerEvent): EffectClaim | null => {
  const raw = payloadObject(event.payload).claim;
  const validation = validateEffectClaim(raw);
  return validation.ok ? validation.claim : null;
};

const claimTraceBase = (event: LedgerEvent, claim: EffectClaim): ClaimTraceBase => ({
  eventId: event.id,
  eventKind: event.kind,
  scope: event.scope,
  ts: event.ts,
  operationRef: claim.operationRef,
  scopeRef: claim.scopeRef,
  authorityRef: claim.authorityRef,
  originRef: claim.originRef,
});

const claimTraceEntry = (event: LedgerEvent, claim: EffectClaim): ClaimTraceEntry => {
  const base = claimTraceBase(event, claim);
  switch (claim.phase) {
    case "pre":
      return { ...base, phase: "pre" };
    case "lived":
      return { ...base, phase: "lived", anchorRef: claim.anchorRef };
    case "rejected":
      return {
        ...base,
        phase: "rejected",
        rejectionRef: claim.rejectionRef,
      };
  }
};

export const projectClaimTrace = (
  events: ReadonlyArray<LedgerEvent>,
  spec: ClaimTraceSpec = {},
): ReadonlyArray<ClaimTraceEntry> => {
  const phases =
    spec.phases !== undefined && spec.phases.length > 0
      ? new Set<EffectClaim["phase"]>(spec.phases)
      : undefined;
  const rows: ClaimTraceEntry[] = [];

  for (const event of events) {
    const claim = claimFromEvent(event);
    if (claim === null) continue;
    if (spec.operationRef !== undefined && claim.operationRef !== spec.operationRef) {
      continue;
    }
    if (phases !== undefined && !phases.has(claim.phase)) continue;
    rows.push(claimTraceEntry(event, claim));
  }
  return rows;
};

export const projectFailurePlane = (
  events: ReadonlyArray<LedgerEvent>,
): ReadonlyArray<FailurePlaneEntry> => {
  const rows: FailurePlaneEntry[] = [];
  for (const event of events) {
    const claim = claimFromEvent(event);
    if (claim?.phase === "rejected") {
      rows.push({
        eventId: event.id,
        eventKind: event.kind,
        scope: event.scope,
        ts: event.ts,
        plane: "claim_rejected",
        operationRef: claim.operationRef,
        rejectionRef: claim.rejectionRef,
        reason: claim.rejectionRef.reason,
      });
      continue;
    }
    if (abortKinds.has(event.kind)) {
      const reason = payloadObject(event.payload).reason;
      rows.push({
        eventId: event.id,
        eventKind: event.kind,
        scope: event.scope,
        ts: event.ts,
        plane: "run_aborted",
        ...(typeof reason === "string" ? { reason } : {}),
      });
    }
  }
  return rows;
};

const numericPayloadRunId = (event: LedgerEvent): number | undefined => {
  const value = payloadObject(event.payload).runId;
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
};

const turnRunId = (event: LedgerEvent): number | undefined => {
  const turn = payloadObject(event.payload).turn;
  if (turn === null || typeof turn !== "object") return undefined;
  const value = (turn as { readonly id?: unknown }).id;
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
};

const startFor = (events: ReadonlyArray<LedgerEvent>, runId: number): LedgerEvent | undefined =>
  events.find((event) => event.id === runId && event.kind === "agent.run.started");

const runTerminal = (events: ReadonlyArray<LedgerEvent>, runId: number): RunTerminal | null => {
  const completed = events.find(
    (event) => event.kind === "agent.run.completed" && numericPayloadRunId(event) === runId,
  );
  if (completed !== undefined) {
    const eventName = payloadObject(completed.payload).event;
    return {
      kind: "delivered",
      at: completed.ts,
      event: typeof eventName === "string" ? eventName : completed.kind,
      payload: completed.payload,
    };
  }

  const aborted = events.find(
    (event) => abortKinds.has(event.kind) && numericPayloadRunId(event) === runId,
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
  const runId = normalizeRunId(rawRunId);
  const start = startFor(events, runId);
  if (start === undefined) {
    return {
      runId,
      startedAt: 0,
      turns: [],
      toolCalls: [],
      terminal: null,
    };
  }

  const turns: RunTurn[] = events
    .filter((event) => event.kind === "llm.response" && turnRunId(event) === runId)
    .map((event) => {
      const p = payloadObject(event.payload);
      const turn = payloadObject(p.turn);
      return {
        index: typeof turn.index === "number" ? turn.index : 0,
        at: event.ts,
        text: typeof p.text === "string" ? p.text : "",
        usage: p.usage,
      };
    });

  const toolCalls: RunToolCall[] = events
    .filter((event) => event.kind === "tool.executed" && numericPayloadRunId(event) === runId)
    .map((event) => {
      const p = payloadObject(event.payload);
      return {
        at: event.ts,
        name: typeof p.name === "string" ? p.name : "",
        args: p.args,
        result: p.result,
      };
    });

  return {
    runId,
    startedAt: start.ts,
    turns,
    toolCalls,
    terminal: runTerminal(events, runId),
  };
};

export const projectRunStatus = (
  events: ReadonlyArray<LedgerEvent>,
  rawRunId: number | string,
): RunStatus => {
  const runId = normalizeRunId(rawRunId);
  const start = startFor(events, runId);
  const terminal = runTerminal(events, runId);

  if (terminal?.kind === "delivered") {
    return { kind: "delivered", at: terminal.at, event: terminal.event };
  }
  if (terminal?.kind === "aborted") {
    return { kind: "aborted", at: terminal.at, abortKind: terminal.event };
  }

  if (start !== undefined) {
    return { kind: "open_without_terminal", startedAt: start.ts };
  }

  const evidence = events.find(
    (event) => numericPayloadRunId(event) === runId || turnRunId(event) === runId,
  );
  return {
    kind: "orphaned",
    startedAt: evidence?.ts ?? 0,
    evidence: evidence?.kind ?? "no_run_evidence",
  };
};

export const projectQuotaState = (
  events: ReadonlyArray<LedgerEvent>,
  spec: QuotaStateSpec,
  now: number,
): QuotaState => {
  const windowStart = spec.windowMs === Number.POSITIVE_INFINITY ? 0 : now - spec.windowMs;
  let consumed = 0;
  for (const event of events) {
    if (event.kind !== "dispatch.consumed") continue;
    if (event.ts < windowStart) continue;
    const payload = decodeConsumedPayloadSync(event.payload);
    if (payload.key === spec.key) {
      consumed += payload.amount;
    }
  }
  return {
    consumed,
    limit: spec.limit,
    remaining: Math.max(0, spec.limit - consumed),
    refundable: 0,
    ...(spec.windowMs === Number.POSITIVE_INFINITY ? {} : { windowStart }),
  };
};

export const projectResourceState = (
  events: ReadonlyArray<LedgerEvent>,
  key: string,
): ResourceState => {
  const state = projectRows(
    events
      .filter((event) => event.kind.startsWith("resource."))
      .map((event) => ({
        kind: event.kind,
        payload: JSON.stringify(event.payload),
      })),
  );
  const projection = state.byKey.get(key) ?? {
    available: 0,
    reserved: 0,
    consumed: 0,
  };
  const reservations = Array.from(state.byId.values())
    .filter((reservation) => reservation.key === key && reservation.status === "active")
    .map((reservation) => ({
      id: reservation.reservationId,
      amount: reservation.amount,
    }));
  return {
    granted: projection.available + projection.reserved + projection.consumed,
    reserved: projection.reserved,
    consumed: projection.consumed,
    available: projection.available,
    reservations,
  };
};

export const projectAdmissionLease = (
  sql: SqlStorage,
  scope: string,
  key: AttemptKey,
  now: number,
): Effect.Effect<CapabilityLease | null, SqlError> =>
  Effect.gen(function* () {
    const rows = yield* loadAdmissionRows(sql, scope);
    const { lease } = projectLease(rows, key, now);
    return lease.status === "unknown" ? null : lease;
  });

// ============================================================
// projectRunsPage — list runs scoped to this DO (contract §5).
//
//   Source: agent.run.started + agent.run.completed + every ABORT.* kind.
//   Cursor: runId DESC; afterRunId means "strictly older than this id".
//   Filter: optional status subset (delivered | aborted | open_without_terminal | orphaned).
//
// Input MUST be ordered by ledger id ASC (streamSnapshot's contract).
// ============================================================

export const RUN_BEARING_KINDS: ReadonlyArray<string> = [
  "agent.run.started",
  "agent.run.completed",
  ...Object.values(ABORT),
];

const RUN_STARTED = "agent.run.started";
const RUN_COMPLETED = "agent.run.completed";

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

  for (const ev of events) {
    if (ev.kind === RUN_STARTED) {
      if (!byRun.has(ev.id)) {
        byRun.set(ev.id, { runId: ev.id, startedAt: ev.ts, terminal: undefined });
      }
      continue;
    }
    const runId = numericPayloadRunId(ev);
    if (runId === undefined) continue;
    const acc = byRun.get(runId);
    if (acc === undefined) continue;
    if (acc.terminal !== undefined) continue;
    if (ev.kind === RUN_COMPLETED) {
      const eventName = payloadObject(ev.payload).event;
      acc.terminal = {
        kind: "delivered",
        at: ev.ts,
        event: typeof eventName === "string" ? eventName : RUN_COMPLETED,
      };
      continue;
    }
    if (abortKinds.has(ev.kind)) {
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

  // DESC sort by runId; pagination cursor is runId-keyed.
  summaries.sort((a, b) => b.runId - a.runId);

  const afterFiltered =
    spec.afterRunId === undefined ? summaries : summaries.filter((s) => s.runId < spec.afterRunId!);

  const limit = Math.max(0, spec.limit);
  const page = afterFiltered.slice(0, limit);
  const nextCursor =
    afterFiltered.length > limit && page.length > 0 ? page[page.length - 1]!.runId : null;

  return { runs: page, nextCursor };
};
