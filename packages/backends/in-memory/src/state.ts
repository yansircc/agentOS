import { Effect } from "effect";
import { JsonStringifyError, SqlError } from "@agent-os/kernel/errors";
import type {
  EventHandler,
  EventQueryOptions,
  LedgerEvent,
  LedgerEventRpc,
} from "@agent-os/kernel/types";
import {
  durableTriggerDuePayload,
  fireBackendEventHandlers,
  type IntentPointerDuePayload,
} from "@agent-os/backend-protocol";
import {
  scheduledEventIntentPayload,
  type AnyDurableTrigger,
  type TriggerTx,
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

interface InMemoryDueWorkRow {
  readonly id: number;
  readonly fireAt: number;
  readonly kind: string;
  readonly payload: IntentPointerDuePayload;
  completedAt: number | null;
}

export interface InMemoryBackendStateOptions {
  readonly handlers?: Iterable<InMemoryEventHandlerRegistration>;
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

const eventToRpc = (event: LedgerEvent): LedgerEventRpc => ({
  id: event.id,
  ts: event.ts,
  kind: event.kind,
  scope: event.scope,
  payload: event.payload,
});

export class InMemoryBackendState {
  private nextEventId = 1;
  private nextDueWorkId = 1;
  private readonly rows: LedgerEvent[] = [];
  private readonly sinks = new Set<EventSink>();
  private readonly handlers = new Map<string, Set<EventHandler>>();
  private readonly dueWork: InMemoryDueWorkRow[] = [];
  private readonly outbox = new Map<number, DispatchOutboxRow>();

  constructor(options: InMemoryBackendStateOptions = {}) {
    for (const registration of options.handlers ?? []) {
      this.addHandler(registration.kind, registration.handler);
    }
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
  ): Effect.Effect<ReadonlyArray<LedgerEvent>, JsonStringifyError> {
    return this.commitPrepared(() => specs);
  }

  commitPrepared(
    makeSpecs: (nextEventId: number) => ReadonlyArray<InMemoryEventSpec>,
  ): Effect.Effect<ReadonlyArray<LedgerEvent>, JsonStringifyError> {
    return Effect.gen(this, function* () {
      const startId = this.nextEventId;
      const specs = makeSpecs(startId);
      yield* Effect.forEach(specs, (spec) => validateSerializablePayload(spec.payload), {
        discard: true,
      });
      const committed = yield* Effect.sync(() => {
        const committed = specs.map(
          (spec, index): LedgerEvent => ({
            id: startId + index,
            ts: spec.ts ?? startId + index,
            kind: spec.kind,
            scope: spec.scope,
            payload: spec.payload,
          }),
        );
        this.nextEventId += committed.length;
        this.rows.push(...committed);
        return committed;
      });
      yield* this.fireMany(committed);
      return committed;
    });
  }

  schedule(
    scope: string,
    intentTs: number,
    at: number,
    trigger: Pick<AnyDurableTrigger, "kind" | "intentEventKind">,
    eventKind: string,
    data: unknown,
  ): Effect.Effect<{ readonly id: number }, JsonStringifyError> {
    return Effect.gen(this, function* () {
      const payload = scheduledEventIntentPayload(eventKind, data);
      yield* validateSerializablePayload(payload);
      const committed = yield* Effect.sync(() => {
        const event: LedgerEvent = {
          id: this.nextEventId,
          ts: intentTs,
          kind: trigger.intentEventKind,
          scope,
          payload,
        };
        this.nextEventId += 1;
        this.rows.push(event);
        const dueId = this.nextDueWorkId++;
        this.dueWork.push({
          id: dueId,
          fireAt: at,
          kind: trigger.kind,
          payload: durableTriggerDuePayload(event.id),
          completedAt: null,
        });
        return event;
      });
      yield* this.fireMany([committed]);
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

  nextDueAt(): number | null {
    let minDueAt: number | null = null;
    for (const row of this.dueWork) {
      if (row.completedAt !== null) continue;
      if (minDueAt === null || row.fireAt < minDueAt) minDueAt = row.fireAt;
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

  addDueWork(kind: string, intentEventId: number, fireAt: number): number {
    const id = this.nextDueWorkId++;
    this.dueWork.push({
      id,
      fireAt,
      kind,
      payload: durableTriggerDuePayload(intentEventId),
      completedAt: null,
    });
    return id;
  }

  pendingOutboxByIntent(intentEventId: number): DispatchOutboxRow | null {
    const row = this.outbox.get(intentEventId);
    if (row === undefined || row.deliveredEventId !== null) return null;
    return row;
  }

  commitTrigger(
    scope: string,
    row: InMemoryDueWorkRow,
    now: number,
    hasTrigger: (kind: string) => boolean,
    commit: (tx: TriggerTx) => void,
  ): Effect.Effect<
    { readonly completed: boolean; readonly events: ReadonlyArray<LedgerEvent> },
    JsonStringifyError | SqlError
  > {
    return Effect.gen(this, function* () {
      if (row.completedAt !== null) return { completed: false, events: [] };
      const startId = this.nextEventId;
      const written: LedgerEvent[] = [];
      let rejected: string | null = null;
      const due: Array<{
        readonly triggerKind: string;
        readonly fireAt: number;
        readonly intentEventId: number;
      }> = [];
      const tx: TriggerTx = {
        scope,
        now,
        dueWorkId: row.id,
        intentEventId: row.payload.intentEventId,
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
            rejected = `unregistered durable trigger kind: ${spec.triggerKind}`;
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
      };
      yield* Effect.try({
        try: () => commit(tx),
        catch: (cause) => new SqlError({ cause }),
      });
      if (rejected !== null) {
        return yield* Effect.fail(new SqlError({ cause: rejected }));
      }
      yield* Effect.forEach(written, (event) => validateSerializablePayload(event.payload), {
        discard: true,
      });
      yield* Effect.sync(() => {
        this.nextEventId += written.length;
        this.rows.push(...written);
        row.completedAt = now;
        for (const spec of due) {
          const dueId = this.nextDueWorkId++;
          this.dueWork.push({
            id: dueId,
            fireAt: spec.fireAt,
            kind: spec.triggerKind,
            payload: durableTriggerDuePayload(spec.intentEventId),
            completedAt: null,
          });
        }
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
            subscription.sink(event);
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
