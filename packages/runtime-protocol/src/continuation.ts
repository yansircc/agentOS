import { isScopeRef, type ScopeRef } from "@agent-os/kernel/effect-claim";
import type { Recorded } from "@agent-os/kernel";
import type { RuntimeLedgerEventByKind } from "./runtime-events";
import { RUNTIME_EVENT_KIND } from "./runtime-events";
import type { SubmitResumeDecision, TurnRef } from "./submit";
import type { InputRequestResumePayload } from "./input-request";
import { recordRuntimeProtocolValue } from "./recorded";

export interface LedgerWitnessedScopedRef<Kind extends string = string> {
  readonly kind: Kind;
  readonly scopeRef: ScopeRef;
  readonly afterEventId: number;
}

export interface ContinuationRef extends LedgerWitnessedScopedRef<"agent.run.continuation"> {
  readonly runId: number;
  readonly turn: TurnRef;
  readonly interruptId: string;
  readonly interruptionEventId: number;
  readonly gateRef: string;
}

export type RecordedContinuationRef = ContinuationRef & Recorded<ContinuationRef>;

export type ContinuationRefFromInterruptionResult =
  | { readonly ok: true; readonly ref: RecordedContinuationRef }
  | {
      readonly ok: false;
      readonly reason: "interruption_missing_decision_binding";
    };

export interface ContinuationAnswer {
  readonly decisionRef: string;
  readonly resume: InputRequestResumePayload;
}

export interface DecisionContinuationCause {
  readonly kind: "decision";
  readonly decisionRef: string;
  readonly resume: InputRequestResumePayload;
}

export interface RecoveryObservation {
  readonly publicMessage: string;
  readonly diagnosticRefs?: ReadonlyArray<{
    readonly eventId: number;
    readonly reason: string;
  }>;
  readonly attributes?: ReadonlyArray<{
    readonly key: string;
    readonly value: string | number | boolean | null;
  }>;
}

export interface RecoveryFingerprint {
  readonly owner: "agentos" | "product";
  readonly value: string;
}

export interface RecoveryVerdictContinuationCause {
  readonly kind: "recovery_verdict";
  readonly verdictRef: string;
  readonly verdict: "recoverable" | "terminal";
  readonly observation: RecoveryObservation;
  readonly fingerprint?: RecoveryFingerprint;
}

export type ContinuationCause = DecisionContinuationCause | RecoveryVerdictContinuationCause;

export interface RecoveryBudget {
  readonly hard: {
    readonly maxAttempts: number;
    readonly deadlineTs?: number;
  };
  readonly soft?: {
    readonly maxSameFailure?: number;
  };
}

export interface RecoveryAttemptRecord {
  readonly eventId: number;
  readonly ts: number;
  readonly cause: RecoveryVerdictContinuationCause;
}

export type RecoveryTerminalCause =
  | {
      readonly kind: "attempt_budget_exhausted";
      readonly attempts: number;
      readonly maxAttempts: number;
    }
  | {
      readonly kind: "deadline_exhausted";
      readonly nowTs: number;
      readonly deadlineTs: number;
    }
  | {
      readonly kind: "same_failure_budget_exhausted";
      readonly fingerprint: RecoveryFingerprint;
      readonly sameFailureCount: number;
      readonly maxSameFailure: number;
    }
  | {
      readonly kind: "verdict_terminal";
      readonly verdictRef: string;
    };

export type RecoveryBudgetProjection =
  | {
      readonly status: "open";
      readonly attempts: number;
      readonly deadlineTs?: number;
    }
  | {
      readonly status: "terminal";
      readonly attempts: number;
      readonly deadlineTs?: number;
      readonly terminal: RecoveryTerminalCause;
    };

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 1;

const isNonNegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

const isTurnRef = (value: unknown): value is TurnRef =>
  typeof value === "object" &&
  value !== null &&
  isPositiveInteger((value as { readonly id?: unknown }).id) &&
  typeof (value as { readonly index?: unknown }).index === "number" &&
  Number.isInteger((value as { readonly index?: unknown }).index) &&
  (value as { readonly index: number }).index >= 0;

export const isContinuationRef = (value: unknown): value is ContinuationRef =>
  typeof value === "object" &&
  value !== null &&
  (value as { readonly kind?: unknown }).kind === "agent.run.continuation" &&
  isScopeRef((value as { readonly scopeRef?: unknown }).scopeRef) &&
  isPositiveInteger((value as { readonly afterEventId?: unknown }).afterEventId) &&
  isPositiveInteger((value as { readonly runId?: unknown }).runId) &&
  isTurnRef((value as { readonly turn?: unknown }).turn) &&
  (value as { readonly runId: number }).runId === (value as { readonly turn: TurnRef }).turn.id &&
  typeof (value as { readonly interruptId?: unknown }).interruptId === "string" &&
  (value as { readonly interruptId: string }).interruptId.length > 0 &&
  isPositiveInteger((value as { readonly interruptionEventId?: unknown }).interruptionEventId) &&
  typeof (value as { readonly gateRef?: unknown }).gateRef === "string" &&
  (value as { readonly gateRef: string }).gateRef.length > 0;

export const recordedContinuationRefFromUnknown = (
  value: unknown,
): RecordedContinuationRef | null =>
  isContinuationRef(value) ? recordRuntimeProtocolValue(value) : null;

const isRecoveryObservation = (value: unknown): value is RecoveryObservation => {
  if (typeof value !== "object" || value === null) return false;
  const observation = value as {
    readonly publicMessage?: unknown;
    readonly diagnosticRefs?: unknown;
    readonly attributes?: unknown;
  };
  if (typeof observation.publicMessage !== "string" || observation.publicMessage.length === 0) {
    return false;
  }
  if (
    observation.diagnosticRefs !== undefined &&
    (!Array.isArray(observation.diagnosticRefs) ||
      observation.diagnosticRefs.some(
        (ref) =>
          typeof ref !== "object" ||
          ref === null ||
          !isPositiveInteger((ref as { readonly eventId?: unknown }).eventId) ||
          typeof (ref as { readonly reason?: unknown }).reason !== "string" ||
          (ref as { readonly reason: string }).reason.length === 0,
      ))
  ) {
    return false;
  }
  if (
    observation.attributes !== undefined &&
    (!Array.isArray(observation.attributes) ||
      observation.attributes.some((attribute) => {
        if (typeof attribute !== "object" || attribute === null) return true;
        const candidate = attribute as { readonly key?: unknown; readonly value?: unknown };
        return (
          typeof candidate.key !== "string" ||
          candidate.key.length === 0 ||
          !(
            typeof candidate.value === "string" ||
            typeof candidate.value === "number" ||
            typeof candidate.value === "boolean" ||
            candidate.value === null
          )
        );
      }))
  ) {
    return false;
  }
  return true;
};

const isRecoveryFingerprint = (value: unknown): value is RecoveryFingerprint =>
  typeof value === "object" &&
  value !== null &&
  ((value as { readonly owner?: unknown }).owner === "agentos" ||
    (value as { readonly owner?: unknown }).owner === "product") &&
  typeof (value as { readonly value?: unknown }).value === "string" &&
  (value as { readonly value: string }).value.length > 0;

export const isContinuationCause = (value: unknown): value is ContinuationCause => {
  if (typeof value !== "object" || value === null) return false;
  const cause = value as { readonly kind?: unknown };
  if (cause.kind === "decision") {
    return typeof (value as { readonly decisionRef?: unknown }).decisionRef === "string";
  }
  if (cause.kind !== "recovery_verdict") return false;
  const recovery = value as {
    readonly verdictRef?: unknown;
    readonly verdict?: unknown;
    readonly observation?: unknown;
    readonly fingerprint?: unknown;
  };
  return (
    typeof recovery.verdictRef === "string" &&
    recovery.verdictRef.length > 0 &&
    (recovery.verdict === "recoverable" || recovery.verdict === "terminal") &&
    isRecoveryObservation(recovery.observation) &&
    (recovery.fingerprint === undefined || isRecoveryFingerprint(recovery.fingerprint))
  );
};

export const isRecoveryAttemptRecord = (value: unknown): value is RecoveryAttemptRecord =>
  typeof value === "object" &&
  value !== null &&
  isPositiveInteger((value as { readonly eventId?: unknown }).eventId) &&
  isNonNegativeInteger((value as { readonly ts?: unknown }).ts) &&
  isContinuationCause((value as { readonly cause?: unknown }).cause) &&
  (value as { readonly cause: ContinuationCause }).cause.kind === "recovery_verdict";

export const continuationRefFromInterruptedEvent = (
  event: RuntimeLedgerEventByKind<typeof RUNTIME_EVENT_KIND.AGENT_RUN_INTERRUPTED>,
): ContinuationRefFromInterruptionResult => {
  const decision = event.payload.decision;
  if (decision === undefined) {
    return { ok: false, reason: "interruption_missing_decision_binding" };
  }
  return {
    ok: true,
    ref: recordRuntimeProtocolValue({
      kind: "agent.run.continuation",
      scopeRef: event.scopeRef,
      afterEventId: event.id,
      runId: event.payload.runId,
      turn: event.payload.turn,
      interruptId: event.payload.interruptId,
      interruptionEventId: event.id,
      gateRef: decision.gateRef,
    } satisfies ContinuationRef),
  };
};

export const submitResumeDecisionFromContinuationRef = (
  ref: ContinuationRef,
  answer: ContinuationAnswer,
): SubmitResumeDecision => ({
  runId: ref.runId,
  turn: ref.turn,
  interruptId: ref.interruptId,
  gateRef: ref.gateRef,
  decisionRef: answer.decisionRef,
  resume: answer.resume,
});

export const decisionContinuationCause = (
  answer: ContinuationAnswer,
): DecisionContinuationCause => ({
  kind: "decision",
  decisionRef: answer.decisionRef,
  resume: answer.resume,
});
