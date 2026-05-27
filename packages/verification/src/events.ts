import type { LivedClaim } from "@agent-os/core/effect-claim";
import { VERIFICATION_EVENT_PREFIX } from "./extension";

export const VERIFICATION_EVENTS = {
  GATE_RECORDED: `${VERIFICATION_EVENT_PREFIX}gate.recorded`,
} as const;

export type VerificationEventKind = (typeof VERIFICATION_EVENTS)[keyof typeof VERIFICATION_EVENTS];

export type VerificationGateStatus = "passed" | "failed";

export interface VerificationGateRecordedPayload {
  readonly subjectRef: string;
  readonly gate: string;
  readonly status: VerificationGateStatus;
  readonly proofRef: string;
  readonly fingerprint: string;
  readonly summary?: string;
  readonly claim?: LivedClaim;
}

export interface VerificationLedgerEvent {
  readonly id: number;
  readonly kind: string;
  readonly payload: unknown;
}

export interface VerificationGateFact extends VerificationGateRecordedPayload {
  readonly eventId: number;
}

export interface VerificationGateProjection {
  readonly subjectRef: string;
  readonly ready: boolean;
  readonly latestByGate: ReadonlyMap<string, VerificationGateFact>;
  readonly gateEventIds: ReadonlyArray<number>;
  readonly missing: ReadonlyArray<string>;
  readonly failed: ReadonlyArray<VerificationGateFact>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const gatePayloadFrom = (event: VerificationLedgerEvent): VerificationGateFact | null => {
  if (event.kind !== VERIFICATION_EVENTS.GATE_RECORDED) return null;
  if (!isRecord(event.payload)) return null;
  const { subjectRef, gate, status, proofRef, fingerprint, summary } = event.payload;
  if (typeof subjectRef !== "string") return null;
  if (typeof gate !== "string") return null;
  if (status !== "passed" && status !== "failed") return null;
  if (typeof proofRef !== "string") return null;
  if (typeof fingerprint !== "string") return null;
  return {
    eventId: event.id,
    subjectRef,
    gate,
    status,
    proofRef,
    fingerprint,
    summary: typeof summary === "string" ? summary : undefined,
  };
};

export const projectVerificationGates = (
  events: Iterable<VerificationLedgerEvent>,
  subjectRef: string,
  requiredGates: ReadonlyArray<string>,
): VerificationGateProjection => {
  const latestByGate = new Map<string, VerificationGateFact>();

  for (const event of events) {
    const fact = gatePayloadFrom(event);
    if (fact === null) continue;
    if (fact.subjectRef !== subjectRef) continue;
    latestByGate.set(fact.gate, fact);
  }

  const missing = requiredGates.filter((gate) => !latestByGate.has(gate));
  const failed = requiredGates
    .map((gate) => latestByGate.get(gate))
    .filter((fact): fact is VerificationGateFact => fact?.status === "failed");
  const ready = missing.length === 0 && failed.length === 0;

  return {
    subjectRef,
    ready,
    latestByGate,
    gateEventIds: [...latestByGate.values()].map((fact) => fact.eventId),
    missing,
    failed,
  };
};
