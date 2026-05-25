/**
 * AgentDOBase — the only public class.
 *
 * Scope is SSoT-owned by the DO instance — derived from `this.ctx.id.name`.
 * SubmitSpec.deliver carries only the event name. DOs created via
 * `newUniqueId` reject all calls with ScopeMissingError.
 *
 * Boundary contract:
 *   submit(spec)         resolves SubmitResult; rejects on infra
 *   events()             resolves LedgerEventRpc[]; rejects on SQL read fail
 *   emitEvent(spec)      resolves {id}; rejects on infra / reserved kind
 *   dispatchToScope(spec) resolves {outboundEventId}; rejects on infra / config
 *   scheduleEvent(spec)  resolves {id}; rejects on infra
 *   alarm()              auto-invoked by CF DO runtime
 *
 * Reactive surface — full reactive triad (now-write × future-write × react):
 *   emitEvent      now-write (this method)
 *   scheduleEvent  future-write
 *   on / off       react (subscribe)
 *
 * submit() is a composite (now-write × dispatch loop × deliver-event log),
 * not the primitive for "app writes a fact". emitEvent is the primitive;
 * use submit only when an agent run is the right shape.
 *
 * Reactive subscribe:
 *   protected on(kind, handler)  composable Set, sequential dispatch, 5s timeout per handler
 *   protected off(kind, handler) unregister
 */

import { Clock, Effect, Layer, ManagedRuntime } from "effect";
import { DurableObject } from "cloudflare:workers";
import {
  DispatchScopeMismatch,
  DispatchTargetNotFound,
  InvalidScheduleAt,
  InvalidResourceAmount,
  isReservedEventKind,
  ReservedEventKindError,
  ScopeMissingError,
  SqlError,
} from "./errors";
import type {
  EventHandler,
  DispatchToScopeResult,
  DispatchToScopeSpec,
  EventQueryOptions,
  LedgerEvent,
  LedgerEventRpc,
  ResourceGrantResult,
  ResourceGrantSpec,
  ResourceReservationSpec,
  ResourceReserveResult,
  ResourceReserveSpec,
  ScheduledEventSpec,
  StreamEventsOptions,
} from "./types";
import {
  Dispatch,
  DispatchLive,
  type DispatchEnvelope,
  type DispatchTargetRegistry,
} from "./dispatch";
import { EventBus, EventBusLive } from "./event-bus";
import { Ledger, LedgerLive } from "./ledger";
import { Scheduler, SchedulerLive } from "./scheduler";
import { Resources, ResourcesLive } from "./resources";
import {
  generateImageEffect,
  type GenerateImageSpec,
  type ImageResult,
} from "./image";
import { Quota, QuotaLive } from "./quota-service";
import { AiBinding } from "./llm";
import { Admission, AdmissionLive } from "./admission";
import {
  ProviderRegistry,
  ProviderRegistryLive,
  type ProviderRegistryConfig,
} from "./provider-registry";
import {
  type InternalSubmitSpec,
  submitAgentEffect,
  type SubmitResult,
  type SubmitSpec,
} from "./submit-agent";

export interface AgentDOEnv {
  readonly AI: Ai;
}

type CoreServices =
  | Ledger
  | EventBus
  | AiBinding
  | Scheduler
  | Dispatch
  | Resources
  | Quota
  | Admission
  | ProviderRegistry;

const makeAgentRuntime = (
  ctx: DurableObjectState,
  scope: string,
  ai: Ai,
  handlers: Map<string, Set<EventHandler>>,
  registry: ProviderRegistryConfig,
  dispatchTargets: DispatchTargetRegistry,
): ManagedRuntime.ManagedRuntime<CoreServices, SqlError> => {
  const sql = ctx.storage.sql;
  const eventBusLayer = EventBusLive(handlers);
  const ledgerLayer = LedgerLive(sql).pipe(Layer.provide(eventBusLayer));
  const schedulerLayer = SchedulerLive(ctx, scope).pipe(
    Layer.provide(eventBusLayer),
  );
  const dispatchLayer = DispatchLive(ctx, scope, dispatchTargets).pipe(
    Layer.provide(eventBusLayer),
  );
  const resourcesLayer = ResourcesLive(ctx).pipe(
    Layer.provide(eventBusLayer),
  );
  const quotaLayer = QuotaLive(ctx).pipe(Layer.provide(eventBusLayer));
  const aiLayer = Layer.succeed(AiBinding, ai);
  const registryLayer = ProviderRegistryLive(registry);
  const admissionLayer = AdmissionLive(ctx).pipe(
    Layer.provide(eventBusLayer),
  );
  return ManagedRuntime.make(
    Layer.mergeAll(
      eventBusLayer,
      ledgerLayer,
      schedulerLayer,
      dispatchLayer,
      resourcesLayer,
      quotaLayer,
      aiLayer,
      admissionLayer,
      registryLayer,
    ),
  );
};

const DEFAULT_STREAM_HEARTBEAT_MS = 15_000;

const normalizePositiveInteger = (
  value: number | undefined,
  fallback: number,
): number =>
  value === undefined || !Number.isFinite(value)
    ? fallback
    : Math.max(0, Math.floor(value));

const normalizeKinds = (
  kinds: ReadonlyArray<string> | undefined,
): ReadonlyArray<string> | undefined => {
  if (kinds === undefined) return undefined;
  const normalized = Array.from(new Set(kinds)).filter(
    (kind) => kind.length > 0,
  );
  return normalized.length === 0 ? undefined : normalized;
};

const eventToRpc = (event: LedgerEvent): LedgerEventRpc => ({
  id: event.id,
  ts: event.ts,
  kind: event.kind,
  scope: event.scope,
  payload: event.payload,
});

const encodeSseEvent = (
  encoder: TextEncoder,
  event: LedgerEvent,
): Uint8Array =>
  encoder.encode(
    [
      `id: ${event.id}`,
      "event: ledger",
      `data: ${JSON.stringify(eventToRpc(event))}`,
      "",
      "",
    ].join("\n"),
  );

const encodeSseHeartbeat = (encoder: TextEncoder): Uint8Array =>
  encoder.encode(": keepalive\n\n");

export abstract class AgentDOBase<
  Env extends AgentDOEnv,
> extends DurableObject<Env> {
  private readonly _handlers: Map<string, Set<EventHandler>> = new Map();
  private _runtime?: ManagedRuntime.ManagedRuntime<CoreServices, SqlError>;

  private runtimeFor(
    scope: string,
  ): ManagedRuntime.ManagedRuntime<CoreServices, SqlError> {
    if (this._runtime === undefined) {
      this._runtime = makeAgentRuntime(
        this.ctx,
        scope,
        this.env.AI,
        this._handlers,
        this.provideRegistry(),
        this.provideDispatchTargets(),
      );
    }
    return this._runtime;
  }

  /** Hook for subclass to provide endpoints/credentials registry resolved
   *  at DO construction. Used by `LlmRoute.kind === "openai-chat-compatible"`
   *  (and future external-route variants) — `endpointRef` and `credentialRef`
   *  on the route are looked up through this map by `callLlm`.
   *
   *  Default = empty registry. Apps using only `cf-ai-binding` don't need
   *  to override. Apps with external routes override like:
   *
   *      protected provideRegistry() {
   *        return {
   *          endpoints:   { openrouter: "https://openrouter.ai/api/v1" },
   *          credentials: { OPENROUTER_KEY: this.env.OPENROUTER_KEY },
   *        };
   *      }
   *
   *  Secrets are read from wrangler env at DO construction, NOT logged
   *  to the ledger (only the symbolic refs are). */
  protected provideRegistry(): ProviderRegistryConfig {
    return { endpoints: {}, credentials: {} };
  }

  /** Hook for subclass to provide cross-scope dispatch targets.
   *
   *  `bindingRef` on dispatchToScope resolves through this map to a runtime
   *  DurableObjectNamespace. The ledger stores only the symbolic ref and
   *  target scope; the namespace object is never serialized.
   */
  protected provideDispatchTargets(): DispatchTargetRegistry {
    return {};
  }

  /** Register a handler fired whenever a ledger event of `kind` is written.
   *  Multiple handlers per kind compose (Set semantics). */
  protected on(kind: string, handler: EventHandler): void {
    let set = this._handlers.get(kind);
    if (set === undefined) {
      set = new Set<EventHandler>();
      this._handlers.set(kind, set);
    }
    set.add(handler);
  }

  /** Unregister a handler previously added via `on`. */
  protected off(kind: string, handler: EventHandler): void {
    const set = this._handlers.get(kind);
    if (set !== undefined) {
      set.delete(handler);
    }
  }

  submit(spec: SubmitSpec): Promise<SubmitResult> {
    const scope = this.ctx.id.name;
    if (scope === undefined) {
      return Promise.reject(new ScopeMissingError());
    }
    if (isReservedEventKind(spec.deliver.event)) {
      return Promise.reject(
        new ReservedEventKindError({ event: spec.deliver.event }),
      );
    }
    const internalSpec: InternalSubmitSpec = {
      ...spec,
      deliver: { event: spec.deliver.event, scope },
    };
    return this.runtimeFor(scope).runPromise(submitAgentEffect(internalSpec));
  }

  /** Query ledger events for this DO's scope. */
  events(opts?: EventQueryOptions): Promise<LedgerEventRpc[]> {
    const scope = this.ctx.id.name;
    if (scope === undefined) {
      return Promise.reject(new ScopeMissingError());
    }
    return this.runtimeFor(scope).runPromise(
      Effect.gen(function* () {
        const ledger = yield* Ledger;
        const rows = yield* ledger.events(scope, opts);
        return rows.map(eventToRpc);
      }),
    );
  }

  /** Stream ledger rows for this DO's scope as Server-Sent Events.
   *
   *  Wire is closed: `event: ledger`, `id: <ledger.id>`,
   *  `data: LedgerEventRpc`. Reconnect cursor is `afterId`; HTTP
   *  `Last-Event-ID` parsing belongs to the Worker fetch handler.
   */
  streamEvents(opts: StreamEventsOptions = {}): Response {
    const scope = this.ctx.id.name;
    if (scope === undefined) {
      throw new ScopeMissingError();
    }

    const afterId = normalizePositiveInteger(opts.afterId, 0);
    const heartbeatMs = Math.max(
      1,
      normalizePositiveInteger(opts.heartbeatMs, DEFAULT_STREAM_HEARTBEAT_MS),
    );
    const kinds = normalizeKinds(opts.kinds);
    const runtime = this.runtimeFor(scope);
    const encoder = new TextEncoder();

    let closed = false;
    let cleanup: (() => void) | undefined;
    let heartbeatHandle: ReturnType<typeof setInterval> | undefined;

    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        const close = (): void => {
          if (closed) return;
          closed = true;
          cleanup?.();
          if (heartbeatHandle !== undefined) {
            clearInterval(heartbeatHandle);
          }
          try {
            controller.close();
          } catch {
            // The client may have already cancelled the stream.
          }
        };

        const enqueue = (chunk: Uint8Array): void => {
          if (closed) return;
          try {
            controller.enqueue(chunk);
          } catch {
            close();
          }
        };

        try {
          runtime.runSync(
            Effect.gen(function* () {
              const bus = yield* EventBus;
              const ledger = yield* Ledger;
              let watermark = afterId;
              const liveQueue: LedgerEvent[] = [];
              let mode: "buffering" | "live" = "buffering";

              const subscription = bus.subscribe({
                kinds,
                sink: (event) => {
                  if (event.scope !== scope) return;
                  if (mode === "buffering") {
                    liveQueue.push(event);
                    return;
                  }
                  if (event.id > watermark) {
                    enqueue(encodeSseEvent(encoder, event));
                    watermark = event.id;
                  }
                },
              });
              cleanup = () => subscription.unsubscribe();

              const snapshot = yield* ledger.streamSnapshot(scope, {
                afterId,
                kinds,
              });
              for (const event of snapshot) {
                enqueue(encodeSseEvent(encoder, event));
                watermark = Math.max(watermark, event.id);
              }

              for (const event of liveQueue) {
                if (event.id > watermark) {
                  enqueue(encodeSseEvent(encoder, event));
                  watermark = event.id;
                }
              }
              liveQueue.length = 0;
              mode = "live";
            }),
          );
          heartbeatHandle = setInterval(() => {
            enqueue(encodeSseHeartbeat(encoder));
          }, heartbeatMs);
        } catch (cause) {
          cleanup?.();
          if (heartbeatHandle !== undefined) {
            clearInterval(heartbeatHandle);
          }
          closed = true;
          controller.error(cause);
        }
      },
      cancel: () => {
        closed = true;
        cleanup?.();
        if (heartbeatHandle !== undefined) {
          clearInterval(heartbeatHandle);
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      },
    });
  }

  /** Emit a ledger event NOW for this DO's scope.
   *
   *  The "app writes a fact" primitive — closes the now-write corner of the
   *  reactive surface (the algebra's left-upper that submit and scheduleEvent
   *  do NOT cover). Apps route external inputs (e.g. HTTP POST /answer) into
   *  the ledger via this method; on() handlers fire synchronously after the
   *  row commits.
   *
   *  Distinction from scheduleEvent({at: Date.now()}): scheduleEvent passes
   *  through the scheduler's pending intent buffer + alarm fire, which is
   *  asynchronous and write-amplified. emitEvent is a direct Ledger.log:
   *  the row is committed and on() handlers are invoked before this Promise
   *  resolves. They are NOT degenerate cases of each other.
   */
  emitEvent(spec: { event: string; data: unknown }): Promise<{ id: number }> {
    const scope = this.ctx.id.name;
    if (scope === undefined) {
      return Promise.reject(new ScopeMissingError());
    }
    if (isReservedEventKind(spec.event)) {
      return Promise.reject(new ReservedEventKindError({ event: spec.event }));
    }
    return this.runtimeFor(scope).runPromise(
      Effect.gen(function* () {
        const ledger = yield* Ledger;
        const ev = yield* ledger.log(spec.event, spec.data, scope);
        return { id: ev.id };
      }),
    );
  }

  /** Dispatch an app event to another AgentDOBase scope.
   *
   *  Delivery truth is split across the two ledgers:
   *  - sender records dispatch.outbound.requested and a dispatch_outbox row
   *    in one transactionSync;
   *  - receiver records dispatch.inbound.accepted + the requested app event
   *    in one transactionSync;
   *  - receiver dedupe is (sourceScope, idempotencyKey), not outboundEventId.
   */
  dispatchToScope(
    spec: DispatchToScopeSpec,
  ): Promise<DispatchToScopeResult> {
    const scope = this.ctx.id.name;
    if (scope === undefined) {
      return Promise.reject(new ScopeMissingError());
    }
    if (isReservedEventKind(spec.event)) {
      return Promise.reject(new ReservedEventKindError({ event: spec.event }));
    }
    if (this.provideDispatchTargets()[spec.target.bindingRef] === undefined) {
      return Promise.reject(
        new DispatchTargetNotFound({
          bindingRef: spec.target.bindingRef,
        }),
      );
    }
    return this.runtimeFor(scope).runPromise(
      Effect.gen(function* () {
        const dispatch = yield* Dispatch;
        return yield* dispatch.dispatchToScope(spec);
      }),
    );
  }

  grantResource(spec: ResourceGrantSpec): Promise<ResourceGrantResult> {
    const scope = this.ctx.id.name;
    if (scope === undefined) {
      return Promise.reject(new ScopeMissingError());
    }
    if (!Number.isFinite(spec.amount) || spec.amount <= 0) {
      return Promise.reject(new InvalidResourceAmount({ amount: spec.amount }));
    }
    return this.runtimeFor(scope).runPromise(
      Effect.gen(function* () {
        const resources = yield* Resources;
        return yield* resources.grant(scope, spec);
      }),
    );
  }

  reserveResource(
    spec: ResourceReserveSpec,
  ): Promise<ResourceReserveResult> {
    const scope = this.ctx.id.name;
    if (scope === undefined) {
      return Promise.reject(new ScopeMissingError());
    }
    if (!Number.isFinite(spec.amount) || spec.amount <= 0) {
      return Promise.reject(new InvalidResourceAmount({ amount: spec.amount }));
    }
    return this.runtimeFor(scope).runPromise(
      Effect.gen(function* () {
        const resources = yield* Resources;
        return yield* resources.reserve(scope, spec).pipe(Effect.either);
      }),
    ).then((result) => {
      if (result._tag === "Left") {
        return Promise.reject(result.left);
      }
      return result.right;
    });
  }

  consumeResource(spec: ResourceReservationSpec): Promise<void> {
    const scope = this.ctx.id.name;
    if (scope === undefined) {
      return Promise.reject(new ScopeMissingError());
    }
    return this.runtimeFor(scope).runPromise(
      Effect.gen(function* () {
        const resources = yield* Resources;
        return yield* resources.consume(scope, spec).pipe(Effect.either);
      }),
    ).then((result) => {
      if (result._tag === "Left") {
        return Promise.reject(result.left);
      }
    });
  }

  releaseResource(spec: ResourceReservationSpec): Promise<void> {
    const scope = this.ctx.id.name;
    if (scope === undefined) {
      return Promise.reject(new ScopeMissingError());
    }
    return this.runtimeFor(scope).runPromise(
      Effect.gen(function* () {
        const resources = yield* Resources;
        return yield* resources.release(scope, spec).pipe(Effect.either);
      }),
    ).then((result) => {
      if (result._tag === "Left") {
        return Promise.reject(result.left);
      }
    });
  }

  /** Internal RPC target for DispatchLive. Public only because DO RPC can
   *  invoke public methods; app code should use dispatchToScope instead.
   */
  __agentosReceiveDispatch(
    envelope: DispatchEnvelope,
  ): Promise<{ deliveredEventId: number }> {
    const scope = this.ctx.id.name;
    if (scope === undefined) {
      return Promise.reject(new ScopeMissingError());
    }
    if (envelope.targetScope !== scope) {
      return Promise.reject(
        new DispatchScopeMismatch({
          expected: scope,
          actual: envelope.targetScope,
        }),
      );
    }
    if (isReservedEventKind(envelope.event)) {
      return Promise.reject(
        new ReservedEventKindError({ event: envelope.event }),
      );
    }
    return this.runtimeFor(scope).runPromise(
      Effect.gen(function* () {
        const dispatch = yield* Dispatch;
        return yield* dispatch.receive(envelope);
      }),
    );
  }

  /** Schedule a future ledger event. Scope is implicit (= this DO).
   *
   *  Order: setAlarm BEFORE INSERT, so setAlarm failure leaves no orphan
   *  pending row. If INSERT fails after setAlarm succeeded, alarm fires at
   *  the target time, fireDue sees no new pending, and the alarm naturally
   *  reverts (next = whatever was there before, or null).
   */
  scheduleEvent(spec: ScheduledEventSpec): Promise<{ id: number }> {
    const scope = this.ctx.id.name;
    if (scope === undefined) {
      return Promise.reject(new ScopeMissingError());
    }
    if (!Number.isFinite(spec.at)) {
      return Promise.reject(new InvalidScheduleAt({ at: spec.at }));
    }
    if (isReservedEventKind(spec.event)) {
      return Promise.reject(
        new ReservedEventKindError({ event: spec.event }),
      );
    }
    const ctx = this.ctx;
    return this.runtimeFor(scope).runPromise(
      Effect.gen(function* () {
        const scheduler = yield* Scheduler;
        const existingNext = yield* scheduler.findNextPending();
        const target =
          existingNext === null
            ? spec.at
            : Math.min(existingNext, spec.at);
        // Arm alarm BEFORE the row is inserted. If setAlarm rejects, no
        // pending row gets created — no orphan possible.
        yield* Effect.tryPromise({
          try: () => ctx.storage.setAlarm(target),
          catch: (cause) => new SqlError({ cause }),
        });
        const { id } = yield* scheduler.schedule(
          spec.at,
          spec.event,
          spec.data,
        );
        return { id };
      }),
    );
  }

  generateImage(spec: GenerateImageSpec): Promise<ImageResult> {
    const scope = this.ctx.id.name;
    if (scope === undefined) {
      return Promise.reject(new ScopeMissingError());
    }
    return this.runtimeFor(scope).runPromise(generateImageEffect(spec));
  }

  /** DO alarm handler — invoked automatically by the CF runtime. */
  alarm(): Promise<void> {
    const scope = this.ctx.id.name;
    if (scope === undefined) {
      return Promise.reject(new ScopeMissingError());
    }
    const ctx = this.ctx;
    return this.runtimeFor(scope).runPromise(
      Effect.gen(function* () {
        const scheduler = yield* Scheduler;
        const dispatch = yield* Dispatch;
        const now = yield* Clock.currentTimeMillis;
        const scheduled = yield* scheduler.fireDue(now);
        const outbound = yield* dispatch.drainDue(now);
        const nextValues = [scheduled.next, outbound.next].filter(
          (value): value is number => value !== null,
        );
        const next =
          nextValues.length === 0 ? null : Math.min(...nextValues);
        if (next !== null) {
          yield* Effect.tryPromise({
            try: () => ctx.storage.setAlarm(next),
            catch: (cause) => new SqlError({ cause }),
          });
        }
      }).pipe(Effect.asVoid),
    );
  }
}
