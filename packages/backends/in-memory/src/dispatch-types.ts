import { makePreClaim } from "@agent-os/kernel/effect-claim";
import type { TraceContext } from "@agent-os/telemetry-protocol";
import type { DispatchTargetAdapter } from "@agent-os/runtime";
import type {
  BackendProtocolDispatchTarget,
  BackendProtocolEventIdentity,
  DurableTriggerRetryPolicy,
} from "@agent-os/backend-protocol";

export interface DispatchRequestedPayload {
  readonly target: BackendProtocolDispatchTarget;
  readonly event: string;
  readonly data: unknown;
  readonly idempotencyKey: string;
  readonly retryPolicy: DurableTriggerRetryPolicy;
  readonly claim: ReturnType<typeof makePreClaim>;
  readonly traceContext?: TraceContext;
}

export interface DispatchOutboxRow {
  readonly outboundEventId: number;
  readonly sourceScope: string;
  readonly sourceIdentity: BackendProtocolEventIdentity;
  readonly requested: DispatchRequestedPayload;
  attempts: number;
  deliveredEventId: number | null;
  lastError: string | null;
}

export type InMemoryDispatchTargetRegistry = Readonly<Record<string, DispatchTargetAdapter>>;
