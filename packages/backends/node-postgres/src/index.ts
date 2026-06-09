import { randomUUID } from "node:crypto";
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
  isCoreClaimedEventKind,
} from "@agent-os/kernel/errors";
import {
  authorityRefKey,
  isAuthorityRef,
  isScopeRef,
  makeOperationRef,
  makePreClaim,
  type FactOwnerRef,
} from "@agent-os/kernel/effect-claim";
import { materialRefKey, type BindingMaterialRef } from "@agent-os/kernel/material-ref";
import type {
  DispatchToScopeResult,
  EventHandler,
  EventQueryOptions,
  LedgerEvent,
  ResourceGrantResult,
  ResourceGrantSpec,
  ResourceReservationSpec,
  ResourceReserveResult,
  ResourceReserveSpec,
} from "@agent-os/kernel/types";
import {
  DELIVERY_RETRY_TRIGGER_KIND,
  DISPATCH_EVENT_KINDS,
  DISPATCH_INBOUND_ACCEPTED,
  DISPATCH_RETRY_POLICY,
  backendProtocolEventIdentityKey,
  backendProtocolProjectionKey,
  backendProtocolTruthIdentityKey,
  copyTraceContext,
  describeDispatchCause,
  dispatchBackoffMs,
  dispatchLedgerDeliveryReceipt,
  durableTriggerDuePayload,
  parseDispatchLivedClaim,
  parseRequestedPayloadValue,
  settleDispatchInboundAccepted,
  settleDispatchOutboundDelivered,
  type BackendProtocolEventIdentity,
  type BackendProtocolProjectionKey,
  type BackendProtocolTruthIdentity,
  type DispatchDeliveryResult,
  type DispatchEnvelope,
  type DispatchReceiverResult,
  type DispatchTargetAdapter,
  type GrantResult,
  type ResourceProjection,
} from "@agent-os/backend-protocol";
import {
  RUNTIME_FACT_OWNER,
  type LedgerCommitEventSpec,
  type LedgerTruthIdentity,
} from "@agent-os/runtime-protocol";
import {
  InvalidTraceContext,
  type TelemetryFanoutDiagnostic,
} from "@agent-os/telemetry-protocol";
import { validateOptionalTraceContext } from "@agent-os/telemetry-protocol";
import {
  DURABLE_TRIGGER_SCHEDULED_REQUESTED,
  scheduledEventIntentPayload,
} from "@agent-os/runtime";
import { PsqlCli, quoteIdentifier, sqlJson, sqlNumber, sqlString } from "./sql";

export interface NodePostgresBackendOptions {
  readonly databaseUrl: string;
  readonly schema?: string;
  readonly psqlPath?: string;
  readonly bindingRef: BindingMaterialRef;
}

export interface NodePostgresEventSubscription {
  readonly unsubscribe: () => void;
}

interface EventSink {
  readonly identityKey: string;
  readonly kind: string;
  readonly sink: (event: LedgerEvent) => void;
}

interface DueWorkRow {
  readonly id: number;
  readonly identity: BackendProtocolEventIdentity;
  readonly identityKey: string;
  readonly fireAt: number;
  readonly kind: string;
  readonly payload: { readonly intentEventId: number };
  readonly claimToken: string | null;
  readonly redriveCount: number;
  readonly cancelRequestedAt: number | null;
  readonly cancelReason: string | null;
}

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

const DEFAULT_EVENT_LIMIT = 1000;
const MAX_EVENT_LIMIT = 1000;
const SCHEDULED_EVENT_TRIGGER_KIND = "scheduled_event";

const schemaName = (schema: string | undefined): string =>
  schema ?? `agentos_node_postgres_${randomUUID().replace(/-/g, "_")}`;

const runtimeIdentity = (identity: BackendProtocolTruthIdentity): BackendProtocolEventIdentity => ({
  scopeRef: identity.scopeRef,
  effectAuthorityRef: identity.effectAuthorityRef,
  factOwnerRef: RUNTIME_FACT_OWNER,
});

const eventToRpc = (event: LedgerEvent): LedgerEvent => ({
  id: event.id,
  ts: event.ts,
  kind: event.kind,
  scopeRef: event.scopeRef,
  factOwnerRef: event.factOwnerRef,
  effectAuthorityRef: event.effectAuthorityRef,
  payload: event.payload,
});

const validateSerializablePayload = (payload: unknown): void => {
  try {
    const encoded = JSON.stringify(payload);
    if (typeof encoded !== "string") {
      throw new TypeError("ledger event payload must be JSON serializable");
    }
  } catch (cause) {
    throw new JsonStringifyError({ cause });
  }
};

const sqlPayload = (payload: unknown): string => {
  validateSerializablePayload(payload);
  return sqlJson(payload);
};

const positiveAmount = (amount: number): void => {
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new InvalidResourceAmount({ amount });
  }
};

const emptyResourceProjection = (): ResourceProjection => ({
  available: 0,
  reserved: 0,
  consumed: 0,
});

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

const recordOf = (value: unknown, label: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SqlError({ cause: `${label} payload must be object` });
  }
  return value as Record<string, unknown>;
};

const stringField = (value: Record<string, unknown>, key: string): string => {
  const field = value[key];
  if (typeof field !== "string") {
    throw new SqlError({ cause: `${key} must be string` });
  }
  return field;
};

const finiteNumberField = (value: Record<string, unknown>, key: string): number => {
  const field = value[key];
  if (typeof field !== "number" || !Number.isFinite(field)) {
    throw new SqlError({ cause: `${key} must be finite number` });
  }
  return field;
};

const eventRowSelect = `
  SELECT
    id::int AS "id",
    ts AS "ts",
    kind AS "kind",
    scope_ref AS "scopeRef",
    fact_owner_ref #>> '{}' AS "factOwnerRef",
    effect_authority_ref AS "effectAuthorityRef",
    payload AS "payload"
  FROM agentos_events
`;

export class NodePostgresBackend {
  readonly bindingRef: BindingMaterialRef;
  readonly #sql: PsqlCli;
  readonly #schema: string;
  readonly #handlers = new Map<string, Set<EventHandler>>();
  readonly #sinks = new Set<EventSink>();
  readonly #diagnostics: TelemetryFanoutDiagnostic[] = [];
  readonly #targets = new Map<string, DispatchTargetAdapter>();

  constructor(options: NodePostgresBackendOptions) {
    this.bindingRef = options.bindingRef;
    this.#schema = schemaName(options.schema);
    this.#sql = new PsqlCli({
      databaseUrl: options.databaseUrl,
      schema: this.#schema,
      psqlPath: options.psqlPath,
    });
  }

  get schema(): string {
    return this.#schema;
  }

  async initialize(): Promise<void> {
    await this.#sql.exec(`
      CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(this.#schema)};
      CREATE TABLE IF NOT EXISTS agentos_events (
        id BIGSERIAL PRIMARY KEY,
        ts DOUBLE PRECISION NOT NULL,
        kind TEXT NOT NULL,
        truth_key TEXT NOT NULL,
        identity_key TEXT NOT NULL,
        scope_ref JSONB NOT NULL,
        fact_owner_ref JSONB NOT NULL,
        effect_authority_ref JSONB NOT NULL,
        payload JSONB NOT NULL
      );
      CREATE INDEX IF NOT EXISTS agentos_events_identity_id_idx
        ON agentos_events (identity_key, id);
      CREATE INDEX IF NOT EXISTS agentos_events_kind_idx
        ON agentos_events (kind);

      CREATE TABLE IF NOT EXISTS agentos_due_work (
        id BIGSERIAL PRIMARY KEY,
        identity_key TEXT NOT NULL,
        identity JSONB NOT NULL,
        fire_at DOUBLE PRECISION NOT NULL,
        kind TEXT NOT NULL,
        payload JSONB NOT NULL,
        completed_at DOUBLE PRECISION,
        claimed_at DOUBLE PRECISION,
        claim_token TEXT,
        claim_deadline_at DOUBLE PRECISION,
        redrive_count INTEGER NOT NULL DEFAULT 0,
        cancel_requested_at DOUBLE PRECISION,
        cancel_reason TEXT,
        cancelled_at DOUBLE PRECISION
      );
      CREATE INDEX IF NOT EXISTS agentos_due_work_pending_idx
        ON agentos_due_work (identity_key, completed_at, fire_at, id);
    `);
  }

  async dispose(): Promise<void> {
    await this.#sql.exec(`DROP SCHEMA IF EXISTS ${quoteIdentifier(this.#schema)} CASCADE;`);
  }

  registerDispatchReceiver(
    identity: BackendProtocolEventIdentity,
    receiver?: (
      envelope: DispatchEnvelope,
      accept: () => Promise<DispatchReceiverResult>,
    ) => Promise<DispatchReceiverResult>,
  ): void {
    const targetScope = backendProtocolTruthIdentityKey(identity);
    this.#targets.set(materialRefKey(this.bindingRef), {
      deliver: (envelope) => {
        if (envelope.targetScope !== targetScope) {
          const target = this.#targets.get(`${materialRefKey(this.bindingRef)}:${envelope.targetScope}`);
          if (target !== undefined) return target.deliver(envelope);
        }
        const accept = () => this.receive(identity, envelope);
        return receiver === undefined ? accept() : receiver(envelope, accept);
      },
    });
    this.#targets.set(`${materialRefKey(this.bindingRef)}:${targetScope}`, {
      deliver: (envelope) => {
        const accept = () => this.receive(identity, envelope);
        return receiver === undefined ? accept() : receiver(envelope, accept);
      },
    });
  }

  setDispatchTargetAdapter(adapter: DispatchTargetAdapter | DispatchTargetAdapter["deliver"]): void {
    this.#targets.set(
      materialRefKey(this.bindingRef),
      typeof adapter === "function" ? { deliver: adapter } : adapter,
    );
  }

  addHandler(kind: string, handler: EventHandler): NodePostgresEventSubscription {
    let set = this.#handlers.get(kind);
    if (set === undefined) {
      set = new Set();
      this.#handlers.set(kind, set);
    }
    set.add(handler);
    return {
      unsubscribe: () => {
        set?.delete(handler);
      },
    };
  }

  addSink(
    identity: BackendProtocolEventIdentity,
    kind: string,
    sink: (event: LedgerEvent) => void,
  ): NodePostgresEventSubscription {
    const entry = { identityKey: backendProtocolEventIdentityKey(identity), kind, sink };
    this.#sinks.add(entry);
    return {
      unsubscribe: () => {
        this.#sinks.delete(entry);
      },
    };
  }

  telemetryDiagnostics(): ReadonlyArray<TelemetryFanoutDiagnostic> {
    return [...this.#diagnostics];
  }

  async log(
    identity: BackendProtocolEventIdentity,
    kind: string,
    payload: unknown,
  ): Promise<LedgerEvent> {
    const [event] = await this.#appendEvents([
      {
        ts: Date.now(),
        kind,
        identity,
        payload,
      },
    ]);
    if (event === undefined) throw new SqlError({ cause: "ledger commit returned no event" });
    return event;
  }

  async commit(events: ReadonlyArray<LedgerCommitEventSpec>): Promise<ReadonlyArray<LedgerEvent>> {
    const ts = Date.now();
    return this.#appendEvents(
      events.map((event) => ({
        ts: event.ts ?? ts,
        kind: event.kind,
        identity: runtimeIdentity(event),
        payload: event.payload,
      })),
    );
  }

  async events(
    identity: BackendProtocolEventIdentity,
    opts: EventQueryOptions = {},
  ): Promise<ReadonlyArray<LedgerEvent>> {
    return this.#events(identity, opts);
  }

  async streamSnapshot(
    identity: BackendProtocolEventIdentity,
    opts: Pick<EventQueryOptions, "afterId" | "kinds" | "factOwnerRefs"> = {},
  ): Promise<ReadonlyArray<LedgerEvent>> {
    return this.#events(identity, opts);
  }

  async schedule(
    identity: BackendProtocolEventIdentity,
    at: number,
    eventKind: string,
    data: unknown,
  ): Promise<{ readonly id: number }> {
    const [event] = await this.#appendEvents([
      {
        ts: Date.now(),
        kind: DURABLE_TRIGGER_SCHEDULED_REQUESTED,
        identity,
        payload: scheduledEventIntentPayload(eventKind, data),
      },
    ]);
    if (event === undefined) throw new SqlError({ cause: "schedule commit returned no event" });
    await this.#insertDueWork(identity, SCHEDULED_EVENT_TRIGGER_KIND, event.id, at);
    return { id: event.id };
  }

  async fireDue(
    identity: BackendProtocolEventIdentity,
    now: number,
  ): Promise<{ readonly fired: number }> {
    const result = await this.#drainDue(identity, now);
    return { fired: result.drained };
  }

  async drainDispatchDue(
    identity: BackendProtocolEventIdentity,
    now: number,
  ): Promise<{ readonly delivered: number; readonly failed: number }> {
    const before = await this.#events(identity);
    const result = await this.#drainDue(identity, now);
    if (result.drained === 0) return { delivered: 0, failed: 0 };
    const after = await this.#events(identity);
    const slice = after.slice(before.length);
    return {
      delivered: slice.filter((event) => event.kind === DISPATCH_EVENT_KINDS.OUTBOUND_DELIVERED)
        .length,
      failed: slice.filter((event) => event.kind === DISPATCH_EVENT_KINDS.OUTBOUND_FAILED).length,
    };
  }

  async nextDueAt(identity: BackendProtocolEventIdentity): Promise<number | null> {
    return this.#sql.jsonValue<number | null>(`
      SELECT COALESCE(to_json(MIN(CASE
        WHEN claim_token IS NULL THEN fire_at
        ELSE claim_deadline_at
      END)), 'null'::json)::text
      FROM agentos_due_work
      WHERE identity_key = ${sqlString(backendProtocolEventIdentityKey(identity))}
        AND completed_at IS NULL
    `);
  }

  async pendingDueCount(identity: BackendProtocolEventIdentity): Promise<number> {
    return this.#sql.jsonValue<number>(`
      SELECT to_json(COUNT(*)::int)::text
      FROM agentos_due_work
      WHERE identity_key = ${sqlString(backendProtocolEventIdentityKey(identity))}
        AND completed_at IS NULL
    `);
  }

  async dispatchToScope(
    identity: BackendProtocolEventIdentity,
    spec: {
      readonly target: BackendProtocolTruthIdentity & { readonly bindingRef: BindingMaterialRef };
      readonly event: string;
      readonly data: unknown;
      readonly idempotencyKey: string;
      readonly traceContext?: unknown;
    },
  ): Promise<DispatchToScopeResult> {
    if (isCoreClaimedEventKind(spec.event)) {
      throw new CapabilityRejected({ event: spec.event, capability: "cap_app" });
    }
    const bindingKey = materialRefKey(spec.target.bindingRef);
    if (!this.#targets.has(bindingKey)) {
      throw new DispatchTargetNotFound({ bindingRef: bindingKey });
    }
    if (!isScopeRef(spec.target.scopeRef)) {
      throw new UnsupportedScopeRef({ scopeId: "malformed", position: "target" });
    }
    if (!isAuthorityRef(spec.target.effectAuthorityRef)) {
      throw new SqlError({ cause: "dispatch target effectAuthorityRef malformed" });
    }
    const traceContextResult = validateOptionalTraceContext(spec.traceContext);
    if (!traceContextResult.ok) {
      throw new InvalidTraceContext({
        position: "dispatch",
        reason: traceContextResult.reason,
      });
    }
    const sourceScope = backendProtocolTruthIdentityKey(identity);
    const targetScope = backendProtocolTruthIdentityKey(spec.target);
    const claim = makePreClaim({
      operationRef: makeOperationRef("dispatch", [
        sourceScope,
        bindingKey,
        targetScope,
        spec.idempotencyKey,
      ]),
      scopeRef: spec.target.scopeRef,
      effectAuthorityRef: {
        authorityId: "cap_dispatch",
        authorityClass: "effect",
      },
      originRef: {
        originId: sourceScope,
        originKind: "agent_do",
      },
    });
    const requested = {
      target: spec.target,
      event: spec.event,
      data: spec.data,
      idempotencyKey: spec.idempotencyKey,
      retryPolicy: DISPATCH_RETRY_POLICY,
      claim,
      ...(traceContextResult.traceContext === undefined
        ? {}
        : { traceContext: copyTraceContext(traceContextResult.traceContext) }),
    };
    const [event] = await this.#appendEvents([
      {
        ts: Date.now(),
        kind: DISPATCH_EVENT_KINDS.OUTBOUND_REQUESTED,
        identity,
        payload: requested,
      },
    ]);
    if (event === undefined) throw new SqlError({ cause: "dispatch commit returned no event" });
    await this.#insertDueWork(identity, DELIVERY_RETRY_TRIGGER_KIND, event.id, Date.now());
    await this.#drainDue(identity, Date.now());
    return { outboundEventId: event.id };
  }

  async receive(
    identity: BackendProtocolEventIdentity,
    envelope: DispatchEnvelope,
  ): Promise<DispatchReceiverResult> {
    const scopeLabel = backendProtocolTruthIdentityKey(identity);
    if (envelope.targetScope !== scopeLabel) {
      throw new DispatchScopeMismatch({ expected: scopeLabel, actual: envelope.targetScope });
    }
    if (isCoreClaimedEventKind(envelope.event)) {
      throw new CapabilityRejected({ event: envelope.event, capability: "cap_app" });
    }
    const accepted = await this.#findAcceptedDeliveryId(identity, envelope);
    if (accepted !== null) {
      return {
        deliveredEventId: accepted,
        receipt: dispatchLedgerDeliveryReceipt({ targetScope: scopeLabel, deliveredEventId: accepted }),
      };
    }
    const traceContextResult = validateOptionalTraceContext(envelope.traceContext);
    if (!traceContextResult.ok) {
      throw new InvalidTraceContext({
        position: "dispatch",
        reason: traceContextResult.reason,
      });
    }
    const deliveredEventId = await this.#nextEventId(1);
    const acceptedEventId = deliveredEventId - 1;
    const claim = settleDispatchInboundAccepted(envelope.claim, {
      sourceScope: envelope.sourceScope,
      targetScope: scopeLabel,
      deliveredEventId,
    });
    const events = await this.#appendEventsWithIds([
      {
        id: acceptedEventId,
        ts: Date.now(),
        kind: DISPATCH_INBOUND_ACCEPTED,
        identity,
        payload: {
          sourceScope: envelope.sourceScope,
          outboundEventId: envelope.outboundEventId,
          idempotencyKey: envelope.idempotencyKey,
          deliveredEventId,
          claim,
          ...(traceContextResult.traceContext === undefined
            ? {}
            : { traceContext: copyTraceContext(traceContextResult.traceContext) }),
        },
      },
      {
        id: deliveredEventId,
        ts: Date.now(),
        kind: envelope.event,
        identity,
        payload: envelope.data,
      },
    ]);
    const delivered = events[1];
    if (delivered === undefined) throw new SqlError({ cause: "dispatch receive returned no event" });
    return {
      deliveredEventId: delivered.id,
      receipt: dispatchLedgerDeliveryReceipt({ targetScope: scopeLabel, deliveredEventId: delivered.id }),
    };
  }

  async grantResource(
    identity: BackendProtocolEventIdentity,
    spec: ResourceGrantSpec,
  ): Promise<ResourceGrantResult> {
    positiveAmount(spec.amount);
    const [event] = await this.#appendEvents([
      {
        ts: Date.now(),
        kind: "resource_pool.granted",
        identity,
        payload: { key: spec.key, amount: spec.amount, ref: spec.ref },
      },
    ]);
    if (event === undefined) throw new SqlError({ cause: "resource grant returned no event" });
    return { eventId: event.id };
  }

  async reserveResource(
    identity: BackendProtocolEventIdentity,
    spec: ResourceReserveSpec,
  ): Promise<ResourceReserveResult> {
    positiveAmount(spec.amount);
    const projected = await this.#loadResourceState(identity);
    const existing = projected.byIdempotencyKey.get(spec.idempotencyKey);
    if (existing !== undefined) return { reservationId: existing.reservationId };
    const current = projected.byKey.get(spec.key) ?? emptyResourceProjection();
    if (current.available < spec.amount) {
      await this.#appendEvents([
        {
          ts: Date.now(),
          kind: "resource_pool.reserve_rejected",
          identity,
          payload: {
            key: spec.key,
            amount: spec.amount,
            ref: spec.ref,
            idempotencyKey: spec.idempotencyKey,
            available: current.available,
          },
        },
      ]);
      throw new ResourceInsufficient({
        key: spec.key,
        requested: spec.amount,
        available: current.available,
      });
    }
    const reservationId = randomUUID();
    await this.#appendEvents([
      {
        ts: Date.now(),
        kind: "resource_pool.reserved",
        identity,
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
  }

  async consumeResource(
    identity: BackendProtocolEventIdentity,
    spec: ResourceReservationSpec,
  ): Promise<void> {
    const projected = await this.#loadResourceState(identity);
    const reservation = projected.byId.get(spec.reservationId);
    if (reservation === undefined) {
      throw new ResourceReservationNotFound({ reservationId: spec.reservationId });
    }
    if (reservation.status === "consumed") return;
    if (reservation.status === "released") {
      throw new ResourceReservationClosed({ reservationId: spec.reservationId, status: "released" });
    }
    await this.#appendEvents([
      {
        ts: Date.now(),
        kind: "resource_pool.consumed",
        identity,
        payload: { reservationId: spec.reservationId, ref: spec.ref },
      },
    ]);
  }

  async releaseResource(
    identity: BackendProtocolEventIdentity,
    spec: ResourceReservationSpec,
  ): Promise<void> {
    const projected = await this.#loadResourceState(identity);
    const reservation = projected.byId.get(spec.reservationId);
    if (reservation === undefined) {
      throw new ResourceReservationNotFound({ reservationId: spec.reservationId });
    }
    if (reservation.status === "released") return;
    if (reservation.status === "consumed") {
      throw new ResourceReservationClosed({ reservationId: spec.reservationId, status: "consumed" });
    }
    await this.#appendEvents([
      {
        ts: Date.now(),
        kind: "resource_pool.released",
        identity,
        payload: { reservationId: spec.reservationId, ref: spec.ref },
      },
    ]);
  }

  async projectResource(key: BackendProtocolProjectionKey): Promise<ResourceProjection> {
    const projected = await this.#loadResourceState(key);
    return projected.byKey.get(key.projectionId) ?? emptyResourceProjection();
  }

  async quotaTryGrant(
    identity: BackendProtocolEventIdentity,
    key: BackendProtocolProjectionKey,
    amount: number,
    windowMs: number,
    limit: number,
    toolName: string,
    operationRef: string,
  ): Promise<GrantResult> {
    const now = Date.now();
    const windowStart = windowMs === Number.POSITIVE_INFINITY ? 0 : now - windowMs;
    const events = await this.#events(identity);
    let consumed = 0;
    for (const event of events) {
      if (event.kind !== "quota.consumed" || event.ts < windowStart) continue;
      const payload = recordOf(event.payload, "quota.consumed");
      const eventOperationRef = typeof payload.operationRef === "string" ? payload.operationRef : null;
      if (eventOperationRef === operationRef) return { granted: true, consumed, limit };
      const payloadKey = stringField(payload, "key");
      const consumedAmount = finiteNumberField(payload, "amount");
      stringField(payload, "toolName");
      if (payloadKey === key.projectionId) consumed += consumedAmount;
    }
    if (consumed + amount > limit) {
      await this.#appendEvents([
        {
          ts: now,
          kind: "quota.rate_limited",
          identity,
          payload: { key: key.projectionId, attempted: amount, consumed, limit, windowMs, toolName },
        },
      ]);
      return { granted: false, consumed, limit };
    }
    await this.#appendEvents([
      {
        ts: now,
        kind: "quota.consumed",
        identity,
        payload: { key: key.projectionId, amount, toolName, operationRef },
      },
    ]);
    return { granted: true, consumed, limit };
  }

  async #drainDue(
    identity: BackendProtocolEventIdentity,
    now: number,
  ): Promise<{ readonly drained: number }> {
    let drained = 0;
    for (;;) {
      const row = await this.#claimDue(identity, now);
      if (row === null) return { drained };
      if (row.kind === SCHEDULED_EVENT_TRIGGER_KIND) {
        await this.#commitScheduled(row, now);
        drained += 1;
        continue;
      }
      if (row.kind === DELIVERY_RETRY_TRIGGER_KIND) {
        await this.#commitDispatchRetry(row, now);
        drained += 1;
        continue;
      }
      await this.#completeDue(row.id, now, row.claimToken);
      drained += 1;
    }
  }

  async #commitScheduled(row: DueWorkRow, now: number): Promise<void> {
    const [intent] = await this.#eventById(row.identity, row.payload.intentEventId);
    if (intent === undefined) {
      await this.#completeDue(row.id, now, row.claimToken);
      return;
    }
    const payload = recordOf(intent.payload, DURABLE_TRIGGER_SCHEDULED_REQUESTED);
    const eventKind = stringField(payload, "eventKind");
    await this.#appendEvents([
      {
        ts: now,
        kind: eventKind,
        identity: row.identity,
        payload: payload.data,
      },
    ]);
    await this.#completeDue(row.id, now, row.claimToken);
  }

  async #commitDispatchRetry(row: DueWorkRow, now: number): Promise<void> {
    const [intent] = await this.#eventById(row.identity, row.payload.intentEventId);
    if (intent === undefined) {
      await this.#completeDue(row.id, now, row.claimToken);
      return;
    }
    const parsed = parseRequestedPayloadValue(intent.payload);
    if (!parsed.ok) {
      await this.#completeDue(row.id, now, row.claimToken);
      return;
    }
    const requested = parsed.value;
    const existingDelivered = (await this.#events(row.identity)).filter(
      (event) =>
        event.kind === DISPATCH_EVENT_KINDS.OUTBOUND_DELIVERED &&
        recordOf(event.payload, DISPATCH_EVENT_KINDS.OUTBOUND_DELIVERED).outboundEventId ===
          intent.id,
    );
    if (existingDelivered.length > 0) {
      await this.#completeDue(row.id, now, row.claimToken);
      return;
    }
    const attempts =
      (await this.#events(row.identity)).filter(
        (event) =>
          (event.kind === DISPATCH_EVENT_KINDS.OUTBOUND_FAILED ||
            event.kind === DISPATCH_EVENT_KINDS.OUTBOUND_DELIVERED) &&
          recordOf(event.payload, event.kind).outboundEventId === intent.id,
      ).length + 1;
    const bindingKey = materialRefKey(requested.target.bindingRef);
    const target = this.#targets.get(bindingKey);
    const envelope: DispatchEnvelope = {
      sourceScope: backendProtocolTruthIdentityKey(row.identity),
      outboundEventId: intent.id,
      targetScope: backendProtocolTruthIdentityKey(requested.target),
      event: requested.event,
      data: requested.data,
      idempotencyKey: requested.idempotencyKey,
      claim: requested.claim,
      ...(requested.traceContext === undefined ? {} : { traceContext: requested.traceContext }),
    };
    try {
      if (target === undefined) throw "agent_os.dispatch_target_not_found";
      const result = await target.deliver(envelope);
      await this.#appendEvents([
        {
          ts: now,
          kind: DISPATCH_EVENT_KINDS.OUTBOUND_DELIVERED,
          identity: row.identity,
          payload: {
            outboundEventId: intent.id,
            target: requested.target,
            event: requested.event,
            idempotencyKey: requested.idempotencyKey,
            deliveryReceipt: result.receipt,
            attempt: attempts,
            claim: settleDispatchOutboundDelivered(requested.claim, {
              bindingKey,
              deliveryReceipt: result.receipt,
            }),
            ...(requested.traceContext === undefined ? {} : { traceContext: requested.traceContext }),
          },
        },
      ]);
      await this.#completeDue(row.id, now, row.claimToken);
    } catch (cause) {
      const terminal = attempts >= requested.retryPolicy.maxAttempts;
      const nextAttemptAt = terminal ? null : now + dispatchBackoffMs(attempts);
      await this.#appendEvents([
        {
          ts: now,
          kind: DISPATCH_EVENT_KINDS.OUTBOUND_FAILED,
          identity: row.identity,
          payload: {
            outboundEventId: intent.id,
            target: requested.target,
            event: requested.event,
            idempotencyKey: requested.idempotencyKey,
            attempt: attempts,
            error: describeDispatchCause(cause),
            terminal,
            ...(nextAttemptAt === null ? {} : { nextAttemptAt }),
            ...(requested.traceContext === undefined ? {} : { traceContext: requested.traceContext }),
          },
        },
      ]);
      await this.#completeDue(row.id, now, row.claimToken);
      if (nextAttemptAt !== null) {
        await this.#insertDueWork(row.identity, DELIVERY_RETRY_TRIGGER_KIND, intent.id, nextAttemptAt);
      }
    }
  }

  async #findAcceptedDeliveryId(
    identity: BackendProtocolEventIdentity,
    envelope: DispatchEnvelope,
  ): Promise<number | null> {
    for (const event of await this.#events(identity, { kinds: [DISPATCH_INBOUND_ACCEPTED] })) {
      const payload = recordOf(event.payload, DISPATCH_INBOUND_ACCEPTED);
      if (
        payload.sourceScope === envelope.sourceScope &&
        payload.idempotencyKey === envelope.idempotencyKey
      ) {
        const deliveredEventId = finiteNumberField(payload, "deliveredEventId");
        const claim = parseDispatchLivedClaim(payload.claim, DISPATCH_INBOUND_ACCEPTED);
        if (!claim.ok) throw new SqlError({ cause: claim.failure.reason });
        return deliveredEventId;
      }
    }
    return null;
  }

  async #loadResourceState(identity: LedgerTruthIdentity): Promise<ProjectedResourceState> {
    const events = await this.#events(runtimeIdentity(identity));
    const reservations = new Map<string, ReservationState>();
    const byIdempotencyKey = new Map<string, ReservationState>();
    const grants: Array<{ readonly key: string; readonly amount: number }> = [];
    for (const event of events) {
      if (!event.kind.startsWith("resource_pool.")) continue;
      const payload = recordOf(event.payload, event.kind);
      switch (event.kind) {
        case "resource_pool.granted":
          grants.push({ key: stringField(payload, "key"), amount: finiteNumberField(payload, "amount") });
          break;
        case "resource_pool.reserved": {
          const reservation: ReservationState = {
            reservationId: stringField(payload, "reservationId"),
            key: stringField(payload, "key"),
            amount: finiteNumberField(payload, "amount"),
            idempotencyKey: stringField(payload, "idempotencyKey"),
            status: "active",
          };
          reservations.set(reservation.reservationId, reservation);
          byIdempotencyKey.set(reservation.idempotencyKey, reservation);
          break;
        }
        case "resource_pool.consumed":
        case "resource_pool.released": {
          const reservationId = stringField(payload, "reservationId");
          const existing = reservations.get(reservationId);
          if (existing !== undefined) {
            const next = {
              ...existing,
              status: event.kind === "resource_pool.consumed" ? "consumed" : "released",
            } satisfies ReservationState;
            reservations.set(reservationId, next);
            byIdempotencyKey.set(next.idempotencyKey, next);
          }
          break;
        }
      }
    }
    const byKey = new Map<string, ResourceProjection>();
    for (const grant of grants) addResourceProjection(byKey, grant.key, { available: grant.amount });
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
    return { byId: reservations, byIdempotencyKey, byKey };
  }

  async #insertDueWork(
    identity: BackendProtocolEventIdentity,
    kind: string,
    intentEventId: number,
    fireAt: number,
  ): Promise<number> {
    const identityKey = backendProtocolEventIdentityKey(identity);
    const rows = await this.#sql.jsonArrayStatement<{ readonly id: number }>(`
      WITH inserted AS (
      INSERT INTO agentos_due_work (
        identity_key, identity, fire_at, kind, payload
      )
      VALUES (
        ${sqlString(identityKey)},
        ${sqlJson(identity)},
        ${sqlNumber(fireAt)},
        ${sqlString(kind)},
        ${sqlJson(durableTriggerDuePayload(intentEventId))}
      )
      RETURNING id::int AS id
      ),
      agentos_json_rows AS (
        SELECT * FROM inserted
      )
      SELECT COALESCE(json_agg(row_to_json(agentos_json_rows)), '[]'::json)::text
      FROM agentos_json_rows
    `);
    const row = rows[0];
    if (row === undefined) throw new SqlError({ cause: "due_work insert returned no row" });
    return row.id;
  }

  async #claimDue(identity: BackendProtocolEventIdentity, now: number): Promise<DueWorkRow | null> {
    const token = randomUUID();
    const deadlineAt = now + 60_000;
    const rows = await this.#sql.jsonArrayStatement<DueWorkRow>(`
      WITH candidate AS (
        SELECT id, claim_token
        FROM agentos_due_work
        WHERE identity_key = ${sqlString(backendProtocolEventIdentityKey(identity))}
          AND completed_at IS NULL
          AND fire_at <= ${sqlNumber(now)}
          AND (claim_token IS NULL OR claim_deadline_at <= ${sqlNumber(now)})
        ORDER BY fire_at ASC, id ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      ),
      claimed AS (
        UPDATE agentos_due_work work
        SET
          claimed_at = ${sqlNumber(now)},
          claim_token = ${sqlString(token)},
          claim_deadline_at = ${sqlNumber(deadlineAt)},
          redrive_count = CASE
            WHEN candidate.claim_token IS NULL THEN work.redrive_count
            ELSE work.redrive_count + 1
          END
        FROM candidate
        WHERE work.id = candidate.id
        RETURNING
          work.id::int AS "id",
          work.identity AS "identity",
          work.identity_key AS "identityKey",
          work.fire_at AS "fireAt",
          work.kind AS "kind",
          work.payload AS "payload",
          work.claim_token AS "claimToken",
          work.redrive_count AS "redriveCount",
          work.cancel_requested_at AS "cancelRequestedAt",
          work.cancel_reason AS "cancelReason"
      )
      , agentos_json_rows AS (
        SELECT * FROM claimed
      )
      SELECT COALESCE(json_agg(row_to_json(agentos_json_rows)), '[]'::json)::text
      FROM agentos_json_rows
    `);
    return rows[0] ?? null;
  }

  async #completeDue(id: number, now: number, token: string | null): Promise<void> {
    await this.#sql.exec(`
      UPDATE agentos_due_work
      SET completed_at = ${sqlNumber(now)}
      WHERE id = ${sqlNumber(id)}
        AND completed_at IS NULL
        ${token === null ? "" : `AND claim_token = ${sqlString(token)}`};
    `);
  }

  async #eventById(
    identity: BackendProtocolEventIdentity,
    id: number,
  ): Promise<ReadonlyArray<LedgerEvent>> {
    return this.#sql.json<LedgerEvent>(`
      ${eventRowSelect}
      WHERE identity_key = ${sqlString(backendProtocolEventIdentityKey(identity))}
        AND id = ${sqlNumber(id)}
      ORDER BY id ASC
    `);
  }

  async #events(
    identity: BackendProtocolEventIdentity,
    opts: EventQueryOptions = {},
  ): Promise<ReadonlyArray<LedgerEvent>> {
    const afterId = Math.max(0, Math.floor(opts.afterId ?? 0));
    const limit = Math.min(MAX_EVENT_LIMIT, Math.max(1, Math.floor(opts.limit ?? DEFAULT_EVENT_LIMIT)));
    const kinds =
      opts.kinds === undefined || opts.kinds.length === 0
        ? ""
        : `AND kind = ANY(ARRAY[${opts.kinds.map(sqlString).join(", ")}]::text[])`;
    const factOwners =
      opts.factOwnerRefs === undefined || opts.factOwnerRefs.length === 0
        ? ""
        : `AND fact_owner_ref #>> '{}' = ANY(ARRAY[${opts.factOwnerRefs.map(sqlString).join(", ")}]::text[])`;
    return this.#sql.json<LedgerEvent>(`
      ${eventRowSelect}
      WHERE identity_key = ${sqlString(backendProtocolEventIdentityKey(identity))}
        AND id > ${sqlNumber(afterId)}
        ${kinds}
        ${factOwners}
      ORDER BY id ASC
      LIMIT ${sqlNumber(limit)}
    `);
  }

  async #appendEvents(
    specs: ReadonlyArray<{
      readonly ts: number;
      readonly kind: string;
      readonly identity: BackendProtocolEventIdentity;
      readonly payload: unknown;
    }>,
  ): Promise<ReadonlyArray<LedgerEvent>> {
    const rows = await this.#sql.jsonArrayStatement<LedgerEvent>(`
      WITH input AS (
        SELECT *
        FROM jsonb_to_recordset(${sqlPayload(
          specs.map((spec) => ({
            ts: spec.ts,
            kind: spec.kind,
            truthKey: backendProtocolTruthIdentityKey(spec.identity),
            identityKey: backendProtocolEventIdentityKey(spec.identity),
            scopeRef: spec.identity.scopeRef,
            factOwnerRef: spec.identity.factOwnerRef,
            effectAuthorityRef: spec.identity.effectAuthorityRef,
            payload: spec.payload,
          })),
        )})
        AS x(
          "ts" double precision,
          "kind" text,
          "truthKey" text,
          "identityKey" text,
          "scopeRef" jsonb,
          "factOwnerRef" jsonb,
          "effectAuthorityRef" jsonb,
          "payload" jsonb
        )
      ),
      inserted AS (
        INSERT INTO agentos_events (
          ts, kind, truth_key, identity_key, scope_ref, fact_owner_ref, effect_authority_ref, payload
        )
        SELECT "ts", "kind", "truthKey", "identityKey", "scopeRef", "factOwnerRef", "effectAuthorityRef", "payload"
        FROM input
        RETURNING
          id::int AS "id",
          ts AS "ts",
          kind AS "kind",
          scope_ref AS "scopeRef",
          fact_owner_ref #>> '{}' AS "factOwnerRef",
          effect_authority_ref AS "effectAuthorityRef",
          payload AS "payload"
      )
      , agentos_json_rows AS (
        SELECT * FROM inserted ORDER BY id ASC
      )
      SELECT COALESCE(json_agg(row_to_json(agentos_json_rows)), '[]'::json)::text
      FROM agentos_json_rows
    `);
    await this.#fireMany(rows);
    return rows;
  }

  async #nextEventId(offset: number): Promise<number> {
    const rows = await this.#sql.json<{ readonly id: number }>(`
      SELECT nextval('agentos_events_id_seq')::int AS id
      FROM generate_series(1, ${sqlNumber(offset + 1)})
      ORDER BY id DESC
      LIMIT 1
    `);
    const row = rows[0];
    if (row === undefined) throw new SqlError({ cause: "next event id unavailable" });
    return row.id;
  }

  async #appendEventsWithIds(
    specs: ReadonlyArray<{
      readonly id: number;
      readonly ts: number;
      readonly kind: string;
      readonly identity: BackendProtocolEventIdentity;
      readonly payload: unknown;
    }>,
  ): Promise<ReadonlyArray<LedgerEvent>> {
    const rows = await this.#sql.jsonArrayStatement<LedgerEvent>(`
      WITH input AS (
        SELECT *
        FROM jsonb_to_recordset(${sqlPayload(
          specs.map((spec) => ({
            id: spec.id,
            ts: spec.ts,
            kind: spec.kind,
            truthKey: backendProtocolTruthIdentityKey(spec.identity),
            identityKey: backendProtocolEventIdentityKey(spec.identity),
            scopeRef: spec.identity.scopeRef,
            factOwnerRef: spec.identity.factOwnerRef,
            effectAuthorityRef: spec.identity.effectAuthorityRef,
            payload: spec.payload,
          })),
        )})
        AS x(
          "id" bigint,
          "ts" double precision,
          "kind" text,
          "truthKey" text,
          "identityKey" text,
          "scopeRef" jsonb,
          "factOwnerRef" jsonb,
          "effectAuthorityRef" jsonb,
          "payload" jsonb
        )
      ),
      inserted AS (
        INSERT INTO agentos_events (
          id, ts, kind, truth_key, identity_key, scope_ref, fact_owner_ref, effect_authority_ref, payload
        )
        SELECT "id", "ts", "kind", "truthKey", "identityKey", "scopeRef", "factOwnerRef", "effectAuthorityRef", "payload"
        FROM input
        RETURNING
          id::int AS "id",
          ts AS "ts",
          kind AS "kind",
          scope_ref AS "scopeRef",
          fact_owner_ref #>> '{}' AS "factOwnerRef",
          effect_authority_ref AS "effectAuthorityRef",
          payload AS "payload"
      )
      , agentos_json_rows AS (
        SELECT * FROM inserted ORDER BY id ASC
      )
      SELECT COALESCE(json_agg(row_to_json(agentos_json_rows)), '[]'::json)::text
      FROM agentos_json_rows
    `);
    await this.#fireMany(rows);
    return rows;
  }

  async #fireMany(events: ReadonlyArray<LedgerEvent>): Promise<void> {
    for (const event of events) {
      const identityKey = backendProtocolEventIdentityKey(event);
      for (const sink of Array.from(this.#sinks)) {
        if (sink.identityKey !== identityKey || sink.kind !== event.kind) continue;
        try {
          sink.sink(event);
        } catch (cause) {
          this.#diagnostics.push({
            phase: "sink",
            eventId: event.id,
            kind: event.kind,
            identityKey: backendProtocolTruthIdentityKey(event),
            message: describeDispatchCause(cause),
          });
        }
      }
      const handlers = this.#handlers.get(event.kind);
      if (handlers === undefined) continue;
      for (const handler of handlers) {
        try {
          await handler(eventToRpc(event));
        } catch {
          // Handler failures are post-commit diagnostics; a failed handler must
          // not prevent later handlers from observing the committed fact.
        }
      }
    }
  }
}

export const nodePostgresRuntimeIdentity = runtimeIdentity;
export const nodePostgresProjectionKey = backendProtocolProjectionKey;
export type { FactOwnerRef };
