import type {
  DispatchToScopeResult,
  DispatchToScopeSpec,
  EventHandler,
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
} from "@agent-os/kernel/types";
/**
 * Cloudflare Durable Object adapter.
 *
 * Scope is SSoT-owned by the DO instance. DOs created via
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
 * submit() is the agent run lifecycle. It writes runtime terminal facts only.
 * emitEvent is the primitive for app facts.
 *
 * Reactive subscribe is config-owned: createAgentDurableObject({ eventHandlers })
 * receives the runtime client and construction-time extension capabilities.
 */

import { Cause, Clock, Effect, Exit, Layer, ManagedRuntime, Option } from "effect";
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
  TriggerFactoryError,
  UnsupportedScopeRef,
} from "@agent-os/kernel/errors";
import type {
  AttachedStreamCancelResult,
  AttachedStreamStartSpec,
  AnyMaterializedProjectionDefinition,
  MaterializedProjectionGetSpec,
  MaterializedProjectionListSpec,
  MaterializedProjectionRebuildResult,
  MaterializedProjectionRow,
  MaterializedProjectionStatus,
} from "@agent-os/runtime";
import type {
  AgentBindings,
  AgentManifest,
  AgentSubmitBindings,
  MountedAgent,
  AttemptKey,
  CapabilityLease,
  InternalSubmitSpec,
  SubmitResult,
  SubmitSpec,
  SubmitToolIntent,
} from "@agent-os/runtime-protocol";
import {
  Admission,
  AttachedStreams,
  DurableTriggerRegistry,
  commitBoundaryEvent,
  Ledger,
  MaterializedProjections,
  TriggerPump,
  submitAgentEffect,
  validateBoundaryEventPayload,
  type TriggerCancelResult,
  type TriggerDrainResult,
  type TriggerDrainUntilQuietOptions,
  type TriggerDrainUntilQuietResult,
} from "@agent-os/runtime";
import { LlmTransport } from "@agent-os/llm-protocol";
import { RUNTIME_FACT_OWNER } from "@agent-os/runtime-protocol";
import {
  backendProtocolEventIdentityKey,
  QUOTA_EVENT_KIND,
  RESOURCE_EVENT_KIND,
  type BackendProtocolEventIdentity,
  type BackendProtocolTruthIdentity,
  type DispatchReceiverResult,
} from "@agent-os/backend-protocol";
import { Dispatch, type DispatchEnvelope, type DispatchTargetRegistry } from "./dispatch";
import { EventBus, createEventStreamResponse, eventToRpc } from "./ledger";
import { Scheduler } from "./scheduler";
import { Resources } from "./resources";
import { MissingLlmTransportLive } from "./llm";
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
import { isScopeRef, type AuthorityRef, type ScopeRef } from "@agent-os/kernel/effect-claim";
import { projectAdmissionLease, projectQuotaState, projectResourceState } from "./projections";
import {
  projectRunsPage,
  projectRunStatus,
  projectRunTrace,
  RUN_BEARING_KINDS,
} from "@agent-os/runtime/run-projector";
import { makeCloudflareBackendCoreLayer, type CloudflareBackendCoreServices } from "./runtime-core";
import { commitDurableTriggerIntent } from "./due-work";
import type { CloudflareTriggerSource } from "./trigger-factory";
import type { CloudflareAttachedStreamSource } from "./stream-factory";
import { createAttachedStreamResponse } from "./attached-stream-wire";
import { mountCloudflareAgent } from "./mount";
import { commitLedgerTransaction } from "./ledger/commit";
import {
  cloudflareDefaultTruthIdentityFromRoutingScope,
  cloudflareRouteKeyFromScopeRef,
  cloudflareTruthIdentity,
  eventIdentity,
  LegacyLedgerSchemaError,
} from "./ledger/identity";

export interface CloudflareAgentEnv {}

export interface AgentRuntimeReaderClient {
  readonly events: (
    identity: BackendProtocolTruthIdentity,
    opts?: EventQueryOptions,
  ) => Promise<LedgerEventRpc[]>;
  readonly streamEvents: (
    identity: BackendProtocolTruthIdentity,
    opts?: StreamEventsOptions,
  ) => Response;
  readonly projectionGet: (
    spec: MaterializedProjectionGetSpec,
  ) => Promise<MaterializedProjectionRow | null>;
  readonly projectionList: (
    spec: MaterializedProjectionListSpec,
  ) => Promise<ReadonlyArray<MaterializedProjectionRow>>;
  readonly projectionStatus: (
    spec: BackendProtocolEventIdentity & { readonly kind: string },
  ) => Promise<MaterializedProjectionStatus>;
  readonly projectionRebuild: (
    spec: BackendProtocolEventIdentity & { readonly kind: string },
  ) => Promise<MaterializedProjectionRebuildResult>;
}

export interface AgentTriggerIntentSpec {
  readonly triggerKind: string;
  readonly payload: unknown;
  readonly at: number;
  readonly ts?: number;
}

export interface AgentTriggerCancelSpec {
  readonly triggerKind: string;
  readonly intentEventId: number;
  readonly reason?: string;
}

export interface AgentAttachedStreamSpec extends AttachedStreamStartSpec {}

export interface AgentAttachedStreamCancelSpec {
  readonly streamRef: string;
  readonly reason?: string;
}

export interface AgentDrainDueTestingOptions {
  readonly now?: number;
}

export interface AgentDrainUntilQuietTestingOptions extends AgentDrainDueTestingOptions {
  readonly maxIterations?: number;
}

export interface AgentRuntimeClient extends AgentRuntimeReaderClient {
  readonly emitEvent: (spec: {
    readonly event: string;
    readonly data: unknown;
  }) => Promise<{ id: number }>;
  readonly enqueueTrigger: (spec: AgentTriggerIntentSpec) => Promise<{ id: number }>;
  readonly cancelTrigger: (spec: AgentTriggerCancelSpec) => Promise<TriggerCancelResult>;
  readonly attachStream: (spec: AgentAttachedStreamSpec) => Promise<Response>;
  readonly cancelStream: (
    spec: AgentAttachedStreamCancelSpec,
  ) => Promise<AttachedStreamCancelResult>;
  readonly dispatchToScope: (spec: DispatchToScopeSpec) => Promise<DispatchToScopeResult>;
  readonly scheduleEvent: (spec: ScheduledEventSpec) => Promise<{ id: number }>;
  readonly submit: (spec: SubmitSpec) => Promise<SubmitResult>;
}

export interface AgentSubmitSpec {
  readonly intent: string;
  readonly input: unknown;
  readonly effectAuthorityRef: AuthorityRef;
  readonly bindings?: AgentSubmitBindings;
  readonly llmRouteBindingRef?: string;
  readonly system?: string;
  readonly budget?: SubmitSpec["budget"];
  readonly outputSchema?: SubmitSpec["outputSchema"];
  readonly traceContext?: SubmitSpec["traceContext"];
  readonly resume?: SubmitSpec["resume"];
}

export interface AgentDeclaredIntent {
  readonly kind: string;
  readonly boundaryPackageId: string;
}

export interface AgentEventHandlerRegistration {
  readonly kind: string;
  readonly handler: EventHandler;
}

export interface AgentEventHandlerContext<Runtime = AgentRuntimeClient> {
  readonly runtime: Runtime;
  readonly capabilities: ReadonlyMap<string, ExtensionCapability>;
}

type CoreServices = CloudflareBackendCoreServices | LlmTransport | Admission | RefResolverService;

const makeAgentRuntime = <Env extends CloudflareAgentEnv>(
  ctx: DurableObjectState,
  env: Env,
  scope: string,
  identity: BackendProtocolEventIdentity,
  handlers: Map<string, Set<EventHandler>>,
  refs: RefResolver,
  llmTransport: Layer.Layer<LlmTransport, never, RefResolverService>,
  dispatchTargets: DispatchTargetRegistry,
  appTriggers: CloudflareTriggerSource<Env>,
  appStreams: CloudflareAttachedStreamSource<Env>,
  appProjections: ReadonlyArray<AnyMaterializedProjectionDefinition>,
): ManagedRuntime.ManagedRuntime<CoreServices, SqlError | TriggerFactoryError> => {
  const backendCoreLayer = makeCloudflareBackendCoreLayer(
    ctx,
    env,
    scope,
    identity,
    handlers,
    dispatchTargets,
    appTriggers,
    appStreams,
    appProjections,
  );
  const refResolverLayer = RefResolverLive(refs);
  const llmTransportLayer = llmTransport.pipe(Layer.provide(refResolverLayer));
  const admissionLayer = AdmissionLive(ctx, identity).pipe(
    Layer.provide(Layer.mergeAll(backendCoreLayer, llmTransportLayer)),
  );
  return ManagedRuntime.make(
    Layer.mergeAll(backendCoreLayer, llmTransportLayer, admissionLayer, refResolverLayer),
  );
};

export interface AgentDurableObjectConfig<
  Env extends CloudflareAgentEnv,
  Runtime = AgentRuntimeClient,
> {
  readonly manifest?: AgentManifest;
  readonly agentBindings?: AgentBindings;
  readonly refResolver?: (env: Env) => RefResolver;
  readonly llmTransport?: (env: Env) => Layer.Layer<LlmTransport, never, RefResolverService>;
  readonly extensions?: (env: Env) => ReadonlyArray<ExtensionDeclaration>;
  readonly declaredIntents?: (env: Env) => ReadonlyArray<AgentDeclaredIntent>;
  readonly dispatchTargets?: (env: Env) => DispatchTargetRegistry;
  readonly triggers?: CloudflareTriggerSource<Env>;
  readonly streams?: CloudflareAttachedStreamSource<Env>;
  readonly projections?: ReadonlyArray<AnyMaterializedProjectionDefinition>;
  readonly scopeRefForScope?: (scope: string, env: Env) => ScopeRef | null;
  readonly eventHandlers?: (
    context: AgentEventHandlerContext<Runtime>,
    env: Env,
  ) => Iterable<AgentEventHandlerRegistration>;
}

export interface MaterializedAgentConfig<
  Env extends CloudflareAgentEnv,
  Runtime = AgentRuntimeClient,
> {
  readonly mountedAgent: MountedAgent;
  readonly refResolver: RefResolver;
  readonly llmTransport: Layer.Layer<LlmTransport, never, RefResolverService>;
  readonly extensions: ReadonlyArray<ExtensionDeclaration>;
  readonly declaredIntents: ReadonlyArray<AgentDeclaredIntent>;
  readonly dispatchTargets: DispatchTargetRegistry;
  readonly triggers: CloudflareTriggerSource<Env>;
  readonly streams: CloudflareAttachedStreamSource<Env>;
  readonly projections: ReadonlyArray<AnyMaterializedProjectionDefinition>;
  readonly scopeRefForScope: (scope: string, env: Env) => ScopeRef | null;
  readonly eventHandlers?: (
    context: AgentEventHandlerContext<Runtime>,
    env: Env,
  ) => Iterable<AgentEventHandlerRegistration>;
}

const emptyRefResolver: RefResolver = {
  material: () => null,
};

const rejectAgentConfig = (message: string): never =>
  Option.getOrThrowWith(Option.none(), () => new TypeError(message));

const mergeSubmitBindings = (
  base: AgentSubmitBindings,
  run: AgentSubmitBindings | undefined,
): AgentSubmitBindings => ({
  llmRoutes: { ...base.llmRoutes, ...run?.llmRoutes },
  tools: { ...base.tools, ...run?.tools },
  materials: { ...base.materials, ...run?.materials },
  resolvedMaterials: { ...base.resolvedMaterials, ...run?.resolvedMaterials },
  toolContext: {
    extensions: {
      ...base.toolContext?.extensions,
      ...run?.toolContext?.extensions,
    },
  },
  toolIntents: [...(base.toolIntents ?? []), ...(run?.toolIntents ?? [])],
  context: run?.context ?? base.context,
  decisionInterrupts: run?.decisionInterrupts ?? base.decisionInterrupts,
});

const declaredToolIntents = (
  extensions: ReadonlyArray<ExtensionDeclaration>,
  declaredIntents: ReadonlyArray<AgentDeclaredIntent>,
): ReadonlyArray<SubmitToolIntent> => {
  const boundaryPackages = new Map<string, BoundaryPackage>();
  for (const extension of extensions) {
    if (isBoundaryPackage(extension)) {
      boundaryPackages.set(extension.packageId, extension);
    }
  }

  return declaredIntents.map((intent) => {
    const boundaryPackage = boundaryPackages.get(intent.boundaryPackageId);
    if (boundaryPackage === undefined) {
      return rejectAgentConfig(
        `declared intent ${intent.kind} references unbound boundary package`,
      );
    }
    if (!extensionOwnsEvent(boundaryPackage, intent.kind)) {
      return rejectAgentConfig(
        `declared intent ${intent.kind} is not owned by ${intent.boundaryPackageId}`,
      );
    }
    return {
      kind: intent.kind,
      boundaryPackage,
    };
  });
};

export class AgentDurableObject<Env extends CloudflareAgentEnv, Runtime = AgentRuntimeReaderClient>
  extends DurableObject<Env>
  implements AgentRuntimeReaderClient
{
  private readonly _handlers: Map<string, Set<EventHandler>> = new Map();
  private readonly _mountedAgent: MountedAgent;
  private readonly _refResolver: RefResolver;
  private readonly _llmTransport: Layer.Layer<LlmTransport, never, RefResolverService>;
  private readonly _extensionValidation: ExtensionValidation;
  private readonly _capabilities: ReadonlyMap<string, ExtensionCapability>;
  private readonly _toolIntents: ReadonlyArray<SubmitToolIntent>;
  private readonly _dispatchTargets: DispatchTargetRegistry;
  private readonly _triggers: CloudflareTriggerSource<Env>;
  private readonly _streams: CloudflareAttachedStreamSource<Env>;
  private readonly _projections: ReadonlyArray<AnyMaterializedProjectionDefinition>;
  private readonly _scopeRefForScope: (scope: string, env: Env) => ScopeRef | null;
  private readonly _runtimes = new Map<
    string,
    ManagedRuntime.ManagedRuntime<CoreServices, SqlError | TriggerFactoryError>
  >();

  constructor(ctx: DurableObjectState, env: Env, config: MaterializedAgentConfig<Env, Runtime>) {
    super(ctx, env);
    this._mountedAgent = config.mountedAgent;
    this._refResolver = config.refResolver;
    this._llmTransport = config.llmTransport;
    this._extensionValidation = validateExtensionDeclarations(config.extensions);
    this._capabilities = this.extensionCapabilities();
    this._toolIntents = declaredToolIntents(config.extensions, config.declaredIntents);
    this._dispatchTargets = config.dispatchTargets;
    this._triggers = config.triggers;
    this._streams = config.streams;
    this._projections = config.projections;
    this._scopeRefForScope = config.scopeRefForScope;

    for (const registration of config.eventHandlers?.(
      { runtime: this as unknown as Runtime, capabilities: this._capabilities },
      env,
    ) ?? []) {
      this.addHandler(registration.kind, registration.handler);
    }
  }

  private defaultTruthIdentityForScope(
    scope: string,
  ): BackendProtocolTruthIdentity | UnsupportedScopeRef {
    const scopeRef = this._scopeRefForScope(scope, this.env);
    if (scopeRef === null) {
      return new UnsupportedScopeRef({ scopeId: scope, position: "source" });
    }
    return {
      scopeRef,
      effectAuthorityRef: { authorityClass: "effect", authorityId: scope },
    };
  }

  private defaultEventIdentityForScope(
    scope: string,
  ): BackendProtocolEventIdentity | UnsupportedScopeRef {
    const truthIdentity = this.defaultTruthIdentityForScope(scope);
    return truthIdentity instanceof UnsupportedScopeRef
      ? truthIdentity
      : eventIdentity(truthIdentity, RUNTIME_FACT_OWNER);
  }

  private runtimeFor(
    scope: string,
    identity: BackendProtocolEventIdentity,
  ): ManagedRuntime.ManagedRuntime<CoreServices, SqlError | TriggerFactoryError> {
    const key = backendProtocolEventIdentityKey(identity);
    const existing = this._runtimes.get(key);
    if (existing !== undefined) return existing;
    const created = makeAgentRuntime(
      this.ctx,
      this.env,
      scope,
      identity,
      this._handlers,
      this._refResolver,
      this._llmTransport,
      this._dispatchTargets,
      this._triggers,
      this._streams,
      this._projections,
    );
    this._runtimes.set(key, created);
    return created;
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

  private runScopedEffect<T, E>(
    scope: string,
    effect: Effect.Effect<T, E, CoreServices>,
    identity?: BackendProtocolEventIdentity,
  ): Promise<T> {
    const runtimeIdentity = identity ?? this.defaultEventIdentityForScope(scope);
    if (runtimeIdentity instanceof UnsupportedScopeRef) {
      return Promise.reject(runtimeIdentity);
    }
    return this.runtimeFor(scope, runtimeIdentity)
      .runPromiseExit(effect)
      .then((exit) => {
        if (Exit.isSuccess(exit)) return exit.value;
        const failure = Cause.failureOption(exit.cause);
        if (Option.isSome(failure)) return Promise.reject(failure.value);
        return Promise.reject(exit.cause);
      });
  }

  private runScoped<T, E>(
    fn: (
      scope: string,
      identity: BackendProtocolEventIdentity,
    ) => Effect.Effect<T, E, CoreServices>,
  ): Promise<T> {
    return this.scopedPromise((scope) => {
      const identity = this.defaultEventIdentityForScope(scope);
      if (identity instanceof UnsupportedScopeRef) {
        return Promise.reject(identity);
      }
      return this.runScopedEffect(scope, fn(scope, identity), identity);
    });
  }

  private runScopedTruth<T, E>(
    truthIdentity: BackendProtocolTruthIdentity,
    fn: (
      scope: string,
      identity: BackendProtocolEventIdentity,
    ) => Effect.Effect<T, E, CoreServices>,
  ): Promise<T> {
    return this.scopedPromise((scope) => {
      const identity = cloudflareTruthIdentity(truthIdentity, "agent runtime query identity");
      if (identity instanceof LegacyLedgerSchemaError) {
        return Promise.reject(identity);
      }
      if (cloudflareRouteKeyFromScopeRef(identity.scopeRef) !== scope) {
        return Promise.reject(
          new UnsupportedScopeRef({ scopeId: identity.scopeRef.scopeId, position: "source" }),
        );
      }
      const runtimeIdentity = eventIdentity(identity, RUNTIME_FACT_OWNER);
      return this.runScopedEffect(scope, fn(scope, runtimeIdentity), runtimeIdentity);
    });
  }

  private runScopedWrite<T, E>(
    event: string,
    fn: (
      scope: string,
      identity: BackendProtocolEventIdentity,
    ) => Effect.Effect<T, E, CoreServices>,
  ): Promise<T> {
    return this.scopedPromise((scope) => {
      const rejected = this.appWriteRejection(event);
      if (rejected !== null) {
        return Promise.reject(rejected);
      }
      const identity = this.defaultEventIdentityForScope(scope);
      if (identity instanceof UnsupportedScopeRef) {
        return Promise.reject(identity);
      }
      return this.runScopedEffect(scope, fn(scope, identity), identity);
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
    const ctx = this.ctx;
    return this.runScoped((_scope, runtimeIdentity) =>
      Effect.gen(function* () {
        const bus = yield* EventBus;
        const ev = yield* commitBoundaryEvent(pkg.boundaryContract, event, data, (identity) =>
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;
            const scopeRef = identity.scopeRef ?? runtimeIdentity.scopeRef;
            const effectAuthorityRef =
              identity.effectAuthorityRef ?? runtimeIdentity.effectAuthorityRef;
            const committed = yield* commitLedgerTransaction(
              ctx,
              bus,
              { factOwnerRef: identity.factOwnerRef },
              (tx) => {
                const ref = tx.append({
                  ts: now,
                  kind: event,
                  scopeRef,
                  effectAuthorityRef,
                  payload: data,
                });
                return ref;
              },
            );
            return committed.event(committed.value);
          }),
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

  protected submitWithBindings(
    spec: AgentSubmitSpec,
    baseBindings: AgentSubmitBindings,
  ): Promise<SubmitResult> {
    const bindings = mergeSubmitBindings(baseBindings, spec.bindings);
    const routeBindingRef = spec.llmRouteBindingRef ?? "default";
    const route = bindings.llmRoutes?.[routeBindingRef];
    if (route === undefined) {
      return Promise.reject(new TypeError(`missing llm route binding ${routeBindingRef}`));
    }
    return this.submitFull({
      intent: spec.intent,
      context: bindings.context ?? { input: spec.input },
      ...(spec.system === undefined ? {} : { system: spec.system }),
      route,
      tools: { ...bindings.tools },
      materials: { ...bindings.materials },
      resolvedMaterials: { ...bindings.resolvedMaterials },
      toolContext: bindings.toolContext,
      toolIntents: [...this._toolIntents, ...(bindings.toolIntents ?? [])],
      effectAuthorityRef: spec.effectAuthorityRef,
      ...(spec.budget === undefined ? {} : { budget: spec.budget }),
      ...(spec.outputSchema === undefined ? {} : { outputSchema: spec.outputSchema }),
      ...(spec.traceContext === undefined ? {} : { traceContext: spec.traceContext }),
      ...(bindings.decisionInterrupts === undefined
        ? {}
        : { decisionInterrupts: bindings.decisionInterrupts }),
      ...(spec.resume === undefined ? {} : { resume: spec.resume }),
    });
  }

  protected submitFull(spec: SubmitSpec): Promise<SubmitResult> {
    return this.scopedPromise((scope) => {
      const scopeRef = this._scopeRefForScope(scope, this.env);
      if (scopeRef === null) {
        return Promise.reject(new UnsupportedScopeRef({ scopeId: scope, position: "source" }));
      }
      const internalSpec: InternalSubmitSpec = {
        ...spec,
        scope,
        scopeRef,
      };
      const identity = eventIdentity(
        { scopeRef, effectAuthorityRef: spec.effectAuthorityRef },
        RUNTIME_FACT_OWNER,
      );
      return this.runtimeFor(scope, identity).runPromise(submitAgentEffect(internalSpec));
    });
  }

  /** Query ledger events for this DO's scope. */
  events(
    identity: BackendProtocolTruthIdentity,
    opts?: EventQueryOptions,
  ): Promise<LedgerEventRpc[]> {
    return this.runScopedTruth(identity, (_scope, runtimeIdentity) =>
      Effect.gen(function* () {
        const ledger = yield* Ledger;
        const rows = yield* ledger.events(runtimeIdentity, opts);
        return rows.map(eventToRpc);
      }),
    );
  }

  runTrace(runId: number | string): Promise<RunTrace> {
    return this.runScoped((_scope, identity) =>
      Effect.gen(function* () {
        const ledger = yield* Ledger;
        const rows = yield* ledger.streamSnapshot(identity);
        return yield* Effect.try({
          try: () => projectRunTrace(rows, runId),
          catch: (cause) => new SqlError({ cause }),
        });
      }),
    );
  }

  runStatus(runId: number | string): Promise<RunStatus> {
    return this.runScoped((_scope, identity) =>
      Effect.gen(function* () {
        const ledger = yield* Ledger;
        const rows = yield* ledger.streamSnapshot(identity);
        return yield* Effect.try({
          try: () => projectRunStatus(rows, runId),
          catch: (cause) => new SqlError({ cause }),
        });
      }),
    );
  }

  /** contract §5 standard projection — list runs scoped to this DO,
   *  sorted runId DESC (newest first). Cursor-paginated via afterRunId.
   *  Caller is responsible for bounding spec.limit. */
  runs(spec: RunListSpec): Promise<RunListPage> {
    return this.runScoped((_scope, identity) =>
      Effect.gen(function* () {
        const ledger = yield* Ledger;
        const rows = yield* ledger.streamSnapshot(identity, {
          kinds: RUN_BEARING_KINDS,
        });
        return yield* Effect.try({
          try: () => projectRunsPage(rows, spec),
          catch: (cause) => new SqlError({ cause }),
        });
      }),
    );
  }

  quotaState(spec: QuotaStateSpec): Promise<QuotaState> {
    return this.runScoped((_scope, identity) =>
      Effect.gen(function* () {
        const ledger = yield* Ledger;
        const rows = yield* ledger.streamSnapshot(identity, {
          kinds: [QUOTA_EVENT_KIND.CONSUMED],
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
    return this.runScoped((_scope, identity) =>
      Effect.gen(function* () {
        const ledger = yield* Ledger;
        const rows = yield* ledger.streamSnapshot(identity, {
          kinds: [
            RESOURCE_EVENT_KIND.GRANTED,
            RESOURCE_EVENT_KIND.RESERVED,
            RESOURCE_EVENT_KIND.RESERVE_REJECTED,
            RESOURCE_EVENT_KIND.CONSUMED,
            RESOURCE_EVENT_KIND.RELEASED,
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
    return this.runScoped((_scope, identity) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        return yield* projectAdmissionLease(sql, identity, identity.factOwnerRef, key, now);
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
  streamEvents(identity: BackendProtocolTruthIdentity, opts: StreamEventsOptions = {}): Response {
    const scope = this.scopeOrError();
    if (scope instanceof ScopeMissingError) {
      return new Response(JSON.stringify({ error: scope._tag }), { status: 500 });
    }
    try {
      const truthIdentity = cloudflareTruthIdentity(identity, "agent runtime stream identity");
      if (truthIdentity instanceof LegacyLedgerSchemaError) {
        return new Response(JSON.stringify({ error: truthIdentity._tag }), { status: 400 });
      }
      if (cloudflareRouteKeyFromScopeRef(truthIdentity.scopeRef) !== scope) {
        return new Response(JSON.stringify({ error: "agent_os.unsupported_scope_ref" }), {
          status: 400,
        });
      }
      const runtimeIdentity = eventIdentity(truthIdentity, RUNTIME_FACT_OWNER);
      return createEventStreamResponse(
        this.runtimeFor(scope, runtimeIdentity),
        runtimeIdentity,
        opts,
      );
    } catch (cause) {
      const tag =
        cause !== null && typeof cause === "object" && "_tag" in cause
          ? String((cause as { readonly _tag: unknown })._tag)
          : "agent_os.stream_identity_error";
      return new Response(JSON.stringify({ error: tag }), { status: 400 });
    }
  }

  projectionGet(spec: MaterializedProjectionGetSpec): Promise<MaterializedProjectionRow | null> {
    return this.runScoped(() =>
      Effect.gen(function* () {
        const projections = yield* MaterializedProjections;
        return yield* projections.get(spec);
      }),
    );
  }

  projectionList(
    spec: MaterializedProjectionListSpec,
  ): Promise<ReadonlyArray<MaterializedProjectionRow>> {
    return this.runScoped(() =>
      Effect.gen(function* () {
        const projections = yield* MaterializedProjections;
        return yield* projections.list(spec);
      }),
    );
  }

  projectionStatus(
    spec: BackendProtocolEventIdentity & { readonly kind: string },
  ): Promise<MaterializedProjectionStatus> {
    return this.runScoped(() =>
      Effect.gen(function* () {
        const projections = yield* MaterializedProjections;
        return yield* projections.status(spec);
      }),
    );
  }

  projectionRebuild(
    spec: BackendProtocolEventIdentity & { readonly kind: string },
  ): Promise<MaterializedProjectionRebuildResult> {
    return this.runScoped(() =>
      Effect.gen(function* () {
        const projections = yield* MaterializedProjections;
        return yield* projections.rebuild(spec);
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
  protected emitEventFull(spec: { event: string; data: unknown }): Promise<{ id: number }> {
    return this.runScopedWrite(spec.event, (_scope, identity) =>
      Effect.gen(function* () {
        const ledger = yield* Ledger;
        const events = yield* ledger.commit([
          {
            kind: spec.event,
            payload: spec.data,
            scopeRef: identity.scopeRef,
            effectAuthorityRef: identity.effectAuthorityRef,
          },
        ]);
        const event = events[0];
        if (event === undefined) {
          return yield* Effect.fail(
            new SqlError({ cause: new Error("ledger commit returned no emitted event") }),
          );
        }
        return { id: event.id };
      }),
    );
  }

  /** Enqueue a registered durable trigger intent.
   *
   *  This is the public projection of `commitDurableTriggerIntent`: registry
   *  lookup happens before any ledger/due/alarm write, and the intent event
   *  kind is owned by the registered trigger value.
   */
  protected enqueueTriggerFull(spec: AgentTriggerIntentSpec): Promise<{ id: number }> {
    if (!Number.isFinite(spec.at)) {
      return Promise.reject(new InvalidScheduleAt({ at: spec.at }));
    }
    const ctx = this.ctx;
    const sql = ctx.storage.sql;
    return this.runScoped((_scope, identity) =>
      Effect.gen(function* () {
        yield* Ledger;
        yield* TriggerPump;
        const bus = yield* EventBus;
        const registry = yield* DurableTriggerRegistry;
        const ts = spec.ts ?? (yield* Clock.currentTimeMillis);
        const intent = yield* commitDurableTriggerIntent(
          ctx,
          sql,
          bus,
          identity,
          spec.at,
          registry,
          spec.triggerKind,
          (tx, trigger) =>
            tx.append({
              ts,
              kind: trigger.intentEventKind,
              scopeRef: identity.scopeRef,
              effectAuthorityRef: identity.effectAuthorityRef,
              payload: spec.payload,
            }),
        );
        return { id: intent.id };
      }),
    );
  }

  protected cancelTriggerFull(spec: AgentTriggerCancelSpec): Promise<TriggerCancelResult> {
    return this.runScoped(() =>
      Effect.gen(function* () {
        const triggerPump = yield* TriggerPump;
        return yield* triggerPump.cancelTrigger(spec);
      }),
    );
  }

  protected attachStreamFull(spec: AgentAttachedStreamSpec): Promise<Response> {
    return this.scopedPromise((scope) => {
      const runStreamEffect = <T, E>(effect: Effect.Effect<T, E, CoreServices>): Promise<T> =>
        this.runScopedEffect(scope, effect);
      return this.runScopedEffect(
        scope,
        Effect.gen(function* () {
          const streams = yield* AttachedStreams;
          const session = yield* streams.attach(spec);
          return createAttachedStreamResponse(session, runStreamEffect);
        }),
      );
    });
  }

  protected cancelStreamFull(
    spec: AgentAttachedStreamCancelSpec,
  ): Promise<AttachedStreamCancelResult> {
    return this.runScoped(() =>
      Effect.gen(function* () {
        const streams = yield* AttachedStreams;
        return yield* streams.cancelStream(spec);
      }),
    );
  }

  /** Testing-only deterministic drain primitive.
   *
   *  Production drain is alarm-owned. Package-local test fixtures may expose
   *  this protected primitive through ugly RPC names for synchronous smoke
   *  tests; it is not a public package subpath.
   */
  protected drainDueOnceForTestingFull(
    options: AgentDrainDueTestingOptions = {},
  ): Promise<TriggerDrainResult> {
    return this.runScoped((_scope) =>
      Effect.gen(function* () {
        const triggerPump = yield* TriggerPump;
        const now = options.now ?? (yield* Clock.currentTimeMillis);
        return yield* triggerPump.drainDue(now);
      }),
    );
  }

  /** Testing-only deterministic drain loop; production drain remains alarm-owned. */
  protected drainUntilQuietForTestingFull(
    options: AgentDrainUntilQuietTestingOptions = {},
  ): Promise<TriggerDrainUntilQuietResult> {
    return this.runScoped((_scope) =>
      Effect.gen(function* () {
        const triggerPump = yield* TriggerPump;
        const now = options.now ?? (yield* Clock.currentTimeMillis);
        const pumpOptions: TriggerDrainUntilQuietOptions =
          options.maxIterations === undefined ? {} : { maxIterations: options.maxIterations };
        return yield* triggerPump.drainUntilQuiet(now, pumpOptions);
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
  protected dispatchToScopeFull(spec: DispatchToScopeSpec): Promise<DispatchToScopeResult> {
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
    const targetScopeRef: unknown = spec.target.scopeRef;
    if (!isScopeRef(targetScopeRef)) {
      return Promise.reject(
        new UnsupportedScopeRef({
          scopeId: "malformed",
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
    return this.runScoped((_scope, identity) =>
      Effect.gen(function* () {
        const resources = yield* Resources;
        return yield* resources.grant(identity, spec);
      }),
    );
  }

  reserveResource(spec: ResourceReserveSpec): Promise<ResourceReserveResult> {
    if (!Number.isFinite(spec.amount) || spec.amount <= 0) {
      return Promise.reject(new InvalidResourceAmount({ amount: spec.amount }));
    }
    return this.runScoped((_scope, identity) =>
      Effect.gen(function* () {
        const resources = yield* Resources;
        return yield* resources.reserve(identity, spec).pipe(Effect.either);
      }),
    ).then((result) => {
      if (result._tag === "Left") {
        return Promise.reject(result.left);
      }
      return result.right;
    });
  }

  consumeResource(spec: ResourceReservationSpec): Promise<void> {
    return this.runScoped((_scope, identity) =>
      Effect.gen(function* () {
        const resources = yield* Resources;
        return yield* resources.consume(identity, spec).pipe(Effect.either);
      }),
    ).then((result) => {
      if (result._tag === "Left") {
        return Promise.reject(result.left);
      }
    });
  }

  releaseResource(spec: ResourceReservationSpec): Promise<void> {
    return this.runScoped((_scope, identity) =>
      Effect.gen(function* () {
        const resources = yield* Resources;
        return yield* resources.release(identity, spec).pipe(Effect.either);
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
  __agentosReceiveDispatch(envelope: DispatchEnvelope): Promise<DispatchReceiverResult> {
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
      const identity = this.defaultEventIdentityForScope(scope);
      if (identity instanceof UnsupportedScopeRef) {
        return Promise.reject(identity);
      }
      return this.runtimeFor(scope, identity).runPromise(
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
   *  the target time, the trigger pump sees no new pending row, and the alarm
   *  naturally reverts (next = whatever was there before, or null).
   */
  protected scheduleEventFull(spec: ScheduledEventSpec): Promise<{ id: number }> {
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
    return this.runScoped((_scope) =>
      Effect.gen(function* () {
        const triggerPump = yield* TriggerPump;
        const now = yield* Clock.currentTimeMillis;
        yield* triggerPump.drainDue(now);
      }).pipe(Effect.asVoid),
    );
  }
}

export const createAgentDurableObject = <Env extends CloudflareAgentEnv>(
  config: AgentDurableObjectConfig<Env> = {},
) =>
  class ConfiguredAgentDurableObject
    extends AgentDurableObject<Env, AgentRuntimeClient>
    implements AgentRuntimeClient
  {
    constructor(ctx: DurableObjectState, env: Env) {
      super(ctx, env, {
        mountedAgent: mountCloudflareAgent(config.manifest, config.agentBindings),
        refResolver: config.refResolver?.(env) ?? emptyRefResolver,
        llmTransport: config.llmTransport?.(env) ?? MissingLlmTransportLive,
        extensions: config.extensions?.(env) ?? [],
        declaredIntents: config.declaredIntents?.(env) ?? [],
        dispatchTargets: config.dispatchTargets?.(env) ?? {},
        triggers: config.triggers ?? [],
        streams: config.streams ?? [],
        projections: config.projections ?? [],
        scopeRefForScope:
          config.scopeRefForScope ??
          ((scope) => cloudflareDefaultTruthIdentityFromRoutingScope(scope).scopeRef),
        eventHandlers: config.eventHandlers,
      });
    }

    submit(spec: SubmitSpec): Promise<SubmitResult> {
      return this.submitFull(spec);
    }

    emitEvent(spec: { event: string; data: unknown }): Promise<{ id: number }> {
      return this.emitEventFull(spec);
    }

    enqueueTrigger(spec: AgentTriggerIntentSpec): Promise<{ id: number }> {
      return this.enqueueTriggerFull(spec);
    }

    cancelTrigger(spec: AgentTriggerCancelSpec): Promise<TriggerCancelResult> {
      return this.cancelTriggerFull(spec);
    }

    attachStream(spec: AgentAttachedStreamSpec): Promise<Response> {
      return this.attachStreamFull(spec);
    }

    cancelStream(spec: AgentAttachedStreamCancelSpec): Promise<AttachedStreamCancelResult> {
      return this.cancelStreamFull(spec);
    }

    dispatchToScope(spec: DispatchToScopeSpec): Promise<DispatchToScopeResult> {
      return this.dispatchToScopeFull(spec);
    }

    scheduleEvent(spec: ScheduledEventSpec): Promise<{ id: number }> {
      return this.scheduleEventFull(spec);
    }
  };
