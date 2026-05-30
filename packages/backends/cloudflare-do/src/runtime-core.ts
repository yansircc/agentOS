import type { EventHandler } from "@agent-os/kernel/types";
import { Effect, Layer } from "effect";
import {
  DurableTriggerRegistry,
  Ledger,
  Quota,
  TriggerPump,
  makeDurableTriggerRegistry,
  scheduledEventTrigger,
  type AnyDurableTrigger,
} from "@agent-os/runtime";
import { SqlError } from "@agent-os/kernel/errors";
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

export type CloudflareBackendCoreServices =
  | EventBus
  | DurableTriggerRegistry
  | Scheduler
  | Dispatch
  | Resources
  | Quota
  | TriggerPump
  | Ledger;

export const makeCloudflareBackendCoreLayer = (
  ctx: DurableObjectState,
  scope: string,
  handlers: Map<string, Set<EventHandler>>,
  dispatchTargets: DispatchTargetRegistry,
  appTriggers: Iterable<AnyDurableTrigger> = [],
): Layer.Layer<CloudflareBackendCoreServices, SqlError> => {
  const eventBusLayer = EventBusLive(handlers);
  const dispatchRetryTrigger = deliveryRetryTrigger(ctx.storage.sql, scope, dispatchTargets);
  const triggerRegistryLayer = Layer.effect(
    DurableTriggerRegistry,
    makeDurableTriggerRegistry([scheduledEventTrigger, dispatchRetryTrigger, ...appTriggers]).pipe(
      Effect.mapError((cause) => new SqlError({ cause })),
    ),
  );
  const triggerLayer = TriggerPumpLive(ctx, scope).pipe(
    Layer.provide(Layer.mergeAll(eventBusLayer, triggerRegistryLayer)),
  );
  const triggerDeps = Layer.mergeAll(eventBusLayer, triggerRegistryLayer, triggerLayer);
  const serviceLayer = Layer.mergeAll(
    LedgerLive(ctx.storage.sql),
    SchedulerLive(ctx, scope),
    DispatchLive(ctx, scope, dispatchTargets).pipe(Layer.provide(triggerDeps)),
    ResourcesLive(ctx),
    QuotaLive(ctx),
  ).pipe(Layer.provide(Layer.mergeAll(eventBusLayer, triggerRegistryLayer)));
  return Layer.mergeAll(eventBusLayer, triggerRegistryLayer, triggerLayer, serviceLayer);
};
