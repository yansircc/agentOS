import { isScopeRef, type ScopeRef } from "@agent-os/kernel/effect-claim";
import type { RuntimeLedgerEventByKind } from "./runtime-events";
import { RUNTIME_EVENT_KIND } from "./runtime-events";
import type { SubmitResumeDecision, TurnRef } from "./submit";

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

export type ContinuationRefFromInterruptionResult =
  | { readonly ok: true; readonly ref: ContinuationRef }
  | {
      readonly ok: false;
      readonly reason: "interruption_missing_decision_binding";
    };

export interface ContinuationAnswer {
  readonly decisionRef: string;
  readonly resume: unknown;
}

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 1;

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
  typeof (value as { readonly interruptId?: unknown }).interruptId === "string" &&
  (value as { readonly interruptId: string }).interruptId.length > 0 &&
  isPositiveInteger((value as { readonly interruptionEventId?: unknown }).interruptionEventId) &&
  typeof (value as { readonly gateRef?: unknown }).gateRef === "string" &&
  (value as { readonly gateRef: string }).gateRef.length > 0;

export const continuationRefFromInterruptedEvent = (
  event: RuntimeLedgerEventByKind<typeof RUNTIME_EVENT_KIND.AGENT_RUN_INTERRUPTED>,
): ContinuationRefFromInterruptionResult => {
  const decision = event.payload.decision;
  if (decision === undefined) {
    return { ok: false, reason: "interruption_missing_decision_binding" };
  }
  return {
    ok: true,
    ref: {
      kind: "agent.run.continuation",
      scopeRef: event.scopeRef,
      afterEventId: event.id,
      runId: event.payload.runId,
      turn: event.payload.turn,
      interruptId: event.payload.interruptId,
      interruptionEventId: event.id,
      gateRef: decision.gateRef,
    },
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
