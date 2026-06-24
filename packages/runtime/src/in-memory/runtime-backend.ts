import { Effect, Layer } from "effect";
import { SqlError } from "@agent-os/core/errors";
import {
  backendProtocolTruthIdentityKey,
  SCHEDULED_EVENT_TRIGGER_KIND,
  type BackendProtocolTruthIdentity,
} from "@agent-os/core/backend-protocol";
import { RefResolverLive, type RefResolver, RefResolverService } from "@agent-os/core/ref-resolver";
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
  type RuntimeStorageError,
} from "@agent-os/runtime";
import { LlmTransport } from "@agent-os/core/llm-protocol";
import {
  createInMemoryBackendState,
  installInMemoryBackendStateProjectionRegistry,
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

const resolvedRuntimeInstallGraphBrand: unique symbol = Symbol(
  "agentos.in_memory.resolved_runtime_install_graph",
);

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

/**
 * Internal substrate input consumed by resolveRuntime after capability
 * contracts have been globally validated. This is not a public assembly API.
 *
 * @internal
 */
export interface InMemoryRuntimeInstallGraphInput {
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

/**
 * Resolved install graph for the in-memory backend.
 *
 * The brand makes ad-hoc half-registration impossible at the public
 * createInMemoryRuntimeBackend boundary; graph construction is owned by the
 * resolver/internal test helper.
 *
 * @public
 */
export interface ResolvedRuntimeInstallGraph {
  readonly [resolvedRuntimeInstallGraphBrand]: true;
  readonly state?: InMemoryBackendState;
  readonly identity: BackendProtocolTruthIdentity;
  readonly scope?: never;
  readonly handlers: ReadonlyArray<InMemoryEventHandlerRegistration>;
  readonly dispatchTargets?: InMemoryDispatchTargetRegistry;
  readonly llm?: InMemoryLlmTransportOptions;
  readonly refResolver?: RefResolver;
  readonly triggers: ReadonlyArray<AnyDurableTrigger>;
  readonly streams: ReadonlyArray<AnyAttachedStreamHandler>;
  readonly projections: ReadonlyArray<AnyMaterializedProjectionDefinition>;
}

/**
 * Internal graph constructor. Keep this out of the in-memory public subpath.
 *
 * @internal
 */
export const defineResolvedRuntimeInstallGraph = (
  input: InMemoryRuntimeInstallGraphInput,
): ResolvedRuntimeInstallGraph => ({
  [resolvedRuntimeInstallGraphBrand]: true,
  state: input.state,
  identity: input.identity,
  handlers: Array.from(input.handlers ?? []),
  dispatchTargets: input.dispatchTargets,
  llm: input.llm,
  refResolver: input.refResolver,
  triggers: [...(input.triggers ?? [])],
  streams: [...(input.streams ?? [])],
  projections: [...(input.projections ?? [])],
});

export interface InMemoryRuntimeBackend {
  readonly state: InMemoryBackendState;
  readonly layer: Layer.Layer<InMemoryRuntimeServices, SqlError | RuntimeStorageError>;
}

export const createInMemoryRuntimeBackend = (
  graph: ResolvedRuntimeInstallGraph,
): InMemoryRuntimeBackend => {
  const projections = graph.projections;
  const state =
    graph.state ?? createInMemoryBackendState({ handlers: graph.handlers, projections });
  if (graph.state !== undefined) {
    installInMemoryBackendStateProjectionRegistry(
      state,
      makeProjectionRegistryResult(projections),
    );
    for (const registration of graph.handlers) {
      state.addHandler(registration.kind, registration.handler);
    }
  }
  const llmLayer = InMemoryLlmTransportLive(graph.llm);
  const refResolverLayer = RefResolverLive(graph.refResolver ?? { material: () => null });
  const admissionLayer = InMemoryAdmissionLive(state).pipe(Layer.provide(llmLayer));
  const dispatchRetryTrigger = deliveryRetryTrigger(state, graph.dispatchTargets ?? {});
  const triggerRegistryLayer = Layer.effect(
    DurableTriggerRegistry,
    makeDurableTriggerRegistry([
      scheduledEventTrigger,
      dispatchRetryTrigger,
      ...graph.triggers,
    ]).pipe(
      Effect.mapError((cause) => new SqlError({ cause })),
      Effect.withSpan("agentos.in_memory.runtime_backend.trigger_registry"),
    ),
  );
  const streamRegistryLayer = Layer.effect(
    AttachedStreamRegistry,
    makeAttachedStreamRegistry(graph.streams, {
      reservedKinds: [
        SCHEDULED_EVENT_TRIGGER_KIND,
        dispatchRetryTrigger.kind,
        ...graph.triggers.map((trigger) => trigger.kind),
      ],
    }).pipe(
      Effect.mapError((cause) => new SqlError({ cause })),
      Effect.withSpan("agentos.in_memory.runtime_backend.stream_registry"),
    ),
  );
  const projectionRegistryLayer = Layer.effect(
    MaterializedProjectionRegistry,
    makeProjectionRegistry(projections).pipe(
      Effect.mapError((cause) => new SqlError({ cause })),
      Effect.withSpan("agentos.in_memory.runtime_backend.projection_registry"),
    ),
  );
  const materializedProjectionLayer = InMemoryMaterializedProjectionsLive(state, graph.identity);
  const scopeLabel = backendProtocolTruthIdentityKey(graph.identity);
  const attachedStreamLayer = InMemoryAttachedStreamsLive(state, graph.identity, scopeLabel).pipe(
    Layer.provide(streamRegistryLayer),
  );
  const triggerLayer = InMemoryTriggerPumpLive(state, graph.identity, scopeLabel).pipe(
    Layer.provide(triggerRegistryLayer),
  );
  return {
    state,
    layer: Layer.mergeAll(
      InMemoryLedgerLive(state),
      InMemoryBoundaryEventsLive(state, graph.identity),
      InMemorySchedulerLive(state, graph.identity).pipe(Layer.provide(triggerRegistryLayer)),
      triggerLayer,
      InMemoryDispatchLive(state, graph.identity, scopeLabel, graph.dispatchTargets).pipe(
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
  graph: ResolvedRuntimeInstallGraph,
): Layer.Layer<InMemoryRuntimeServices, SqlError | RuntimeStorageError> =>
  createInMemoryRuntimeBackend(graph).layer;
