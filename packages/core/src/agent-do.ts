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
 *   emitEvent(spec)      resolves {id}; rejects on infra / capability
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
 *   protected on(kind, handler)  composable Set, sequential dispatch
 *   protected off(kind, handler) unregister
 */

import { Clock, Effect, Layer, ManagedRuntime } from "effect";
import { DurableObject } from "cloudflare:workers";
import {
  CapabilityRejected,
  DispatchScopeMismatch,
  DispatchTargetNotFound,
  InvalidScheduleAt,
  InvalidResourceAmount,
  ScopeMissingError,
  SqlError,
  UnsupportedScopeRef,
} from "./errors";
import type {
  EventHandler,
  DispatchToScopeResult,
  DispatchToScopeSpec,
  EventQueryOptions,
  LedgerEventRpc,
  QuotaState,
  QuotaStateSpec,
  ResourceGrantResult,
  ResourceGrantSpec,
  ResourceReservationSpec,
  ResourceReserveResult,
  ResourceReserveSpec,
  ResourceState,
  RunListPage,
  RunListSpec,
  RunStatus,
  RunTrace,
  ScheduledEventSpec,
  StreamEventsOptions,
} from "./types";
import {
  Dispatch,
  DispatchLive,
  type DispatchEnvelope,
  type DispatchTargetRegistry,
} from "./dispatch";
import {
  EventBus,
  EventBusLive,
  Ledger,
  LedgerLive,
  createEventStreamResponse,
  eventToRpc,
} from "./ledger";
import { Scheduler, SchedulerLive } from "./scheduler";
import { Resources, ResourcesLive } from "./resources";
import { Quota, QuotaLive } from "./quota";
import { AiBinding } from "./llm";
import { Admission, AdmissionLive, type AttemptKey, type CapabilityLease } from "./admission";
import { RefResolverLive, RefResolverService, type RefResolver } from "./ref-resolver";
import {
  type ExtensionPackage,
  type ExtensionCapability,
  type ExtensionValidation,
  ExtensionCapabilityConflict,
  extensionOwnsEvent,
  rejectClaimedAppEvent,
  validateExtensionPackages,
} from "./extensions";
import { scopeRefFromLegacyScope, type ScopeRef } from "./effect-claim";
import {
  type InternalSubmitSpec,
  submitAgentEffect,
  type SubmitResult,
  type SubmitSpec,
} from "./submit-agent";
import {
  projectAdmissionLease,
  projectQuotaState,
  projectResourceState,
  projectRunsPage,
  projectRunStatus,
  projectRunTrace,
  RUN_BEARING_KINDS,
} from "./projections";

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
  | RefResolverService;

const makeAgentRuntime = (
  ctx: DurableObjectState,
  scope: string,
  ai: Ai,
  handlers: Map<string, Set<EventHandler>>,
  refs: RefResolver,
  dispatchTargets: DispatchTargetRegistry,
): ManagedRuntime.ManagedRuntime<CoreServices, SqlError> => {
  const sql = ctx.storage.sql;
  const eventBusLayer = EventBusLive(handlers);
  const ledgerLayer = LedgerLive(sql).pipe(Layer.provide(eventBusLayer));
  const schedulerLayer = SchedulerLive(ctx, scope).pipe(Layer.provide(eventBusLayer));
  const dispatchLayer = DispatchLive(ctx, scope, dispatchTargets).pipe(
    Layer.provide(eventBusLayer),
  );
  const resourcesLayer = ResourcesLive(ctx).pipe(Layer.provide(eventBusLayer));
  const quotaLayer = QuotaLive(ctx).pipe(Layer.provide(eventBusLayer));
  const aiLayer = Layer.succeed(AiBinding, ai);
  const refResolverLayer = RefResolverLive(refs);
  const admissionLayer = AdmissionLive(ctx).pipe(Layer.provide(eventBusLayer));
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
      refResolverLayer,
    ),
  );
};

export abstract class AgentDOBase<Env extends AgentDOEnv> extends DurableObject<Env> {
  private readonly _handlers: Map<string, Set<EventHandler>> = new Map();
  private _runtime?: ManagedRuntime.ManagedRuntime<CoreServices, SqlError>;
  private _extensionValidation?: ExtensionValidation;

  private runtimeFor(scope: string): ManagedRuntime.ManagedRuntime<CoreServices, SqlError> {
    if (this._runtime === undefined) {
      this._runtime = makeAgentRuntime(
        this.ctx,
        scope,
        this.env.AI,
        this._handlers,
        this.provideRefResolver(),
        this.provideDispatchTargets(),
      );
    }
    return this._runtime;
  }

  private extensionValidation(): ExtensionValidation {
    if (this._extensionValidation === undefined) {
      this._extensionValidation = validateExtensionPackages(this.registerExtensions());
    }
    return this._extensionValidation;
  }

  private appCommitRejection(
    event: string,
  ): CapabilityRejected | ExtensionCapabilityConflict | null {
    const validation = this.extensionValidation();
    if (!validation.ok) return validation.error;
    return rejectClaimedAppEvent(event, validation.prefixes);
  }

  private registeredExtension(
    packageId: string,
  ): ExtensionPackage | CapabilityRejected | ExtensionCapabilityConflict {
    const validation = this.extensionValidation();
    if (!validation.ok) return validation.error;
    const pkg = validation.packages.find((candidate) => candidate.packageId === packageId);
    return (
      pkg ??
      new CapabilityRejected({
        event: "*",
        capability: `extension:${packageId}`,
      })
    );
  }

  private extensionCommit(
    pkg: ExtensionPackage,
    event: string,
    data: unknown,
  ): Promise<{ id: number }> {
    const scope = this.ctx.id.name;
    if (scope === undefined) {
      return Promise.reject(new ScopeMissingError());
    }
    if (!extensionOwnsEvent(pkg, event)) {
      return Promise.reject(
        new CapabilityRejected({
          event,
          capability: `extension:${pkg.packageId}`,
        }),
      );
    }
    return this.runtimeFor(scope).runPromise(
      Effect.gen(function* () {
        const ledger = yield* Ledger;
        const ev = yield* ledger.log(event, data, scope);
        return { id: ev.id };
      }),
    );
  }

  private extensionTime(
    pkg: ExtensionPackage,
    at: number,
    event: string,
    data: unknown,
  ): Promise<{ id: number }> {
    const scope = this.ctx.id.name;
    if (scope === undefined) {
      return Promise.reject(new ScopeMissingError());
    }
    if (!Number.isFinite(at)) {
      return Promise.reject(new InvalidScheduleAt({ at }));
    }
    if (!extensionOwnsEvent(pkg, event)) {
      return Promise.reject(
        new CapabilityRejected({
          event,
          capability: `extension:${pkg.packageId}`,
        }),
      );
    }
    const ctx = this.ctx;
    return this.runtimeFor(scope).runPromise(
      Effect.gen(function* () {
        const scheduler = yield* Scheduler;
        const existingNext = yield* scheduler.findNextPending();
        const target = existingNext === null ? at : Math.min(existingNext, at);
        yield* Effect.tryPromise({
          try: () => ctx.storage.setAlarm(target),
          catch: (cause) => new SqlError({ cause }),
        });
        const { id } = yield* scheduler.schedule(at, event, data);
        return { id };
      }),
    );
  }

  /** Hook for subclass to resolve symbolic endpoint / credential refs.
   *  Default = empty resolver. Apps using only `cf-ai-binding` do not
   *  override. External routes return concrete deploy-env values here;
   *  only refs are ledger-visible. */
  protected provideRefResolver(): RefResolver {
    return {
      endpoint: () => null,
      credential: () => null,
    };
  }

  /** Extension packages declare non-core namespaces here. App-facing
   *  commit paths reject these prefixes; package-owned commit helpers
   *  are intentionally not public app surface. */
  protected registerExtensions(): ReadonlyArray<ExtensionPackage> {
    return [];
  }

  /** Mint a scoped P1 capability for a registered extension package.
   *
   *  The handle can commit or defer only events under the package's declared
   *  prefixes. App-facing write paths still reject those prefixes, so a
   *  package-owned vocabulary has exactly one positive write path.
   */
  protected extensionCapability(packageId: string): ExtensionCapability {
    const pkg = this.registeredExtension(packageId);
    if (pkg instanceof CapabilityRejected) {
      throw pkg;
    }
    if (pkg instanceof ExtensionCapabilityConflict) {
      throw pkg;
    }
    return {
      packageId: pkg.packageId,
      kindPrefixes: pkg.kindPrefixes,
      version: pkg.version,
      commit: (spec) => this.extensionCommit(pkg, spec.event, spec.data),
      time: (spec) => this.extensionTime(pkg, spec.at, spec.event, spec.data),
    };
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

  /** Compatibility mapper for existing string-named DO scopes.
   *
   *  New app code should override this when scope names are not one of the
   *  spec-24 conventional prefixes. Returning null is a hard unsupported
   *  state, not a `realm` fallback.
   */
  protected scopeRefForScope(scope: string): ScopeRef | null {
    return scopeRefFromLegacyScope(scope);
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
    const scopeRef = this.scopeRefForScope(scope);
    if (scopeRef === null) {
      return Promise.reject(new UnsupportedScopeRef({ scopeId: scope, position: "source" }));
    }
    const rejected = this.appCommitRejection(spec.deliver.event);
    if (rejected !== null) {
      return Promise.reject(rejected);
    }
    const internalSpec: InternalSubmitSpec = {
      ...spec,
      deliver: { event: spec.deliver.event, scope, scopeRef },
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

  runTrace(runId: number | string): Promise<RunTrace> {
    const scope = this.ctx.id.name;
    if (scope === undefined) {
      return Promise.reject(new ScopeMissingError());
    }
    return this.runtimeFor(scope).runPromise(
      Effect.gen(function* () {
        const ledger = yield* Ledger;
        const rows = yield* ledger.streamSnapshot(scope);
        return projectRunTrace(rows, runId);
      }),
    );
  }

  runStatus(runId: number | string): Promise<RunStatus> {
    const scope = this.ctx.id.name;
    if (scope === undefined) {
      return Promise.reject(new ScopeMissingError());
    }
    return this.runtimeFor(scope).runPromise(
      Effect.gen(function* () {
        const ledger = yield* Ledger;
        const rows = yield* ledger.streamSnapshot(scope);
        return projectRunStatus(rows, runId);
      }),
    );
  }

  /** spec-34 §5 standard projection — list runs scoped to this DO,
   *  sorted runId DESC (newest first). Cursor-paginated via afterRunId.
   *  Caller is responsible for bounding spec.limit. */
  runs(spec: RunListSpec): Promise<RunListPage> {
    const scope = this.ctx.id.name;
    if (scope === undefined) {
      return Promise.reject(new ScopeMissingError());
    }
    return this.runtimeFor(scope).runPromise(
      Effect.gen(function* () {
        const ledger = yield* Ledger;
        const rows = yield* ledger.streamSnapshot(scope, {
          kinds: RUN_BEARING_KINDS,
        });
        return projectRunsPage(rows, spec);
      }),
    );
  }

  quotaState(spec: QuotaStateSpec): Promise<QuotaState> {
    const scope = this.ctx.id.name;
    if (scope === undefined) {
      return Promise.reject(new ScopeMissingError());
    }
    return this.runtimeFor(scope).runPromise(
      Effect.gen(function* () {
        const ledger = yield* Ledger;
        const rows = yield* ledger.streamSnapshot(scope, {
          kinds: ["dispatch.consumed"],
        });
        const now = yield* Clock.currentTimeMillis;
        return yield* Effect.try({
          try: () => projectQuotaState(rows, spec, now),
          catch: (cause) => new SqlError({ cause }),
        });
      }),
    );
  }

  resourceState(key: string): Promise<ResourceState> {
    const scope = this.ctx.id.name;
    if (scope === undefined) {
      return Promise.reject(new ScopeMissingError());
    }
    return this.runtimeFor(scope).runPromise(
      Effect.gen(function* () {
        const ledger = yield* Ledger;
        const rows = yield* ledger.streamSnapshot(scope, {
          kinds: [
            "resource.granted",
            "resource.reserved",
            "resource.reserve_rejected",
            "resource.consumed",
            "resource.released",
          ],
        });
        return yield* Effect.try({
          try: () => projectResourceState(rows, key),
          catch: (cause) => new SqlError({ cause }),
        });
      }),
    );
  }

  admissionLease(key: AttemptKey): Promise<CapabilityLease | null> {
    const scope = this.ctx.id.name;
    if (scope === undefined) {
      return Promise.reject(new ScopeMissingError());
    }
    const sql = this.ctx.storage.sql;
    return this.runtimeFor(scope).runPromise(
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        return yield* projectAdmissionLease(sql, scope, key, now);
      }),
    );
  }

  /** Stream ledger rows for this DO's scope as Server-Sent Events.
   *
   *  Wire is closed: `event: ledger`, `id: <ledger.id>`,
   *  `data: LedgerEventRpc`. Reconnect cursor is `afterId`; HTTP
   *  `Last-Event-ID` parsing belongs to the Worker fetch handler.
   *
   *  Implementation lives in `ledger/stream.ts`; this façade only
   *  validates scope and hands the runtime + opts through.
   */
  streamEvents(opts: StreamEventsOptions = {}): Response {
    const scope = this.ctx.id.name;
    if (scope === undefined) {
      throw new ScopeMissingError();
    }
    return createEventStreamResponse(this.runtimeFor(scope), scope, opts);
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
    const rejected = this.appCommitRejection(spec.event);
    if (rejected !== null) {
      return Promise.reject(rejected);
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
  dispatchToScope(spec: DispatchToScopeSpec): Promise<DispatchToScopeResult> {
    const scope = this.ctx.id.name;
    if (scope === undefined) {
      return Promise.reject(new ScopeMissingError());
    }
    const rejected = this.appCommitRejection(spec.event);
    if (rejected !== null) {
      return Promise.reject(rejected);
    }
    if (this.provideDispatchTargets()[spec.target.bindingRef] === undefined) {
      return Promise.reject(
        new DispatchTargetNotFound({
          bindingRef: spec.target.bindingRef,
        }),
      );
    }
    const targetScopeRef = spec.target.scopeRef ?? this.scopeRefForScope(spec.target.scope);
    if (targetScopeRef === null) {
      return Promise.reject(
        new UnsupportedScopeRef({
          scopeId: spec.target.scope,
          position: "target",
        }),
      );
    }
    const resolvedSpec: DispatchToScopeSpec = {
      ...spec,
      target: { ...spec.target, scopeRef: targetScopeRef },
    };
    return this.runtimeFor(scope).runPromise(
      Effect.gen(function* () {
        const dispatch = yield* Dispatch;
        return yield* dispatch.dispatchToScope(resolvedSpec);
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

  reserveResource(spec: ResourceReserveSpec): Promise<ResourceReserveResult> {
    const scope = this.ctx.id.name;
    if (scope === undefined) {
      return Promise.reject(new ScopeMissingError());
    }
    if (!Number.isFinite(spec.amount) || spec.amount <= 0) {
      return Promise.reject(new InvalidResourceAmount({ amount: spec.amount }));
    }
    return this.runtimeFor(scope)
      .runPromise(
        Effect.gen(function* () {
          const resources = yield* Resources;
          return yield* resources.reserve(scope, spec).pipe(Effect.either);
        }),
      )
      .then((result) => {
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
    return this.runtimeFor(scope)
      .runPromise(
        Effect.gen(function* () {
          const resources = yield* Resources;
          return yield* resources.consume(scope, spec).pipe(Effect.either);
        }),
      )
      .then((result) => {
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
    return this.runtimeFor(scope)
      .runPromise(
        Effect.gen(function* () {
          const resources = yield* Resources;
          return yield* resources.release(scope, spec).pipe(Effect.either);
        }),
      )
      .then((result) => {
        if (result._tag === "Left") {
          return Promise.reject(result.left);
        }
      });
  }

  /** Internal RPC target for DispatchLive. Public only because DO RPC can
   *  invoke public methods; app code should use dispatchToScope instead.
   */
  __agentosReceiveDispatch(envelope: DispatchEnvelope): Promise<{ deliveredEventId: number }> {
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
    const rejected = this.appCommitRejection(envelope.event);
    if (rejected !== null) {
      return Promise.reject(rejected);
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
    const rejected = this.appCommitRejection(spec.event);
    if (rejected !== null) {
      return Promise.reject(rejected);
    }
    const ctx = this.ctx;
    return this.runtimeFor(scope).runPromise(
      Effect.gen(function* () {
        const scheduler = yield* Scheduler;
        const existingNext = yield* scheduler.findNextPending();
        const target = existingNext === null ? spec.at : Math.min(existingNext, spec.at);
        // Arm alarm BEFORE the row is inserted. If setAlarm rejects, no
        // pending row gets created — no orphan possible.
        yield* Effect.tryPromise({
          try: () => ctx.storage.setAlarm(target),
          catch: (cause) => new SqlError({ cause }),
        });
        const { id } = yield* scheduler.schedule(spec.at, spec.event, spec.data);
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
        const dispatch = yield* Dispatch;
        const now = yield* Clock.currentTimeMillis;
        const scheduled = yield* scheduler.fireDue(now);
        const outbound = yield* dispatch.drainDue(now);
        const nextValues = [scheduled.next, outbound.next].filter(
          (value): value is number => value !== null,
        );
        const next = nextValues.length === 0 ? null : Math.min(...nextValues);
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
