import type { Effect } from "effect";
import type { PreClaim, RejectedClaim } from "@agent-os/core/effect-claim";

import type { VerificationGateRecordedPayload } from "./events";

export interface VerificationGateRequest {
  readonly claim?: PreClaim;
  readonly subjectRef: string;
  readonly gate: string;
  readonly inputRef: string;
  readonly policyRef?: string;
}

export interface VerificationCarrierFailure {
  readonly code: "GateUnavailable" | "GateTimedOut" | "GateFailedToRun" | "ProviderFailure";
  readonly reason: string;
  readonly proofRef?: string;
  readonly claim?: RejectedClaim;
}

export interface VerificationCarrier {
  readonly runGate: (
    request: VerificationGateRequest,
  ) => Effect.Effect<VerificationGateRecordedPayload, VerificationCarrierFailure>;
}
