/**
 * @agent-os/ops-api — RunSummary projection (spec-35 §2.4, §3.4)
 *
 * Server-side projection: ops-api Worker fetches narrow event kinds from
 * the scope's DO via events({kinds:...}), then projects to RunSummary[].
 * Clients never re-project raw agent.run.* rows.
 *
 * Why projected in ops-api Worker (not in DO):
 *   spec-35 §10 forbids adding new core API for ops-api v0. AgentDOBase
 *   has no runs() RPC; we synthesize the list from events() filtered to
 *   the run-bearing kinds.
 *
 * Why not raw "agent.aborted.*" prefix filter:
 *   events({kinds:...}) takes exact strings, not prefixes (spec-29 §2.2).
 *   We import ABORT from @agent-os/core for the closed set of abort kinds.
 *   When ABORT grows, this list updates with that PR.
 */

import { ABORT } from "@agent-os/core/abort";
import type { LedgerEventRpc } from "@agent-os/core";

import type { RunListPage, RunStatus, RunSummary } from "./types";

const RUN_STARTED = "agent.run.started";
const RUN_COMPLETED = "agent.run.completed";

export const RUN_KINDS: ReadonlyArray<string> = [
  RUN_STARTED,
  RUN_COMPLETED,
  ...Object.values(ABORT),
];

const ABORT_KIND_SET = new Set<string>(Object.values(ABORT));

const payloadObj = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" ? (v as Record<string, unknown>) : {};

const payloadRunId = (event: LedgerEventRpc): number | undefined => {
  const v = payloadObj(event.payload).runId;
  return typeof v === "number" && Number.isInteger(v) ? v : undefined;
};

interface ProjectRunsOptions {
  readonly statuses?: ReadonlySet<RunStatus["kind"]>;
  readonly afterRunId?: number;
  readonly limit: number;
}

/**
 * Project run-bearing events into RunSummary[].
 * Input events must be ordered by ledger id ASC. Output is sorted by
 * runId DESC (newest first) and capped at `limit`. nextCursor = oldest
 * runId emitted (caller pages via ?afterRunId=oldest-1, descending).
 */
export const projectRuns = (
  events: ReadonlyArray<LedgerEventRpc>,
  opts: ProjectRunsOptions,
): RunListPage => {
  type Acc = {
    runId: number;
    startedAt: number;
    terminal?: {
      kind: "delivered" | "aborted";
      at: number;
      event: string;
    };
  };

  const byRun = new Map<number, Acc>();

  for (const ev of events) {
    if (ev.kind === RUN_STARTED) {
      const runId = ev.id;
      const prev = byRun.get(runId);
      if (prev === undefined) {
        byRun.set(runId, { runId, startedAt: ev.ts });
      }
      continue;
    }
    const runId = payloadRunId(ev);
    if (runId === undefined) continue;
    const acc = byRun.get(runId);
    if (acc === undefined) continue;
    if (acc.terminal !== undefined) continue;
    if (ev.kind === RUN_COMPLETED) {
      const eventName = payloadObj(ev.payload).event;
      acc.terminal = {
        kind: "delivered",
        at: ev.ts,
        event: typeof eventName === "string" ? eventName : RUN_COMPLETED,
      };
      continue;
    }
    if (ABORT_KIND_SET.has(ev.kind)) {
      acc.terminal = { kind: "aborted", at: ev.ts, event: ev.kind };
    }
  }

  const all: RunSummary[] = [];
  for (const acc of byRun.values()) {
    const status = toStatus(acc);
    if (
      opts.statuses !== undefined &&
      opts.statuses.size > 0 &&
      !opts.statuses.has(status.kind)
    ) {
      continue;
    }
    const summary: RunSummary = {
      runId: acc.runId,
      startedAt: acc.startedAt,
      status,
      ...(acc.terminal !== undefined
        ? { durationMs: Math.max(0, acc.terminal.at - acc.startedAt) }
        : {}),
    };
    all.push(summary);
  }

  // Sort by runId DESC (newest first).
  all.sort((a, b) => b.runId - a.runId);

  const filtered =
    opts.afterRunId === undefined
      ? all
      : all.filter((r) => r.runId < opts.afterRunId!);

  const page = filtered.slice(0, opts.limit);
  const nextCursor =
    filtered.length > opts.limit && page.length > 0
      ? page[page.length - 1]!.runId
      : null;

  return { runs: page, nextCursor };
};

const toStatus = (acc: {
  startedAt: number;
  terminal?: { kind: "delivered" | "aborted"; at: number; event: string };
}): RunStatus => {
  if (acc.terminal !== undefined) {
    if (acc.terminal.kind === "delivered") {
      return {
        kind: "delivered",
        at: acc.terminal.at,
        event: acc.terminal.event,
      };
    }
    return {
      kind: "aborted",
      at: acc.terminal.at,
      abortKind: acc.terminal.event,
    };
  }
  return { kind: "open_without_terminal", startedAt: acc.startedAt };
};
