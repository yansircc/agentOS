import { Layer } from "effect";
import { Ledger, Quota, type EventHandler } from "@agent-os/runtime";
import type { SqlError } from "@agent-os/kernel/errors";
import { Dispatch, DispatchLive, type DispatchTargetRegistry } from "./dispatch";
import { EventBus, EventBusLive, LedgerLive } from "./ledger";
import { Scheduler, SchedulerLive } from "./scheduler";
import { Resources, ResourcesLive } from "./resources";
import { QuotaLive } from "./quota";

export type CloudflareBackendCoreServices =
  | EventBus
  | Scheduler
  | Dispatch
  | Resources
  | Quota
  | Ledger;

export const makeCloudflareBackendCoreLayer = (
  ctx: DurableObjectState,
  scope: string,
  handlers: Map<string, Set<EventHandler>>,
  dispatchTargets: DispatchTargetRegistry,
): Layer.Layer<CloudflareBackendCoreServices, SqlError> => {
  const eventBusLayer = EventBusLive(handlers);
  const serviceLayer = Layer.mergeAll(
    LedgerLive(ctx.storage.sql),
    SchedulerLive(ctx, scope),
    DispatchLive(ctx, scope, dispatchTargets),
    ResourcesLive(ctx),
    QuotaLive(ctx),
  ).pipe(Layer.provide(eventBusLayer));
  return Layer.mergeAll(eventBusLayer, serviceLayer);
};
