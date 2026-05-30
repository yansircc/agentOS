import { Context, Effect } from "effect";
import type {
  CapabilityRejected,
  DispatchScopeMismatch,
  DispatchTargetNotFound,
  JsonStringifyError,
  ScopeMissingError,
  SqlError,
  UnsupportedScopeRef,
} from "@agent-os/kernel/errors";
import type { PreClaim } from "@agent-os/kernel/effect-claim";
import type {
  DeliveryReceipt,
  DispatchToScopeResult,
  DispatchToScopeSpec,
  TraceContext,
} from "@agent-os/kernel/types";

export interface DispatchEnvelope {
  readonly sourceScope: string;
  readonly outboundEventId: number;
  readonly targetScope: string;
  readonly event: string;
  readonly data: unknown;
  readonly idempotencyKey: string;
  readonly claim: PreClaim;
  readonly traceContext?: TraceContext;
}

export type DispatchDeliveryReceipt = DeliveryReceipt;

export interface DispatchDeliveryResult {
  readonly receipt: DispatchDeliveryReceipt;
}

export interface DispatchReceiverResult extends DispatchDeliveryResult {
  readonly deliveredEventId: number;
}

export interface DispatchReceiver {
  readonly __agentosReceiveDispatch: (
    envelope: DispatchEnvelope,
  ) => Promise<DispatchReceiverResult>;
}

export interface DispatchTargetAdapter {
  // The substrate may invoke deliver more than once for the same envelope
  // across drain races, redrive, and adapter retries. Implementations must be
  // idempotent by (targetScope, idempotencyKey) or a target-owned receipt key.
  readonly deliver: (envelope: DispatchEnvelope) => Promise<DispatchDeliveryResult>;
}

export class Dispatch extends Context.Tag("@agent-os/Dispatch")<
  Dispatch,
  {
    readonly dispatchToScope: (
      spec: DispatchToScopeSpec,
    ) => Effect.Effect<
      DispatchToScopeResult,
      | SqlError
      | JsonStringifyError
      | DispatchTargetNotFound
      | CapabilityRejected
      | UnsupportedScopeRef
    >;
    readonly receive: (
      envelope: DispatchEnvelope,
    ) => Effect.Effect<
      DispatchReceiverResult,
      SqlError | JsonStringifyError | CapabilityRejected | ScopeMissingError | DispatchScopeMismatch
    >;
  }
>() {}
