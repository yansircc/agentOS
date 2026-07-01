import { scopeRefKey } from "@agent-os/core/effect-claim";
import type { LedgerEvent } from "@agent-os/core/types";
import {
  DECISION_GATE_KIND,
  projectDecisionGate,
  type DecisionGateConsumedPayload,
  type DecisionGateDecidedPayload,
  type DecisionGateCancelledPayload,
  type DecisionGateExpiredPayload,
} from "./decision-gate";
import {
  decodeRuntimeLedgerEvent,
  inputRequestRefFromInterruptedEvent,
  parseInputRequestResumePayload,
  RUNTIME_EVENT_KIND,
  submitResumeDecisionFromInputRequestRef,
  type InputRequestDescriptor,
  type InputRequestKind,
  type InputRequestRef,
  type InputRequestSettlement,
  type RuntimeLedgerEventByKind,
  type SubmitResumeDecision,
} from "@agent-os/core/runtime-protocol";

export type InputRequestProjection =
  | {
      readonly status: "missing_interruption";
      readonly ref: InputRequestRef;
    }
  | {
      readonly status: "pending";
      readonly ref: InputRequestRef;
      readonly request: InputRequestDescriptor;
      readonly interruption: RuntimeLedgerEventByKind<
        typeof RUNTIME_EVENT_KIND.AGENT_RUN_INTERRUPTED
      >;
    }
  | {
      readonly status: "approved";
      readonly ref: InputRequestRef;
      readonly request: InputRequestDescriptor;
      readonly interruption: RuntimeLedgerEventByKind<
        typeof RUNTIME_EVENT_KIND.AGENT_RUN_INTERRUPTED
      >;
      readonly decision: DecisionGateDecidedPayload;
      readonly decisionEventId: number;
    }
  | {
      readonly status: "rejected";
      readonly ref: InputRequestRef;
      readonly request: InputRequestDescriptor;
      readonly interruption: RuntimeLedgerEventByKind<
        typeof RUNTIME_EVENT_KIND.AGENT_RUN_INTERRUPTED
      >;
      readonly decision: DecisionGateDecidedPayload;
      readonly decisionEventId: number;
    }
  | {
      readonly status: "cancelled";
      readonly ref: InputRequestRef;
      readonly request: InputRequestDescriptor;
      readonly interruption: RuntimeLedgerEventByKind<
        typeof RUNTIME_EVENT_KIND.AGENT_RUN_INTERRUPTED
      >;
      readonly cancelled: DecisionGateCancelledPayload;
    }
  | {
      readonly status: "expired";
      readonly ref: InputRequestRef;
      readonly request: InputRequestDescriptor;
      readonly interruption: RuntimeLedgerEventByKind<
        typeof RUNTIME_EVENT_KIND.AGENT_RUN_INTERRUPTED
      >;
      readonly expired: DecisionGateExpiredPayload;
    }
  | {
      readonly status: "consumed";
      readonly ref: InputRequestRef;
      readonly request: InputRequestDescriptor;
      readonly interruption: RuntimeLedgerEventByKind<
        typeof RUNTIME_EVENT_KIND.AGENT_RUN_INTERRUPTED
      >;
      readonly consumed: DecisionGateConsumedPayload;
      readonly consumedEventId: number;
    };

export type InputRequestResumeDecisionResult =
  | { readonly ok: true; readonly resume: SubmitResumeDecision }
  | {
      readonly ok: false;
      readonly reason:
        | "input_request_missing_interruption"
        | "input_request_pending"
        | "input_request_rejected"
        | "input_request_cancelled"
        | "input_request_expired"
        | "input_request_consumed"
        | "input_request_resume_kind_mismatch"
        | "input_request_resume_malformed"
        | "input_request_authorization_ref_malformed";
      readonly projection: InputRequestProjection;
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
  ref: InputRequestRef,
): {
  readonly interruption: RuntimeLedgerEventByKind<typeof RUNTIME_EVENT_KIND.AGENT_RUN_INTERRUPTED>;
  readonly request: InputRequestDescriptor;
} | null => {
  for (const event of events) {
    if (event.id !== ref.interruptionEventId) continue;
    const decoded = decodeRuntimeLedgerEvent(event);
    if (
      decoded._tag !== "runtime" ||
      decoded.event.kind !== RUNTIME_EVENT_KIND.AGENT_RUN_INTERRUPTED
    ) {
      return null;
    }
    const candidate = inputRequestRefFromInterruptedEvent(decoded.event);
    if (!candidate.ok) return null;
    return candidate.ref.runId === ref.runId &&
      candidate.ref.turn.id === ref.turn.id &&
      candidate.ref.turn.index === ref.turn.index &&
      candidate.ref.interruptId === ref.interruptId &&
      candidate.ref.gateRef === ref.gateRef &&
      candidate.ref.requestKind === ref.requestKind &&
      scopeRefKey(candidate.ref.scopeRef) === scopeRefKey(ref.scopeRef)
      ? { interruption: decoded.event, request: candidate.descriptor }
      : null;
  }
  return null;
};

export const projectInputRequest = (
  events: ReadonlyArray<LedgerEvent>,
  ref: InputRequestRef,
): InputRequestProjection => {
  const interruption = interruptionFor(events, ref);
  if (interruption === null) return { status: "missing_interruption", ref };

  const gate = projectDecisionGate(events, ref.gateRef);
  if (gate.status === "consumed" && gate.consumed !== undefined) {
    return {
      status: "consumed",
      ref,
      ...interruption,
      consumed: gate.consumed,
      consumedEventId:
        consumedEventIdFor(events, ref.gateRef, gate.consumed.decisionRef) ?? ref.afterEventId,
    };
  }
  if (gate.status === "approved" && gate.decision !== undefined) {
    return {
      status: "approved",
      ref,
      ...interruption,
      decision: gate.decision,
      decisionEventId:
        decisionEventIdFor(events, ref.gateRef, gate.decision.decisionRef) ?? ref.afterEventId,
    };
  }
  if (gate.status === "rejected" && gate.decision !== undefined) {
    return {
      status: "rejected",
      ref,
      ...interruption,
      decision: gate.decision,
      decisionEventId:
        decisionEventIdFor(events, ref.gateRef, gate.decision.decisionRef) ?? ref.afterEventId,
    };
  }
  if (gate.status === "cancelled" && gate.cancelled !== undefined) {
    return {
      status: "cancelled",
      ref,
      ...interruption,
      cancelled: gate.cancelled,
    };
  }
  if (gate.status === "expired" && gate.expired !== undefined) {
    return {
      status: "expired",
      ref,
      ...interruption,
      expired: gate.expired,
    };
  }
  return { status: "pending", ref, ...interruption };
};

export const projectInputRequests = (
  events: ReadonlyArray<LedgerEvent>,
  runId?: number,
  requestKind?: InputRequestKind,
): ReadonlyArray<InputRequestRef> => {
  const refs: InputRequestRef[] = [];
  for (const event of events) {
    const decoded = decodeRuntimeLedgerEvent(event);
    if (
      decoded._tag !== "runtime" ||
      decoded.event.kind !== RUNTIME_EVENT_KIND.AGENT_RUN_INTERRUPTED
    ) {
      continue;
    }
    const ref = inputRequestRefFromInterruptedEvent(decoded.event);
    if (!ref.ok) continue;
    if (runId !== undefined && ref.ref.runId !== runId) continue;
    if (requestKind !== undefined && ref.ref.requestKind !== requestKind) continue;
    refs.push(ref.ref);
  }
  return refs.sort((left, right) => left.interruptionEventId - right.interruptionEventId);
};

export const projectInputRequestSettlement = (
  events: ReadonlyArray<LedgerEvent>,
  ref: InputRequestRef,
): InputRequestSettlement => {
  const projection = projectInputRequest(events, ref);
  switch (projection.status) {
    case "missing_interruption":
      return { status: "not_found", ref: projection.ref };
    case "pending":
      return {
        status: "pending",
        ref: projection.ref,
        request: projection.request,
      };
    case "approved":
      return {
        status: "approved",
        ref: projection.ref,
        request: projection.request,
        decisionRef: projection.decision.decisionRef,
        decidedBy: projection.decision.decidedBy,
        decidedAtEventId: projection.decisionEventId,
      };
    case "rejected":
      return {
        status: "rejected",
        ref: projection.ref,
        request: projection.request,
        decisionRef: projection.decision.decisionRef,
        decidedBy: projection.decision.decidedBy,
        decidedAtEventId: projection.decisionEventId,
        ...(projection.decision.reason === undefined ? {} : { reason: projection.decision.reason }),
      };
    case "cancelled":
      return {
        status: "cancelled",
        ref: projection.ref,
        request: projection.request,
        closeRef: projection.cancelled.closeRef,
        ...(projection.cancelled.reason === undefined
          ? {}
          : { reason: projection.cancelled.reason }),
      };
    case "expired":
      return {
        status: "expired",
        ref: projection.ref,
        request: projection.request,
        closeRef: projection.expired.closeRef,
        ...(projection.expired.reason === undefined ? {} : { reason: projection.expired.reason }),
      };
    case "consumed":
      return {
        status: "consumed",
        ref: projection.ref,
        request: projection.request,
        decisionRef: projection.consumed.decisionRef,
        consumedBy: projection.consumed.consumedBy,
        consumedAtEventId: projection.consumedEventId,
      };
  }
};

export const submitResumeDecisionFromInputRequestProjection = (
  projection: InputRequestProjection,
  resume: unknown,
): InputRequestResumeDecisionResult => {
  switch (projection.status) {
    case "approved": {
      const parsed = parseInputRequestResumePayload(projection.ref.requestKind, resume);
      if (!parsed.ok) return { ...parsed, projection };
      return {
        ok: true,
        resume: submitResumeDecisionFromInputRequestRef(projection.ref, {
          decisionRef: projection.decision.decisionRef,
          resume: parsed.resume,
        }),
      };
    }
    case "missing_interruption":
      return { ok: false, reason: "input_request_missing_interruption", projection };
    case "pending":
      return { ok: false, reason: "input_request_pending", projection };
    case "rejected":
      return { ok: false, reason: "input_request_rejected", projection };
    case "cancelled":
      return { ok: false, reason: "input_request_cancelled", projection };
    case "expired":
      return { ok: false, reason: "input_request_expired", projection };
    case "consumed":
      return { ok: false, reason: "input_request_consumed", projection };
  }
};
