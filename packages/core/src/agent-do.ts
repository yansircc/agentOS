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
 *   scheduleEvent(spec)  resolves {id}; rejects on infra
 *   alarm()              auto-invoked by CF DO runtime
 *
 * Reactive subscribe:
 *   protected on(kind, handler)  composable Set, sequential dispatch, 5s timeout per handler
 *   protected off(kind, handler) unregister
 */

import { Clock, Effect, Layer, ManagedRuntime } from "effect";
import { DurableObject } from "cloudflare:workers";
import { ScopeMissingError, SqlError } from "./errors";
import type {
  EventHandler,
  LedgerEventRpc,
  ScheduledEventSpec,
} from "./types";
import { EventBusLive } from "./event-bus";
import { Ledger, LedgerLive } from "./ledger";
import { Scheduler, SchedulerLive } from "./scheduler";
import { AiBinding } from "./llm";
import {
  type InternalSubmitSpec,
  submitAgentEffect,
  type SubmitResult,
  type SubmitSpec,
} from "./submit-agent";

export interface AgentDOEnv {
  readonly AI: Ai;
}

type CoreServices = Ledger | AiBinding | Scheduler;

const makeAgentRuntime = (
  ctx: DurableObjectState,
  scope: string,
  ai: Ai,
  handlers: Map<string, Set<EventHandler>>,
): ManagedRuntime.ManagedRuntime<CoreServices, SqlError> => {
  const sql = ctx.storage.sql;
  const eventBusLayer = EventBusLive(handlers);
  const ledgerLayer = LedgerLive(sql).pipe(Layer.provide(eventBusLayer));
  const schedulerLayer = SchedulerLive(ctx, scope).pipe(
    Layer.provide(eventBusLayer),
  );
  const aiLayer = Layer.succeed(AiBinding, ai);
  return ManagedRuntime.make(
    Layer.mergeAll(ledgerLayer, schedulerLayer, aiLayer),
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
      );
    }
    return this._runtime;
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

  /** Schedule a future ledger event. Scope is implicit (= this DO). */
  scheduleEvent(spec: ScheduledEventSpec): Promise<{ id: number }> {
    const scope = this.ctx.id.name;
    if (scope === undefined) {
      return Promise.reject(new ScopeMissingError());
    }
    const ctx = this.ctx;
    return this.runtimeFor(scope).runPromise(
      Effect.gen(function* () {
        const scheduler = yield* Scheduler;
        const { id, nextAlarmAt } = yield* scheduler.schedule(
          spec.at,
          spec.event,
          spec.data,
        );
        if (nextAlarmAt !== null) {
          yield* Effect.tryPromise({
            try: () => ctx.storage.setAlarm(nextAlarmAt),
            catch: (cause) => new SqlError({ cause }),
          });
        }
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
