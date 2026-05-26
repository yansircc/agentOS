import { Effect } from "effect";
import { ABORT, SqlError } from "./errors";
import type {
  LedgerEvent,
  QuotaState,
  QuotaStateSpec,
  ResourceState,
  RunStatus,
  RunTerminal,
  RunTrace,
  RunTurn,
  RunToolCall,
} from "./types";
import { decodeConsumedPayloadSync } from "./quota/payload";
import { projectRows } from "./resources/projection";
import {
  type AttemptKey,
  type CapabilityLease,
  projectLease,
} from "./admission";
import { loadAdmissionRows } from "./admission/payload";

const abortKinds = new Set<string>(Object.values(ABORT));

const normalizeRunId = (runId: number | string): number => {
  const n = typeof runId === "number" ? runId : Number(runId);
  return Number.isInteger(n) && n >= 1 ? n : 0;
};

const payloadObject = (payload: unknown): Record<string, unknown> =>
  payload !== null && typeof payload === "object"
    ? (payload as Record<string, unknown>)
    : {};

const numericPayloadRunId = (event: LedgerEvent): number | undefined => {
  const value = payloadObject(event.payload).runId;
  return typeof value === "number" && Number.isInteger(value)
    ? value
    : undefined;
};

const turnRunId = (event: LedgerEvent): number | undefined => {
  const turn = payloadObject(event.payload).turn;
  if (turn === null || typeof turn !== "object") return undefined;
  const value = (turn as { readonly id?: unknown }).id;
  return typeof value === "number" && Number.isInteger(value)
    ? value
    : undefined;
};

const startFor = (
  events: ReadonlyArray<LedgerEvent>,
  runId: number,
): LedgerEvent | undefined =>
  events.find((event) => event.id === runId && event.kind === "agent.run.started");

const runTerminal = (
  events: ReadonlyArray<LedgerEvent>,
  runId: number,
): RunTerminal | null => {
  const completed = events.find(
    (event) =>
      event.kind === "agent.run.completed" && numericPayloadRunId(event) === runId,
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
    (event) =>
      abortKinds.has(event.kind) && numericPayloadRunId(event) === runId,
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
        id: runId,
        index: typeof turn.index === "number" ? turn.index : 0,
        at: event.ts,
        text: typeof p.text === "string" ? p.text : "",
        usage: p.usage,
      };
    });

  const toolCalls: RunToolCall[] = events
    .filter(
      (event) =>
        event.kind === "tool.executed" && numericPayloadRunId(event) === runId,
    )
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
  const windowStart =
    spec.windowMs === Number.POSITIVE_INFINITY ? 0 : now - spec.windowMs;
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
