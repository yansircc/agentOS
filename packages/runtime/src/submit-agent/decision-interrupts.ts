import { Predicate } from "effect";
import type { LedgerEvent } from "@agent-os/core/types";
import {
  decodeRuntimeLedgerEvent,
  RUNTIME_EVENT_KIND,
  type SubmitDecisionInterrupt,
} from "@agent-os/core/runtime-protocol";
import { makeOperationRef, makePreClaim, type PreClaim } from "@agent-os/core/effect-claim";
import type { InternalSubmitSpec } from "../internal-submit";
import { DECISION_GATE_KIND } from "../decision-gate";

export const decisionInterruptFor = (
  spec: InternalSubmitSpec,
  toolName: string,
): SubmitDecisionInterrupt | undefined =>
  spec.decisionInterrupts?.find((interrupt) => interrupt.toolName === toolName);

const refSuffixFor = (operationRef: string): string => encodeURIComponent(operationRef);

export const decisionGateRefFor = (
  interrupt: SubmitDecisionInterrupt,
  operationRef: string,
): string => `${interrupt.gateRefPrefix ?? "decision_gate"}:${refSuffixFor(operationRef)}`;

export const decisionInterruptIdFor = (
  interrupt: SubmitDecisionInterrupt,
  operationRef: string,
): string => `${interrupt.interruptIdPrefix ?? "decision"}:${refSuffixFor(operationRef)}`;

export const decisionSubjectRefFor = (claim: { readonly operationRef: string }): string =>
  claim.operationRef;

export const decisionGateClaimFor = (
  spec: Pick<InternalSubmitSpec, "effectAuthorityRef" | "scopeRef">,
  runId: number,
  gateRef: string,
): PreClaim =>
  makePreClaim({
    operationRef: makeOperationRef("decision_gate", [gateRef]),
    scopeRef: spec.scopeRef,
    effectAuthorityRef: spec.effectAuthorityRef,
    originRef: {
      originId: `run:${runId}`,
      originKind: "submit",
    },
  });

export const payloadRecord = (event: LedgerEvent): Readonly<Record<string, unknown>> | null =>
  Predicate.isObject(event.payload) ? event.payload : null;

export const matchingDecisionEvent = (
  events: ReadonlyArray<LedgerEvent>,
  gateRef: string,
  decisionRef: string,
): LedgerEvent | undefined =>
  events.find((event) => {
    const payload = payloadRecord(event);
    return (
      event.kind === DECISION_GATE_KIND.DECIDED &&
      payload?.gateRef === gateRef &&
      payload.decisionRef === decisionRef
    );
  });

export const matchingInterruptionEvent = (
  events: ReadonlyArray<LedgerEvent>,
  resume: NonNullable<InternalSubmitSpec["resume"]>,
): LedgerEvent | undefined =>
  events.find((event) => {
    const decoded = decodeRuntimeLedgerEvent(event);
    return (
      decoded._tag === "runtime" &&
      decoded.event.kind === RUNTIME_EVENT_KIND.AGENT_RUN_INTERRUPTED &&
      decoded.event.payload.runId === resume.runId &&
      decoded.event.payload.turn.id === resume.turn.id &&
      decoded.event.payload.turn.index === resume.turn.index &&
      decoded.event.payload.interruptId === resume.interruptId &&
      decoded.event.payload.decision?.gateRef === resume.gateRef
    );
  });
