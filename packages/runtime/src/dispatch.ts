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

export interface DispatchReceiver {
  readonly __agentosReceiveDispatch: (
    envelope: DispatchEnvelope,
  ) => Promise<{ deliveredEventId: number }>;
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
      { deliveredEventId: number },
      SqlError | JsonStringifyError | CapabilityRejected | ScopeMissingError | DispatchScopeMismatch
    >;
    readonly drainDue: (
      now: number,
    ) => Effect.Effect<{ delivered: number; failed: number }, SqlError | JsonStringifyError>;
  }
>() {}
