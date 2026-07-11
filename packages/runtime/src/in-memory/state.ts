import { Effect, Schema } from "effect";
import {
  JsonStringifyError,
  DurableTriggerCommitReturnedThenable,
  SqlError,
  UnregisteredDurableTriggerKind,
} from "@agent-os/core/errors";
import type { EventHandler, EventQueryOptions, LedgerEvent } from "@agent-os/core/types";
import {
  createLedgerArchiveArtifact,
  createLedgerArchiveReceipt,
  canonicalLedgerArchiveJson,
  decodeLedgerArchiveArtifact,
  validateLedgerArchiveChain,
  backendProtocolEventIdentityKey,
  backendProtocolTruthIdentityKey,
  scheduledEventIntentPayload,
  type BackendProtocolEventIdentity,
  type BackendProtocolTruthIdentity,
  type DurableProcessLifecycleState,
  type LedgerArchiveArtifact,
  type LedgerArchiveReceipt,
} from "@agent-os/core/backend-protocol";
import {
  applyProjectionEvent,
  getProjection,
  makeProjectionRegistryResult,
  type AnyMaterializedProjectionDefinition,
  type MaterializedProjectionRebuildResult,
  type MaterializedProjectionRow,
  type MaterializedProjectionStatus,
  type ProjectionApplicationError,
  type ProjectionRegistry,
  type ProjectionRegistryBuildResult,
  type ProjectionRegistryError,
  type ProjectionReducerReturnedThenable,
  UnregisteredProjectionKind,
} from "../projection";
import { type AttachedStreamTerminal, type AttachedStreamTx } from "../attached-stream";
import { getDurableTrigger, type TriggerRegistry, type TriggerTx } from "../trigger";
import { RUNTIME_FACT_OWNER } from "@agent-os/core/runtime-protocol";
import type { TelemetryFanoutDiagnostic } from "@agent-os/core/telemetry-protocol";
import { type AuthorityRef, type ScopeRef } from "@agent-os/core/effect-claim";
import {
  canonicalLedgerEvent,
  canonicalLedgerEventSync,
  canonicalLedgerEvents,
  cloneProjectionMeta,
  cloneProjectionRows,
  eventDisplayScope,
  eventIdentity,
  eventMatches,
  eventMatchesQueryOptions,
  normalizeProjectionLimit,
  projectionMetaKey,
  projectionRowKey,
} from "./state-helpers";
import {
  appendRowsToLedgerIndexes,
  assertInMemoryRuntimeLedgerTransitionBatch,
  queryInMemoryLedgerRows,
  sqlErrorFromUnknown,
} from "./ledger-state";
import {
  claimInMemoryDueWorkRow,
  createInMemoryDueWorkRow,
  dueClaimableRows,
  duePendingRows,
  dueRowsByTriggerIntent,
  durableProcessLifecycleRows,
  nextDueAtForIdentity,
  requestDueCancellation,
  stuckDueWorkRows,
  type InMemoryDueWorkRow,
} from "./due-work-state";
import { fireInMemoryEvents, type InMemoryEventSink } from "./telemetry-state";
import { LedgerArchiveError, mergeLedgerArchiveEvents } from "../ledger-archive";
export {
  inMemoryConversationRuntimeIdentity,
  inMemoryConversationTruthIdentity,
  inMemoryRuntimeEventIdentity,
} from "./state-helpers";

export interface InMemoryEventSubscription {
  readonly unsubscribe: () => void;
}

export interface InMemoryEventHandlerRegistration {
  readonly kind: string;
  readonly handler: EventHandler;
}

export interface InMemoryEventSpec {
  readonly ts?: number;
  readonly kind: string;
  readonly scopeRef: ScopeRef;
  readonly effectAuthorityRef: AuthorityRef;
  readonly payload: unknown;
  readonly scope?: never;
  readonly factOwnerRef?: never;
}

export interface InMemoryProtocolEventSpec extends BackendProtocolEventIdentity {
  readonly ts?: number;
  readonly kind: string;
  readonly payload: unknown;
  readonly scope?: never;
}

export interface InMemoryEventContentSpec {
  readonly ts?: number;
  readonly kind: string;
  readonly payload: unknown;
  readonly scope?: never;
  readonly scopeRef?: never;
  readonly effectAuthorityRef?: never;
  readonly factOwnerRef?: never;
}

export interface InMemoryProjectionMeta {
  version: number;
  status: "current" | "needs_rebuild";
  lastAppliedEventId: number;
  lastRebuiltEventId: number | null;
  updatedAt: number | null;
}

export interface InMemoryBackendStateOptions {
  readonly handlers?: Iterable<InMemoryEventHandlerRegistration>;
  readonly projections?: Iterable<AnyMaterializedProjectionDefinition>;
}

const inMemoryBackendStateProjectionRegistryInstaller: unique symbol = Symbol(
  "agentos.in_memory.backend_state.projection_registry_installer",
);

export class InMemoryBackendState {
  private nextEventId = 1;
  private nextDueWorkId = 1;
  private readonly rows: LedgerEvent[] = [];
  private readonly rowsByTruthIdentityKey = new Map<string, LedgerEvent[]>();
  private readonly rowsByEventIdentityKey = new Map<string, LedgerEvent[]>();
  private readonly sinks = new Set<InMemoryEventSink>();
  private readonly telemetryDiagnosticsLog: TelemetryFanoutDiagnostic[] = [];
  private readonly handlers = new Map<string, Set<EventHandler>>();
  private readonly dueWork: InMemoryDueWorkRow[] = [];
  private projectionRegistry: ProjectionRegistry;
  private projectionRegistryError: ProjectionRegistryError | null = null;
  private readonly projectionRows = new Map<string, MaterializedProjectionRow>();
  private readonly projectionMeta = new Map<string, InMemoryProjectionMeta>();
  private readonly archiveSegments = new Map<
    string,
    Array<{
      artifact: LedgerArchiveArtifact;
      receipt: LedgerArchiveReceipt;
      bytes: Uint8Array;
      tampered: boolean;
    }>
  >();
  private readonly archiveLocks = new Map<string, Promise<void>>();

  constructor(options: InMemoryBackendStateOptions = {}) {
    this.projectionRegistry = new Map();
    this.setProjectionRegistryResult(makeProjectionRegistryResult(options.projections ?? []));
    for (const registration of options.handlers ?? []) {
      this.addHandler(registration.kind, registration.handler);
    }
  }

  private appendRows(events: ReadonlyArray<LedgerEvent>): void {
    appendRowsToLedgerIndexes(
      events,
      this.rows,
      this.rowsByTruthIdentityKey,
      this.rowsByEventIdentityKey,
    );
  }

  private assertRuntimeLedgerTransitionBatch(
    events: ReadonlyArray<LedgerEvent>,
  ): Effect.Effect<void, SqlError> {
    return Effect.try({
      try: () =>
        assertInMemoryRuntimeLedgerTransitionBatch(events, (identity) =>
          this.rowsForTruthIdentity(identity),
        ),
      catch: sqlErrorFromUnknown,
    });
  }

  private rowsForTruthIdentity(identity: BackendProtocolTruthIdentity): ReadonlyArray<LedgerEvent> {
    const key = backendProtocolTruthIdentityKey(identity);
    const segments = this.archiveSegments.get(key) ?? [];
    if (segments.some((segment) => segment.tampered)) {
      throw new LedgerArchiveError({ operation: "read", cause: "archive bytes were tampered" });
    }
    validateLedgerArchiveChain(segments.map((segment) => segment.artifact));
    return mergeLedgerArchiveEvents(
      identity,
      segments.map((segment) => segment.artifact),
      this.rowsByTruthIdentityKey.get(key) ?? [],
    );
  }

  private rowsForEventIdentity(identity: BackendProtocolEventIdentity): ReadonlyArray<LedgerEvent> {
    return this.rowsForTruthIdentity(identity).filter(
      (event) => event.factOwnerRef === identity.factOwnerRef,
    );
  }

  private queryRows(
    identity: BackendProtocolTruthIdentity,
    opts: EventQueryOptions = {},
  ): ReadonlyArray<LedgerEvent> {
    return queryInMemoryLedgerRows(this.rowsForTruthIdentity(identity), identity, opts);
  }

  private setProjectionRegistry(registry: ProjectionRegistry): void {
    this.projectionRegistry = registry;
    this.projectionRegistryError = null;
  }

  private async withArchiveLock<A>(key: string, run: () => Promise<A>): Promise<A> {
    const prior = this.archiveLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = prior.then(() => current);
    this.archiveLocks.set(key, tail);
    await prior;
    try {
      return await run();
    } finally {
      release();
      if (this.archiveLocks.get(key) === tail) this.archiveLocks.delete(key);
    }
  }

  async archiveLedger(spec: {
    readonly identity: BackendProtocolTruthIdentity;
    readonly throughEventId: number;
  }): Promise<LedgerArchiveReceipt> {
    const key = backendProtocolTruthIdentityKey(spec.identity);
    return this.withArchiveLock(key, async () => {
      const segments = this.archiveSegments.get(key) ?? [];
      const previous = segments.at(-1);
      const previousLastId = previous?.receipt.lastEventId ?? 0;
      const events = (this.rowsByTruthIdentityKey.get(key) ?? []).filter(
        (event) => event.id > previousLastId && event.id <= spec.throughEventId,
      );
      if (events.length === 0) {
        if (previous !== undefined && spec.throughEventId <= previous.receipt.lastEventId) {
          return previous.receipt;
        }
        throw new LedgerArchiveError({ operation: "archive", cause: "no hot events to archive" });
      }
      const artifact = await createLedgerArchiveArtifact({
        identity: spec.identity,
        previousSegmentSha256: previous?.artifact.sha256 ?? null,
        events,
      });
      const bytes = new Uint8Array(artifact.bytes);
      const archiveRef = `memory:${encodeURIComponent(key)}:${artifact.sha256}`;
      const receipt = await createLedgerArchiveReceipt({ artifact, archiveRef, readback: bytes });
      segments.push({ artifact, receipt, bytes, tampered: false });
      this.archiveSegments.set(key, segments);
      return receipt;
    });
  }

  async evictArchivedLedger(receipt: LedgerArchiveReceipt): Promise<{ readonly evicted: number }> {
    return this.withArchiveLock(receipt.truthKey, async () => {
      const segments = this.archiveSegments.get(receipt.truthKey) ?? [];
      const stored = segments.find(
        (segment) => segment.receipt.segmentSha256 === receipt.segmentSha256,
      );
      if (
        stored === undefined ||
        canonicalLedgerArchiveJson(stored.receipt) !== canonicalLedgerArchiveJson(receipt) ||
        stored.tampered
      ) {
        throw new LedgerArchiveError({ operation: "evict", cause: "receipt is not authoritative" });
      }
      await decodeLedgerArchiveArtifact(stored.bytes, stored.receipt.segmentSha256);
      const ids = new Set(stored.artifact.segment.events.map((event) => event.id));
      const hot = this.rows.filter((event) => ids.has(event.id));
      if (hot.length === 0) return { evicted: 0 };
      if (
        hot.length !== ids.size ||
        hot.some((event) => {
          const archived = stored.artifact.segment.events.find(
            (candidate) => candidate.id === event.id,
          );
          return (
            archived === undefined ||
            canonicalLedgerArchiveJson(event) !== canonicalLedgerArchiveJson(archived)
          );
        })
      ) {
        throw new LedgerArchiveError({ operation: "evict", cause: "hot event set mismatch" });
      }
      const remaining = this.rows.filter((event) => !ids.has(event.id));
      this.rows.length = 0;
      this.rowsByTruthIdentityKey.clear();
      this.rowsByEventIdentityKey.clear();
      this.appendRows(remaining);
      return { evicted: hot.length };
    });
  }

  corruptArchiveForTest(receipt: LedgerArchiveReceipt): void {
    const segment = (this.archiveSegments.get(receipt.truthKey) ?? []).find(
      (candidate) => candidate.receipt.segmentSha256 === receipt.segmentSha256,
    );
    if (segment !== undefined) segment.tampered = true;
  }

  private setProjectionRegistryResult(result: ProjectionRegistryBuildResult): void {
    if (result._tag === "success") {
      this.setProjectionRegistry(result.registry);
    } else {
      this.projectionRegistry = new Map();
      this.projectionRegistryError = result.error;
    }
  }

  [inMemoryBackendStateProjectionRegistryInstaller](result: ProjectionRegistryBuildResult): void {
    this.setProjectionRegistryResult(result);
  }

  private projectionRegistryEffect(): Effect.Effect<ProjectionRegistry, ProjectionRegistryError> {
    return this.projectionRegistryError === null
      ? Effect.succeed(this.projectionRegistry)
      : Effect.fail(this.projectionRegistryError);
  }

  private projectionDefinitionsForEvent(
    eventKind: string,
    registry: ProjectionRegistry = this.projectionRegistry,
  ): ReadonlyArray<AnyMaterializedProjectionDefinition> {
    return Array.from(registry.values()).filter((projection) =>
      projection.eventKinds.includes(eventKind),
    );
  }

  private replaceProjectionState(
    rows: ReadonlyMap<string, MaterializedProjectionRow>,
    meta: ReadonlyMap<string, InMemoryProjectionMeta>,
  ): void {
    this.projectionRows.clear();
    for (const [key, row] of rows) this.projectionRows.set(key, row);
    this.projectionMeta.clear();
    for (const [key, value] of meta) this.projectionMeta.set(key, value);
  }

  private applyProjectionEventsTo(
    rows: Map<string, MaterializedProjectionRow>,
    meta: Map<string, InMemoryProjectionMeta>,
    events: ReadonlyArray<LedgerEvent>,
    definitionsForEvent: (
      eventKind: string,
    ) => ReadonlyArray<AnyMaterializedProjectionDefinition> = (eventKind) =>
      this.projectionDefinitionsForEvent(eventKind),
  ): Effect.Effect<void, ProjectionApplicationError | ProjectionReducerReturnedThenable> {
    return Effect.gen({ self: this }, function* () {
      for (const event of events) {
        const identity = eventIdentity(event);
        const displayScope = eventDisplayScope(identity);
        const definitions = definitionsForEvent(event.kind);
        for (const projection of definitions) {
          const result = yield* applyProjectionEvent(projection, event, (identityKey) => {
            const row = rows.get(projectionRowKey(identity, projection.kind, identityKey));
            return row === undefined ? null : { identity: row.identity, state: row.state };
          });
          if (result._tag === "put") {
            rows.set(projectionRowKey(identity, projection.kind, result.identityKey), {
              kind: projection.kind,
              scope: displayScope,
              identityKey: result.identityKey,
              identity: result.identity,
              state: result.state,
              version: projection.version,
              updatedEventId: event.id,
              updatedAt: event.ts,
            });
          } else if (result._tag === "delete") {
            rows.delete(projectionRowKey(identity, projection.kind, result.identityKey));
          }
          const key = projectionMetaKey(identity, projection.kind);
          const current = meta.get(key);
          meta.set(key, {
            version: projection.version,
            status: "current",
            lastAppliedEventId: event.id,
            lastRebuiltEventId: current?.lastRebuiltEventId ?? null,
            updatedAt: event.ts,
          });
        }
      }
    });
  }

  private prepareProjectionState(events: ReadonlyArray<LedgerEvent>): Effect.Effect<
    {
      readonly rows: Map<string, MaterializedProjectionRow>;
      readonly meta: Map<string, InMemoryProjectionMeta>;
    },
    SqlError
  > {
    if (events.length === 0) {
      return Effect.succeed({
        rows: cloneProjectionRows(this.projectionRows),
        meta: cloneProjectionMeta(this.projectionMeta),
      });
    }
    return Effect.gen({ self: this }, function* () {
      const registry = yield* this.projectionRegistryEffect().pipe(
        Effect.mapError((cause) => new SqlError({ cause })),
      );
      if (registry.size === 0) {
        return {
          rows: cloneProjectionRows(this.projectionRows),
          meta: cloneProjectionMeta(this.projectionMeta),
        };
      }
      const rows = cloneProjectionRows(this.projectionRows);
      const meta = cloneProjectionMeta(this.projectionMeta);
      yield* this.applyProjectionEventsTo(rows, meta, events, (eventKind) =>
        this.projectionDefinitionsForEvent(eventKind, registry),
      ).pipe(Effect.mapError((cause) => new SqlError({ cause })));
      return { rows, meta };
    });
  }

  projectionGet(spec: {
    readonly kind: string;
    readonly eventIdentity: BackendProtocolEventIdentity;
    readonly identity: unknown;
  }): Effect.Effect<MaterializedProjectionRow | null, SqlError | UnregisteredProjectionKind> {
    return Effect.gen({ self: this }, function* () {
      const registry = yield* this.projectionRegistryEffect().pipe(
        Effect.mapError((cause) => new SqlError({ cause })),
      );
      const projection = yield* getProjection(registry, spec.kind);
      const identity = yield* Effect.try({
        try: () => Schema.decodeUnknownSync(projection.identity)(spec.identity),
        catch: (cause) => new SqlError({ cause }),
      });
      const identityKey = projection.identityKey(identity);
      return (
        this.projectionRows.get(projectionRowKey(spec.eventIdentity, spec.kind, identityKey)) ??
        null
      );
    });
  }

  projectionList(spec: {
    readonly kind: string;
    readonly eventIdentity: BackendProtocolEventIdentity;
    readonly limit?: number;
    readonly afterKey?: string;
  }): Effect.Effect<
    ReadonlyArray<MaterializedProjectionRow>,
    SqlError | UnregisteredProjectionKind
  > {
    return Effect.gen({ self: this }, function* () {
      const registry = yield* this.projectionRegistryEffect().pipe(
        Effect.mapError((cause) => new SqlError({ cause })),
      );
      yield* getProjection(registry, spec.kind);
      const limit = normalizeProjectionLimit(spec.limit);
      const scope = eventDisplayScope(spec.eventIdentity);
      return Array.from(this.projectionRows.values())
        .filter((row) => {
          if (row.scope !== scope || row.kind !== spec.kind) return false;
          if (spec.afterKey !== undefined && row.identityKey <= spec.afterKey) return false;
          return true;
        })
        .sort((left, right) => left.identityKey.localeCompare(right.identityKey))
        .slice(0, limit);
    });
  }

  projectionStatus(spec: {
    readonly kind: string;
    readonly eventIdentity: BackendProtocolEventIdentity;
  }): Effect.Effect<MaterializedProjectionStatus, SqlError | UnregisteredProjectionKind> {
    return Effect.gen({ self: this }, function* () {
      const registry = yield* this.projectionRegistryEffect().pipe(
        Effect.mapError((cause) => new SqlError({ cause })),
      );
      const projection = yield* getProjection(registry, spec.kind);
      const scope = eventDisplayScope(spec.eventIdentity);
      const meta = this.projectionMeta.get(projectionMetaKey(spec.eventIdentity, spec.kind));
      if (meta === undefined) {
        return {
          kind: spec.kind,
          scope,
          version: projection.version,
          status: "current" as const,
          lastAppliedEventId: 0,
          lastRebuiltEventId: null,
          updatedAt: null,
        };
      }
      return {
        kind: spec.kind,
        scope,
        version: projection.version,
        status:
          meta.status === "current" && meta.version === projection.version
            ? ("current" as const)
            : ("needs_rebuild" as const),
        lastAppliedEventId: meta.lastAppliedEventId,
        lastRebuiltEventId: meta.lastRebuiltEventId,
        updatedAt: meta.updatedAt,
      };
    });
  }

  projectionRebuild(spec: {
    readonly kind: string;
    readonly eventIdentity: BackendProtocolEventIdentity;
  }): Effect.Effect<
    MaterializedProjectionRebuildResult,
    | SqlError
    | UnregisteredProjectionKind
    | ProjectionApplicationError
    | ProjectionReducerReturnedThenable
  > {
    return Effect.gen({ self: this }, function* () {
      const registry = yield* this.projectionRegistryEffect().pipe(
        Effect.mapError((cause) => new SqlError({ cause })),
      );
      const projection = yield* getProjection(registry, spec.kind);
      const rows = cloneProjectionRows(this.projectionRows);
      const meta = cloneProjectionMeta(this.projectionMeta);
      const scope = eventDisplayScope(spec.eventIdentity);
      for (const key of rows.keys()) {
        const row = rows.get(key);
        if (row?.scope === scope && row.kind === spec.kind) rows.delete(key);
      }
      meta.delete(projectionMetaKey(spec.eventIdentity, spec.kind));
      const events = this.rowsForEventIdentity(spec.eventIdentity).filter((event) =>
        projection.eventKinds.includes(event.kind),
      );
      yield* this.applyProjectionEventsTo(rows, meta, events, (eventKind) =>
        projection.eventKinds.includes(eventKind) ? [projection] : [],
      );
      const last = events.at(-1) ?? null;
      const statusKey = projectionMetaKey(spec.eventIdentity, spec.kind);
      const current = meta.get(statusKey);
      meta.set(statusKey, {
        version: projection.version,
        status: "current",
        lastAppliedEventId: current?.lastAppliedEventId ?? 0,
        lastRebuiltEventId: last?.id ?? 0,
        updatedAt: current?.updatedAt ?? null,
      });
      this.replaceProjectionState(rows, meta);
      const rebuilt = Array.from(rows.values()).filter(
        (row) => row.scope === scope && row.kind === spec.kind,
      ).length;
      const status = yield* this.projectionStatus(spec);
      return { ...status, rows: rebuilt };
    });
  }

  addHandler(kind: string, handler: EventHandler): InMemoryEventSubscription {
    let set = this.handlers.get(kind);
    if (set === undefined) {
      set = new Set();
      this.handlers.set(kind, set);
    }
    set.add(handler);
    return {
      unsubscribe: () => {
        set?.delete(handler);
      },
    };
  }

  subscribe(opts: {
    readonly kinds?: ReadonlyArray<string>;
    readonly sink: (event: LedgerEvent) => void;
  }): InMemoryEventSubscription {
    const subscription: InMemoryEventSink = {
      ...(opts.kinds === undefined || opts.kinds.length === 0
        ? {}
        : { kinds: new Set(opts.kinds) }),
      sink: opts.sink,
    };
    this.sinks.add(subscription);
    return {
      unsubscribe: () => {
        this.sinks.delete(subscription);
      },
    };
  }

  telemetryDiagnostics(): ReadonlyArray<TelemetryFanoutDiagnostic> {
    return [...this.telemetryDiagnosticsLog];
  }

  snapshot(
    identity: BackendProtocolTruthIdentity,
    opts: EventQueryOptions = {},
  ): ReadonlyArray<LedgerEvent> {
    return this.queryRows(identity, opts);
  }

  eventSnapshot(
    identity: BackendProtocolEventIdentity,
    opts: EventQueryOptions = {},
  ): ReadonlyArray<LedgerEvent> {
    return this.queryRows(identity, { ...opts, factOwnerRefs: [identity.factOwnerRef] });
  }

  streamSnapshot(
    identity: BackendProtocolTruthIdentity,
    opts: Pick<EventQueryOptions, "afterId" | "kinds" | "factOwnerRefs"> = {},
  ): ReadonlyArray<LedgerEvent> {
    return this.queryRows(identity, opts);
  }

  commitEvents(
    specs: ReadonlyArray<InMemoryEventSpec>,
  ): Effect.Effect<ReadonlyArray<LedgerEvent>, JsonStringifyError | SqlError> {
    return this.commitPrepared(() => specs);
  }

  commitPrepared(
    makeSpecs: (nextEventId: number) => ReadonlyArray<InMemoryEventSpec>,
  ): Effect.Effect<ReadonlyArray<LedgerEvent>, JsonStringifyError | SqlError> {
    return this.commitProtocolPrepared((nextEventId) =>
      makeSpecs(nextEventId).map((spec) => ({
        ts: spec.ts,
        kind: spec.kind,
        scopeRef: spec.scopeRef,
        effectAuthorityRef: spec.effectAuthorityRef,
        factOwnerRef: RUNTIME_FACT_OWNER,
        payload: spec.payload,
      })),
    );
  }

  commitProtocolEvents(
    specs: ReadonlyArray<InMemoryProtocolEventSpec>,
  ): Effect.Effect<ReadonlyArray<LedgerEvent>, JsonStringifyError | SqlError> {
    return this.commitProtocolPrepared(() => specs);
  }

  commitProtocolPrepared(
    makeSpecs: (nextEventId: number) => ReadonlyArray<InMemoryProtocolEventSpec>,
  ): Effect.Effect<ReadonlyArray<LedgerEvent>, JsonStringifyError | SqlError> {
    return Effect.gen({ self: this }, function* () {
      const startId = this.nextEventId;
      const specs = makeSpecs(startId);
      const events = specs.map(
        (spec, index): LedgerEvent => ({
          id: startId + index,
          ts: spec.ts ?? startId + index,
          kind: spec.kind,
          scopeRef: spec.scopeRef,
          effectAuthorityRef: spec.effectAuthorityRef,
          factOwnerRef: spec.factOwnerRef,
          payload: spec.payload,
        }),
      );
      const committed = yield* canonicalLedgerEvents(events);
      yield* this.assertRuntimeLedgerTransitionBatch(committed);
      const projectionState = yield* this.prepareProjectionState(committed);
      yield* Effect.sync(() => {
        this.nextEventId += committed.length;
        this.appendRows(committed);
        this.replaceProjectionState(projectionState.rows, projectionState.meta);
      });
      yield* this.fireMany(committed);
      return committed;
    });
  }

  commitTriggerIntent(
    identity: BackendProtocolEventIdentity,
    fireAt: number,
    registry: TriggerRegistry,
    triggerKind: string,
    makeSpec: (trigger: {
      readonly kind: string;
      readonly intentEventKind: string;
    }) => InMemoryEventContentSpec,
  ): Effect.Effect<LedgerEvent, JsonStringifyError | SqlError | UnregisteredDurableTriggerKind> {
    return Effect.gen({ self: this }, function* () {
      const trigger = yield* getDurableTrigger(registry, triggerKind);
      const spec = makeSpec(trigger);
      const event = yield* canonicalLedgerEvent({
        id: this.nextEventId,
        ts: spec.ts ?? this.nextEventId,
        kind: spec.kind,
        scopeRef: identity.scopeRef,
        effectAuthorityRef: identity.effectAuthorityRef,
        factOwnerRef: identity.factOwnerRef,
        payload: spec.payload,
      });
      yield* this.assertRuntimeLedgerTransitionBatch([event]);
      const projectionState = yield* this.prepareProjectionState([event]);
      const committed = yield* Effect.sync(() => {
        this.nextEventId += 1;
        this.appendRows([event]);
        this.replaceProjectionState(projectionState.rows, projectionState.meta);
        const dueId = this.nextDueWorkId++;
        this.dueWork.push(
          createInMemoryDueWorkRow({
            id: dueId,
            identity,
            fireAt,
            kind: trigger.kind,
            intentEventId: event.id,
          }),
        );
        return event;
      });
      yield* this.fireMany([committed]);
      return committed;
    });
  }

  schedule(
    identity: BackendProtocolEventIdentity,
    intentTs: number,
    at: number,
    registry: TriggerRegistry,
    triggerKind: string,
    eventKind: string,
    data: unknown,
  ): Effect.Effect<
    { readonly id: number },
    JsonStringifyError | SqlError | UnregisteredDurableTriggerKind
  > {
    return Effect.gen({ self: this }, function* () {
      const payload = scheduledEventIntentPayload(eventKind, data);
      const committed = yield* this.commitTriggerIntent(
        identity,
        at,
        registry,
        triggerKind,
        (trigger) => ({
          ts: intentTs,
          kind: trigger.intentEventKind,
          payload,
        }),
      );
      return { id: committed.id };
    });
  }

  eventById(
    identity: BackendProtocolEventIdentity,
    intentEventId: number,
    kind: string,
  ): LedgerEvent | null {
    return (
      this.rowsForEventIdentity(identity).find(
        (row) => row.id === intentEventId && row.kind === kind,
      ) ?? null
    );
  }

  duePending(
    identity: BackendProtocolEventIdentity,
    now: number,
  ): ReadonlyArray<InMemoryDueWorkRow> {
    return duePendingRows(this.dueWork, identity, now);
  }

  dueClaimable(
    identity: BackendProtocolEventIdentity,
    now: number,
  ): ReadonlyArray<InMemoryDueWorkRow> {
    return dueClaimableRows(this.dueWork, identity, now);
  }

  nextDueAt(identity: BackendProtocolEventIdentity): number | null {
    return nextDueAtForIdentity(this.dueWork, identity);
  }

  completeDueWork(id: number, completedAt: number): void {
    const row = this.dueWork.find((candidate) => candidate.id === id);
    if (row !== undefined && row.completedAt === null) {
      row.completedAt = completedAt;
    }
  }

  addDueWork(
    identity: BackendProtocolEventIdentity,
    kind: string,
    intentEventId: number,
    fireAt: number,
  ): number {
    const id = this.nextDueWorkId++;
    this.dueWork.push(createInMemoryDueWorkRow({ id, identity, fireAt, kind, intentEventId }));
    return id;
  }

  claimDueWork(
    row: InMemoryDueWorkRow,
    now: number,
    token: string,
    deadlineAt: number,
  ): InMemoryDueWorkRow | null {
    return claimInMemoryDueWorkRow(row, now, token, deadlineAt);
  }

  dueByTriggerIntent(
    identity: BackendProtocolEventIdentity,
    kind: string,
    intentEventId: number,
  ): ReadonlyArray<InMemoryDueWorkRow> {
    return dueRowsByTriggerIntent(this.dueWork, identity, kind, intentEventId);
  }

  requestCancellation(row: InMemoryDueWorkRow, now: number, reason?: string): boolean {
    return requestDueCancellation(row, now, reason);
  }

  stuckDueWork(
    identity: BackendProtocolEventIdentity,
    now: number,
  ): ReadonlyArray<{
    readonly dueWorkId: number;
    readonly triggerKind: string;
    readonly intentEventId: number;
    readonly claimDeadlineAt: number;
    readonly redriveCount: number;
  }> {
    return stuckDueWorkRows(this.dueWork, identity, now);
  }

  durableProcessLifecycle(
    identity: BackendProtocolEventIdentity,
  ): Effect.Effect<ReadonlyArray<DurableProcessLifecycleState>, SqlError> {
    return Effect.gen({ self: this }, function* () {
      return yield* Effect.try({
        try: () => durableProcessLifecycleRows(this.dueWork, identity),
        catch: sqlErrorFromUnknown,
      });
    });
  }

  commitAttachedStreamTerminal<Terminal>(
    identity: BackendProtocolEventIdentity,
    scopeLabel: string,
    streamRef: string,
    kind: string,
    now: number,
    signal: AbortSignal,
    terminal: AttachedStreamTerminal<Terminal>,
    commit: (terminal: AttachedStreamTerminal<Terminal>, tx: AttachedStreamTx) => string | null,
  ): Effect.Effect<{ readonly events: ReadonlyArray<LedgerEvent> }, JsonStringifyError | SqlError> {
    return Effect.gen({ self: this }, function* () {
      const startId = this.nextEventId;
      const written: LedgerEvent[] = [];
      const tx: AttachedStreamTx = {
        scope: scopeLabel,
        streamRef,
        now,
        signal,
        events: (opts = {}) => {
          const committed = this.eventSnapshot(identity, opts);
          return [...committed, ...written].filter(
            (event) => eventMatches(event, identity) && eventMatchesQueryOptions(event, opts),
          );
        },
        insertEvent: (spec) => {
          const event = canonicalLedgerEventSync({
            id: startId + written.length,
            ts: spec.ts ?? now,
            kind: spec.kind,
            scopeRef: identity.scopeRef,
            effectAuthorityRef: identity.effectAuthorityRef,
            factOwnerRef: identity.factOwnerRef,
            payload: spec.payload,
          });
          written.push(event);
          return event;
        },
      };
      const commitFailure = yield* Effect.try({
        try: () => commit(terminal, tx),
        catch: (cause) => (cause instanceof JsonStringifyError ? cause : new SqlError({ cause })),
      });
      if (commitFailure !== null) {
        return yield* Effect.fail(new SqlError({ cause: commitFailure }));
      }
      const committed = yield* canonicalLedgerEvents(written);
      yield* this.assertRuntimeLedgerTransitionBatch(committed);
      const projectionState = yield* this.prepareProjectionState(committed);
      yield* Effect.sync(() => {
        this.nextEventId += committed.length;
        this.appendRows(committed);
        this.replaceProjectionState(projectionState.rows, projectionState.meta);
      });
      yield* this.fireMany(committed);
      return { events: committed };
    });
  }

  commitTrigger(
    scopeLabel: string,
    row: InMemoryDueWorkRow,
    now: number,
    hasTrigger: (kind: string) => boolean,
    commit: (tx: TriggerTx) => DurableTriggerCommitReturnedThenable | null,
    options: {
      readonly claimToken?: string;
      readonly requireUnclaimed?: boolean;
      readonly cancelled?: boolean;
      readonly acquireMode?: "normal" | "redrive";
    } = {},
  ): Effect.Effect<
    { readonly completed: boolean; readonly events: ReadonlyArray<LedgerEvent> },
    | JsonStringifyError
    | SqlError
    | UnregisteredDurableTriggerKind
    | DurableTriggerCommitReturnedThenable
  > {
    return Effect.gen({ self: this }, function* () {
      if (row.completedAt !== null) return { completed: false, events: [] };
      if (options.claimToken !== undefined && row.claimToken !== options.claimToken) {
        return { completed: false, events: [] };
      }
      if (options.requireUnclaimed === true && row.claimToken !== null) {
        return { completed: false, events: [] };
      }
      const startId = this.nextEventId;
      const written: LedgerEvent[] = [];
      const identity = row.identity;
      let rejected: UnregisteredDurableTriggerKind | null = null;
      const due: Array<{
        readonly triggerKind: string;
        readonly fireAt: number;
        readonly intentEventId: number;
      }> = [];
      const tx: TriggerTx = {
        scope: scopeLabel,
        now,
        dueWorkId: row.id,
        intentEventId: row.payload.intentEventId,
        acquireMode: options.acquireMode ?? "normal",
        insertEvent: (spec) => {
          const event = canonicalLedgerEventSync({
            id: startId + written.length,
            ts: spec.ts ?? now,
            kind: spec.kind,
            scopeRef: identity.scopeRef,
            effectAuthorityRef: identity.effectAuthorityRef,
            factOwnerRef: identity.factOwnerRef,
            payload: spec.payload,
          });
          written.push(event);
          return event;
        },
        enqueue: (spec) => {
          const event = canonicalLedgerEventSync({
            id: startId + written.length,
            ts: spec.ts ?? now,
            kind: spec.intentEventKind,
            scopeRef: identity.scopeRef,
            effectAuthorityRef: identity.effectAuthorityRef,
            factOwnerRef: identity.factOwnerRef,
            payload: spec.payload,
          });
          if (!hasTrigger(spec.triggerKind)) {
            rejected = new UnregisteredDurableTriggerKind({ kind: spec.triggerKind });
            return event;
          }
          written.push(event);
          due.push({
            triggerKind: spec.triggerKind,
            fireAt: spec.fireAt,
            intentEventId: event.id,
          });
          return event;
        },
        reschedule: (fireAt, intentEventId = row.payload.intentEventId) => {
          due.push({
            triggerKind: row.kind,
            fireAt,
            intentEventId,
          });
        },
      };
      const commitFailure = yield* Effect.try({
        try: () => commit(tx),
        catch: (cause) =>
          cause instanceof JsonStringifyError ||
          cause instanceof DurableTriggerCommitReturnedThenable
            ? cause
            : new SqlError({ cause }),
      });
      if (commitFailure !== null) {
        return yield* Effect.fail(commitFailure);
      }
      if (rejected !== null) {
        return yield* Effect.fail(rejected);
      }
      const committed = yield* canonicalLedgerEvents(written);
      yield* this.assertRuntimeLedgerTransitionBatch(committed);
      const projectionState = yield* this.prepareProjectionState(committed);
      yield* Effect.sync(() => {
        this.nextEventId += committed.length;
        this.appendRows(committed);
        this.replaceProjectionState(projectionState.rows, projectionState.meta);
        row.completedAt = now;
        if (options.cancelled === true) row.cancelledAt = now;
        for (const spec of due) {
          const dueId = this.nextDueWorkId++;
          this.dueWork.push(
            createInMemoryDueWorkRow({
              id: dueId,
              identity,
              fireAt: spec.fireAt,
              kind: spec.triggerKind,
              intentEventId: spec.intentEventId,
            }),
          );
        }
      });
      yield* this.fireMany(committed);
      return { completed: true, events: committed };
    });
  }

  private fireMany(events: ReadonlyArray<LedgerEvent>): Effect.Effect<void> {
    return fireInMemoryEvents(events, {
      sinks: this.sinks,
      handlers: this.handlers,
      diagnostics: this.telemetryDiagnosticsLog,
    });
  }
}

export const createInMemoryBackendState = (
  options: InMemoryBackendStateOptions = {},
): InMemoryBackendState => new InMemoryBackendState(options);

/**
 * Internal backend graph installation hook. Keep projection registry mutation
 * off the public InMemoryBackendState surface.
 *
 * @internal
 */
export const installInMemoryBackendStateProjectionRegistry = (
  state: InMemoryBackendState,
  result: ProjectionRegistryBuildResult,
): void => {
  state[inMemoryBackendStateProjectionRegistryInstaller](result);
};
