import { makePreClaim } from "@agent-os/kernel/effect-claim";
import type { DispatchReceiver, DispatchTargetSpec, TraceContext } from "@agent-os/runtime";

export interface DispatchRequestedPayload {
  readonly target: DispatchTargetSpec;
  readonly event: string;
  readonly data: unknown;
  readonly idempotencyKey: string;
  readonly claim: ReturnType<typeof makePreClaim>;
  readonly traceContext?: TraceContext;
}

export interface DispatchOutboxRow {
  readonly outboundEventId: number;
  readonly sourceScope: string;
  readonly requested: DispatchRequestedPayload;
  attempts: number;
  deliveredEventId: number | null;
  lastError: string | null;
}

export type InMemoryDispatchTargetRegistry = Readonly<
  Record<string, Readonly<Record<string, DispatchReceiver>>>
>;
