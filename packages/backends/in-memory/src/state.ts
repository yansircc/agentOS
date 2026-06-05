import { Effect, Schema } from "effect";
import {
  JsonStringifyError,
  DurableTriggerCommitReturnedThenable,
  SqlError,
  UnregisteredDurableTriggerKind,
} from "@agent-os/kernel/errors";
import type {
  EventHandler,
  EventQueryOptions,
  LedgerEvent,
  LedgerEventRpc,
} from "@agent-os/kernel/types";
import {
  durableProcessLifecycleState,
  durableTriggerDuePayload,
  fireBackendEventHandlers,
  type DurableProcessLifecycleState,
  type IntentPointerDuePayload,
} from "@agent-os/backend-protocol";
import {
  scheduledEventIntentPayload,
  applyProjectionEvent,
  getProjection,
  makeProjectionRegistryResult,
  getDurableTrigger,
  type AnyMaterializedProjectionDefinition,
  type AttachedStreamTx,
  type AttachedStreamTerminal,
  type MaterializedProjectionRebuildResult,
  type MaterializedProjectionRow,
  type MaterializedProjectionStatus,
  type ProjectionApplicationError,
  type ProjectionRegistry,
  type ProjectionRegistryBuildResult,
  type ProjectionRegistryError,
  type ProjectionReducerReturnedThenable,
  type TriggerRegistry,
  type TriggerTx,
  UnregisteredProjectionKind,
} from "@agent-os/runtime";
import type { DispatchOutboxRow } from "./dispatch-types";

const DEFAULT_EVENT_LIMIT = 1000;
const MAX_EVENT_LIMIT = 1000;

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
  readonly scope: string;
  readonly payload: unknown;
}

interface EventSink {
  readonly kinds?: ReadonlySet<string>;
  readonly sink: (event: LedgerEvent) => void;
}

interface InMemoryFanoutDiagnostic {
  readonly phase: "sink";
  readonly eventId: number;
  readonly kind: string;
  readonly scope: string;
  readonly message: string;
}

interface InMemoryDueWorkRow {
  readonly id: number;
  readonly fireAt: number;
  readonly kind: string;
  readonly payload: IntentPointerDuePayload;
  completedAt: number | null;
  claimedAt: number | null;
  claimToken: string | null;
  claimDeadlineAt: number | null;
  redriveCount: number;
  cancelRequestedAt: number | null;
  cancelReason: string | null;
  cancelledAt: number | null;
}

interface InMemoryProjectionMeta {
  version: number;
  status: "current" | "needs_rebuild";
  lastAppliedEventId: number;
  lastRebuiltEventId: number | null;
  updatedAt: number | null;
}

type InMemoryOutboxPatch =
  | { readonly _tag: "add"; readonly row: DispatchOutboxRow }
  | {
      readonly _tag: "delivered";
      readonly outboundEventId: number;
      readonly deliveredEventId: number;
      readonly attempts: number;
    }
  | {
      readonly _tag: "failed";
      readonly outboundEventId: number;
      readonly attempts: number;
      readonly lastError: string;
    };

export interface InMemoryBackendStateOptions {
  readonly handlers?: Iterable<InMemoryEventHandlerRegistration>;
  readonly projections?: Iterable<AnyMaterializedProjectionDefinition>;
}

const validateSerializablePayload = (payload: unknown): Effect.Effect<void, JsonStringifyError> =>
  Effect.try({
    try: () => JSON.stringify(payload),
    catch: (cause) => new JsonStringifyError({ cause }),
  }).pipe(
    Effect.flatMap((serialized) =>
      typeof serialized === "string"
        ? Effect.void
        : Effect.fail(
            new JsonStringifyError({
              cause: new TypeError("ledger event payload must be JSON serializable"),
            }),
          ),
    ),
  );

const normalizeNonNegativeInteger = (value: number | undefined, fallback: number): number =>
  value === undefined || !Number.isFinite(value) ? fallback : Math.max(0, Math.floor(value));

const describeFanoutCause = (cause: unknown): string => {
  if (typeof cause === "string") return cause;
  if (cause instanceof Error) return `${cause.name}: ${cause.message}`;
  return Object.prototype.toString.call(cause);
};

const eventToRpc = (event: LedgerEvent): LedgerEventRpc => ({
  id: event.id,
  ts: event.ts,
  kind: event.kind,
  scope: event.scope,
  payload: event.payload,
});

const projectionRowKey = (scope: string, kind: string, identityKey: string): string =>
  JSON.stringify([scope, kind, identityKey]);

const projectionMetaKey = (scope: string, kind: string): string => JSON.stringify([scope, kind]);

const cloneProjectionRows = (
  rows: ReadonlyMap<string, MaterializedProjectionRow>,
): Map<string, MaterializedProjectionRow> => new Map(rows);

const cloneProjectionMeta = (
  meta: ReadonlyMap<string, InMemoryProjectionMeta>,
): Map<string, InMemoryProjectionMeta> => new Map(meta);

const normalizeProjectionLimit = (limit: number | undefined): number =>
  limit === undefined
    ? DEFAULT_EVENT_LIMIT
    : Math.max(
        0,
        Math.min(MAX_EVENT_LIMIT, normalizeNonNegativeInteger(limit, DEFAULT_EVENT_LIMIT)),
      );

export class InMemoryBackendState {
  private nextEventId = 1;
  private nextDueWorkId = 1;
  private readonly rows: LedgerEvent[] = [];
  private readonly sinks = new Set<EventSink>();
  private readonly fanoutDiagnosticsLog: InMemoryFanoutDiagnostic[] = [];
  private readonly handlers = new Map<string, Set<EventHandler>>();
  private readonly dueWork: InMemoryDueWorkRow[] = [];
  private readonly outbox = new Map<number, DispatchOutboxRow>();
  private projectionRegistry: ProjectionRegistry;
  private projectionRegistryError: ProjectionRegistryError | null = null;
  private readonly projectionRows = new Map<string, MaterializedProjectionRow>();
  private readonly projectionMeta = new Map<string, InMemoryProjectionMeta>();

  constructor(options: InMemoryBackendStateOptions = {}) {
    this.projectionRegistry = new Map();
    this.setProjectionRegistryResult(makeProjectionRegistryResult(options.projections ?? []));
    for (const registration of options.handlers ?? []) {
      this.addHandler(registration.kind, registration.handler);
    }
  }

  setProjectionRegistry(registry: ProjectionRegistry): void {
    this.projectionRegistry = registry;
    this.projectionRegistryError = null;
  }

  setProjectionRegistryResult(result: ProjectionRegistryBuildResult): void {
    if (result._tag === "success") {
      this.setProjectionRegistry(result.registry);
    } else {
      this.projectionRegistry = new Map();
      this.projectionRegistryError = result.error;
    }
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
    return Effect.gen(this, function* () {
      for (const event of events) {
        const definitions = definitionsForEvent(event.kind);
        for (const projection of definitions) {
          const result = yield* applyProjectionEvent(projection, event, (identityKey) => {
            const row = rows.get(projectionRowKey(event.scope, projection.kind, identityKey));
            return row === undefined ? null : { identity: row.identity, state: row.state };
          });
          if (result._tag === "put") {
            rows.set(projectionRowKey(event.scope, projection.kind, result.identityKey), {
              kind: projection.kind,
              scope: event.scope,
              identityKey: result.identityKey,
              identity: result.identity,
              state: result.state,
              version: projection.version,
              updatedEventId: event.id,
              updatedAt: event.ts,
            });
          } else if (result._tag === "delete") {
            rows.delete(projectionRowKey(event.scope, projection.kind, result.identityKey));
          }
          const key = projectionMetaKey(event.scope, projection.kind);
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
    return Effect.gen(this, function* () {
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
    readonly scope: string;
    readonly identity: unknown;
  }): Effect.Effect<MaterializedProjectionRow | null, SqlError | UnregisteredProjectionKind> {
    return Effect.gen(this, function* () {
      const registry = yield* this.projectionRegistryEffect().pipe(
        Effect.mapError((cause) => new SqlError({ cause })),
      );
      const projection = yield* getProjection(registry, spec.kind);
      const identity = yield* Effect.try({
        try: () => Schema.decodeUnknownSync(projection.identity)(spec.identity),
        catch: (cause) => new SqlError({ cause }),
      });
      const identityKey = projection.identityKey(identity);
      return this.projectionRows.get(projectionRowKey(spec.scope, spec.kind, identityKey)) ?? null;
    });
  }

  projectionList(spec: {
    readonly kind: string;
    readonly scope: string;
    readonly limit?: number;
    readonly afterKey?: string;
  }): Effect.Effect<
    ReadonlyArray<MaterializedProjectionRow>,
    SqlError | UnregisteredProjectionKind
  > {
    return Effect.gen(this, function* () {
      const registry = yield* this.projectionRegistryEffect().pipe(
        Effect.mapError((cause) => new SqlError({ cause })),
      );
      yield* getProjection(registry, spec.kind);
      const limit = normalizeProjectionLimit(spec.limit);
      return Array.from(this.projectionRows.values())
        .filter((row) => {
          if (row.scope !== spec.scope || row.kind !== spec.kind) return false;
          if (spec.afterKey !== undefined && row.identityKey <= spec.afterKey) return false;
          return true;
        })
        .sort((left, right) => left.identityKey.localeCompare(right.identityKey))
        .slice(0, limit);
    });
  }

  projectionStatus(spec: {
    readonly kind: string;
    readonly scope: string;
  }): Effect.Effect<MaterializedProjectionStatus, SqlError | UnregisteredProjectionKind> {
    return Effect.gen(this, function* () {
      const registry = yield* this.projectionRegistryEffect().pipe(
        Effect.mapError((cause) => new SqlError({ cause })),
      );
      const projection = yield* getProjection(registry, spec.kind);
      const meta = this.projectionMeta.get(projectionMetaKey(spec.scope, spec.kind));
      if (meta === undefined) {
        return {
          kind: spec.kind,
          scope: spec.scope,
          version: projection.version,
          status: "current" as const,
          lastAppliedEventId: 0,
          lastRebuiltEventId: null,
          updatedAt: null,
        };
      }
      return {
        kind: spec.kind,
        scope: spec.scope,
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
    readonly scope: string;
  }): Effect.Effect<
    MaterializedProjectionRebuildResult,
    | SqlError
    | UnregisteredProjectionKind
    | ProjectionApplicationError
    | ProjectionReducerReturnedThenable
  > {
    return Effect.gen(this, function* () {
      const registry = yield* this.projectionRegistryEffect().pipe(
        Effect.mapError((cause) => new SqlError({ cause })),
      );
      const projection = yield* getProjection(registry, spec.kind);
      const rows = cloneProjectionRows(this.projectionRows);
      const meta = cloneProjectionMeta(this.projectionMeta);
      for (const key of rows.keys()) {
        const row = rows.get(key);
        if (row?.scope === spec.scope && row.kind === spec.kind) rows.delete(key);
      }
      meta.delete(projectionMetaKey(spec.scope, spec.kind));
      const events = this.rows.filter(
        (event) => event.scope === spec.scope && projection.eventKinds.includes(event.kind),
      );
      yield* this.applyProjectionEventsTo(rows, meta, events, (eventKind) =>
        projection.eventKinds.includes(eventKind) ? [projection] : [],
      );
      const last = events.at(-1) ?? null;
      const statusKey = projectionMetaKey(spec.scope, spec.kind);
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
        (row) => row.scope === spec.scope && row.kind === spec.kind,
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
    const subscription: EventSink = {
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

  fanoutDiagnostics(): ReadonlyArray<InMemoryFanoutDiagnostic> {
    return [...this.fanoutDiagnosticsLog];
  }

  snapshot(scope?: string, opts: EventQueryOptions = {}): ReadonlyArray<LedgerEvent> {
    const afterId = normalizeNonNegativeInteger(opts.afterId, 0);
    const limit =
      opts.limit === undefined
        ? DEFAULT_EVENT_LIMIT
        : Math.max(0, Math.min(MAX_EVENT_LIMIT, normalizeNonNegativeInteger(opts.limit, 0)));
    const kinds =
      opts.kinds === undefined
        ? undefined
        : new Set(Array.from(new Set(opts.kinds)).filter((kind) => kind.length > 0));
    const selected = this.rows.filter((row) => {
      if (scope !== undefined && row.scope !== scope) return false;
      if (row.id <= afterId) return false;
      if (kinds !== undefined && kinds.size > 0 && !kinds.has(row.kind)) return false;
      return true;
    });
    return selected.slice(0, limit);
  }

  streamSnapshot(
    scope: string,
    opts: Pick<EventQueryOptions, "afterId" | "kinds"> = {},
  ): ReadonlyArray<LedgerEvent> {
    const afterId = normalizeNonNegativeInteger(opts.afterId, 0);
    const kinds =
      opts.kinds === undefined
        ? undefined
        : new Set(Array.from(new Set(opts.kinds)).filter((kind) => kind.length > 0));
    return this.rows.filter((row) => {
      if (row.scope !== scope) return false;
      if (row.id <= afterId) return false;
      if (kinds !== undefined && kinds.size > 0 && !kinds.has(row.kind)) return false;
      return true;
    });
  }

  commitEvents(
    specs: ReadonlyArray<InMemoryEventSpec>,
  ): Effect.Effect<ReadonlyArray<LedgerEvent>, JsonStringifyError | SqlError> {
    return this.commitPrepared(() => specs);
  }

  commitPrepared(
    makeSpecs: (nextEventId: number) => ReadonlyArray<InMemoryEventSpec>,
  ): Effect.Effect<ReadonlyArray<LedgerEvent>, JsonStringifyError | SqlError> {
    return Effect.gen(this, function* () {
      const startId = this.nextEventId;
      const specs = makeSpecs(startId);
      yield* Effect.forEach(specs, (spec) => validateSerializablePayload(spec.payload), {
        discard: true,
      });
      const committed = specs.map(
        (spec, index): LedgerEvent => ({
          id: startId + index,
          ts: spec.ts ?? startId + index,
          kind: spec.kind,
          scope: spec.scope,
          payload: spec.payload,
        }),
      );
      const projectionState = yield* this.prepareProjectionState(committed);
      yield* Effect.sync(() => {
        this.nextEventId += committed.length;
        this.rows.push(...committed);
        this.replaceProjectionState(projectionState.rows, projectionState.meta);
      });
      yield* this.fireMany(committed);
      return committed;
    });
  }

  commitTriggerIntent(
    scope: string,
    fireAt: number,
    registry: TriggerRegistry,
    triggerKind: string,
    makeSpec: (trigger: {
      readonly kind: string;
      readonly intentEventKind: string;
    }) => InMemoryEventSpec,
    stageOutbox?: (event: LedgerEvent) => DispatchOutboxRow,
  ): Effect.Effect<LedgerEvent, JsonStringifyError | SqlError | UnregisteredDurableTriggerKind> {
    return Effect.gen(this, function* () {
      const trigger = yield* getDurableTrigger(registry, triggerKind);
      const spec = makeSpec(trigger);
      yield* validateSerializablePayload(spec.payload);
      const event: LedgerEvent = {
        id: this.nextEventId,
        ts: spec.ts ?? this.nextEventId,
        kind: spec.kind,
        scope,
        payload: spec.payload,
      };
      const projectionState = yield* this.prepareProjectionState([event]);
      const stagedOutbox = stageOutbox?.(event);
      const committed = yield* Effect.sync(() => {
        this.nextEventId += 1;
        this.rows.push(event);
        this.replaceProjectionState(projectionState.rows, projectionState.meta);
        const dueId = this.nextDueWorkId++;
        this.dueWork.push({
          id: dueId,
          fireAt,
          kind: trigger.kind,
          payload: durableTriggerDuePayload(event.id),
          completedAt: null,
          claimedAt: null,
          claimToken: null,
          claimDeadlineAt: null,
          redriveCount: 0,
          cancelRequestedAt: null,
          cancelReason: null,
          cancelledAt: null,
        });
        if (stagedOutbox !== undefined) this.applyOutboxPatch({ _tag: "add", row: stagedOutbox });
        return event;
      });
      yield* this.fireMany([committed]);
      return committed;
    });
  }

  schedule(
    scope: string,
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
    return Effect.gen(this, function* () {
      const payload = scheduledEventIntentPayload(eventKind, data);
      const committed = yield* this.commitTriggerIntent(
        scope,
        at,
        registry,
        triggerKind,
        (trigger) => ({
          ts: intentTs,
          kind: trigger.intentEventKind,
          scope,
          payload,
        }),
      );
      return { id: committed.id };
    });
  }

  eventById(intentEventId: number, kind: string): LedgerEvent | null {
    return this.rows.find((row) => row.id === intentEventId && row.kind === kind) ?? null;
  }

  duePending(now: number): ReadonlyArray<InMemoryDueWorkRow> {
    return this.dueWork
      .filter((row) => row.completedAt === null && row.fireAt <= now)
      .sort((a, b) => a.fireAt - b.fireAt || a.id - b.id);
  }

  dueClaimable(now: number): ReadonlyArray<InMemoryDueWorkRow> {
    return this.dueWork
      .filter(
        (row) =>
          row.completedAt === null &&
          row.fireAt <= now &&
          (row.claimToken === null || (row.claimDeadlineAt !== null && row.claimDeadlineAt <= now)),
      )
      .sort((a, b) => a.fireAt - b.fireAt || a.id - b.id);
  }

  nextDueAt(): number | null {
    let minDueAt: number | null = null;
    for (const row of this.dueWork) {
      if (row.completedAt !== null) continue;
      const next = row.claimToken === null ? row.fireAt : row.claimDeadlineAt;
      if (next === null) continue;
      if (minDueAt === null || next < minDueAt) minDueAt = next;
    }
    return minDueAt;
  }

  completeDueWork(id: number, completedAt: number): void {
    const row = this.dueWork.find((candidate) => candidate.id === id);
    if (row !== undefined && row.completedAt === null) {
      row.completedAt = completedAt;
    }
  }

  addOutbox(row: DispatchOutboxRow): void {
    this.outbox.set(row.outboundEventId, row);
  }

  private applyOutboxPatch(patch: InMemoryOutboxPatch): void {
    if (patch._tag === "add") {
      this.outbox.set(patch.row.outboundEventId, patch.row);
      return;
    }
    const row = this.outbox.get(patch.outboundEventId);
    if (row === undefined || row.deliveredEventId !== null) return;
    row.attempts = patch.attempts;
    if (patch._tag === "delivered") {
      row.deliveredEventId = patch.deliveredEventId;
      row.lastError = null;
      return;
    }
    row.lastError = patch.lastError;
  }

  addDueWork(kind: string, intentEventId: number, fireAt: number): number {
    const id = this.nextDueWorkId++;
    this.dueWork.push({
      id,
      fireAt,
      kind,
      payload: durableTriggerDuePayload(intentEventId),
      completedAt: null,
      claimedAt: null,
      claimToken: null,
      claimDeadlineAt: null,
      redriveCount: 0,
      cancelRequestedAt: null,
      cancelReason: null,
      cancelledAt: null,
    });
    return id;
  }

  claimDueWork(
    row: InMemoryDueWorkRow,
    now: number,
    token: string,
    deadlineAt: number,
  ): InMemoryDueWorkRow | null {
    if (row.completedAt !== null || row.fireAt > now) return null;
    if (row.claimToken !== null && (row.claimDeadlineAt === null || row.claimDeadlineAt > now)) {
      return null;
    }
    const redrive = row.claimToken !== null;
    row.claimedAt = now;
    row.claimToken = token;
    row.claimDeadlineAt = deadlineAt;
    if (redrive) row.redriveCount += 1;
    return row;
  }

  dueByTriggerIntent(kind: string, intentEventId: number): ReadonlyArray<InMemoryDueWorkRow> {
    return this.dueWork
      .filter(
        (row) =>
          row.completedAt === null &&
          row.kind === kind &&
          row.payload.intentEventId === intentEventId,
      )
      .sort((a, b) => a.fireAt - b.fireAt || a.id - b.id);
  }

  requestCancellation(row: InMemoryDueWorkRow, now: number, reason?: string): boolean {
    if (row.completedAt !== null) return false;
    row.cancelRequestedAt ??= now;
    row.cancelReason ??= reason ?? null;
    if (row.claimToken !== null && (row.claimDeadlineAt === null || row.claimDeadlineAt > now)) {
      row.claimDeadlineAt = now;
    }
    return true;
  }

  stuckDueWork(now: number): ReadonlyArray<{
    readonly dueWorkId: number;
    readonly triggerKind: string;
    readonly intentEventId: number;
    readonly claimDeadlineAt: number;
    readonly redriveCount: number;
  }> {
    return this.dueWork
      .filter(
        (row) =>
          row.completedAt === null &&
          row.claimToken !== null &&
          row.claimDeadlineAt !== null &&
          row.claimDeadlineAt <= now,
      )
      .sort((a, b) => (a.claimDeadlineAt ?? 0) - (b.claimDeadlineAt ?? 0) || a.id - b.id)
      .map((row) => ({
        dueWorkId: row.id,
        triggerKind: row.kind,
        intentEventId: row.payload.intentEventId,
        claimDeadlineAt: row.claimDeadlineAt ?? now,
        redriveCount: row.redriveCount,
      }));
  }

  durableProcessLifecycle(): Effect.Effect<ReadonlyArray<DurableProcessLifecycleState>, SqlError> {
    return Effect.gen(this, function* () {
      const states: DurableProcessLifecycleState[] = [];
      for (const row of [...this.dueWork].sort((left, right) => left.id - right.id)) {
        const result = durableProcessLifecycleState({
          id: row.id,
          fireAt: row.fireAt,
          kind: row.kind,
          intentEventId: row.payload.intentEventId,
          completedAt: row.completedAt,
          claimedAt: row.claimedAt,
          claimToken: row.claimToken,
          claimDeadlineAt: row.claimDeadlineAt,
          redriveCount: row.redriveCount,
          cancelRequestedAt: row.cancelRequestedAt,
          cancelReason: row.cancelReason,
          cancelledAt: row.cancelledAt,
        });
        if (!result.ok) {
          return yield* Effect.fail(new SqlError({ cause: result.cause }));
        }
        states.push(result.state);
      }
      return states;
    });
  }

  pendingOutboxByIntent(intentEventId: number): DispatchOutboxRow | null {
    const row = this.outbox.get(intentEventId);
    if (row === undefined || row.deliveredEventId !== null) return null;
    return row;
  }

  commitAttachedStreamTerminal<Terminal>(
    scope: string,
    streamRef: string,
    kind: string,
    now: number,
    signal: AbortSignal,
    terminal: AttachedStreamTerminal<Terminal>,
    commit: (terminal: AttachedStreamTerminal<Terminal>, tx: AttachedStreamTx) => string | null,
  ): Effect.Effect<{ readonly events: ReadonlyArray<LedgerEvent> }, JsonStringifyError | SqlError> {
    return Effect.gen(this, function* () {
      const startId = this.nextEventId;
      const written: LedgerEvent[] = [];
      const tx: AttachedStreamTx = {
        scope,
        streamRef,
        now,
        signal,
        events: (opts = {}) => {
          const afterId = normalizeNonNegativeInteger(opts.afterId, 0);
          const kinds =
            opts.kinds === undefined
              ? undefined
              : new Set(Array.from(new Set(opts.kinds)).filter((entry) => entry.length > 0));
          return [...this.rows, ...written].filter((event) => {
            if (event.scope !== scope) return false;
            if (event.id <= afterId) return false;
            if (kinds !== undefined && kinds.size > 0 && !kinds.has(event.kind)) return false;
            return true;
          });
        },
        insertEvent: (spec) => {
          const event: LedgerEvent = {
            id: startId + written.length,
            ts: spec.ts ?? now,
            kind: spec.kind,
            scope,
            payload: spec.payload,
          };
          written.push(event);
          return event;
        },
      };
      const commitFailure = yield* Effect.try({
        try: () => commit(terminal, tx),
        catch: (cause) => new SqlError({ cause }),
      });
      if (commitFailure !== null) {
        return yield* Effect.fail(new SqlError({ cause: commitFailure }));
      }
      yield* Effect.forEach(written, (event) => validateSerializablePayload(event.payload), {
        discard: true,
      });
      const projectionState = yield* this.prepareProjectionState(written);
      yield* Effect.sync(() => {
        this.nextEventId += written.length;
        this.rows.push(...written);
        this.replaceProjectionState(projectionState.rows, projectionState.meta);
      });
      const events = written.length === 0 ? [] : this.rows.slice(this.rows.length - written.length);
      yield* this.fireMany(events);
      return { events };
    });
  }

  commitTrigger(
    scope: string,
    row: InMemoryDueWorkRow,
    now: number,
    hasTrigger: (kind: string) => boolean,
    commit: (tx: TriggerTx) => DurableTriggerCommitReturnedThenable | null,
    options: {
      readonly claimToken?: string;
      readonly requireUnclaimed?: boolean;
      readonly cancelled?: boolean;
      readonly signal?: AbortSignal;
      readonly acquireMode?: "normal" | "redrive";
    } = {},
  ): Effect.Effect<
    { readonly completed: boolean; readonly events: ReadonlyArray<LedgerEvent> },
    | JsonStringifyError
    | SqlError
    | UnregisteredDurableTriggerKind
    | DurableTriggerCommitReturnedThenable
  > {
    return Effect.gen(this, function* () {
      if (row.completedAt !== null) return { completed: false, events: [] };
      if (options.claimToken !== undefined && row.claimToken !== options.claimToken) {
        return { completed: false, events: [] };
      }
      if (options.requireUnclaimed === true && row.claimToken !== null) {
        return { completed: false, events: [] };
      }
      const startId = this.nextEventId;
      const written: LedgerEvent[] = [];
      let rejected: UnregisteredDurableTriggerKind | null = null;
      const due: Array<{
        readonly triggerKind: string;
        readonly fireAt: number;
        readonly intentEventId: number;
      }> = [];
      const outboxPatches: InMemoryOutboxPatch[] = [];
      const tx: TriggerTx = {
        scope,
        now,
        dueWorkId: row.id,
        intentEventId: row.payload.intentEventId,
        signal: options.signal ?? new AbortController().signal,
        acquireMode: options.acquireMode ?? "normal",
        events: (opts = {}) => {
          const afterId = normalizeNonNegativeInteger(opts.afterId, 0);
          const kinds =
            opts.kinds === undefined
              ? undefined
              : new Set(Array.from(new Set(opts.kinds)).filter((kind) => kind.length > 0));
          return [...this.rows, ...written].filter((event) => {
            if (event.scope !== scope) return false;
            if (event.id <= afterId) return false;
            if (kinds !== undefined && kinds.size > 0 && !kinds.has(event.kind)) return false;
            return true;
          });
        },
        insertEvent: (spec) => {
          const event: LedgerEvent = {
            id: startId + written.length,
            ts: spec.ts ?? now,
            kind: spec.kind,
            scope,
            payload: spec.payload,
          };
          written.push(event);
          return event;
        },
        enqueue: (spec) => {
          if (!hasTrigger(spec.triggerKind)) {
            rejected = new UnregisteredDurableTriggerKind({ kind: spec.triggerKind });
            return {
              id: startId + written.length,
              ts: spec.ts ?? now,
              kind: spec.intentEventKind,
              scope,
              payload: spec.payload,
            };
          }
          const event: LedgerEvent = {
            id: startId + written.length,
            ts: spec.ts ?? now,
            kind: spec.intentEventKind,
            scope,
            payload: spec.payload,
          };
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
        markOutboxDelivered: (spec: {
          readonly outboundEventId: number;
          readonly deliveredEventId: number;
          readonly attempts: number;
        }) => {
          outboxPatches.push({ _tag: "delivered", ...spec });
        },
        markOutboxFailed: (spec: {
          readonly outboundEventId: number;
          readonly attempts: number;
          readonly lastError: string;
        }) => {
          outboxPatches.push({ _tag: "failed", ...spec });
        },
      } as TriggerTx & {
        readonly markOutboxDelivered: (spec: {
          readonly outboundEventId: number;
          readonly deliveredEventId: number;
          readonly attempts: number;
        }) => void;
        readonly markOutboxFailed: (spec: {
          readonly outboundEventId: number;
          readonly attempts: number;
          readonly lastError: string;
        }) => void;
      };
      const commitFailure = yield* Effect.try({
        try: () => commit(tx),
        catch: (cause) =>
          cause instanceof DurableTriggerCommitReturnedThenable ? cause : new SqlError({ cause }),
      });
      if (commitFailure !== null) {
        return yield* Effect.fail(commitFailure);
      }
      if (rejected !== null) {
        return yield* Effect.fail(rejected);
      }
      yield* Effect.forEach(written, (event) => validateSerializablePayload(event.payload), {
        discard: true,
      });
      const projectionState = yield* this.prepareProjectionState(written);
      yield* Effect.sync(() => {
        this.nextEventId += written.length;
        this.rows.push(...written);
        this.replaceProjectionState(projectionState.rows, projectionState.meta);
        row.completedAt = now;
        if (options.cancelled === true) row.cancelledAt = now;
        for (const spec of due) {
          const dueId = this.nextDueWorkId++;
          this.dueWork.push({
            id: dueId,
            fireAt: spec.fireAt,
            kind: spec.triggerKind,
            payload: durableTriggerDuePayload(spec.intentEventId),
            completedAt: null,
            claimedAt: null,
            claimToken: null,
            claimDeadlineAt: null,
            redriveCount: 0,
            cancelRequestedAt: null,
            cancelReason: null,
            cancelledAt: null,
          });
        }
        for (const patch of outboxPatches) this.applyOutboxPatch(patch);
      });
      const events = written.length === 0 ? [] : this.rows.slice(this.rows.length - written.length);
      yield* this.fireMany(events);
      return { completed: true, events };
    });
  }

  private fireMany(events: ReadonlyArray<LedgerEvent>): Effect.Effect<void> {
    if (events.length === 0) return Effect.void;
    const fireSinks = Effect.sync(() => {
      const sinks = Array.from(this.sinks);
      for (const event of events) {
        for (const subscription of sinks) {
          if (subscription.kinds === undefined || subscription.kinds.has(event.kind)) {
            try {
              subscription.sink(event);
            } catch (cause) {
              this.fanoutDiagnosticsLog.push({
                phase: "sink",
                eventId: event.id,
                kind: event.kind,
                scope: event.scope,
                message: describeFanoutCause(cause),
              });
            }
          }
        }
      }
    });
    return fireSinks.pipe(
      Effect.andThen(
        Effect.forEach(
          events,
          (event) => {
            const handlers = this.handlers.get(event.kind);
            if (handlers === undefined || handlers.size === 0) return Effect.void;
            return fireBackendEventHandlers(
              Array.from(handlers),
              eventToRpc(event),
              "event handler",
            );
          },
          { concurrency: 1, discard: true },
        ),
      ),
    );
  }
}

export const createInMemoryBackendState = (
  options: InMemoryBackendStateOptions = {},
): InMemoryBackendState => new InMemoryBackendState(options);
