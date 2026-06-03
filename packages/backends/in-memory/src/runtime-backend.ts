import { Effect, Layer } from "effect";
import { SqlError } from "@agent-os/kernel/errors";
import {
  Admission,
  AttachedStreamRegistry,
  AttachedStreams,
  Dispatch,
  DurableTriggerRegistry,
  Ledger,
  LlmTransport,
  MaterializedProjectionRegistry,
  MaterializedProjections,
  Quota,
  Resources,
  Scheduler,
  TriggerPump,
  makeProjectionRegistry,
  makeProjectionRegistryResult,
  makeDurableTriggerRegistry,
  makeAttachedStreamRegistry,
  scheduledEventTrigger,
  type AnyAttachedStreamHandler,
  type AnyDurableTrigger,
  type AnyMaterializedProjectionDefinition,
} from "@agent-os/runtime";
import {
  createInMemoryBackendState,
  type InMemoryBackendState,
  type InMemoryEventHandlerRegistration,
} from "./state";
import { InMemoryAdmissionLive } from "./admission";
import { InMemoryAttachedStreamsLive } from "./attached-stream";
import { InMemoryDispatchLive, deliveryRetryTrigger } from "./dispatch";
import type { InMemoryDispatchTargetRegistry } from "./dispatch-types";
import { InMemoryLedgerLive } from "./ledger";
import { InMemoryLlmTransportLive, type InMemoryLlmTransportOptions } from "./llm";
import { InMemoryMaterializedProjectionsLive } from "./materialized-projections";
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
  | Admission
  | AttachedStreams
  | MaterializedProjectionRegistry
  | MaterializedProjections;

export interface InMemoryRuntimeLayerOptions {
  readonly state?: InMemoryBackendState;
  readonly scope: string;
  readonly handlers?: Iterable<InMemoryEventHandlerRegistration>;
  readonly dispatchTargets?: InMemoryDispatchTargetRegistry;
  readonly llm?: InMemoryLlmTransportOptions;
  readonly triggers?: ReadonlyArray<AnyDurableTrigger>;
  readonly streams?: ReadonlyArray<AnyAttachedStreamHandler>;
  readonly projections?: ReadonlyArray<AnyMaterializedProjectionDefinition>;
}

export interface InMemoryRuntimeBackend {
  readonly state: InMemoryBackendState;
  readonly layer: Layer.Layer<InMemoryRuntimeServices, SqlError>;
}

export const createInMemoryRuntimeBackend = (
  options: InMemoryRuntimeLayerOptions,
): InMemoryRuntimeBackend => {
  const projections = options.projections ?? [];
  const state =
    options.state ?? createInMemoryBackendState({ handlers: options.handlers, projections });
  if (options.state !== undefined) {
    state.setProjectionRegistryResult(makeProjectionRegistryResult(projections));
  }
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
  const streamRegistryLayer = Layer.effect(
    AttachedStreamRegistry,
    makeAttachedStreamRegistry(options.streams ?? [], {
      reservedKinds: [
        scheduledEventTrigger.kind,
        dispatchRetryTrigger.kind,
        ...(options.triggers ?? []).map((trigger) => trigger.kind),
      ],
    }).pipe(Effect.mapError((cause) => new SqlError({ cause }))),
  );
  const projectionRegistryLayer = Layer.effect(
    MaterializedProjectionRegistry,
    makeProjectionRegistry(projections).pipe(Effect.mapError((cause) => new SqlError({ cause }))),
  );
  const materializedProjectionLayer = InMemoryMaterializedProjectionsLive(state);
  const attachedStreamLayer = InMemoryAttachedStreamsLive(state, options.scope).pipe(
    Layer.provide(streamRegistryLayer),
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
      streamRegistryLayer,
      attachedStreamLayer,
      projectionRegistryLayer,
      materializedProjectionLayer,
    ),
  };
};

export const makeInMemoryRuntimeLayer = (
  options: InMemoryRuntimeLayerOptions,
): Layer.Layer<InMemoryRuntimeServices, SqlError> => createInMemoryRuntimeBackend(options).layer;
