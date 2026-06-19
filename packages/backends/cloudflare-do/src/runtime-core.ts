import type { EventHandler } from "@agent-os/kernel/types";
import { Effect, Layer } from "effect";
import {
  AttachedStreamRegistry,
  AttachedStreams,
  BoundaryEvents,
  DurableTriggerRegistry,
  Ledger,
  MaterializedProjectionRegistry,
  MaterializedProjections,
  Quota,
  TriggerPump,
  makeProjectionRegistry,
  makeDurableTriggerRegistry,
  makeAttachedStreamRegistry,
  scheduledEventTrigger,
  type AnyMaterializedProjectionDefinition,
  type RuntimeStorageError,
} from "@agent-os/runtime";
import { SqlError, TriggerFactoryError } from "@agent-os/kernel/errors";
import {
  Dispatch,
  DispatchLive,
  deliveryRetryTrigger,
  type DispatchTargetRegistry,
} from "./dispatch";
import { EventBus, EventBusLive, LedgerLive } from "./ledger";
import { Scheduler, SchedulerLive } from "./scheduler";
import { Resources, ResourcesLive } from "./resources";
import { QuotaLive } from "./quota";
import { TriggerPumpLive } from "./trigger-pump";
import { resolveCloudflareTriggerSource, type CloudflareTriggerSource } from "./trigger-factory";
import {
  resolveCloudflareAttachedStreamSource,
  type CloudflareAttachedStreamSource,
} from "./stream-factory";
import { AttachedStreamsLive } from "./attached-stream";
import { BoundaryEventsLive } from "./boundary-events";
import { CloudflareMaterializedProjectionsLive } from "./materialized-projections";
import type { BackendProtocolEventIdentity } from "@agent-os/backend-protocol";

export type CloudflareBackendCoreServices =
  | EventBus
  | DurableTriggerRegistry
  | Scheduler
  | Dispatch
  | Resources
  | Quota
  | TriggerPump
  | AttachedStreamRegistry
  | AttachedStreams
  | BoundaryEvents
  | MaterializedProjectionRegistry
  | MaterializedProjections
  | Ledger;

export const makeCloudflareBackendCoreLayer = <Env>(
  ctx: DurableObjectState,
  env: Env,
  scope: string,
  identity: BackendProtocolEventIdentity,
  handlers: Map<string, Set<EventHandler>>,
  dispatchTargets: DispatchTargetRegistry,
  appTriggers: CloudflareTriggerSource<Env> = [],
  appStreams: CloudflareAttachedStreamSource<Env> = [],
  appProjections: ReadonlyArray<AnyMaterializedProjectionDefinition> = [],
): Layer.Layer<
  CloudflareBackendCoreServices,
  SqlError | TriggerFactoryError | RuntimeStorageError
> => {
  const eventBusLayer = EventBusLive(handlers);
  const projectionRegistryLayer = Layer.effect(
    MaterializedProjectionRegistry,
    makeProjectionRegistry(appProjections).pipe(
      Effect.mapError((cause) => new SqlError({ cause })),
    ),
  );
  const materializedProjectionLayer = CloudflareMaterializedProjectionsLive(ctx).pipe(
    Layer.provide(projectionRegistryLayer),
  );
  const dispatchRetryTrigger = deliveryRetryTrigger(scope, dispatchTargets);
  const triggerRegistryLayer = Layer.effect(
    DurableTriggerRegistry,
    Effect.gen(function* () {
      const resolvedAppTriggers = yield* resolveCloudflareTriggerSource(appTriggers, {
        env,
        scope,
        sql: ctx.storage.sql,
      });
      return yield* makeDurableTriggerRegistry([
        scheduledEventTrigger,
        dispatchRetryTrigger,
        ...resolvedAppTriggers,
      ]).pipe(Effect.mapError((cause) => new SqlError({ cause })));
    }),
  );
  const triggerLayer = TriggerPumpLive(ctx, scope).pipe(
    Layer.provide(Layer.mergeAll(eventBusLayer, triggerRegistryLayer)),
  );
  const streamRegistryLayer = Layer.effect(
    AttachedStreamRegistry,
    Effect.gen(function* () {
      const triggerRegistry = yield* DurableTriggerRegistry;
      const resolvedAppStreams = yield* resolveCloudflareAttachedStreamSource(appStreams, {
        env,
        scope,
        sql: ctx.storage.sql,
      });
      return yield* makeAttachedStreamRegistry(resolvedAppStreams, {
        reservedKinds: triggerRegistry.keys(),
      }).pipe(Effect.mapError((cause) => new SqlError({ cause })));
    }),
  ).pipe(Layer.provide(triggerRegistryLayer));
  const attachedStreamLayer = AttachedStreamsLive(ctx, scope, identity).pipe(
    Layer.provide(Layer.mergeAll(eventBusLayer, streamRegistryLayer)),
  );
  const triggerDeps = Layer.mergeAll(eventBusLayer, triggerRegistryLayer, triggerLayer);
  const serviceLayer = Layer.mergeAll(
    LedgerLive(ctx),
    BoundaryEventsLive(ctx, identity),
    SchedulerLive(ctx, scope, identity),
    DispatchLive(ctx, scope, identity, dispatchTargets).pipe(Layer.provide(triggerDeps)),
    ResourcesLive(ctx, identity),
    QuotaLive(ctx, identity),
  ).pipe(Layer.provide(Layer.mergeAll(eventBusLayer, triggerRegistryLayer)));
  return Layer.mergeAll(
    eventBusLayer,
    triggerRegistryLayer,
    triggerLayer,
    streamRegistryLayer,
    attachedStreamLayer,
    projectionRegistryLayer,
    materializedProjectionLayer,
    serviceLayer,
  );
};
