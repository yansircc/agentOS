/**
 * Cloudflare Durable Object adapter.
 *
 * Scope is SSoT-owned by the DO instance.
 * SubmitSpec.deliver carries only the event name. DOs created via
 * `newUniqueId` rejects all scoped calls.
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
 * Reactive subscribe is config-owned: createAgentDurableObject({ eventHandlers })
 * receives the runtime client and construction-time extension capabilities.
 */

import { Clock, Effect, Layer, ManagedRuntime } from "effect";
import { DurableObject } from "cloudflare:workers";
import {
  CapabilityRejected,
  DispatchBindingRefMalformed,
  DispatchScopeMismatch,
  DispatchTargetNotFound,
  InvalidScheduleAt,
  InvalidResourceAmount,
  ScopeMissingError,
  SqlError,
  UnsupportedScopeRef,
} from "@agent-os/kernel/errors";
import type {
  AttemptKey,
  CapabilityLease,
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
  SubmitResult,
  SubmitSpec,
  StreamEventsOptions,
} from "@agent-os/runtime";
import {
  Admission,
  commitBoundaryEvent,
  Ledger,
  LlmTransport,
  Quota,
  submitAgentEffect,
  validateBoundaryEventPayload,
  type InternalSubmitSpec,
} from "@agent-os/runtime";
import {
  Dispatch,
  DispatchLive,
  type DispatchEnvelope,
  type DispatchTargetRegistry,
} from "./dispatch";
import { armNextDue } from "./due-work";
import {
  EventBus,
  EventBusLive,
  LedgerLive,
  createEventStreamResponse,
  eventToRpc,
} from "./ledger";
import { Scheduler, SchedulerLive } from "./scheduler";
import { Resources, ResourcesLive } from "./resources";
import { QuotaLive } from "./quota";
import { AiBinding, LlmTransportLive } from "./llm";
import { isMaterialRef, materialRefKey } from "@agent-os/kernel/material-ref";
import { AdmissionLive } from "./admission";
import {
  RefResolverLive,
  RefResolverService,
  type RefResolver,
} from "@agent-os/kernel/ref-resolver";
import {
  type BoundaryPackage,
  type ExtensionDeclaration,
  type ExtensionCapability,
  type ExtensionValidation,
  ExtensionCapabilityConflict,
  extensionOwnsEvent,
  isBoundaryPackage,
  rejectClaimedAppEvent,
  validateExtensionDeclarations,
} from "@agent-os/kernel/extensions";
import { isScopeRef, type ScopeRef } from "@agent-os/kernel/effect-claim";
import {
  projectAdmissionLease,
  projectQuotaState,
  projectResourceState,
  projectRunsPage,
  projectRunStatus,
  projectRunTrace,
  RUN_BEARING_KINDS,
} from "./projections";

export interface CloudflareAgentEnv {
  readonly AI: Ai;
}

export interface AgentRuntimeClient {
  readonly submit: (spec: SubmitSpec) => Promise<SubmitResult>;
  readonly events: (opts?: EventQueryOptions) => Promise<LedgerEventRpc[]>;
  readonly streamEvents: (opts?: StreamEventsOptions) => Response;
  readonly emitEvent: (spec: {
    readonly event: string;
    readonly data: unknown;
  }) => Promise<{ id: number }>;
  readonly dispatchToScope: (spec: DispatchToScopeSpec) => Promise<DispatchToScopeResult>;
  readonly scheduleEvent: (spec: ScheduledEventSpec) => Promise<{ id: number }>;
}

export interface AgentEventHandlerRegistration {
  readonly kind: string;
  readonly handler: EventHandler;
}

export interface AgentEventHandlerContext {
  readonly runtime: AgentRuntimeClient;
  readonly capabilities: ReadonlyMap<string, ExtensionCapability>;
}

type CoreServices =
  | Ledger
  | EventBus
  | AiBinding
  | LlmTransport
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
  const providerBaseLayer = Layer.mergeAll(aiLayer, refResolverLayer);
  const llmTransportLayer = LlmTransportLive.pipe(Layer.provide(providerBaseLayer));
  const admissionLayer = AdmissionLive(ctx).pipe(
    Layer.provide(Layer.mergeAll(eventBusLayer, providerBaseLayer)),
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
      llmTransportLayer,
      admissionLayer,
      refResolverLayer,
    ),
  );
};

export interface AgentDurableObjectConfig<Env extends CloudflareAgentEnv> {
  readonly refResolver?: (env: Env) => RefResolver;
  readonly extensions?: (env: Env) => ReadonlyArray<ExtensionDeclaration>;
  readonly dispatchTargets?: (env: Env) => DispatchTargetRegistry;
  readonly scopeRefForScope?: (scope: string, env: Env) => ScopeRef | null;
  readonly eventHandlers?: (
    context: AgentEventHandlerContext,
    env: Env,
  ) => Iterable<AgentEventHandlerRegistration>;
}

interface MaterializedAgentConfig<Env extends CloudflareAgentEnv> {
  readonly refResolver: RefResolver;
  readonly extensions: ReadonlyArray<ExtensionDeclaration>;
  readonly dispatchTargets: DispatchTargetRegistry;
  readonly scopeRefForScope: (scope: string, env: Env) => ScopeRef | null;
  readonly eventHandlers?: (
    context: AgentEventHandlerContext,
    env: Env,
  ) => Iterable<AgentEventHandlerRegistration>;
}

const emptyRefResolver: RefResolver = {
  material: () => null,
};

class AgentDurableObject<Env extends CloudflareAgentEnv>
  extends DurableObject<Env>
  implements AgentRuntimeClient
{
  private readonly _handlers: Map<string, Set<EventHandler>> = new Map();
  private readonly _refResolver: RefResolver;
  private readonly _extensionValidation: ExtensionValidation;
  private readonly _capabilities: ReadonlyMap<string, ExtensionCapability>;
  private readonly _dispatchTargets: DispatchTargetRegistry;
  private readonly _scopeRefForScope: (scope: string, env: Env) => ScopeRef | null;
  private _runtime?: ManagedRuntime.ManagedRuntime<CoreServices, SqlError>;

  constructor(ctx: DurableObjectState, env: Env, config: MaterializedAgentConfig<Env>) {
    super(ctx, env);
    this._refResolver = config.refResolver;
    this._extensionValidation = validateExtensionDeclarations(config.extensions);
    this._capabilities = this.extensionCapabilities();
    this._dispatchTargets = config.dispatchTargets;
    this._scopeRefForScope = config.scopeRefForScope;

    for (const registration of config.eventHandlers?.(
      { runtime: this, capabilities: this._capabilities },
      env,
    ) ?? []) {
      this.addHandler(registration.kind, registration.handler);
    }
  }

  private runtimeFor(scope: string): ManagedRuntime.ManagedRuntime<CoreServices, SqlError> {
    if (this._runtime === undefined) {
      this._runtime = makeAgentRuntime(
        this.ctx,
        scope,
        this.env.AI,
        this._handlers,
        this._refResolver,
        this._dispatchTargets,
      );
    }
    return this._runtime;
  }

  private extensionValidation(): ExtensionValidation {
    return this._extensionValidation;
  }

  private appWriteRejection(
    event: string,
  ): CapabilityRejected | ExtensionCapabilityConflict | null {
    const validation = this.extensionValidation();
    if (!validation.ok) return validation.error;
    return rejectClaimedAppEvent(event, validation.prefixes);
  }

  private scopeOrError(): string | ScopeMissingError {
    const scope = this.ctx.id.name;
    return scope === undefined ? new ScopeMissingError() : scope;
  }

  private scopedPromise<T>(fn: (scope: string) => Promise<T>): Promise<T> {
    const scope = this.scopeOrError();
    return scope instanceof ScopeMissingError ? Promise.reject(scope) : fn(scope);
  }

  private runScoped<T, E>(fn: (scope: string) => Effect.Effect<T, E, CoreServices>): Promise<T> {
    return this.scopedPromise((scope) => this.runtimeFor(scope).runPromise(fn(scope)));
  }

  private runScopedWrite<T, E>(
    event: string,
    fn: (scope: string) => Effect.Effect<T, E, CoreServices>,
  ): Promise<T> {
    return this.scopedPromise((scope) => {
      const rejected = this.appWriteRejection(event);
      if (rejected !== null) {
        return Promise.reject(rejected);
      }
      return this.runtimeFor(scope).runPromise(fn(scope));
    });
  }

  private extensionCapabilities(): ReadonlyMap<string, ExtensionCapability> {
    const validation = this._extensionValidation;
    const capabilities = new Map<string, ExtensionCapability>();
    if (!validation.ok) return capabilities;
    for (const declaration of validation.declarations) {
      if (isBoundaryPackage(declaration)) {
        capabilities.set(declaration.packageId, this.makeExtensionCapability(declaration));
      }
    }
    return capabilities;
  }

  private makeExtensionCapability(pkg: BoundaryPackage): ExtensionCapability {
    return {
      packageId: pkg.packageId,
      kindPrefixes: pkg.kindPrefixes,
      version: pkg.version,
      commit: (spec) => this.extensionCommit(pkg, spec.event, spec.data),
      time: (spec) => this.extensionTime(pkg, spec.at, spec.event, spec.data),
    };
  }

  private extensionCommit(
    pkg: BoundaryPackage,
    event: string,
    data: unknown,
  ): Promise<{ id: number }> {
    if (!extensionOwnsEvent(pkg, event)) {
      return Promise.reject(
        new CapabilityRejected({
          event,
          capability: `extension:${pkg.packageId}`,
        }),
      );
    }
    const rejected = validateBoundaryEventPayload(pkg.boundaryContract, event, data);
    if (rejected !== null) {
      return Promise.reject(rejected);
    }
    return this.runScoped((scope) =>
      Effect.gen(function* () {
        const ledger = yield* Ledger;
        const ev = yield* commitBoundaryEvent(pkg.boundaryContract, event, data, () =>
          ledger.log(event, data, scope),
        );
        return { id: ev.id };
      }),
    );
  }

  private extensionTime(
    pkg: BoundaryPackage,
    at: number,
    event: string,
    data: unknown,
  ): Promise<{ id: number }> {
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
    const rejected = validateBoundaryEventPayload(pkg.boundaryContract, event, data);
    if (rejected !== null) {
      return Promise.reject(rejected);
    }
    return this.runScoped((_scope) =>
      Effect.gen(function* () {
        const scheduler = yield* Scheduler;
        const { id } = yield* scheduler.schedule(at, event, data);
        return { id };
      }),
    );
  }

  private addHandler(kind: string, handler: EventHandler): void {
    let set = this._handlers.get(kind);
    if (set === undefined) {
      set = new Set<EventHandler>();
      this._handlers.set(kind, set);
    }
    set.add(handler);
  }

  submit(spec: SubmitSpec): Promise<SubmitResult> {
    return this.scopedPromise((scope) => {
      const scopeRef = this._scopeRefForScope(scope, this.env);
      if (scopeRef === null) {
        return Promise.reject(new UnsupportedScopeRef({ scopeId: scope, position: "source" }));
      }
      const rejected = this.appWriteRejection(spec.deliver.event);
      if (rejected !== null) {
        return Promise.reject(rejected);
      }
      const internalSpec: InternalSubmitSpec = {
        ...spec,
        deliver: { event: spec.deliver.event, scope, scopeRef },
      };
      return this.runtimeFor(scope).runPromise(submitAgentEffect(internalSpec));
    });
  }

  /** Query ledger events for this DO's scope. */
  events(opts?: EventQueryOptions): Promise<LedgerEventRpc[]> {
    return this.runScoped((scope) =>
      Effect.gen(function* () {
        const ledger = yield* Ledger;
        const rows = yield* ledger.events(scope, opts);
        return rows.map(eventToRpc);
      }),
    );
  }

  runTrace(runId: number | string): Promise<RunTrace> {
    return this.runScoped((scope) =>
      Effect.gen(function* () {
        const ledger = yield* Ledger;
        const rows = yield* ledger.streamSnapshot(scope);
        return projectRunTrace(rows, runId);
      }),
    );
  }

  runStatus(runId: number | string): Promise<RunStatus> {
    return this.runScoped((scope) =>
      Effect.gen(function* () {
        const ledger = yield* Ledger;
        const rows = yield* ledger.streamSnapshot(scope);
        return projectRunStatus(rows, runId);
      }),
    );
  }

  /** contract §5 standard projection — list runs scoped to this DO,
   *  sorted runId DESC (newest first). Cursor-paginated via afterRunId.
   *  Caller is responsible for bounding spec.limit. */
  runs(spec: RunListSpec): Promise<RunListPage> {
    return this.runScoped((scope) =>
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
    return this.runScoped((scope) =>
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
    return this.runScoped((scope) =>
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
    const sql = this.ctx.storage.sql;
    return this.runScoped((scope) =>
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
    const scope = this.scopeOrError();
    if (scope instanceof ScopeMissingError) {
      return new Response(JSON.stringify({ error: scope._tag }), { status: 500 });
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
    return this.runScopedWrite(spec.event, (scope) =>
      Effect.gen(function* () {
        const ledger = yield* Ledger;
        const ev = yield* ledger.log(spec.event, spec.data, scope);
        return { id: ev.id };
      }),
    );
  }

  /** Dispatch an app event to another configured agent scope.
   *
   *  Delivery truth is split across the two ledgers:
   *  - sender records dispatch.outbound.requested and a dispatch_outbox row
   *    in one transactionSync;
   *  - receiver records dispatch.inbound.accepted + the requested app event
   *    in one transactionSync;
   *  - receiver dedupe is (sourceScope, idempotencyKey), not outboundEventId.
   */
  dispatchToScope(spec: DispatchToScopeSpec): Promise<DispatchToScopeResult> {
    if (!isMaterialRef(spec.target.bindingRef) || spec.target.bindingRef.kind !== "binding") {
      return Promise.reject(new DispatchBindingRefMalformed({ position: "target" }));
    }
    const bindingKey = materialRefKey(spec.target.bindingRef);
    if (this._dispatchTargets[bindingKey] === undefined) {
      return Promise.reject(
        new DispatchTargetNotFound({
          bindingRef: bindingKey,
        }),
      );
    }
    if (!isScopeRef(spec.target.scopeRef)) {
      return Promise.reject(
        new UnsupportedScopeRef({
          scopeId: spec.target.scope,
          position: "target",
        }),
      );
    }
    return this.runScopedWrite(spec.event, (_scope) =>
      Effect.gen(function* () {
        const dispatch = yield* Dispatch;
        return yield* dispatch.dispatchToScope(spec);
      }),
    );
  }

  grantResource(spec: ResourceGrantSpec): Promise<ResourceGrantResult> {
    if (!Number.isFinite(spec.amount) || spec.amount <= 0) {
      return Promise.reject(new InvalidResourceAmount({ amount: spec.amount }));
    }
    return this.runScoped((scope) =>
      Effect.gen(function* () {
        const resources = yield* Resources;
        return yield* resources.grant(scope, spec);
      }),
    );
  }

  reserveResource(spec: ResourceReserveSpec): Promise<ResourceReserveResult> {
    if (!Number.isFinite(spec.amount) || spec.amount <= 0) {
      return Promise.reject(new InvalidResourceAmount({ amount: spec.amount }));
    }
    return this.runScoped((scope) =>
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
    return this.runScoped((scope) =>
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
    return this.runScoped((scope) =>
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
  __agentosReceiveDispatch(envelope: DispatchEnvelope): Promise<{ deliveredEventId: number }> {
    return this.scopedPromise((scope) => {
      if (envelope.targetScope !== scope) {
        return Promise.reject(
          new DispatchScopeMismatch({
            expected: scope,
            actual: envelope.targetScope,
          }),
        );
      }
      const rejected = this.appWriteRejection(envelope.event);
      if (rejected !== null) {
        return Promise.reject(rejected);
      }
      return this.runtimeFor(scope).runPromise(
        Effect.gen(function* () {
          const dispatch = yield* Dispatch;
          return yield* dispatch.receive(envelope);
        }),
      );
    });
  }

  /** Schedule a future ledger event. Scope is implicit (= this DO).
   *
   *  Order: setAlarm BEFORE INSERT, so setAlarm failure leaves no orphan
   *  pending row. If INSERT fails after setAlarm succeeded, alarm fires at
   *  the target time, fireDue sees no new pending, and the alarm naturally
   *  reverts (next = whatever was there before, or null).
   */
  scheduleEvent(spec: ScheduledEventSpec): Promise<{ id: number }> {
    if (!Number.isFinite(spec.at)) {
      return Promise.reject(new InvalidScheduleAt({ at: spec.at }));
    }
    return this.runScopedWrite(spec.event, (_scope) =>
      Effect.gen(function* () {
        const scheduler = yield* Scheduler;
        const { id } = yield* scheduler.schedule(spec.at, spec.event, spec.data);
        return { id };
      }),
    );
  }

  /** DO alarm handler — invoked automatically by the CF runtime. */
  alarm(): Promise<void> {
    const ctx = this.ctx;
    const sql = this.ctx.storage.sql;
    return this.runScoped((_scope) =>
      Effect.gen(function* () {
        const scheduler = yield* Scheduler;
        const dispatch = yield* Dispatch;
        const now = yield* Clock.currentTimeMillis;
        yield* scheduler.fireDue(now);
        yield* dispatch.drainDue(now);
        yield* armNextDue(ctx, sql);
      }).pipe(Effect.asVoid),
    );
  }
}

export const createAgentDurableObject = <Env extends CloudflareAgentEnv>(
  config: AgentDurableObjectConfig<Env> = {},
) =>
  class ConfiguredAgentDurableObject extends AgentDurableObject<Env> {
    constructor(ctx: DurableObjectState, env: Env) {
      super(ctx, env, {
        refResolver: config.refResolver?.(env) ?? emptyRefResolver,
        extensions: config.extensions?.(env) ?? [],
        dispatchTargets: config.dispatchTargets?.(env) ?? {},
        scopeRefForScope: config.scopeRefForScope ?? (() => null),
        eventHandlers: config.eventHandlers,
      });
    }
  };
