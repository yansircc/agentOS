import { Context, Effect } from "effect";
import type {
  CapabilityRejected,
  DurableTriggerCommitReturnedThenable,
  DispatchScopeMismatch,
  DispatchTargetNotFound,
  JsonStringifyError,
  ScopeMissingError,
  SqlError,
  UnregisteredDurableTriggerKind,
  UnsupportedScopeRef,
} from "@agent-os/kernel/errors";
import type { DispatchToScopeResult, DispatchToScopeSpec } from "@agent-os/kernel/types";
import type { InvalidTraceContext } from "@agent-os/telemetry-protocol";
import type { DispatchEnvelope, DispatchReceiverResult } from "@agent-os/backend-protocol";

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
      | InvalidTraceContext
      | CapabilityRejected
      | UnsupportedScopeRef
      | UnregisteredDurableTriggerKind
      | DurableTriggerCommitReturnedThenable
    >;
    readonly receive: (
      envelope: DispatchEnvelope,
    ) => Effect.Effect<
      DispatchReceiverResult,
      | SqlError
      | JsonStringifyError
      | InvalidTraceContext
      | CapabilityRejected
      | ScopeMissingError
      | DispatchScopeMismatch
    >;
  }
>() {}
