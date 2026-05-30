import { Effect, Layer } from "effect";
import { SqlError } from "@agent-os/kernel/errors";
import {
  Admission,
  Dispatch,
  DurableTriggerRegistry,
  Ledger,
  LlmTransport,
  Quota,
  Resources,
  Scheduler,
  TriggerPump,
  makeDurableTriggerRegistry,
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
  | DurableTriggerRegistry
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
  const triggerRegistryLayer = Layer.effect(
    DurableTriggerRegistry,
    makeDurableTriggerRegistry([
      scheduledEventTrigger,
      dispatchRetryTrigger,
      ...(options.triggers ?? []),
    ]).pipe(Effect.mapError((cause) => new SqlError({ cause }))),
  );
  const triggerLayer = InMemoryTriggerPumpLive(state, options.scope).pipe(
    Layer.provide(triggerRegistryLayer),
  );
  return {
    state,
    layer: Layer.mergeAll(
      InMemoryLedgerLive(state),
      InMemorySchedulerLive(state, options.scope).pipe(Layer.provide(triggerRegistryLayer)),
      triggerLayer,
      InMemoryDispatchLive(state, options.scope, options.dispatchTargets).pipe(
        Layer.provide(Layer.mergeAll(triggerLayer, triggerRegistryLayer)),
      ),
      InMemoryResourcesLive(state),
      InMemoryQuotaLive(state),
      llmLayer,
      admissionLayer,
      triggerRegistryLayer,
    ),
  };
};

export const makeInMemoryRuntimeLayer = (
  options: InMemoryRuntimeLayerOptions,
): Layer.Layer<InMemoryRuntimeServices, SqlError> => createInMemoryRuntimeBackend(options).layer;
