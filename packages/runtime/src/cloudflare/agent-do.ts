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
} from "@agent-os/core/types";
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
  ScopeMissingError,
  SqlError,
  TriggerFactoryError,
  UnsupportedScopeRef,
} from "@agent-os/core/errors";
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
  AgentManifestProjection,
  AgentSubmitBindings,
  AttemptKey,
  CapabilityLease,
  SubmitResult,
  SubmitRunInput,
  SubmitSpec,
  SubmitToolIntent,
} from "@agent-os/core/runtime-protocol";
import {
  AttachedStreams,
  Dispatch,
  DurableTriggerRegistry,
  BoundaryEvents,
  commitBoundaryEvent,
  Ledger,
  MaterializedProjections,
  Resources,
  TriggerPump,
  recordLedgerPortEvent,
  runWorkspaceJobEffect,
  runtimeStorageOrJsonError,
  validateBoundaryEventPayload,
  type RunWorkspaceJobSpec,
  type RuntimeStorageError,
  type TriggerCancelResult,
  type TriggerDrainResult,
  type TriggerDrainUntilQuietOptions,
  type TriggerDrainUntilQuietResult,
} from "@agent-os/runtime";
import { submitAgentEffect, type SubmitAgentProductLink } from "../submit-agent";
import type { ScheduleFireDeliveryDispatchResult, ScheduleFireDispatchResult } from "../schedule";
import { LlmTransport } from "@agent-os/core/llm-protocol";
import {
  agentRunAbortedEvent,
  lowerSubmitRunInput,
  manifestTruthIdentity,
  RUNTIME_FACT_OWNER,
  submitResumeDecisionFromInputRequestRef,
} from "@agent-os/core/runtime-protocol";
import { ABORT, type AbortKind } from "@agent-os/core/abort";
import {
  backendProtocolEventIdentityKey,
  QUOTA_EVENT_KIND,
  RESOURCE_EVENT_KIND,
  type BackendProtocolEventIdentity,
  type BackendProtocolTruthIdentity,
  type DispatchEnvelope,
  type DispatchReceiverResult,
} from "@agent-os/core/backend-protocol";
import { type DispatchTargetRegistry } from "./dispatch/dispatch";
import { EventBus } from "./ledger/event-bus";
import { eventToRpc } from "./ledger/ledger";
import { createEventStreamResponse } from "./ledger/stream";
import { Scheduler } from "./scheduler";
import { isMaterialRef, materialRefKey } from "@agent-os/core/material-ref";
import { RefResolverService, type RefResolver } from "@agent-os/core/ref-resolver";
import {
  type BoundaryPackage,
  type ExtensionCapability,
  type ExtensionValidation,
  ExtensionCapabilityConflict,
  extensionOwnsEvent,
  isBoundaryPackage,
  rejectClaimedAppEvent,
  validateExtensionDeclarations,
} from "@agent-os/core/extensions";
import { isScopeRef, scopeRefKey } from "@agent-os/core/effect-claim";
import type {
  WorkspaceAgentDecideInputRequestCommandInput,
  WorkspaceAgentResumeInputRequestCommandInput,
} from "@agent-os/core/workspace-agent";
import { projectAdmissionLease, projectQuotaState, projectResourceState } from "./projections";
import {
  projectRunsPage,
  projectRunStatus,
  projectRunTrace,
  projectSubmitResult,
  RUN_BEARING_KINDS,
} from "@agent-os/runtime/run-projector";
import type { WorkspaceJobProjection } from "../workspace-job-carrier";
import { commitDurableTriggerIntent } from "./due-work";
import type { CloudflareTriggerSource } from "./trigger-factory";
import type { CloudflareAttachedStreamSource } from "./stream-factory";
import { createAttachedStreamResponse } from "./attached-stream-wire";
import { DURABLE_OBJECT_RPC_INVOKE, durableObjectRpcInvoke } from "./do-rpc";
import type { CloudflareAgentMount } from "./mount";
import {
  materializeCloudflareAgentConfig,
  type AgentDurableObjectConfig,
  type CloudflareAgentEnv,
  type MaterializedAgentConfig,
} from "./deployment";
import type { ResolvedRuntimeGraphStatus } from "../runtime-graph-status";
import { commitLedgerTransaction } from "./ledger/commit";
import {
  cloudflareDefaultTruthIdentityFromRoutingScope,
  cloudflareRouteKeyFromScopeRef,
  cloudflareTruthIdentity,
  CloudflareLedgerSchemaError,
  eventIdentity,
} from "./ledger/identity";
import {
  DECISION_GATE_KIND,
  decisionGateBoundaryContract,
  decisionGateSettlementRef,
  projectDecisionGate,
} from "../decision-gate";
import { projectInputRequest } from "../input-request";
import {
  chatInputForResume,
  declaredToolIntents,
  errorTagFromCause,
  invalidResourceAmount,
  jsonErrorResponse,
  lowerAgentSubmitSpec,
  makeAgentRuntime,
  promiseFromEffectResult,
  scopedInternalSubmitSpec,
  type CoreServices,
} from "./agent-do-helpers";

export interface AgentRuntimeReaderClient {
  readonly info: () => Promise<AgentManifestProjection>;
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
  readonly submit: (spec: AgentSubmitSpec) => Promise<SubmitResult>;
  readonly resumeInputRequest: (
    spec: WorkspaceAgentResumeInputRequestCommandInput,
  ) => Promise<SubmitResult>;
  readonly decideInputRequest: (
    spec: WorkspaceAgentDecideInputRequestCommandInput,
  ) => Promise<SubmitResult>;
  readonly runWorkspaceJob: (spec: AgentWorkspaceJobSpec) => Promise<WorkspaceJobProjection>;
}

export type AgentWorkspaceJobSpec = Omit<RunWorkspaceJobSpec, "scope" | "identity">;

export interface AgentSubmitSpec {
  readonly intent: string;
  readonly input: unknown;
  readonly llmRouteBindingRef?: string;
  readonly context?: Record<string, unknown>;
  readonly system?: string;
  readonly budget?: SubmitSpec["budget"];
  readonly outputSchema?: SubmitSpec["outputSchema"];
  readonly traceContext?: SubmitSpec["traceContext"];
  readonly dynamicCapability?: SubmitRunInput["dynamicCapability"];
  readonly materials?: SubmitRunInput["materials"];
  readonly toolContext?: SubmitRunInput["toolContext"];
  readonly toolPolicy?: SubmitSpec["toolPolicy"];
  readonly decisionInterrupts?: SubmitRunInput["decisionInterrupts"];
  readonly resume?: SubmitSpec["resume"];
}

export class AgentDurableObject<Env extends CloudflareAgentEnv, Runtime = AgentRuntimeReaderClient>
  extends DurableObject<Env>
  implements AgentRuntimeReaderClient
{
  private readonly _handlers: Map<string, Set<EventHandler>> = new Map();
  protected readonly _mount: CloudflareAgentMount;
  private readonly _refResolver: RefResolver;
  private readonly _llmTransport: Layer.Layer<LlmTransport, never, RefResolverService>;
  private readonly _extensionValidation: ExtensionValidation;
  private readonly _capabilities: ReadonlyMap<string, ExtensionCapability>;
  private readonly _toolIntents: ReadonlyArray<SubmitToolIntent>;
  private readonly _dispatchTargets: DispatchTargetRegistry;
  private readonly _triggers: CloudflareTriggerSource<Env>;
  private readonly _streams: CloudflareAttachedStreamSource<Env>;
  private readonly _projections: ReadonlyArray<AnyMaterializedProjectionDefinition>;
  private readonly _graphStatus?: ResolvedRuntimeGraphStatus;
  private readonly _runtimes = new Map<
    string,
    ManagedRuntime.ManagedRuntime<
      CoreServices,
      SqlError | TriggerFactoryError | RuntimeStorageError
    >
  >();

  constructor(ctx: DurableObjectState, env: Env, config: MaterializedAgentConfig<Env, Runtime>) {
    super(ctx, env);
    this._mount = config.mount;
    this._refResolver = config.refResolver;
    this._llmTransport = config.llmTransport;
    this._extensionValidation = validateExtensionDeclarations(config.extensions);
    this._capabilities = this.extensionCapabilities();
    this._toolIntents = declaredToolIntents(config.extensions, config.declaredIntents);
    this._dispatchTargets = config.dispatchTargets;
    this._triggers = config.triggers;
    this._streams = config.streams;
    this._projections = config.mount.projectionSinks.materialized;
    this._graphStatus = config.graphStatus;

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
    const manifest = this._mount.driverConfig.manifest;
    if (manifest.scope.idSource === "manifest") {
      const identity = manifestTruthIdentity(manifest);
      return cloudflareRouteKeyFromScopeRef(identity.scopeRef) === scope
        ? identity
        : new UnsupportedScopeRef({ scopeId: identity.scopeRef.scopeId, position: "source" });
    }
    if (manifest.scope.idSource === "extension") {
      return new UnsupportedScopeRef({ scopeId: scope, position: "source" });
    }
    return cloudflareDefaultTruthIdentityFromRoutingScope(scope, manifest.scope.kind);
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
  ): ManagedRuntime.ManagedRuntime<
    CoreServices,
    SqlError | TriggerFactoryError | RuntimeStorageError
  > {
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

  [DURABLE_OBJECT_RPC_INVOKE](
    method: string,
    args: ReadonlyArray<unknown>,
  ): ReturnType<typeof durableObjectRpcInvoke> {
    return durableObjectRpcInvoke(
      this as unknown as Readonly<Record<string, unknown>>,
      method,
      args,
    );
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
        const failure = Cause.findErrorOption(exit.cause);
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
      if (identity instanceof CloudflareLedgerSchemaError) {
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
        capabilities.set(declaration.ownerId, this.makeExtensionCapability(declaration));
      }
    }
    return capabilities;
  }

  private makeExtensionCapability(pkg: BoundaryPackage): ExtensionCapability {
    return {
      ownerId: pkg.ownerId,
      sourcePackageName: pkg.sourcePackageName,
      kindPrefixes: pkg.kindPrefixes,
      version: pkg.version,
      commit: (spec) => this.extensionCommit(pkg, spec.event, spec.data),
      time: (spec) => this.extensionTime(pkg, spec.at, spec.event, spec.data),
    };
  }

  info(): Promise<AgentManifestProjection> {
    return Promise.resolve(this._mount.projectionSinks.info);
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
          capability: `extension:${pkg.ownerId}`,
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
            ).pipe(Effect.mapError((cause) => runtimeStorageOrJsonError("boundary_event", cause)));
            return yield* recordLedgerPortEvent("boundary_event", committed.event(committed.value));
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
          capability: `extension:${pkg.ownerId}`,
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
    return this.submitWithBindingsAndProductLink(spec, baseBindings);
  }

  protected submitWithBindingsAndProductLink(
    spec: AgentSubmitSpec,
    baseBindings: AgentSubmitBindings,
    productLink?: SubmitAgentProductLink,
  ): Promise<SubmitResult> {
    return this.scopedPromise((scope) => {
      const truthIdentity = this.defaultTruthIdentityForScope(scope);
      if (truthIdentity instanceof UnsupportedScopeRef) {
        return Promise.reject(truthIdentity);
      }
      try {
        return this.submitFullScoped(
          scope,
          truthIdentity,
          lowerAgentSubmitSpec(
            spec,
            baseBindings,
            this._toolIntents,
            truthIdentity.effectAuthorityRef,
          ),
          productLink,
        );
      } catch (cause) {
        return Promise.reject(cause);
      }
    });
  }

  protected resumeInputRequestWithBindings(
    spec: WorkspaceAgentResumeInputRequestCommandInput,
    baseBindings: AgentSubmitBindings,
  ): Promise<SubmitResult> {
    return this.scopedPromise((scope) => {
      const truthIdentity = this.defaultTruthIdentityForScope(scope);
      if (truthIdentity instanceof UnsupportedScopeRef) {
        return Promise.reject(truthIdentity);
      }
      if (scopeRefKey(spec.ref.scopeRef) !== scopeRefKey(truthIdentity.scopeRef)) {
        return Promise.reject(
          new UnsupportedScopeRef({ scopeId: scopeRefKey(spec.ref.scopeRef), position: "source" }),
        );
      }
      const runtimeIdentity = eventIdentity(truthIdentity, RUNTIME_FACT_OWNER);
      return this.runScopedEffect(
        scope,
        Effect.gen(function* () {
          const ledger = yield* Ledger;
          const boundaryEvents = yield* BoundaryEvents;
          const events = yield* ledger.events(runtimeIdentity);
          const chatInput = chatInputForResume(events, spec.ref);
          if (chatInput === null) {
            return yield* Effect.fail(
              new TypeError("input request resume missing original chat input"),
            );
          }
          const gate = projectDecisionGate(events, spec.ref.gateRef);
          const inputRequest = projectInputRequest(events, spec.ref);
          if (gate.status === "requested" && inputRequest.status === "pending") {
            yield* boundaryEvents.commit(decisionGateBoundaryContract, DECISION_GATE_KIND.DECIDED, {
              gateRef: spec.ref.gateRef,
              decisionRef: spec.answer.decisionRef,
              decision: "approved",
              decidedBy: spec.decidedBy,
            });
          } else if (
            (gate.status === "approved" || gate.status === "consumed") &&
            gate.decision?.decisionRef === spec.answer.decisionRef
          ) {
            // Idempotent retry after DECIDED was persisted but before/while submit resumed.
          } else {
            return yield* Effect.fail(
              new TypeError(`input request is not resumable: ${gate.status}`),
            );
          }
          return chatInput;
        }),
        runtimeIdentity,
      ).then((chatInput) =>
        this.submitFullScoped(
          scope,
          truthIdentity,
          lowerSubmitRunInput({
            input: {
              intent: chatInput.intent,
              context: chatInput.context,
              resume: submitResumeDecisionFromInputRequestRef(spec.ref, spec.answer),
            },
            bindings: baseBindings,
            effectAuthorityRef: truthIdentity.effectAuthorityRef,
          }),
        ),
      );
    });
  }

  protected decideInputRequestWithBindings(
    spec: WorkspaceAgentDecideInputRequestCommandInput,
    baseBindings: AgentSubmitBindings,
  ): Promise<SubmitResult> {
    if (spec.decision.kind === "approved") {
      return this.resumeInputRequestWithBindings(
        {
          ref: spec.ref,
          decidedBy: spec.decision.decidedBy,
          answer: spec.decision.answer,
        },
        baseBindings,
      );
    }
    return this.closeInputRequest(spec);
  }

  private closeInputRequest(
    spec: WorkspaceAgentDecideInputRequestCommandInput,
  ): Promise<SubmitResult> {
    const closeDecision = spec.decision;
    if (closeDecision.kind === "approved") {
      return Promise.reject(new TypeError("approved input requests must resume"));
    }
    return this.scopedPromise((scope) => {
      const truthIdentity = this.defaultTruthIdentityForScope(scope);
      if (truthIdentity instanceof UnsupportedScopeRef) {
        return Promise.reject(truthIdentity);
      }
      if (scopeRefKey(spec.ref.scopeRef) !== scopeRefKey(truthIdentity.scopeRef)) {
        return Promise.reject(
          new UnsupportedScopeRef({ scopeId: scopeRefKey(spec.ref.scopeRef), position: "source" }),
        );
      }
      const runtimeIdentity = eventIdentity(truthIdentity, RUNTIME_FACT_OWNER);
      return this.runScopedEffect(
        scope,
        Effect.gen(function* () {
          const ledger = yield* Ledger;
          const boundaryEvents = yield* BoundaryEvents;
          const events = yield* ledger.events(runtimeIdentity);
          const gate = projectDecisionGate(events, spec.ref.gateRef);
          const inputRequest = projectInputRequest(events, spec.ref);
          const resultFromLedger = () => {
            const result = projectSubmitResult(events, spec.ref.runId);
            return result === null
              ? Effect.fail(new TypeError("input request close missing terminal run fact"))
              : Effect.succeed(result);
          };
          const sameTerminal =
            (closeDecision.kind === "rejected" &&
              gate.status === "rejected" &&
              gate.decision?.decisionRef === closeDecision.decisionRef) ||
            (closeDecision.kind === "cancelled" &&
              gate.status === "cancelled" &&
              gate.cancelled?.closeRef === closeDecision.closeRef) ||
            (closeDecision.kind === "expired" &&
              gate.status === "expired" &&
              gate.expired?.closeRef === closeDecision.closeRef);
          if (sameTerminal) {
            return yield* resultFromLedger();
          }
          if (gate.status !== "requested" || inputRequest.status !== "pending") {
            return yield* Effect.fail(
              new TypeError(`input request terminal conflict: ${gate.status}`),
            );
          }
          const terminal =
            closeDecision.kind === "rejected"
              ? {
                  event: DECISION_GATE_KIND.DECIDED,
                  payload: {
                    gateRef: spec.ref.gateRef,
                    decisionRef: closeDecision.decisionRef,
                    decision: "rejected",
                    decidedBy: closeDecision.decidedBy,
                    reason: closeDecision.reason ?? "rejected",
                    rejectionRef: {
                      rejectionId: decisionGateSettlementRef(
                        "rejected",
                        spec.ref.gateRef,
                        closeDecision.decisionRef,
                      ),
                      rejectionKind: "policy_denied",
                      reason: closeDecision.reason ?? "rejected",
                    },
                  },
                  abortKind: ABORT.DECISION_REJECTED,
                  terminalRef: closeDecision.decisionRef,
                  reason: "rejected",
                }
              : closeDecision.kind === "cancelled"
                ? {
                    event: DECISION_GATE_KIND.CANCELLED,
                    payload: {
                      gateRef: spec.ref.gateRef,
                      closeRef: closeDecision.closeRef,
                      reason: closeDecision.reason ?? "cancelled",
                    },
                    abortKind: ABORT.DECISION_CANCELLED,
                    terminalRef: closeDecision.closeRef,
                    reason: "cancelled",
                  }
                : {
                    event: DECISION_GATE_KIND.EXPIRED,
                    payload: {
                      gateRef: spec.ref.gateRef,
                      closeRef: closeDecision.closeRef,
                      reason: closeDecision.reason ?? "expired",
                    },
                    abortKind: ABORT.DECISION_EXPIRED,
                    terminalRef: closeDecision.closeRef,
                    reason: "expired",
                  };
          yield* boundaryEvents.commitWithRuntimeEvents(
            decisionGateBoundaryContract,
            terminal.event,
            terminal.payload,
            () => [
              agentRunAbortedEvent({
                scopeRef: runtimeIdentity.scopeRef,
                effectAuthorityRef: runtimeIdentity.effectAuthorityRef,
                kind: terminal.abortKind as AbortKind,
                runId: spec.ref.runId,
                tokensUsed: inputRequest.interruption.payload.tokensUsed,
                payload: {
                  reason: terminal.reason,
                  gateRef: spec.ref.gateRef,
                  terminalRef: terminal.terminalRef,
                },
                traceContext: inputRequest.interruption.payload.traceContext,
              }),
            ],
          );
          const nextEvents = yield* ledger.events(runtimeIdentity);
          const result = projectSubmitResult(nextEvents, spec.ref.runId);
          return result === null
            ? yield* Effect.fail(new TypeError("input request close missing terminal run fact"))
            : result;
        }),
        runtimeIdentity,
      );
    });
  }

  protected submitFull(spec: SubmitSpec): Promise<SubmitResult> {
    return this.scopedPromise((scope) => {
      const truthIdentity = this.defaultTruthIdentityForScope(scope);
      if (truthIdentity instanceof UnsupportedScopeRef) {
        return Promise.reject(truthIdentity);
      }
      return this.submitFullScoped(scope, truthIdentity, spec);
    });
  }

  private submitFullScoped(
    scope: string,
    truthIdentity: BackendProtocolTruthIdentity,
    spec: SubmitSpec,
    productLink?: SubmitAgentProductLink,
  ): Promise<SubmitResult> {
    const { identity, internalSpec } = scopedInternalSubmitSpec(
      scope,
      truthIdentity,
      spec,
      this._graphStatus,
    );
    return this.runtimeFor(scope, identity).runPromise(
      submitAgentEffect(internalSpec, productLink === undefined ? {} : { productLink }),
    );
  }

  protected runWorkspaceJobFull(spec: AgentWorkspaceJobSpec): Promise<WorkspaceJobProjection> {
    return this.scopedPromise((scope) => {
      const truthIdentity = this.defaultTruthIdentityForScope(scope);
      if (truthIdentity instanceof UnsupportedScopeRef) {
        return Promise.reject(truthIdentity);
      }
      const runtimeIdentity = eventIdentity(truthIdentity, RUNTIME_FACT_OWNER);
      return this.runScopedEffect(
        scope,
        runWorkspaceJobEffect({
          ...spec,
          scope,
          identity: truthIdentity,
        }),
        runtimeIdentity,
      );
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
      return jsonErrorResponse(scope._tag, 500);
    }
    try {
      const truthIdentity = cloudflareTruthIdentity(identity, "agent runtime stream identity");
      if (truthIdentity instanceof CloudflareLedgerSchemaError) {
        return jsonErrorResponse(truthIdentity._tag, 400);
      }
      if (cloudflareRouteKeyFromScopeRef(truthIdentity.scopeRef) !== scope) {
        return jsonErrorResponse("agent_os.unsupported_scope_ref", 400);
      }
      const runtimeIdentity = eventIdentity(truthIdentity, RUNTIME_FACT_OWNER);
      return createEventStreamResponse(
        this.runtimeFor(scope, runtimeIdentity),
        runtimeIdentity,
        opts,
      );
    } catch (cause) {
      return jsonErrorResponse(errorTagFromCause(cause, "agent_os.stream_identity_error"), 400);
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

  protected commitScheduleFireDispatchFull(
    result: ScheduleFireDispatchResult,
  ): Promise<ReadonlyArray<LedgerEventRpc>> {
    return this.runScoped((_scope) =>
      Effect.gen(function* () {
        const ledger = yield* Ledger;
        const events = yield* ledger.commitPrepared((tx) => {
          const requested = tx.append(result.requested);
          const outcomeShape = result.outcome(1);
          tx.append({
            kind: outcomeShape.kind,
            scopeRef: outcomeShape.scopeRef,
            effectAuthorityRef: outcomeShape.effectAuthorityRef,
            buildPayload: (context) => result.outcome(context.id(requested)).payload,
          });
        });
        return events as ReadonlyArray<LedgerEventRpc>;
      }),
    );
  }

  protected commitScheduleFireDispatchFullWithDelivery(
    result: ScheduleFireDeliveryDispatchResult,
  ): Promise<ReadonlyArray<LedgerEventRpc>> {
    if (result.kind === "replay") return Promise.resolve([]);
    return this.runScoped((_scope) =>
      Effect.gen(function* () {
        const ledger = yield* Ledger;
        const events = yield* ledger.commitPrepared((tx) => {
          const deliveryRequested = tx.append(result.delivery.requested);
          const deliveryOutcomeShape = result.schedule.ok
            ? result.delivery.accept(1)
            : result.delivery.fail(1, {
                reason: result.schedule.reason,
                retryable: result.schedule.phase !== "contract",
              });
          tx.append({
            kind: deliveryOutcomeShape.kind,
            scopeRef: deliveryOutcomeShape.scopeRef,
            effectAuthorityRef: deliveryOutcomeShape.effectAuthorityRef,
            buildPayload: (context) =>
              result.schedule.ok
                ? result.delivery.accept(context.id(deliveryRequested)).payload
                : result.delivery.fail(context.id(deliveryRequested), {
                    reason: result.schedule.reason,
                    retryable: result.schedule.phase !== "contract",
                  }).payload,
          });
          const scheduleRequested = tx.append(result.schedule.requested);
          const scheduleOutcomeShape = result.schedule.outcome(1);
          tx.append({
            kind: scheduleOutcomeShape.kind,
            scopeRef: scheduleOutcomeShape.scopeRef,
            effectAuthorityRef: scheduleOutcomeShape.effectAuthorityRef,
            buildPayload: (context) =>
              result.schedule.outcome(context.id(scheduleRequested)).payload,
          });
        });
        return events as ReadonlyArray<LedgerEventRpc>;
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
   *  - sender records dispatch.outbound.requested;
   *  - sender retry state is derived from dispatch.outbound.* facts;
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
    const invalidAmount = invalidResourceAmount(spec.amount);
    if (invalidAmount !== null) return Promise.reject(invalidAmount);
    return this.runScoped((_scope, identity) =>
      Effect.gen(function* () {
        const resources = yield* Resources;
        return yield* resources.grant(identity, spec);
      }),
    );
  }

  reserveResource(spec: ResourceReserveSpec): Promise<ResourceReserveResult> {
    const invalidAmount = invalidResourceAmount(spec.amount);
    if (invalidAmount !== null) return Promise.reject(invalidAmount);
    return this.runScoped((_scope, identity) =>
      Effect.gen(function* () {
        const resources = yield* Resources;
        return yield* resources.reserve(identity, spec).pipe(Effect.result);
      }),
    ).then(promiseFromEffectResult);
  }

  consumeResource(spec: ResourceReservationSpec): Promise<void> {
    return this.runScoped((_scope, identity) =>
      Effect.gen(function* () {
        const resources = yield* Resources;
        return yield* resources.consume(identity, spec).pipe(Effect.result);
      }),
    ).then(promiseFromEffectResult);
  }

  releaseResource(spec: ResourceReservationSpec): Promise<void> {
    return this.runScoped((_scope, identity) =>
      Effect.gen(function* () {
        const resources = yield* Resources;
        return yield* resources.release(identity, spec).pipe(Effect.result);
      }),
    ).then(promiseFromEffectResult);
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
  config: AgentDurableObjectConfig<Env, AgentRuntimeClient>,
) =>
  class ConfiguredAgentDurableObject
    extends AgentDurableObject<Env, AgentRuntimeClient>
    implements AgentRuntimeClient
  {
    constructor(ctx: DurableObjectState, env: Env) {
      super(ctx, env, materializeCloudflareAgentConfig(config.manifest, config, env));
    }

    submit(spec: AgentSubmitSpec): Promise<SubmitResult> {
      return this.submitWithBindings(spec, this._mount.driverConfig.bindings);
    }

    resumeInputRequest(spec: WorkspaceAgentResumeInputRequestCommandInput): Promise<SubmitResult> {
      return this.resumeInputRequestWithBindings(spec, this._mount.driverConfig.bindings);
    }

    decideInputRequest(spec: WorkspaceAgentDecideInputRequestCommandInput): Promise<SubmitResult> {
      return this.decideInputRequestWithBindings(spec, this._mount.driverConfig.bindings);
    }

    runWorkspaceJob(spec: AgentWorkspaceJobSpec): Promise<WorkspaceJobProjection> {
      return this.runWorkspaceJobFull(spec);
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
