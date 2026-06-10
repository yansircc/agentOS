import { Effect, Layer } from "effect";
import { SqlError } from "@agent-os/kernel/errors";
import {
  backendProtocolTruthIdentityKey,
  SCHEDULED_EVENT_TRIGGER_KIND,
  type BackendProtocolTruthIdentity,
} from "@agent-os/backend-protocol";
import {
  RefResolverLive,
  type RefResolver,
  RefResolverService,
} from "@agent-os/kernel/ref-resolver";
import {
  Admission,
  AttachedStreamRegistry,
  AttachedStreams,
  BoundaryEvents,
  Dispatch,
  DurableTriggerRegistry,
  Ledger,
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
import { LlmTransport } from "@agent-os/llm-protocol";
import {
  createInMemoryBackendState,
  type InMemoryBackendState,
  type InMemoryEventHandlerRegistration,
} from "./state";
import { InMemoryAdmissionLive } from "./admission";
import { InMemoryAttachedStreamsLive } from "./attached-stream";
import { InMemoryBoundaryEventsLive } from "./boundary-events";
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
  | BoundaryEvents
  | TriggerPump
  | Admission
  | AttachedStreams
  | MaterializedProjectionRegistry
  | MaterializedProjections
  | RefResolverService;

export interface InMemoryRuntimeLayerOptions {
  readonly state?: InMemoryBackendState;
  readonly identity: BackendProtocolTruthIdentity;
  readonly scope?: never;
  readonly handlers?: Iterable<InMemoryEventHandlerRegistration>;
  readonly dispatchTargets?: InMemoryDispatchTargetRegistry;
  readonly llm?: InMemoryLlmTransportOptions;
  readonly refResolver?: RefResolver;
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
  const refResolverLayer = RefResolverLive(options.refResolver ?? { material: () => null });
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
        SCHEDULED_EVENT_TRIGGER_KIND,
        dispatchRetryTrigger.kind,
        ...(options.triggers ?? []).map((trigger) => trigger.kind),
      ],
    }).pipe(Effect.mapError((cause) => new SqlError({ cause }))),
  );
  const projectionRegistryLayer = Layer.effect(
    MaterializedProjectionRegistry,
    makeProjectionRegistry(projections).pipe(Effect.mapError((cause) => new SqlError({ cause }))),
  );
  const materializedProjectionLayer = InMemoryMaterializedProjectionsLive(state, options.identity);
  const scopeLabel = backendProtocolTruthIdentityKey(options.identity);
  const attachedStreamLayer = InMemoryAttachedStreamsLive(state, options.identity, scopeLabel).pipe(
    Layer.provide(streamRegistryLayer),
  );
  const triggerLayer = InMemoryTriggerPumpLive(state, options.identity, scopeLabel).pipe(
    Layer.provide(triggerRegistryLayer),
  );
  return {
    state,
    layer: Layer.mergeAll(
      InMemoryLedgerLive(state),
      InMemoryBoundaryEventsLive(state, options.identity),
      InMemorySchedulerLive(state, options.identity).pipe(Layer.provide(triggerRegistryLayer)),
      triggerLayer,
      InMemoryDispatchLive(state, options.identity, scopeLabel, options.dispatchTargets).pipe(
        Layer.provide(Layer.mergeAll(triggerLayer, triggerRegistryLayer)),
      ),
      InMemoryResourcesLive(state),
      InMemoryQuotaLive(state),
      llmLayer,
      refResolverLayer,
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
