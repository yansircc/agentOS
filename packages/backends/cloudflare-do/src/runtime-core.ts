import type { EventHandler } from "@agent-os/kernel/types";
import { Layer } from "effect";
import { Ledger, Quota, TriggerPump, type AnyDurableTrigger } from "@agent-os/runtime";
import type { SqlError } from "@agent-os/kernel/errors";
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
import { scheduledEventTrigger } from "./scheduled-trigger";
import { TriggerPumpLive } from "./trigger-pump";

export type CloudflareBackendCoreServices =
  | EventBus
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
  const triggerLayer = TriggerPumpLive(ctx, scope, [
    scheduledEventTrigger,
    deliveryRetryTrigger(ctx.storage.sql, scope, dispatchTargets),
    ...appTriggers,
  ]).pipe(Layer.provide(eventBusLayer));
  const triggerDeps = Layer.mergeAll(eventBusLayer, triggerLayer);
  const serviceLayer = Layer.mergeAll(
    LedgerLive(ctx.storage.sql),
    SchedulerLive(ctx, scope),
    DispatchLive(ctx, scope, dispatchTargets).pipe(Layer.provide(triggerDeps)),
    ResourcesLive(ctx),
    QuotaLive(ctx),
  ).pipe(Layer.provide(eventBusLayer));
  return Layer.mergeAll(eventBusLayer, triggerLayer, serviceLayer);
};
