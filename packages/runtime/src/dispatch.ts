import { Context, Effect } from "effect";
import type {
  CapabilityRejected,
  DurableTriggerCommitReturnedThenable,
  DispatchScopeMismatch,
  DispatchTargetNotFound,
  JsonStringifyError,
  ScopeMissingError,
  UnregisteredDurableTriggerKind,
  UnsupportedScopeRef,
} from "@agent-os/core/errors";
import type { DispatchToScopeResult, DispatchToScopeSpec } from "@agent-os/core/types";
import type { InvalidTraceContext } from "@agent-os/core/telemetry-protocol";
import type { DispatchEnvelope, DispatchReceiverResult } from "@agent-os/core/backend-protocol";
import type { RuntimeStorageError } from "./ledger";

export class Dispatch extends Context.Service<
  Dispatch,
  {
    readonly dispatchToScope: (
      spec: DispatchToScopeSpec,
    ) => Effect.Effect<
      DispatchToScopeResult,
      | RuntimeStorageError
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
      | RuntimeStorageError
      | JsonStringifyError
      | InvalidTraceContext
      | CapabilityRejected
      | ScopeMissingError
      | DispatchScopeMismatch
    >;
  }
>()("@agent-os/Dispatch") {}
