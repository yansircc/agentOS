import { Clock, Effect, Layer } from "effect";
import {
  CapabilityRejected,
  DispatchScopeMismatch,
  DispatchTargetNotFound,
  InvalidResourceAmount,
  JsonStringifyError,
  ResourceInsufficient,
  ResourceReservationClosed,
  ResourceReservationNotFound,
  SqlError,
  UnsupportedScopeRef,
  UpstreamFailure,
  isCoreClaimedEventKind,
} from "@agent-os/kernel/errors";
import {
  isScopeRef,
  makeOperationRef,
  makePreClaim,
  settleLivedClaim,
} from "@agent-os/kernel/effect-claim";
import { materialRefKey } from "@agent-os/kernel/material-ref";
import type { LlmRequest, LlmResponse } from "@agent-os/kernel/llm";
import {
  Admission,
  Dispatch,
  Ledger,
  LlmTransport,
  Quota,
  Resources,
  Scheduler,
  decideTier,
  projectLease,
  routeFingerprint,
  validateAgainstSchema,
  type AdmissionImpact,
  type AdmissionRow,
  type AttemptKey,
  type AttemptResult,
  type AttemptSpec,
  type CapabilityLease,
  type DispatchEnvelope,
  type DispatchReceiver,
  type DispatchTargetSpec,
  type EventHandler,
  type EventQueryOptions,
  type GrantResult,
  type InvalidateSpec,
  type LedgerEvent,
  type LedgerEventRpc,
  type Outcome,
  type ResourceProjection,
  type TraceContext,
} from "@agent-os/runtime";

const DEFAULT_EVENT_LIMIT = 1000;
const MAX_EVENT_LIMIT = 1000;
const IN_MEMORY_ADAPTER_VERSION = "1.0.0";
const DISPATCH_OUTBOUND_REQUESTED = "dispatch.outbound.requested";
const DISPATCH_OUTBOUND_DELIVERED = "dispatch.outbound.delivered";
const DISPATCH_OUTBOUND_FAILED = "dispatch.outbound.failed";
const DISPATCH_INBOUND_ACCEPTED = "dispatch.inbound.accepted";

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

interface ScheduledRow {
  readonly id: number;
  readonly fireAt: number;
  readonly eventKind: string;
  readonly data: unknown;
  firedEventId: number | null;
}

interface DispatchRequestedPayload {
  readonly target: DispatchTargetSpec;
  readonly event: string;
  readonly data: unknown;
  readonly idempotencyKey: string;
  readonly claim: ReturnType<typeof makePreClaim>;
  readonly traceContext?: TraceContext;
}

interface DispatchOutboxRow {
  readonly outboundEventId: number;
  readonly sourceScope: string;
  readonly requested: DispatchRequestedPayload;
  attempts: number;
  nextAttemptAt: number;
  deliveredEventId: number | null;
  lastError: string | null;
}

export type InMemoryDispatchTargetRegistry = Readonly<
  Record<string, Readonly<Record<string, DispatchReceiver>>>
>;

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

const copyTraceContext = (traceContext: TraceContext | undefined): TraceContext | undefined => {
  if (traceContext === undefined) return undefined;
  return {
    ...(traceContext.traceparent === undefined ? {} : { traceparent: traceContext.traceparent }),
    ...(traceContext.tracestate === undefined ? {} : { tracestate: traceContext.tracestate }),
  };
};

const describeCause = (cause: unknown): string => {
  if (typeof cause === "string") return cause;
  if (cause instanceof Error) return `${cause.name}: ${cause.message}`;
  if (typeof cause === "object" && cause !== null && "_tag" in cause) {
    return String((cause as { readonly _tag: unknown })._tag);
  }
  return Object.prototype.toString.call(cause);
};

const retryDelayMs = (attempt: number): number =>
  Math.min(60_000, 1_000 * 2 ** Math.min(Math.max(attempt - 1, 0), 6));

const eventToRpc = (event: LedgerEvent): LedgerEventRpc => ({
  id: event.id,
  ts: event.ts,
  kind: event.kind,
  scope: event.scope,
  payload: event.payload,
});

export class InMemoryBackendState {
  private nextEventId = 1;
  private nextScheduledId = 1;
  private readonly rows: LedgerEvent[] = [];
  private readonly sinks = new Set<EventSink>();
  private readonly handlers = new Map<string, Set<EventHandler>>();
  private readonly scheduled: ScheduledRow[] = [];
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
            ts: spec.ts ?? Date.now(),
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
    at: number,
    eventKind: string,
    data: unknown,
  ): Effect.Effect<{ readonly id: number }, JsonStringifyError> {
    return Effect.gen(this, function* () {
      yield* validateSerializablePayload(data);
      return yield* Effect.sync(() => {
        const id = this.nextScheduledId++;
        this.scheduled.push({ id, fireAt: at, eventKind, data, firedEventId: null });
        return { id };
      });
    });
  }

  dueScheduled(now: number): ReadonlyArray<ScheduledRow> {
    return this.scheduled
      .filter((row) => row.firedEventId === null && row.fireAt <= now)
      .sort((a, b) => a.fireAt - b.fireAt || a.id - b.id);
  }

  nextScheduledAt(): number | null {
    let next: number | null = null;
    for (const row of this.scheduled) {
      if (row.firedEventId !== null) continue;
      if (next === null || row.fireAt < next) next = row.fireAt;
    }
    return next;
  }

  markScheduledFired(id: number, eventId: number): void {
    const row = this.scheduled.find((candidate) => candidate.id === id);
    if (row !== undefined && row.firedEventId === null) {
      row.firedEventId = eventId;
    }
  }
  addOutbox(row: DispatchOutboxRow): void {
    this.outbox.set(row.outboundEventId, row);
  }

  dueOutbox(now: number): ReadonlyArray<DispatchOutboxRow> {
    return Array.from(this.outbox.values())
      .filter((row) => row.deliveredEventId === null && row.nextAttemptAt <= now)
      .sort((a, b) => a.nextAttemptAt - b.nextAttemptAt || a.outboundEventId - b.outboundEventId);
  }

  nextOutboxAt(): number | null {
    let next: number | null = null;
    for (const row of this.outbox.values()) {
      if (row.deliveredEventId !== null) continue;
      if (next === null || row.nextAttemptAt < next) next = row.nextAttemptAt;
    }
    return next;
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
            const rpcEvent = eventToRpc(event);
            return Effect.forEach(
              Array.from(handlers),
              (handler) =>
                Effect.tryPromise({
                  try: () => handler(rpcEvent),
                  catch: (cause) => cause,
                }).pipe(
                  Effect.timeout("5 seconds"),
                  Effect.catchAll((cause) =>
                    Effect.sync(() => {
                      console.error(
                        `[agent-os] in-memory handler for "${event.kind}" failed:`,
                        cause,
                      );
                    }),
                  ),
                ),
              { concurrency: 1, discard: true },
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

export const InMemoryLedgerLive = (state: InMemoryBackendState): Layer.Layer<Ledger> =>
  Layer.succeed(Ledger, {
    log: (kind, payload, scope) =>
      Effect.gen(function* () {
        const ts = yield* Clock.currentTimeMillis;
        const [event] = yield* state.commitEvents([{ ts, kind, scope, payload }]);
        return event!;
      }),
    events: (scope, opts = {}) => Effect.succeed(state.snapshot(scope, opts)),
    streamSnapshot: (scope, opts = {}) => Effect.succeed(state.streamSnapshot(scope, opts)),
  });

export const InMemorySchedulerLive = (
  state: InMemoryBackendState,
  scope: string,
): Layer.Layer<Scheduler> =>
  Layer.succeed(Scheduler, {
    findNextPending: () => Effect.succeed(state.nextScheduledAt()),
    schedule: (at, eventKind, data) => state.schedule(at, eventKind, data),
    fireDue: (now) =>
      Effect.gen(function* () {
        let fired = 0;
        for (const row of state.dueScheduled(now)) {
          const [event] = yield* state.commitEvents([
            { ts: now, kind: row.eventKind, scope, payload: row.data },
          ]);
          state.markScheduledFired(row.id, event!.id);
          fired += 1;
        }
        return { next: state.nextScheduledAt(), fired };
      }),
  });

interface ReservationState {
  readonly reservationId: string;
  readonly key: string;
  readonly amount: number;
  readonly idempotencyKey: string;
  readonly status: "active" | "consumed" | "released";
}

interface ProjectedResourceState {
  readonly byId: Map<string, ReservationState>;
  readonly byIdempotencyKey: Map<string, ReservationState>;
  readonly byKey: Map<string, ResourceProjection>;
}

const emptyResourceProjection = (): ResourceProjection => ({
  available: 0,
  reserved: 0,
  consumed: 0,
});

const positiveAmount = (amount: number): Effect.Effect<void, InvalidResourceAmount> =>
  Number.isFinite(amount) && amount > 0
    ? Effect.void
    : Effect.fail(new InvalidResourceAmount({ amount }));

type DecodeResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly cause: unknown };

const decodeOk = <T>(value: T): DecodeResult<T> => ({ ok: true, value });

const decodeFail = <T = never>(message: string): DecodeResult<T> => ({
  ok: false,
  cause: new TypeError(message),
});

const recordOf = (value: unknown, label: string): DecodeResult<Record<string, unknown>> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return decodeFail(`${label} must be object`);
  }
  return decodeOk(value as Record<string, unknown>);
};

const finiteNumberField = (
  record: Record<string, unknown>,
  field: string,
): DecodeResult<number> => {
  const value = record[field];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return decodeFail(`${field} must be finite number`);
  }
  return decodeOk(value);
};

const stringField = (record: Record<string, unknown>, field: string): DecodeResult<string> => {
  const value = record[field];
  if (typeof value !== "string") return decodeFail(`${field} must be string`);
  return decodeOk(value);
};

const addResourceProjection = (
  map: Map<string, ResourceProjection>,
  key: string,
  delta: Partial<ResourceProjection>,
): void => {
  const current = map.get(key) ?? emptyResourceProjection();
  map.set(key, {
    available: current.available + (delta.available ?? 0),
    reserved: current.reserved + (delta.reserved ?? 0),
    consumed: current.consumed + (delta.consumed ?? 0),
  });
};

const projectResources = (
  events: ReadonlyArray<LedgerEvent>,
): DecodeResult<ProjectedResourceState> => {
  const grants: Array<{ readonly key: string; readonly amount: number }> = [];
  const reservations = new Map<string, ReservationState>();
  const byIdempotencyKey = new Map<string, ReservationState>();

  for (const event of events) {
    if (!event.kind.startsWith("resource.")) continue;
    const payloadResult = recordOf(event.payload, event.kind);
    if (!payloadResult.ok) return payloadResult;
    const payload = payloadResult.value;
    switch (event.kind) {
      case "resource.granted": {
        const key = stringField(payload, "key");
        if (!key.ok) return key;
        const amount = finiteNumberField(payload, "amount");
        if (!amount.ok) return amount;
        grants.push({
          key: key.value,
          amount: amount.value,
        });
        break;
      }
      case "resource.reserved": {
        const reservationId = stringField(payload, "reservationId");
        if (!reservationId.ok) return reservationId;
        const key = stringField(payload, "key");
        if (!key.ok) return key;
        const amount = finiteNumberField(payload, "amount");
        if (!amount.ok) return amount;
        const idempotencyKey = stringField(payload, "idempotencyKey");
        if (!idempotencyKey.ok) return idempotencyKey;
        const reservation: ReservationState = {
          reservationId: reservationId.value,
          key: key.value,
          amount: amount.value,
          idempotencyKey: idempotencyKey.value,
          status: "active",
        };
        reservations.set(reservation.reservationId, reservation);
        byIdempotencyKey.set(reservation.idempotencyKey, reservation);
        break;
      }
      case "resource.reserve_rejected": {
        const key = stringField(payload, "key");
        if (!key.ok) return key;
        const amount = finiteNumberField(payload, "amount");
        if (!amount.ok) return amount;
        const idempotencyKey = stringField(payload, "idempotencyKey");
        if (!idempotencyKey.ok) return idempotencyKey;
        const available = finiteNumberField(payload, "available");
        if (!available.ok) return available;
        break;
      }
      case "resource.consumed":
      case "resource.released": {
        const reservationId = stringField(payload, "reservationId");
        if (!reservationId.ok) return reservationId;
        const existing = reservations.get(reservationId.value);
        if (existing !== undefined) {
          const next = {
            ...existing,
            status: event.kind === "resource.consumed" ? "consumed" : "released",
          } satisfies ReservationState;
          reservations.set(reservationId.value, next);
          byIdempotencyKey.set(next.idempotencyKey, next);
        }
        break;
      }
    }
  }

  const byKey = new Map<string, ResourceProjection>();
  for (const grant of grants) {
    addResourceProjection(byKey, grant.key, { available: grant.amount });
  }
  for (const reservation of reservations.values()) {
    if (reservation.status === "active") {
      addResourceProjection(byKey, reservation.key, {
        available: -reservation.amount,
        reserved: reservation.amount,
      });
    } else if (reservation.status === "consumed") {
      addResourceProjection(byKey, reservation.key, {
        available: -reservation.amount,
        consumed: reservation.amount,
      });
    }
  }

  return decodeOk({ byId: reservations, byIdempotencyKey, byKey });
};

const loadResourceState = (
  state: InMemoryBackendState,
  scope: string,
): Effect.Effect<ProjectedResourceState, SqlError> =>
  Effect.sync(() => projectResources(state.streamSnapshot(scope))).pipe(
    Effect.flatMap((result) =>
      result.ok ? Effect.succeed(result.value) : Effect.fail(new SqlError({ cause: result.cause })),
    ),
  );

export const InMemoryResourcesLive = (state: InMemoryBackendState): Layer.Layer<Resources> =>
  Layer.succeed(Resources, {
    grant: (scope, spec) =>
      Effect.gen(function* () {
        yield* positiveAmount(spec.amount);
        const ts = yield* Clock.currentTimeMillis;
        const [event] = yield* state.commitEvents([
          {
            ts,
            kind: "resource.granted",
            scope,
            payload: { key: spec.key, amount: spec.amount, ref: spec.ref },
          },
        ]);
        return { eventId: event!.id };
      }),

    reserve: (scope, spec) =>
      Effect.gen(function* () {
        yield* positiveAmount(spec.amount);
        const ts = yield* Clock.currentTimeMillis;
        const projected = yield* loadResourceState(state, scope);
        const existing = projected.byIdempotencyKey.get(spec.idempotencyKey);
        if (existing !== undefined) return { reservationId: existing.reservationId };

        const current = projected.byKey.get(spec.key) ?? emptyResourceProjection();
        if (current.available < spec.amount) {
          yield* state.commitEvents([
            {
              ts,
              kind: "resource.reserve_rejected",
              scope,
              payload: {
                key: spec.key,
                amount: spec.amount,
                ref: spec.ref,
                idempotencyKey: spec.idempotencyKey,
                available: current.available,
              },
            },
          ]);
          return yield* Effect.fail(
            new ResourceInsufficient({
              key: spec.key,
              requested: spec.amount,
              available: current.available,
            }),
          );
        }

        const reservationId = crypto.randomUUID();
        yield* state.commitEvents([
          {
            ts,
            kind: "resource.reserved",
            scope,
            payload: {
              key: spec.key,
              amount: spec.amount,
              ref: spec.ref,
              idempotencyKey: spec.idempotencyKey,
              reservationId,
            },
          },
        ]);
        return { reservationId };
      }),

    consume: (scope, spec) =>
      Effect.gen(function* () {
        const ts = yield* Clock.currentTimeMillis;
        const projected = yield* loadResourceState(state, scope);
        const reservation = projected.byId.get(spec.reservationId);
        if (reservation === undefined) {
          return yield* Effect.fail(
            new ResourceReservationNotFound({ reservationId: spec.reservationId }),
          );
        }
        if (reservation.status === "consumed") return;
        if (reservation.status === "released") {
          return yield* Effect.fail(
            new ResourceReservationClosed({
              reservationId: spec.reservationId,
              status: "released",
            }),
          );
        }
        yield* state.commitEvents([
          {
            ts,
            kind: "resource.consumed",
            scope,
            payload: { reservationId: spec.reservationId, ref: spec.ref },
          },
        ]);
      }),

    release: (scope, spec) =>
      Effect.gen(function* () {
        const ts = yield* Clock.currentTimeMillis;
        const projected = yield* loadResourceState(state, scope);
        const reservation = projected.byId.get(spec.reservationId);
        if (reservation === undefined) {
          return yield* Effect.fail(
            new ResourceReservationNotFound({ reservationId: spec.reservationId }),
          );
        }
        if (reservation.status === "released") return;
        if (reservation.status === "consumed") {
          return yield* Effect.fail(
            new ResourceReservationClosed({
              reservationId: spec.reservationId,
              status: "consumed",
            }),
          );
        }
        yield* state.commitEvents([
          {
            ts,
            kind: "resource.released",
            scope,
            payload: { reservationId: spec.reservationId, ref: spec.ref },
          },
        ]);
      }),

    project: (scope, key) =>
      Effect.map(
        loadResourceState(state, scope),
        (projected) => projected.byKey.get(key) ?? emptyResourceProjection(),
      ),
  });

const consumedAmount = (event: LedgerEvent, key: string): DecodeResult<number> => {
  const payloadResult = recordOf(event.payload, "dispatch.consumed");
  if (!payloadResult.ok) return payloadResult;
  const payload = payloadResult.value;
  const payloadKey = stringField(payload, "key");
  if (!payloadKey.ok) return payloadKey;
  const amount = finiteNumberField(payload, "amount");
  if (!amount.ok) return amount;
  const toolName = stringField(payload, "toolName");
  if (!toolName.ok) return toolName;
  return decodeOk(payloadKey.value === key ? amount.value : 0);
};

export const InMemoryQuotaLive = (state: InMemoryBackendState): Layer.Layer<Quota> =>
  Layer.succeed(Quota, {
    tryGrant: (scope, key, amount, windowMs, limit, toolName) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const windowStart = windowMs === Number.POSITIVE_INFINITY ? 0 : now - windowMs;
        const consumed = yield* Effect.sync(() => {
          let sum = 0;
          for (const event of state.streamSnapshot(scope)) {
            if (event.kind !== "dispatch.consumed" || event.ts < windowStart) continue;
            const amountResult = consumedAmount(event, key);
            if (!amountResult.ok) return amountResult;
            sum += amountResult.value;
          }
          return decodeOk(sum);
        }).pipe(
          Effect.flatMap((result) =>
            result.ok
              ? Effect.succeed(result.value)
              : Effect.fail(new SqlError({ cause: result.cause })),
          ),
        );

        if (consumed + amount > limit) {
          yield* state.commitEvents([
            {
              ts: now,
              kind: "dispatch.rate_limited",
              scope,
              payload: { key, attempted: amount, consumed, limit, windowMs, toolName },
            },
          ]);
          return { granted: false, consumed, limit } satisfies GrantResult;
        }

        yield* state.commitEvents([
          {
            ts: now,
            kind: "dispatch.consumed",
            scope,
            payload: { key, amount, toolName },
          },
        ]);
        return { granted: true, consumed, limit } satisfies GrantResult;
      }),
  });

const targetFor = (
  targets: InMemoryDispatchTargetRegistry,
  bindingKey: string,
  scope: string,
): DispatchReceiver | undefined => targets[bindingKey]?.[scope];

const findAcceptedDeliveryId = (
  state: InMemoryBackendState,
  scope: string,
  envelope: DispatchEnvelope,
): DecodeResult<number | null> => {
  for (const event of state.streamSnapshot(scope, { kinds: [DISPATCH_INBOUND_ACCEPTED] })) {
    const payload = recordOf(event.payload, DISPATCH_INBOUND_ACCEPTED);
    if (!payload.ok) return payload;
    if (
      payload.value.sourceScope === envelope.sourceScope &&
      payload.value.idempotencyKey === envelope.idempotencyKey
    ) {
      const deliveredEventId = finiteNumberField(payload.value, "deliveredEventId");
      if (!deliveredEventId.ok) return deliveredEventId;
      return decodeOk(deliveredEventId.value);
    }
  }
  return decodeOk(null);
};

const drainDueOutbox = (
  state: InMemoryBackendState,
  scope: string,
  targets: InMemoryDispatchTargetRegistry,
  now: number,
): Effect.Effect<
  { readonly delivered: number; readonly failed: number; readonly next: number | null },
  JsonStringifyError
> =>
  Effect.gen(function* () {
    let delivered = 0;
    let failed = 0;
    for (const row of state.dueOutbox(now)) {
      const bindingKey = materialRefKey(row.requested.target.bindingRef);
      const receiver = targetFor(targets, bindingKey, row.requested.target.scope);
      const attempt = row.attempts + 1;
      if (receiver === undefined) {
        const nextAttemptAt = now + retryDelayMs(attempt);
        yield* state.commitEvents([
          {
            ts: now,
            kind: DISPATCH_OUTBOUND_FAILED,
            scope,
            payload: {
              outboundEventId: row.outboundEventId,
              target: row.requested.target,
              event: row.requested.event,
              idempotencyKey: row.requested.idempotencyKey,
              attempt,
              nextAttemptAt,
              error: "agent_os.dispatch_target_not_found",
            },
          },
        ]);
        row.attempts = attempt;
        row.nextAttemptAt = nextAttemptAt;
        row.lastError = "agent_os.dispatch_target_not_found";
        failed += 1;
        continue;
      }

      const envelope: DispatchEnvelope = {
        sourceScope: row.sourceScope,
        outboundEventId: row.outboundEventId,
        targetScope: row.requested.target.scope,
        event: row.requested.event,
        data: row.requested.data,
        idempotencyKey: row.requested.idempotencyKey,
        claim: row.requested.claim,
        ...(row.requested.traceContext === undefined
          ? {}
          : { traceContext: row.requested.traceContext }),
      };
      const result = yield* Effect.tryPromise({
        try: () => receiver.__agentosReceiveDispatch(envelope),
        catch: (cause) => cause,
      }).pipe(Effect.either);

      if (result._tag === "Right") {
        const [event] = yield* state.commitEvents([
          {
            ts: now,
            kind: DISPATCH_OUTBOUND_DELIVERED,
            scope,
            payload: {
              outboundEventId: row.outboundEventId,
              target: row.requested.target,
              event: row.requested.event,
              idempotencyKey: row.requested.idempotencyKey,
              deliveredEventId: result.right.deliveredEventId,
              attempt,
              claim: settleLivedClaim(row.requested.claim, {
                anchorId: `${row.requested.target.scope}:${result.right.deliveredEventId}`,
                anchorKind: "ledger_event",
                carrierRef: `dispatch:${bindingKey}`,
              }),
              ...(row.requested.traceContext === undefined
                ? {}
                : { traceContext: row.requested.traceContext }),
            },
          },
        ]);
        row.deliveredEventId = event!.id;
        row.attempts = attempt;
        row.lastError = null;
        delivered += 1;
        continue;
      }

      const nextAttemptAt = now + retryDelayMs(attempt);
      const error = describeCause(result.left);
      yield* state.commitEvents([
        {
          ts: now,
          kind: DISPATCH_OUTBOUND_FAILED,
          scope,
          payload: {
            outboundEventId: row.outboundEventId,
            target: row.requested.target,
            event: row.requested.event,
            idempotencyKey: row.requested.idempotencyKey,
            attempt,
            nextAttemptAt,
            error,
          },
        },
      ]);
      row.attempts = attempt;
      row.nextAttemptAt = nextAttemptAt;
      row.lastError = error;
      failed += 1;
    }
    return { delivered, failed, next: state.nextOutboxAt() };
  });

export const InMemoryDispatchLive = (
  state: InMemoryBackendState,
  scope: string,
  targets: InMemoryDispatchTargetRegistry = {},
): Layer.Layer<Dispatch> =>
  Layer.succeed(Dispatch, {
    dispatchToScope: (spec) =>
      Effect.gen(function* () {
        if (isCoreClaimedEventKind(spec.event)) {
          return yield* Effect.fail(
            new CapabilityRejected({ event: spec.event, capability: "cap_app" }),
          );
        }
        const bindingKey = materialRefKey(spec.target.bindingRef);
        if (targetFor(targets, bindingKey, spec.target.scope) === undefined) {
          return yield* Effect.fail(new DispatchTargetNotFound({ bindingRef: bindingKey }));
        }
        if (!isScopeRef(spec.target.scopeRef)) {
          return yield* Effect.fail(
            new UnsupportedScopeRef({
              scopeId: spec.target.scope,
              position: "target",
            }),
          );
        }

        const now = yield* Clock.currentTimeMillis;
        const traceContext = copyTraceContext(spec.traceContext);
        const claim = makePreClaim({
          operationRef: makeOperationRef("dispatch", [
            scope,
            bindingKey,
            spec.target.scope,
            spec.idempotencyKey,
          ]),
          scopeRef: spec.target.scopeRef,
          authorityRef: {
            authorityId: "cap_dispatch",
            authorityClass: "effect",
          },
          originRef: {
            originId: scope,
            originKind: "agent_do",
          },
        });
        const requested: DispatchRequestedPayload = {
          target: spec.target,
          event: spec.event,
          data: spec.data,
          idempotencyKey: spec.idempotencyKey,
          claim,
          ...(traceContext === undefined ? {} : { traceContext }),
        };
        const [event] = yield* state.commitEvents([
          {
            ts: now,
            kind: DISPATCH_OUTBOUND_REQUESTED,
            scope,
            payload: requested,
          },
        ]);
        state.addOutbox({
          outboundEventId: event!.id,
          sourceScope: scope,
          requested,
          attempts: 0,
          nextAttemptAt: now,
          deliveredEventId: null,
          lastError: null,
        });
        yield* drainDueOutbox(state, scope, targets, now);
        return { outboundEventId: event!.id };
      }),

    receive: (envelope) =>
      Effect.gen(function* () {
        if (envelope.targetScope !== scope) {
          return yield* Effect.fail(
            new DispatchScopeMismatch({ expected: scope, actual: envelope.targetScope }),
          );
        }
        if (isCoreClaimedEventKind(envelope.event)) {
          return yield* Effect.fail(
            new CapabilityRejected({ event: envelope.event, capability: "cap_app" }),
          );
        }

        const accepted = findAcceptedDeliveryId(state, scope, envelope);
        if (!accepted.ok) {
          return yield* Effect.fail(new SqlError({ cause: accepted.cause }));
        }
        if (accepted.value !== null) {
          return { deliveredEventId: accepted.value };
        }

        const now = yield* Clock.currentTimeMillis;
        const traceContext = copyTraceContext(envelope.traceContext);
        const events = yield* state.commitPrepared((nextId) => {
          const deliveredEventId = nextId + 1;
          const claim = settleLivedClaim(envelope.claim, {
            anchorId: `${scope}:${deliveredEventId}`,
            anchorKind: "ledger_event",
            carrierRef: `dispatch:${envelope.sourceScope}`,
          });
          return [
            {
              ts: now,
              kind: DISPATCH_INBOUND_ACCEPTED,
              scope,
              payload: {
                sourceScope: envelope.sourceScope,
                outboundEventId: envelope.outboundEventId,
                idempotencyKey: envelope.idempotencyKey,
                deliveredEventId,
                claim,
                ...(traceContext === undefined ? {} : { traceContext }),
              },
            },
            { ts: now, kind: envelope.event, scope, payload: envelope.data },
          ];
        });
        return { deliveredEventId: events[1]!.id };
      }),

    drainDue: (now) => drainDueOutbox(state, scope, targets, now),

    findNextPending: () => Effect.succeed(state.nextOutboxAt()),
  });

export interface InMemoryLlmTransportOptions {
  readonly handler?: (request: LlmRequest) => LlmResponse | Promise<LlmResponse>;
  readonly responses?: ReadonlyArray<LlmResponse>;
}

const responseQueueHandler = (
  responses: ReadonlyArray<LlmResponse>,
): ((request: LlmRequest) => LlmResponse | Promise<LlmResponse>) => {
  const queue = [...responses];
  return () => {
    const next = queue.shift();
    if (next === undefined) {
      return Promise.reject(new Error("in_memory_llm_response_missing"));
    }
    return next;
  };
};

export const InMemoryLlmTransportLive = (
  options: InMemoryLlmTransportOptions = {},
): Layer.Layer<LlmTransport> => {
  const handler = options.handler ?? responseQueueHandler(options.responses ?? []);
  return Layer.succeed(LlmTransport, {
    call: (request) =>
      Effect.tryPromise({
        try: async () => handler(request),
        catch: (cause) => new UpstreamFailure({ cause }),
      }),
  });
};

const outcomeFromLease = (lease: CapabilityLease & { readonly status: "unsupported" }): Outcome => {
  switch (lease.failureClass) {
    case "BehaviorFailed":
      return { class: "BehaviorFailed", sampleDigest: "cached-short-circuit" };
    case "ProviderRejected":
      return { class: "ProviderRejected", status: 0, body: "cached-short-circuit" };
    case "SchemaUnsupported":
      return { class: "SchemaUnsupported", reason: "cached-short-circuit" };
    case "AuthError":
      return { class: "AuthError", status: 401 };
    case "RateLimited":
      return { class: "RateLimited" };
    case "TransientError":
      return { class: "TransientError", cause: "cached-short-circuit" };
    case "ConfigError":
      return { class: "ConfigError", reason: "cached-short-circuit" };
  }
};

const projectAdmissionRows = (
  state: InMemoryBackendState,
  scope: string,
): Effect.Effect<ReadonlyArray<AdmissionRow>, SqlError> =>
  Effect.sync(() => {
    const rows: AdmissionRow[] = [];
    for (const event of state.streamSnapshot(scope)) {
      if (event.kind === "llm.structured.evidence") {
        const payload = recordOf(event.payload, event.kind);
        if (!payload.ok) return payload;
        rows.push({
          id: event.id,
          ts: event.ts,
          kind: "llm.structured.evidence",
          key: payload.value.key as AttemptKey,
          stimulusKind: payload.value.stimulusKind as "probe" | "live",
          outcome: payload.value.outcome as Outcome,
          admissionImpact: payload.value.admissionImpact as AdmissionImpact,
        });
      }
      if (event.kind === "llm.structured.invalidate") {
        const payload = recordOf(event.payload, event.kind);
        if (!payload.ok) return payload;
        rows.push({
          id: event.id,
          ts: event.ts,
          kind: "llm.structured.invalidate",
          key: payload.value.key as Partial<AttemptKey>,
        });
      }
    }
    return decodeOk(rows);
  }).pipe(
    Effect.flatMap((result) =>
      result.ok ? Effect.succeed(result.value) : Effect.fail(new SqlError({ cause: result.cause })),
    ),
  );

export const InMemoryAdmissionLive = (
  state: InMemoryBackendState,
): Layer.Layer<Admission, never, LlmTransport> =>
  Layer.effect(
    Admission,
    Effect.gen(function* () {
      const llm = yield* LlmTransport;
      const attemptStructured = <O>(
        spec: AttemptSpec<O>,
      ): Effect.Effect<AttemptResult<O>, SqlError | JsonStringifyError> =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const key: AttemptKey = {
            routeFingerprint: routeFingerprint(spec.route),
            schemaFingerprint: spec.schemaContract.fingerprint,
            strategy: spec.strategy,
            adapterVersion: IN_MEMORY_ADAPTER_VERSION,
          };
          const preRows = yield* projectAdmissionRows(state, spec.scope);
          const { lease: preLease, latestBarrierTs } = projectLease(preRows, key, now);
          if (preLease.status === "unsupported" && now < preLease.retryAfter) {
            return {
              ok: false,
              outcome: outcomeFromLease(preLease),
              lease: preLease,
              admissionImpact: "lease-bearing",
              shortCircuited: true,
            };
          }

          const userContent =
            spec.stimulus.kind === "live"
              ? spec.stimulus.userInput.userText
              : JSON.stringify(spec.stimulus.synthetic);
          const response = yield* Effect.either(
            llm.call({
              route: spec.route,
              messages: [{ role: "user", content: userContent }],
            }),
          );

          let decoded: O | undefined;
          let outcome: Outcome;
          if (response._tag === "Left") {
            outcome = { class: "TransientError", cause: describeCause(response.left) };
          } else {
            try {
              const parsed = JSON.parse(response.right.text) as O;
              const violations = validateAgainstSchema(parsed, spec.schemaContract.schema);
              if (violations.length > 0) {
                outcome = { class: "BehaviorFailed", sampleDigest: violations.join("|") };
              } else {
                decoded = parsed;
                outcome = { class: "Supported", tokensUsed: response.right.usage.totalTokens };
              }
            } catch (cause) {
              outcome = { class: "BehaviorFailed", sampleDigest: describeCause(cause) };
            }
          }

          const admissionImpact = decideTier(
            preLease,
            outcome,
            spec.stimulus.kind,
            latestBarrierTs,
          );
          const evidencePayload = {
            key,
            stimulusKind: spec.stimulus.kind,
            outcome,
            admissionImpact,
            adapterId: `in-memory@${IN_MEMORY_ADAPTER_VERSION}`,
          };
          const deliver =
            outcome.class === "Supported" && spec.stimulus.kind === "live" && decoded !== undefined
              ? spec.stimulus.deliver(decoded)
              : null;

          yield* state.commitEvents([
            {
              ts: now,
              kind: "llm.structured.evidence",
              scope: spec.scope,
              payload: evidencePayload,
            },
            ...(deliver === null
              ? []
              : [
                  {
                    ts: now,
                    kind: deliver.event,
                    scope: spec.scope,
                    payload: deliver.payload,
                  },
                ]),
          ]);

          const postRows = yield* projectAdmissionRows(state, spec.scope);
          const { lease } = projectLease(postRows, key, now);
          if (outcome.class === "Supported" && decoded !== undefined) {
            return {
              ok: true,
              decoded,
              outcome,
              lease,
              admissionImpact,
              shortCircuited: false,
            };
          }
          return {
            ok: false,
            outcome,
            lease,
            admissionImpact,
            shortCircuited: false,
          };
        });

      const invalidate = (
        spec: InvalidateSpec,
      ): Effect.Effect<{ readonly barrierId: number }, JsonStringifyError> =>
        Effect.gen(function* () {
          const ts = yield* Clock.currentTimeMillis;
          const [event] = yield* state.commitEvents([
            {
              ts,
              kind: "llm.structured.invalidate",
              scope: spec.scope,
              payload: { key: spec.key, reason: spec.reason, by: spec.by },
            },
          ]);
          return { barrierId: event!.id };
        });

      return { attemptStructured, invalidate };
    }),
  );

export type InMemoryRuntimeServices =
  | Ledger
  | Scheduler
  | Dispatch
  | Resources
  | Quota
  | LlmTransport
  | Admission;

export interface InMemoryRuntimeLayerOptions {
  readonly state?: InMemoryBackendState;
  readonly scope: string;
  readonly handlers?: Iterable<InMemoryEventHandlerRegistration>;
  readonly dispatchTargets?: InMemoryDispatchTargetRegistry;
  readonly llm?: InMemoryLlmTransportOptions;
}

export interface InMemoryRuntimeBackend {
  readonly state: InMemoryBackendState;
  readonly layer: Layer.Layer<InMemoryRuntimeServices>;
}

export const createInMemoryRuntimeBackend = (
  options: InMemoryRuntimeLayerOptions,
): InMemoryRuntimeBackend => {
  const state = options.state ?? createInMemoryBackendState({ handlers: options.handlers });
  const llmLayer = InMemoryLlmTransportLive(options.llm);
  const admissionLayer = InMemoryAdmissionLive(state).pipe(Layer.provide(llmLayer));
  return {
    state,
    layer: Layer.mergeAll(
      InMemoryLedgerLive(state),
      InMemorySchedulerLive(state, options.scope),
      InMemoryDispatchLive(state, options.scope, options.dispatchTargets),
      InMemoryResourcesLive(state),
      InMemoryQuotaLive(state),
      llmLayer,
      admissionLayer,
    ),
  };
};

export const makeInMemoryRuntimeLayer = (
  options: InMemoryRuntimeLayerOptions,
): Layer.Layer<InMemoryRuntimeServices> => createInMemoryRuntimeBackend(options).layer;
