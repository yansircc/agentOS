import { Layer } from "effect";
import type { SqlError } from "@agent-os/kernel/errors";
import {
  Admission,
  Dispatch,
  Ledger,
  LlmTransport,
  Quota,
  Resources,
  Scheduler,
  TriggerPump,
  scheduledEventTrigger,
  type AnyDurableTrigger,
} from "@agent-os/runtime";
import {
  createInMemoryBackendState,
  type InMemoryBackendState,
  type InMemoryEventHandlerRegistration,
} from "./state";
import { InMemoryAdmissionLive } from "./admission";
import { InMemoryDispatchLive, deliveryRetryTrigger } from "./dispatch";
import type { InMemoryDispatchTargetRegistry } from "./dispatch-types";
import { InMemoryLedgerLive } from "./ledger";
import { InMemoryLlmTransportLive, type InMemoryLlmTransportOptions } from "./llm";
import { InMemoryQuotaLive } from "./quota";
import { InMemoryResourcesLive } from "./resources";
import { InMemorySchedulerLive } from "./scheduler";
import { InMemoryTriggerPumpLive } from "./trigger-pump";

export type InMemoryRuntimeServices =
  | Ledger
  | Scheduler
  | Dispatch
  | Resources
  | Quota
  | LlmTransport
  | TriggerPump
  | Admission;

export interface InMemoryRuntimeLayerOptions {
  readonly state?: InMemoryBackendState;
  readonly scope: string;
  readonly handlers?: Iterable<InMemoryEventHandlerRegistration>;
  readonly dispatchTargets?: InMemoryDispatchTargetRegistry;
  readonly llm?: InMemoryLlmTransportOptions;
  readonly triggers?: ReadonlyArray<AnyDurableTrigger>;
}

export interface InMemoryRuntimeBackend {
  readonly state: InMemoryBackendState;
  readonly layer: Layer.Layer<InMemoryRuntimeServices, SqlError>;
}

export const createInMemoryRuntimeBackend = (
  options: InMemoryRuntimeLayerOptions,
): InMemoryRuntimeBackend => {
  const state = options.state ?? createInMemoryBackendState({ handlers: options.handlers });
  const llmLayer = InMemoryLlmTransportLive(options.llm);
  const admissionLayer = InMemoryAdmissionLive(state).pipe(Layer.provide(llmLayer));
  const dispatchRetryTrigger = deliveryRetryTrigger(state, options.dispatchTargets ?? {});
  const triggerLayer = InMemoryTriggerPumpLive(state, options.scope, [
    scheduledEventTrigger,
    dispatchRetryTrigger,
    ...(options.triggers ?? []),
  ]);
  return {
    state,
    layer: Layer.mergeAll(
      InMemoryLedgerLive(state),
      InMemorySchedulerLive(state, options.scope),
      triggerLayer,
      InMemoryDispatchLive(
        state,
        options.scope,
        options.dispatchTargets,
        dispatchRetryTrigger,
      ).pipe(Layer.provide(triggerLayer)),
      InMemoryResourcesLive(state),
      InMemoryQuotaLive(state),
      llmLayer,
      admissionLayer,
    ),
  };
};

export const makeInMemoryRuntimeLayer = (
  options: InMemoryRuntimeLayerOptions,
): Layer.Layer<InMemoryRuntimeServices, SqlError> => createInMemoryRuntimeBackend(options).layer;
