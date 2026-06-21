import { Predicate } from "effect";
import type { LivedClaim } from "@agent-os/core/effect-claim";
import { validateTerminalClaim } from "@agent-os/core/settlement-contract";
import {
  VERIFICATION_EVENTS,
  VERIFICATION_KIND,
  verificationSettlementContract,
} from "./definition";
export { VERIFICATION_EVENTS, VERIFICATION_KIND } from "./definition";

export type VerificationGateStatus = "passed" | "failed";

type VerificationPayloads = typeof VERIFICATION_EVENTS;

export type VerificationGateRecordedPayload =
  VerificationPayloads[(typeof VERIFICATION_KIND)["GATE_RECORDED"]];

export type VerificationEventKind = keyof typeof VERIFICATION_EVENTS;

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

const livedClaimFrom = (value: unknown): LivedClaim | undefined => {
  const result = validateTerminalClaim(verificationSettlementContract, value);
  return result.ok && result.claim.phase === "lived" ? result.claim : undefined;
};

const gatePayloadFrom = (event: VerificationLedgerEvent): VerificationGateFact | null => {
  if (event.kind !== VERIFICATION_KIND.GATE_RECORDED) return null;
  if (!Predicate.isObject(event.payload)) return null;
  const { subjectRef, gate, status, proofRef, fingerprint, summary } = event.payload;
  if (typeof subjectRef !== "string") return null;
  if (typeof gate !== "string") return null;
  if (status !== "passed" && status !== "failed") return null;
  if (typeof proofRef !== "string") return null;
  if (typeof fingerprint !== "string") return null;
  const claim = livedClaimFrom(event.payload.claim);
  if (claim === undefined) return null;
  return {
    eventId: event.id,
    subjectRef,
    gate,
    status,
    proofRef,
    fingerprint,
    summary: typeof summary === "string" ? summary : undefined,
    claim,
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
