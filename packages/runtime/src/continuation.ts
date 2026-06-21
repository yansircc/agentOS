import { scopeRefKey } from "@agent-os/core/effect-claim";
import type { LedgerEvent } from "@agent-os/core/types";
import {
  DECISION_GATE_KIND,
  projectDecisionGate,
  type DecisionGateConsumedPayload,
  type DecisionGateDecidedPayload,
} from "@agent-os/decision-gate";
import {
  continuationRefFromInterruptedEvent,
  decodeRuntimeLedgerEvent,
  RUNTIME_EVENT_KIND,
  type ContinuationRef,
  type FailureDiagnostic,
  type InputRequestResumePayload,
  type RecoveryAttemptRecord,
  type RecoveryBudget,
  type RecoveryBudgetProjection,
  type RecoveryFingerprint,
  type RuntimeLedgerEventByKind,
  type SubmitResumeDecision,
} from "@agent-os/core/runtime-protocol";

export type ContinuationProjection =
  | {
      readonly status: "missing_interruption";
      readonly ref: ContinuationRef;
    }
  | {
      readonly status: "pending";
      readonly ref: ContinuationRef;
      readonly interruption: RuntimeLedgerEventByKind<
        typeof RUNTIME_EVENT_KIND.AGENT_RUN_INTERRUPTED
      >;
    }
  | {
      readonly status: "approved";
      readonly ref: ContinuationRef;
      readonly interruption: RuntimeLedgerEventByKind<
        typeof RUNTIME_EVENT_KIND.AGENT_RUN_INTERRUPTED
      >;
      readonly decision: DecisionGateDecidedPayload;
      readonly decisionEventId: number;
    }
  | {
      readonly status: "rejected";
      readonly ref: ContinuationRef;
      readonly interruption: RuntimeLedgerEventByKind<
        typeof RUNTIME_EVENT_KIND.AGENT_RUN_INTERRUPTED
      >;
      readonly decision: DecisionGateDecidedPayload;
      readonly decisionEventId: number;
    }
  | {
      readonly status: "consumed";
      readonly ref: ContinuationRef;
      readonly interruption: RuntimeLedgerEventByKind<
        typeof RUNTIME_EVENT_KIND.AGENT_RUN_INTERRUPTED
      >;
      readonly consumed: DecisionGateConsumedPayload;
      readonly consumedEventId: number;
    };

export type ContinuationResumeDecisionResult =
  | { readonly ok: true; readonly resume: SubmitResumeDecision }
  | {
      readonly ok: false;
      readonly reason:
        | "continuation_missing_interruption"
        | "continuation_pending"
        | "continuation_rejected"
        | "continuation_consumed";
      readonly projection: ContinuationProjection;
    };

const fingerprintPart = (value: string | undefined): string => {
  if (value === undefined || value.length === 0) return "-";
  return encodeURIComponent(value);
};

/**
 * Derives substrate-owned recovery fingerprints from redacted diagnostics.
 *
 * Product verifiers own product fingerprints; runtime owns substrate failure
 * fingerprints so loop termination never depends on product code for tool,
 * provider, budget, or material failures.
 */
export const fingerprintFailureDiagnostic = (
  diagnostic: FailureDiagnostic,
): RecoveryFingerprint => ({
  owner: "agentos",
  value: [
    "failure",
    fingerprintPart(diagnostic.category),
    fingerprintPart(diagnostic.reason),
    fingerprintPart(diagnostic.toolName),
    fingerprintPart(diagnostic.phase),
  ].join(":"),
});

const latestTerminalVerdict = (
  attempts: ReadonlyArray<RecoveryAttemptRecord>,
): RecoveryAttemptRecord | undefined =>
  [...attempts].reverse().find((attempt) => attempt.cause.verdict === "terminal");

const sameFailureCount = (
  attempts: ReadonlyArray<RecoveryAttemptRecord>,
  fingerprint: RecoveryFingerprint,
): number =>
  attempts.filter(
    (attempt) =>
      attempt.cause.fingerprint?.owner === fingerprint.owner &&
      attempt.cause.fingerprint.value === fingerprint.value,
  ).length;

/**
 * Projects durable recovery budget state from ledger-reconstructable attempts.
 *
 * Hard terminality is owned by runtime-controlled attempt count and absolute
 * deadline. Product fingerprints only provide an earlier soft stop.
 */
export const projectRecoveryAttemptBudget = (
  attempts: ReadonlyArray<RecoveryAttemptRecord>,
  budget: RecoveryBudget,
  nowTs: number,
): RecoveryBudgetProjection => {
  const attemptCount = attempts.length;
  const deadlineTs = budget.hard.deadlineTs;
  const terminalVerdict = latestTerminalVerdict(attempts);
  if (terminalVerdict !== undefined) {
    return {
      status: "terminal",
      attempts: attemptCount,
      ...(deadlineTs === undefined ? {} : { deadlineTs }),
      terminal: {
        kind: "verdict_terminal",
        verdictRef: terminalVerdict.cause.verdictRef,
      },
    };
  }
  if (attemptCount >= budget.hard.maxAttempts) {
    return {
      status: "terminal",
      attempts: attemptCount,
      ...(deadlineTs === undefined ? {} : { deadlineTs }),
      terminal: {
        kind: "attempt_budget_exhausted",
        attempts: attemptCount,
        maxAttempts: budget.hard.maxAttempts,
      },
    };
  }
  if (deadlineTs !== undefined && nowTs >= deadlineTs) {
    return {
      status: "terminal",
      attempts: attemptCount,
      deadlineTs,
      terminal: {
        kind: "deadline_exhausted",
        nowTs,
        deadlineTs,
      },
    };
  }
  const maxSameFailure = budget.soft?.maxSameFailure;
  if (maxSameFailure !== undefined) {
    const latestFingerprint = attempts.at(-1)?.cause.fingerprint;
    if (latestFingerprint !== undefined) {
      const count = sameFailureCount(attempts, latestFingerprint);
      if (count >= maxSameFailure) {
        return {
          status: "terminal",
          attempts: attemptCount,
          ...(deadlineTs === undefined ? {} : { deadlineTs }),
          terminal: {
            kind: "same_failure_budget_exhausted",
            fingerprint: latestFingerprint,
            sameFailureCount: count,
            maxSameFailure,
          },
        };
      }
    }
  }
  return {
    status: "open",
    attempts: attemptCount,
    ...(deadlineTs === undefined ? {} : { deadlineTs }),
  };
};

const payloadRecord = (event: LedgerEvent): Readonly<Record<string, unknown>> | null =>
  typeof event.payload === "object" && event.payload !== null
    ? (event.payload as Readonly<Record<string, unknown>>)
    : null;

const decisionEventIdFor = (
  events: ReadonlyArray<LedgerEvent>,
  gateRef: string,
  decisionRef: string,
): number | null => {
  const event = events.find((candidate) => {
    const payload = payloadRecord(candidate);
    return (
      candidate.kind === DECISION_GATE_KIND.DECIDED &&
      payload?.gateRef === gateRef &&
      payload.decisionRef === decisionRef
    );
  });
  return event?.id ?? null;
};

const consumedEventIdFor = (
  events: ReadonlyArray<LedgerEvent>,
  gateRef: string,
  decisionRef: string,
): number | null => {
  const event = events.find((candidate) => {
    const payload = payloadRecord(candidate);
    return (
      candidate.kind === DECISION_GATE_KIND.CONSUMED &&
      payload?.gateRef === gateRef &&
      payload.decisionRef === decisionRef
    );
  });
  return event?.id ?? null;
};

const interruptionFor = (
  events: ReadonlyArray<LedgerEvent>,
  ref: ContinuationRef,
): RuntimeLedgerEventByKind<typeof RUNTIME_EVENT_KIND.AGENT_RUN_INTERRUPTED> | null => {
  for (const event of events) {
    if (event.id !== ref.interruptionEventId) continue;
    const decoded = decodeRuntimeLedgerEvent(event);
    if (
      decoded._tag !== "runtime" ||
      decoded.event.kind !== RUNTIME_EVENT_KIND.AGENT_RUN_INTERRUPTED
    ) {
      return null;
    }
    const candidate = decoded.event;
    const refResult = continuationRefFromInterruptedEvent(candidate);
    if (!refResult.ok) return null;
    return refResult.ref.runId === ref.runId &&
      refResult.ref.turn.id === ref.turn.id &&
      refResult.ref.turn.index === ref.turn.index &&
      refResult.ref.interruptId === ref.interruptId &&
      refResult.ref.gateRef === ref.gateRef &&
      scopeRefKey(refResult.ref.scopeRef) === scopeRefKey(ref.scopeRef)
      ? candidate
      : null;
  }
  return null;
};

export const projectContinuation = (
  events: ReadonlyArray<LedgerEvent>,
  ref: ContinuationRef,
): ContinuationProjection => {
  const interruption = interruptionFor(events, ref);
  if (interruption === null) {
    return { status: "missing_interruption", ref };
  }

  const gate = projectDecisionGate(events, ref.gateRef);
  if (gate.status === "consumed" && gate.consumed !== undefined) {
    return {
      status: "consumed",
      ref,
      interruption,
      consumed: gate.consumed,
      consumedEventId:
        consumedEventIdFor(events, ref.gateRef, gate.consumed.decisionRef) ?? ref.afterEventId,
    };
  }
  if (gate.status === "approved" && gate.decision !== undefined) {
    return {
      status: "approved",
      ref,
      interruption,
      decision: gate.decision,
      decisionEventId:
        decisionEventIdFor(events, ref.gateRef, gate.decision.decisionRef) ?? ref.afterEventId,
    };
  }
  if (gate.status === "rejected" && gate.decision !== undefined) {
    return {
      status: "rejected",
      ref,
      interruption,
      decision: gate.decision,
      decisionEventId:
        decisionEventIdFor(events, ref.gateRef, gate.decision.decisionRef) ?? ref.afterEventId,
    };
  }
  return { status: "pending", ref, interruption };
};

export const projectContinuationRefs = (
  events: ReadonlyArray<LedgerEvent>,
  runId?: number,
): ReadonlyArray<ContinuationRef> => {
  const refs: ContinuationRef[] = [];
  for (const event of events) {
    const decoded = decodeRuntimeLedgerEvent(event);
    if (
      decoded._tag !== "runtime" ||
      decoded.event.kind !== RUNTIME_EVENT_KIND.AGENT_RUN_INTERRUPTED
    ) {
      continue;
    }
    if (runId !== undefined && decoded.event.payload.runId !== runId) continue;
    const ref = continuationRefFromInterruptedEvent(decoded.event);
    if (ref.ok) refs.push(ref.ref);
  }
  return refs.sort((left, right) => left.interruptionEventId - right.interruptionEventId);
};

export const submitResumeDecisionFromContinuationProjection = (
  projection: ContinuationProjection,
  resume: InputRequestResumePayload,
): ContinuationResumeDecisionResult => {
  switch (projection.status) {
    case "approved":
      return {
        ok: true,
        resume: {
          runId: projection.ref.runId,
          turn: projection.ref.turn,
          interruptId: projection.ref.interruptId,
          gateRef: projection.ref.gateRef,
          decisionRef: projection.decision.decisionRef,
          resume,
        },
      };
    case "missing_interruption":
      return { ok: false, reason: "continuation_missing_interruption", projection };
    case "pending":
      return { ok: false, reason: "continuation_pending", projection };
    case "rejected":
      return { ok: false, reason: "continuation_rejected", projection };
    case "consumed":
      return { ok: false, reason: "continuation_consumed", projection };
  }
};
