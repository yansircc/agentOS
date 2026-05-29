import { Predicate } from "effect";
import {
  isRejectionRef,
  validateEffectClaim,
  type LivedClaim,
  type PreClaim,
  type RejectionRef,
} from "@agent-os/kernel/effect-claim";
import { defineEventKindView, defineEventPayloads, payload } from "@agent-os/kernel/extensions";
import { validateTerminalClaim } from "@agent-os/kernel/settlement-contract";
import { decisionGateSettlementContract } from "./settlement";

export type DecisionGateDecision = "approved" | "rejected";

export interface DecisionGateRequestedPayload {
  readonly gateRef: string;
  readonly subjectRef: string;
  readonly claim: PreClaim;
  readonly policyRef?: string;
  readonly summary?: string;
}

export interface DecisionGateDecidedPayload {
  readonly gateRef: string;
  readonly decisionRef: string;
  readonly decision: DecisionGateDecision;
  readonly decidedBy: string;
  readonly reason?: string;
  readonly rejectionRef?: RejectionRef;
}

export interface DecisionGateConsumedPayload {
  readonly gateRef: string;
  readonly decisionRef: string;
  readonly consumedBy: string;
  readonly claim: LivedClaim;
}

export const DECISION_GATE_EVENTS = defineEventPayloads({
  "decision_gate.requested": payload<DecisionGateRequestedPayload>(),
  "decision_gate.decided": payload<DecisionGateDecidedPayload>(),
  "decision_gate.consumed": payload<DecisionGateConsumedPayload>(),
});

export const DECISION_GATE_KIND = defineEventKindView(DECISION_GATE_EVENTS, {
  REQUESTED: "decision_gate.requested",
  DECIDED: "decision_gate.decided",
  CONSUMED: "decision_gate.consumed",
});

export type DecisionGateEventKind = keyof typeof DECISION_GATE_EVENTS;

export interface DecisionGateLedgerEvent {
  readonly id: number;
  readonly kind: string;
  readonly payload: unknown;
}

export interface DecisionGateProjection {
  readonly gateRef: string;
  readonly status: "missing" | "requested" | "approved" | "rejected" | "consumed";
  readonly request?: DecisionGateRequestedPayload;
  readonly decision?: DecisionGateDecidedPayload;
  readonly consumed?: DecisionGateConsumedPayload;
}

const stringField = (payload: Record<string, unknown>, key: string): string | undefined =>
  typeof payload[key] === "string" ? payload[key] : undefined;

const preClaimFrom = (value: unknown): PreClaim | undefined => {
  const result = validateEffectClaim(value);
  return result.ok && result.claim.phase === "pre" ? result.claim : undefined;
};

const livedClaimFrom = (value: unknown): LivedClaim | undefined => {
  const result = validateTerminalClaim(decisionGateSettlementContract, value);
  return result.ok && result.claim.phase === "lived" ? result.claim : undefined;
};

const requestedFrom = (
  payload: Record<string, unknown>,
): DecisionGateRequestedPayload | undefined => {
  const gateRef = stringField(payload, "gateRef");
  const subjectRef = stringField(payload, "subjectRef");
  const claim = preClaimFrom(payload.claim);
  if (gateRef === undefined || subjectRef === undefined || claim === undefined) {
    return undefined;
  }
  return {
    gateRef,
    subjectRef,
    claim,
    ...(typeof payload.policyRef === "string" ? { policyRef: payload.policyRef } : {}),
    ...(typeof payload.summary === "string" ? { summary: payload.summary } : {}),
  };
};

const decidedFrom = (payload: Record<string, unknown>): DecisionGateDecidedPayload | undefined => {
  const gateRef = stringField(payload, "gateRef");
  const decisionRef = stringField(payload, "decisionRef");
  const decidedBy = stringField(payload, "decidedBy");
  if (gateRef === undefined || decisionRef === undefined || decidedBy === undefined) {
    return undefined;
  }
  if (payload.decision !== "approved" && payload.decision !== "rejected") {
    return undefined;
  }
  if (payload.decision === "rejected" && !isRejectionRef(payload.rejectionRef)) {
    return undefined;
  }
  return {
    gateRef,
    decisionRef,
    decidedBy,
    decision: payload.decision,
    ...(typeof payload.reason === "string" ? { reason: payload.reason } : {}),
    ...(isRejectionRef(payload.rejectionRef) ? { rejectionRef: payload.rejectionRef } : {}),
  };
};

const consumedFrom = (
  payload: Record<string, unknown>,
): DecisionGateConsumedPayload | undefined => {
  const gateRef = stringField(payload, "gateRef");
  const decisionRef = stringField(payload, "decisionRef");
  const consumedBy = stringField(payload, "consumedBy");
  const claim = livedClaimFrom(payload.claim);
  if (
    gateRef === undefined ||
    decisionRef === undefined ||
    consumedBy === undefined ||
    claim === undefined
  ) {
    return undefined;
  }
  return { gateRef, decisionRef, consumedBy, claim };
};

export const projectDecisionGate = (
  events: Iterable<DecisionGateLedgerEvent>,
  gateRef: string,
): DecisionGateProjection => {
  let request: DecisionGateRequestedPayload | undefined;
  let decision: DecisionGateDecidedPayload | undefined;
  let consumed: DecisionGateConsumedPayload | undefined;

  for (const event of events) {
    if (!Predicate.isRecord(event.payload)) continue;
    if (event.payload.gateRef !== gateRef) continue;
    switch (event.kind) {
      case DECISION_GATE_KIND.REQUESTED: {
        const next = requestedFrom(event.payload);
        if (next !== undefined) {
          request = next;
          decision = undefined;
          consumed = undefined;
        }
        break;
      }
      case DECISION_GATE_KIND.DECIDED: {
        const next = decidedFrom(event.payload);
        if (next !== undefined && request !== undefined) {
          decision = next;
          consumed = undefined;
        }
        break;
      }
      case DECISION_GATE_KIND.CONSUMED: {
        const next = consumedFrom(event.payload);
        if (
          next !== undefined &&
          request !== undefined &&
          decision?.decision === "approved" &&
          decision.decisionRef === next.decisionRef
        ) {
          consumed = next;
        }
        break;
      }
    }
  }

  const status =
    consumed !== undefined
      ? "consumed"
      : decision?.decision === "approved"
        ? "approved"
        : decision?.decision === "rejected"
          ? "rejected"
          : request !== undefined
            ? "requested"
            : "missing";

  return { gateRef, status, request, decision, consumed };
};
