import { makePreClaim } from "@agent-os/kernel/effect-claim";
import type { TraceContext } from "@agent-os/telemetry-protocol";
import type {
  BackendProtocolDispatchTarget,
  DispatchTargetAdapter,
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

export type InMemoryDispatchTargetRegistry = Readonly<Record<string, DispatchTargetAdapter>>;
