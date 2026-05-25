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
  InvalidScheduleAt,
  isReservedEventKind,
  ReservedEventKindError,
  ScopeMissingError,
  SqlError,
} from "./errors";
import type {
  EventHandler,
  LedgerEventRpc,
  ScheduledEventSpec,
} from "./types";
import { EventBusLive } from "./event-bus";
import { Ledger, LedgerLive } from "./ledger";
import { Scheduler, SchedulerLive } from "./scheduler";
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
  | AiBinding
  | Scheduler
  | Quota
  | Admission
  | ProviderRegistry;

const makeAgentRuntime = (
  ctx: DurableObjectState,
  scope: string,
  ai: Ai,
  handlers: Map<string, Set<EventHandler>>,
  registry: ProviderRegistryConfig,
): ManagedRuntime.ManagedRuntime<CoreServices, SqlError> => {
  const sql = ctx.storage.sql;
  const eventBusLayer = EventBusLive(handlers);
  const ledgerLayer = LedgerLive(sql).pipe(Layer.provide(eventBusLayer));
  const schedulerLayer = SchedulerLive(ctx, scope).pipe(
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
      ledgerLayer,
      schedulerLayer,
      quotaLayer,
      aiLayer,
      admissionLayer,
      registryLayer,
    ),
  );
};

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
  events(): Promise<LedgerEventRpc[]> {
    const scope = this.ctx.id.name;
    if (scope === undefined) {
      return Promise.reject(new ScopeMissingError());
    }
    return this.runtimeFor(scope).runPromise(
      Effect.gen(function* () {
        const ledger = yield* Ledger;
        const rows = yield* ledger.events(scope);
        return rows.map(
          (e): LedgerEventRpc => ({
            id: e.id,
            ts: e.ts,
            kind: e.kind,
            scope: e.scope,
            payload: e.payload,
          }),
        );
      }),
    );
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
        const now = yield* Clock.currentTimeMillis;
        const { next } = yield* scheduler.fireDue(now);
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
