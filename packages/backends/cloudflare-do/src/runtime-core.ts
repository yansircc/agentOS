import type { EventHandler } from "@agent-os/kernel/types";
import { Effect, Layer } from "effect";
import {
  DurableTriggerRegistry,
  Ledger,
  Quota,
  TriggerPump,
  makeDurableTriggerRegistry,
  scheduledEventTrigger,
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

export type CloudflareBackendCoreServices =
  | EventBus
  | DurableTriggerRegistry
  | Scheduler
  | Dispatch
  | Resources
  | Quota
  | TriggerPump
  | Ledger;

export const makeCloudflareBackendCoreLayer = <Env>(
  ctx: DurableObjectState,
  env: Env,
  scope: string,
  handlers: Map<string, Set<EventHandler>>,
  dispatchTargets: DispatchTargetRegistry,
  appTriggers: CloudflareTriggerSource<Env> = [],
): Layer.Layer<CloudflareBackendCoreServices, SqlError | TriggerFactoryError> => {
  const eventBusLayer = EventBusLive(handlers);
  const dispatchRetryTrigger = deliveryRetryTrigger(ctx.storage.sql, scope, dispatchTargets);
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
