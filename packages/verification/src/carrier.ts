import type { Effect } from "effect";

import type { VerificationGateRecordedPayload } from "./events";

export interface VerificationGateRequest {
  readonly subjectRef: string;
  readonly gate: string;
  readonly inputRef: string;
  readonly policyRef?: string;
}

export interface VerificationCarrierFailure {
  readonly code:
    | "GateUnavailable"
    | "GateTimedOut"
    | "GateFailedToRun"
    | "ProviderFailure";
  readonly reason: string;
  readonly proofRef?: string;
}

export interface VerificationCarrier {
  readonly runGate: (
    request: VerificationGateRequest,
  ) => Effect.Effect<
    VerificationGateRecordedPayload,
    VerificationCarrierFailure
  >;
}
