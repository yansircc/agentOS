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
  DURABLE_TRIGGER_SCHEDULED_REQUESTED,
  QUOTA_EVENT_KIND,
  RESOURCE_EVENT_KIND,
  SCHEDULED_EVENT_TRIGGER_KIND,
  backendProtocolEventIdentityKey,
  backendProtocolProjectionKey,
  backendProtocolTruthIdentityKey,
  copyTraceContext,
  describeDispatchCause,
  dispatchBackoffMs,
  dispatchLedgerDeliveryReceipt,
  dispatchTargetDelivered,
  emptyResourceProjection,
  parseDispatchLivedClaim,
  parseScheduledEventIntentPayload,
  parseRequestedPayloadValue,
  projectQuotaGrantUsage,
  projectResourceEvents,
  scheduledEventIntentPayload,
  settleDispatchInboundAccepted,
  settleDispatchOutboundDelivered,
  type BackendProtocolEventIdentity,
  type BackendProtocolProjectionKey,
  type BackendProtocolTruthIdentity,
  type DispatchEnqueueAcknowledgement,
  type DispatchEnvelope,
  type DispatchReceiverResult,
  type DispatchTargetAdapter,
  type DispatchTargetResult,
  type GrantResult,
  type ProjectedResourceState,
  type ResourceProjection,
} from "@agent-os/backend-protocol";
import {
  assertRuntimeLedgerTransitions,
  RUNTIME_FACT_OWNER,
  type LedgerCommitEventSpec,
  type LedgerTruthIdentity,
} from "@agent-os/runtime-protocol";
import { InvalidTraceContext, type TelemetryFanoutDiagnostic } from "@agent-os/telemetry-protocol";
import { validateOptionalTraceContext } from "@agent-os/telemetry-protocol";
import {
  PsqlCli,
  quoteIdentifier,
  sqlJson,
  sqlNumber,
  sqlString,
  systemTimeNow,
  type NodePostgresNow,
} from "./host";

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
  readonly dispatchIntent: LedgerEvent | null;
  readonly dispatchSuccessCount: number;
  readonly dispatchAttemptCount: number;
}

interface ResourceReserveTransactionRow {
  readonly status: "existing" | "reserved" | "insufficient";
  readonly reservationId: string;
  readonly available: number;
  readonly event: LedgerEvent | null;
}

interface ResourceTerminalTransactionRow {
  readonly status: "written" | "noop" | "missing" | "closed";
  readonly closedStatus: "consumed" | "released" | null;
  readonly event: LedgerEvent | null;
}

const DEFAULT_EVENT_LIMIT = 1000;
const MAX_EVENT_LIMIT = 1000;

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

const groupRuntimeEventsByIdentityKey = (
  events: ReadonlyArray<LedgerEvent>,
): Map<string, LedgerEvent[]> => {
  const groups = new Map<string, LedgerEvent[]>();
  for (const event of events) {
    if (event.factOwnerRef !== RUNTIME_FACT_OWNER) continue;
    const key = backendProtocolEventIdentityKey(event);
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, [event]);
    } else {
      group.push(event);
    }
  }
  return groups;
};

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

const recordOf = (value: unknown, label: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SqlError({ cause: `${label} payload must be object` });
  }
  return value as Record<string, unknown>;
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

const resourceLockKey = (identityKey: string): string => `agentos:resource:${identityKey}`;

const resourceProjectionCtes = (identityKey: string): string => `
  resource_events AS (
    SELECT id, kind, payload
    FROM agentos_events
    WHERE identity_key = ${sqlString(identityKey)}
      AND kind LIKE 'resource_pool.%'
    ORDER BY id ASC
  ),
  resource_grants AS (
    SELECT
      id,
      payload ->> 'key' AS resource_key,
      (payload ->> 'amount')::double precision AS amount
    FROM resource_events
    WHERE kind = ${sqlString(RESOURCE_EVENT_KIND.GRANTED)}
  ),
  resource_reserved AS (
    SELECT
      id,
      payload ->> 'reservationId' AS reservation_id,
      payload ->> 'idempotencyKey' AS idempotency_key,
      payload ->> 'key' AS resource_key,
      (payload ->> 'amount')::double precision AS amount
    FROM resource_events
    WHERE kind = ${sqlString(RESOURCE_EVENT_KIND.RESERVED)}
  ),
  resource_rejections AS (
    SELECT
      id,
      payload ->> 'idempotencyKey' AS idempotency_key,
      payload ->> 'key' AS resource_key,
      (payload ->> 'amount')::double precision AS amount,
      (payload ->> 'available')::double precision AS available
    FROM resource_events
    WHERE kind = ${sqlString(RESOURCE_EVENT_KIND.RESERVE_REJECTED)}
  ),
  resource_terminal AS (
    SELECT
      payload ->> 'reservationId' AS reservation_id,
      kind,
      id,
      row_number() OVER (PARTITION BY payload ->> 'reservationId' ORDER BY id DESC) AS ordinal
    FROM resource_events
    WHERE kind IN (
      ${sqlString(RESOURCE_EVENT_KIND.CONSUMED)},
      ${sqlString(RESOURCE_EVENT_KIND.RELEASED)}
    )
  ),
  resource_reservations AS (
    SELECT
      reserved.id,
      reserved.reservation_id,
      reserved.idempotency_key,
      reserved.resource_key,
      reserved.amount,
      terminal.kind AS terminal_kind
    FROM resource_reserved reserved
    LEFT JOIN resource_terminal terminal
      ON terminal.reservation_id = reserved.reservation_id
     AND terminal.ordinal = 1
  ),
  resource_projection_validation AS (
    SELECT
      (SELECT COUNT(*) FROM resource_grants)
      + (SELECT COUNT(*) FROM resource_reserved)
      + (SELECT COUNT(*) FROM resource_rejections)
      + (SELECT COUNT(*) FROM resource_terminal) AS row_count
  )
`;

export class NodePostgresBackend {
  readonly bindingRef: BindingMaterialRef;
  readonly #sql: PsqlCli;
  readonly #schema: string;
  readonly #handlers = new Map<string, Set<EventHandler>>();
  readonly #sinks = new Set<EventSink>();
  readonly #diagnostics: TelemetryFanoutDiagnostic[] = [];
  readonly #targets = new Map<string, DispatchTargetAdapter>();
  readonly #now: NodePostgresNow;

  constructor(options: NodePostgresBackendOptions) {
    this.bindingRef = options.bindingRef;
    this.#schema = schemaName(options.schema);
    this.#now = systemTimeNow;
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
      CREATE UNIQUE INDEX IF NOT EXISTS agentos_dispatch_inbound_idempotency_idx
        ON agentos_events (
          identity_key,
          ((payload ->> 'sourceScope')),
          ((payload ->> 'idempotencyKey'))
        )
        WHERE kind = ${sqlString(DISPATCH_INBOUND_ACCEPTED)};

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
          const target = this.#targets.get(
            `${materialRefKey(this.bindingRef)}:${envelope.targetScope}`,
          );
          if (target !== undefined) return target.deliver(envelope);
        }
        const accept = () => this.receive(identity, envelope);
        return (receiver === undefined ? accept() : receiver(envelope, accept)).then(
          dispatchTargetDelivered,
        );
      },
    });
    this.#targets.set(`${materialRefKey(this.bindingRef)}:${targetScope}`, {
      deliver: (envelope) => {
        const accept = () => this.receive(identity, envelope);
        return (receiver === undefined ? accept() : receiver(envelope, accept)).then(
          dispatchTargetDelivered,
        );
      },
    });
  }

  setDispatchTargetAdapter(
    adapter: DispatchTargetAdapter | DispatchTargetAdapter["deliver"],
  ): void {
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
        ts: this.#now(),
        kind,
        identity,
        payload,
      },
    ]);
    if (event === undefined) throw new SqlError({ cause: "ledger commit returned no event" });
    return event;
  }

  async commit(events: ReadonlyArray<LedgerCommitEventSpec>): Promise<ReadonlyArray<LedgerEvent>> {
    const ts = this.#now();
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
    const event = await this.#appendEventAndDueWork(
      {
        ts: this.#now(),
        kind: DURABLE_TRIGGER_SCHEDULED_REQUESTED,
        identity,
        payload: scheduledEventIntentPayload(eventKind, data),
      },
      SCHEDULED_EVENT_TRIGGER_KIND,
      at,
    );
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
    const now = this.#now();
    const event = await this.#appendEventAndDueWork(
      {
        ts: now,
        kind: DISPATCH_EVENT_KINDS.OUTBOUND_REQUESTED,
        identity,
        payload: requested,
      },
      DELIVERY_RETRY_TRIGGER_KIND,
      now,
    );
    await this.#drainDue(identity, now);
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
        receipt: dispatchLedgerDeliveryReceipt({
          targetScope: scopeLabel,
          deliveredEventId: accepted,
        }),
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
    const events = await this.#appendDispatchReceiveEvents({
      identity,
      acceptedEventId,
      deliveredEventId,
      acceptedPayload: {
        sourceScope: envelope.sourceScope,
        outboundEventId: envelope.outboundEventId,
        idempotencyKey: envelope.idempotencyKey,
        deliveredEventId,
        claim,
        ...(traceContextResult.traceContext === undefined
          ? {}
          : { traceContext: copyTraceContext(traceContextResult.traceContext) }),
      },
      deliveredKind: envelope.event,
      deliveredPayload: envelope.data,
    });
    if (events.length === 0) {
      const concurrentAccepted = await this.#findAcceptedDeliveryId(identity, envelope);
      if (concurrentAccepted === null) {
        throw new SqlError({ cause: "dispatch receive conflict returned no accepted event" });
      }
      return {
        deliveredEventId: concurrentAccepted,
        receipt: dispatchLedgerDeliveryReceipt({
          targetScope: scopeLabel,
          deliveredEventId: concurrentAccepted,
        }),
      };
    }
    const delivered = events.find((event) => event.id === deliveredEventId);
    if (delivered === undefined)
      throw new SqlError({ cause: "dispatch receive returned no event" });
    return {
      deliveredEventId: delivered.id,
      receipt: dispatchLedgerDeliveryReceipt({
        targetScope: scopeLabel,
        deliveredEventId: delivered.id,
      }),
    };
  }

  async #appendDispatchReceiveEvents(spec: {
    readonly identity: BackendProtocolEventIdentity;
    readonly acceptedEventId: number;
    readonly deliveredEventId: number;
    readonly acceptedPayload: unknown;
    readonly deliveredKind: string;
    readonly deliveredPayload: unknown;
  }): Promise<ReadonlyArray<LedgerEvent>> {
    const ts = this.#now();
    const truthKey = backendProtocolTruthIdentityKey(spec.identity);
    const identityKey = backendProtocolEventIdentityKey(spec.identity);
    const rows = await this.#sql.jsonArrayStatement<LedgerEvent>(`
      WITH accepted AS (
        INSERT INTO agentos_events (
          id, ts, kind, truth_key, identity_key, scope_ref, fact_owner_ref, effect_authority_ref, payload
        )
        VALUES (
          ${sqlNumber(spec.acceptedEventId)},
          ${sqlNumber(ts)},
          ${sqlString(DISPATCH_INBOUND_ACCEPTED)},
          ${sqlString(truthKey)},
          ${sqlString(identityKey)},
          ${sqlJson(spec.identity.scopeRef)},
          ${sqlJson(spec.identity.factOwnerRef)},
          ${sqlJson(spec.identity.effectAuthorityRef)},
          ${sqlPayload(spec.acceptedPayload)}
        )
        ON CONFLICT (
          identity_key,
          ((payload ->> 'sourceScope')),
          ((payload ->> 'idempotencyKey'))
        )
        WHERE kind = ${sqlString(DISPATCH_INBOUND_ACCEPTED)}
        DO NOTHING
        RETURNING
          id::int AS "id",
          ts AS "ts",
          kind AS "kind",
          scope_ref AS "scopeRef",
          fact_owner_ref #>> '{}' AS "factOwnerRef",
          effect_authority_ref AS "effectAuthorityRef",
          payload AS "payload"
      ),
      delivered AS (
        INSERT INTO agentos_events (
          id, ts, kind, truth_key, identity_key, scope_ref, fact_owner_ref, effect_authority_ref, payload
        )
        SELECT
          ${sqlNumber(spec.deliveredEventId)},
          ${sqlNumber(ts)},
          ${sqlString(spec.deliveredKind)},
          ${sqlString(truthKey)},
          ${sqlString(identityKey)},
          ${sqlJson(spec.identity.scopeRef)},
          ${sqlJson(spec.identity.factOwnerRef)},
          ${sqlJson(spec.identity.effectAuthorityRef)},
          ${sqlPayload(spec.deliveredPayload)}
        FROM accepted
        RETURNING
          id::int AS "id",
          ts AS "ts",
          kind AS "kind",
          scope_ref AS "scopeRef",
          fact_owner_ref #>> '{}' AS "factOwnerRef",
          effect_authority_ref AS "effectAuthorityRef",
          payload AS "payload"
      ),
      agentos_json_rows AS (
        SELECT * FROM accepted
        UNION ALL
        SELECT * FROM delivered
        ORDER BY "id" ASC
      )
      SELECT COALESCE(json_agg(row_to_json(agentos_json_rows)), '[]'::json)::text
      FROM agentos_json_rows
    `);
    if (rows.length !== 0 && rows.length !== 2) {
      throw new SqlError({ cause: "dispatch receive append returned partial event pair" });
    }
    await this.#fireMany(rows);
    return rows;
  }

  async grantResource(
    identity: BackendProtocolEventIdentity,
    spec: ResourceGrantSpec,
  ): Promise<ResourceGrantResult> {
    positiveAmount(spec.amount);
    const event = await this.#appendResourceEventLocked({
      ts: this.#now(),
      kind: RESOURCE_EVENT_KIND.GRANTED,
      identity,
      payload: { key: spec.key, amount: spec.amount, ref: spec.ref },
    });
    return { eventId: event.id };
  }

  async reserveResource(
    identity: BackendProtocolEventIdentity,
    spec: ResourceReserveSpec,
  ): Promise<ResourceReserveResult> {
    positiveAmount(spec.amount);
    const reservationId = randomUUID();
    const identityKey = backendProtocolEventIdentityKey(identity);
    const now = this.#now();
    const [row] = await this.#sql.jsonArrayStatement<ResourceReserveTransactionRow>(`
      BEGIN;
      SELECT pg_advisory_xact_lock(hashtextextended(${sqlString(resourceLockKey(identityKey))}, 0));

      WITH
      ${resourceProjectionCtes(identityKey)},
      resource_balance AS (
        SELECT
          COALESCE(
            (SELECT SUM(amount) FROM resource_grants WHERE resource_key = ${sqlString(spec.key)}),
            0
          )
          - COALESCE(
            (
              SELECT SUM(amount)
              FROM resource_reservations
              WHERE resource_key = ${sqlString(spec.key)}
                AND terminal_kind IS NULL
            ),
            0
          )
          - COALESCE(
            (
              SELECT SUM(amount)
              FROM resource_reservations
              WHERE resource_key = ${sqlString(spec.key)}
                AND terminal_kind = ${sqlString(RESOURCE_EVENT_KIND.CONSUMED)}
            ),
            0
          ) AS available
        FROM resource_projection_validation
      ),
      existing_reservation AS (
        SELECT reservation_id
        FROM resource_reservations
        WHERE idempotency_key = ${sqlString(spec.idempotencyKey)}
        ORDER BY id DESC
        LIMIT 1
      ),
      decision AS (
        SELECT
          existing_reservation.reservation_id AS existing_reservation_id,
          resource_balance.available AS available
        FROM resource_balance
        LEFT JOIN existing_reservation ON TRUE
      ),
      event_input AS (
        SELECT
          CASE
            WHEN decision.available < ${sqlNumber(spec.amount)}
              THEN ${sqlString(RESOURCE_EVENT_KIND.RESERVE_REJECTED)}
            ELSE ${sqlString(RESOURCE_EVENT_KIND.RESERVED)}
          END AS kind,
          CASE
            WHEN decision.available < ${sqlNumber(spec.amount)}
              THEN jsonb_build_object(
                'key', ${sqlString(spec.key)},
                'amount', ${sqlNumber(spec.amount)},
                'ref', ${sqlString(spec.ref)},
                'idempotencyKey', ${sqlString(spec.idempotencyKey)},
                'available', decision.available
              )
            ELSE jsonb_build_object(
              'key', ${sqlString(spec.key)},
              'amount', ${sqlNumber(spec.amount)},
              'ref', ${sqlString(spec.ref)},
              'idempotencyKey', ${sqlString(spec.idempotencyKey)},
              'reservationId', ${sqlString(reservationId)}
            )
          END AS payload
        FROM decision
        WHERE decision.existing_reservation_id IS NULL
      ),
      inserted AS (
        INSERT INTO agentos_events (
          ts,
          kind,
          truth_key,
          identity_key,
          scope_ref,
          fact_owner_ref,
          effect_authority_ref,
          payload
        )
        SELECT
          ${sqlNumber(now)},
          event_input.kind,
          ${sqlString(backendProtocolTruthIdentityKey(identity))},
          ${sqlString(identityKey)},
          ${sqlJson(identity.scopeRef)},
          ${sqlJson(identity.factOwnerRef)},
          ${sqlJson(identity.effectAuthorityRef)},
          event_input.payload
        FROM event_input
        RETURNING
          id::int AS "id",
          ts AS "ts",
          kind AS "kind",
          scope_ref AS "scopeRef",
          fact_owner_ref #>> '{}' AS "factOwnerRef",
          effect_authority_ref AS "effectAuthorityRef",
          payload AS "payload"
      ),
      result AS (
        SELECT
          CASE
            WHEN decision.existing_reservation_id IS NOT NULL THEN 'existing'
            WHEN decision.available < ${sqlNumber(spec.amount)} THEN 'insufficient'
            ELSE 'reserved'
          END AS "status",
          COALESCE(decision.existing_reservation_id, ${sqlString(reservationId)}) AS "reservationId",
          decision.available AS "available",
          (SELECT row_to_json(inserted) FROM inserted LIMIT 1) AS "event"
        FROM decision
      ),
      agentos_json_rows AS (
        SELECT * FROM result
      )
      SELECT COALESCE(json_agg(row_to_json(agentos_json_rows)), '[]'::json)::text
      FROM agentos_json_rows;
      COMMIT
    `);
    if (row === undefined) throw new SqlError({ cause: "resource reserve returned no result" });
    if (row.event !== null) await this.#fireMany([row.event]);
    if (row.status === "insufficient") {
      throw new ResourceInsufficient({
        key: spec.key,
        requested: spec.amount,
        available: row.available,
      });
    }
    return { reservationId: row.reservationId };
  }

  async consumeResource(
    identity: BackendProtocolEventIdentity,
    spec: ResourceReservationSpec,
  ): Promise<void> {
    await this.#terminalResourceReservationLocked(identity, spec, RESOURCE_EVENT_KIND.CONSUMED);
  }

  async releaseResource(
    identity: BackendProtocolEventIdentity,
    spec: ResourceReservationSpec,
  ): Promise<void> {
    await this.#terminalResourceReservationLocked(identity, spec, RESOURCE_EVENT_KIND.RELEASED);
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
    const now = this.#now();
    const windowStart = windowMs === Number.POSITIVE_INFINITY ? 0 : now - windowMs;
    const events = await this.#events(identity);
    let usage: ReturnType<typeof projectQuotaGrantUsage>;
    try {
      usage = projectQuotaGrantUsage(events, {
        key: key.projectionId,
        windowStart,
        operationRef,
      });
    } catch (cause) {
      throw new SqlError({ cause });
    }
    if (usage.alreadyGranted) return { granted: true, consumed: usage.consumed, limit };
    const consumed = usage.consumed;
    if (consumed + amount > limit) {
      await this.#appendEvents([
        {
          ts: now,
          kind: QUOTA_EVENT_KIND.RATE_LIMITED,
          identity,
          payload: {
            key: key.projectionId,
            attempted: amount,
            consumed,
            limit,
            windowMs,
            toolName,
          },
        },
      ]);
      return { granted: false, consumed, limit };
    }
    await this.#appendEvents([
      {
        ts: now,
        kind: QUOTA_EVENT_KIND.CONSUMED,
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
    const parsed = parseScheduledEventIntentPayload(intent.payload);
    if (!parsed.ok) {
      await this.#completeDue(row.id, now, row.claimToken);
      return;
    }
    await this.#appendEventsAndCompleteDue(
      [
        {
          ts: now,
          kind: parsed.payload.eventKind,
          identity: row.identity,
          payload: parsed.payload.data,
        },
      ],
      row,
      now,
    );
  }

  async #commitDispatchRetry(row: DueWorkRow, now: number): Promise<void> {
    const intent = row.dispatchIntent;
    if (intent === null) {
      await this.#completeDue(row.id, now, row.claimToken);
      return;
    }
    const parsed = parseRequestedPayloadValue(intent.payload);
    if (!parsed.ok) {
      await this.#completeDue(row.id, now, row.claimToken);
      return;
    }
    const requested = parsed.value;
    if (row.dispatchSuccessCount > 0) {
      await this.#completeDue(row.id, now, row.claimToken);
      return;
    }
    const attempts = row.dispatchAttemptCount + 1;
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
    let outcome: DispatchTargetResult | { readonly _tag: "failed"; readonly cause: unknown };
    try {
      if (target === undefined) throw "agent_os.dispatch_target_not_found";
      outcome = await target.deliver(envelope);
    } catch (cause) {
      outcome = { _tag: "failed", cause };
    }

    if (outcome._tag === "delivered") {
      await this.#appendEventsAndCompleteDue(
        [
          {
            ts: now,
            kind: DISPATCH_EVENT_KINDS.OUTBOUND_DELIVERED,
            identity: row.identity,
            payload: {
              outboundEventId: intent.id,
              target: requested.target,
              event: requested.event,
              idempotencyKey: requested.idempotencyKey,
              deliveryReceipt: outcome.receipt,
              attempt: attempts,
              claim: settleDispatchOutboundDelivered(requested.claim, {
                bindingKey,
                deliveryReceipt: outcome.receipt,
              }),
              ...(requested.traceContext === undefined
                ? {}
                : { traceContext: requested.traceContext }),
            },
          },
        ],
        row,
        now,
      );
      return;
    }

    if (outcome._tag === "enqueued") {
      const acknowledgement: DispatchEnqueueAcknowledgement = outcome.acknowledgement;
      await this.#appendEventsAndCompleteDue(
        [
          {
            ts: now,
            kind: DISPATCH_EVENT_KINDS.OUTBOUND_ENQUEUED,
            identity: row.identity,
            payload: {
              outboundEventId: intent.id,
              target: requested.target,
              event: requested.event,
              idempotencyKey: requested.idempotencyKey,
              enqueueAcknowledgement: acknowledgement,
              attempt: attempts,
              ...(requested.traceContext === undefined
                ? {}
                : { traceContext: requested.traceContext }),
            },
          },
        ],
        row,
        now,
      );
      return;
    }

    const terminal = attempts >= requested.retryPolicy.maxAttempts;
    const nextAttemptAt = terminal ? null : now + dispatchBackoffMs(attempts);
    await this.#appendEventsAndCompleteDue(
      [
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
            error: describeDispatchCause(outcome.cause),
            terminal,
            ...(nextAttemptAt === null ? {} : { nextAttemptAt }),
            ...(requested.traceContext === undefined
              ? {}
              : { traceContext: requested.traceContext }),
          },
        },
      ],
      row,
      now,
      nextAttemptAt === null
        ? undefined
        : {
            kind: DELIVERY_RETRY_TRIGGER_KIND,
            intentEventId: intent.id,
            fireAt: nextAttemptAt,
          },
    );
  }

  async #findAcceptedDeliveryId(
    identity: BackendProtocolEventIdentity,
    envelope: DispatchEnvelope,
  ): Promise<number | null> {
    const rows = await this.#sql.json<{ readonly payload: unknown }>(`
      SELECT payload AS "payload"
      FROM agentos_events
      WHERE identity_key = ${sqlString(backendProtocolEventIdentityKey(identity))}
        AND kind = ${sqlString(DISPATCH_INBOUND_ACCEPTED)}
        AND payload ->> 'sourceScope' = ${sqlString(envelope.sourceScope)}
        AND payload ->> 'idempotencyKey' = ${sqlString(envelope.idempotencyKey)}
      ORDER BY id ASC
      LIMIT 1
    `);
    const row = rows[0];
    if (row === undefined) return null;
    const payload = recordOf(row.payload, DISPATCH_INBOUND_ACCEPTED);
    const deliveredEventId = finiteNumberField(payload, "deliveredEventId");
    const claim = parseDispatchLivedClaim(payload.claim, DISPATCH_INBOUND_ACCEPTED);
    if (!claim.ok) throw new SqlError({ cause: claim.failure.reason });
    return deliveredEventId;
  }

  async #appendResourceEventLocked(spec: {
    readonly ts: number;
    readonly kind: string;
    readonly identity: BackendProtocolEventIdentity;
    readonly payload: unknown;
  }): Promise<LedgerEvent> {
    const identityKey = backendProtocolEventIdentityKey(spec.identity);
    const rows = await this.#sql.jsonArrayStatement<LedgerEvent>(`
      BEGIN;
      SELECT pg_advisory_xact_lock(hashtextextended(${sqlString(resourceLockKey(identityKey))}, 0));

      WITH inserted AS (
        INSERT INTO agentos_events (
          ts,
          kind,
          truth_key,
          identity_key,
          scope_ref,
          fact_owner_ref,
          effect_authority_ref,
          payload
        )
        VALUES (
          ${sqlNumber(spec.ts)},
          ${sqlString(spec.kind)},
          ${sqlString(backendProtocolTruthIdentityKey(spec.identity))},
          ${sqlString(identityKey)},
          ${sqlJson(spec.identity.scopeRef)},
          ${sqlJson(spec.identity.factOwnerRef)},
          ${sqlJson(spec.identity.effectAuthorityRef)},
          ${sqlPayload(spec.payload)}
        )
        RETURNING
          id::int AS "id",
          ts AS "ts",
          kind AS "kind",
          scope_ref AS "scopeRef",
          fact_owner_ref #>> '{}' AS "factOwnerRef",
          effect_authority_ref AS "effectAuthorityRef",
          payload AS "payload"
      ),
      agentos_json_rows AS (
        SELECT * FROM inserted ORDER BY id ASC
      )
      SELECT COALESCE(json_agg(row_to_json(agentos_json_rows)), '[]'::json)::text
      FROM agentos_json_rows;
      COMMIT
    `);
    const event = rows[0];
    if (event === undefined) throw new SqlError({ cause: "resource append returned no event" });
    await this.#fireMany(rows);
    return event;
  }

  async #terminalResourceReservationLocked(
    identity: BackendProtocolEventIdentity,
    spec: ResourceReservationSpec,
    terminalKind: typeof RESOURCE_EVENT_KIND.CONSUMED | typeof RESOURCE_EVENT_KIND.RELEASED,
  ): Promise<void> {
    const identityKey = backendProtocolEventIdentityKey(identity);
    const terminalStatus = terminalKind === RESOURCE_EVENT_KIND.CONSUMED ? "consumed" : "released";
    const now = this.#now();
    const [row] = await this.#sql.jsonArrayStatement<ResourceTerminalTransactionRow>(`
      BEGIN;
      SELECT pg_advisory_xact_lock(hashtextextended(${sqlString(resourceLockKey(identityKey))}, 0));

      WITH
      ${resourceProjectionCtes(identityKey)},
      target_reservation AS (
        SELECT reservation_id, terminal_kind
        FROM resource_reservations
        WHERE reservation_id = ${sqlString(spec.reservationId)}
        ORDER BY id DESC
        LIMIT 1
      ),
      decision AS (
        SELECT
          CASE
            WHEN target_reservation.reservation_id IS NULL THEN 'missing'
            WHEN target_reservation.terminal_kind = ${sqlString(terminalKind)} THEN 'noop'
            WHEN target_reservation.terminal_kind IS NOT NULL THEN 'closed'
            ELSE 'written'
          END AS status,
          CASE target_reservation.terminal_kind
            WHEN ${sqlString(RESOURCE_EVENT_KIND.CONSUMED)} THEN 'consumed'
            WHEN ${sqlString(RESOURCE_EVENT_KIND.RELEASED)} THEN 'released'
            ELSE NULL
          END AS closed_status
        FROM resource_projection_validation
        LEFT JOIN target_reservation ON TRUE
      ),
      event_input AS (
        SELECT
          ${sqlString(terminalKind)} AS kind,
          jsonb_build_object(
            'reservationId', ${sqlString(spec.reservationId)},
            'ref', ${sqlString(spec.ref)}
          ) AS payload
        FROM decision
        WHERE decision.status = 'written'
      ),
      inserted AS (
        INSERT INTO agentos_events (
          ts,
          kind,
          truth_key,
          identity_key,
          scope_ref,
          fact_owner_ref,
          effect_authority_ref,
          payload
        )
        SELECT
          ${sqlNumber(now)},
          event_input.kind,
          ${sqlString(backendProtocolTruthIdentityKey(identity))},
          ${sqlString(identityKey)},
          ${sqlJson(identity.scopeRef)},
          ${sqlJson(identity.factOwnerRef)},
          ${sqlJson(identity.effectAuthorityRef)},
          event_input.payload
        FROM event_input
        RETURNING
          id::int AS "id",
          ts AS "ts",
          kind AS "kind",
          scope_ref AS "scopeRef",
          fact_owner_ref #>> '{}' AS "factOwnerRef",
          effect_authority_ref AS "effectAuthorityRef",
          payload AS "payload"
      ),
      result AS (
        SELECT
          decision.status AS "status",
          decision.closed_status AS "closedStatus",
          (SELECT row_to_json(inserted) FROM inserted LIMIT 1) AS "event"
        FROM decision
      ),
      agentos_json_rows AS (
        SELECT * FROM result
      )
      SELECT COALESCE(json_agg(row_to_json(agentos_json_rows)), '[]'::json)::text
      FROM agentos_json_rows;
      COMMIT
    `);
    if (row === undefined) throw new SqlError({ cause: "resource terminal returned no result" });
    if (row.event !== null) await this.#fireMany([row.event]);
    if (row.status === "missing") {
      throw new ResourceReservationNotFound({ reservationId: spec.reservationId });
    }
    if (row.status === "closed") {
      throw new ResourceReservationClosed({
        reservationId: spec.reservationId,
        status: row.closedStatus ?? terminalStatus,
      });
    }
  }

  async #loadResourceState(identity: LedgerTruthIdentity): Promise<ProjectedResourceState> {
    const events = await this.#events(runtimeIdentity(identity));
    try {
      return projectResourceEvents(events);
    } catch (cause) {
      throw new SqlError({ cause });
    }
  }

  async #appendEventAndDueWork(
    spec: {
      readonly ts: number;
      readonly kind: string;
      readonly identity: BackendProtocolEventIdentity;
      readonly payload: unknown;
    },
    dueKind: string,
    fireAt: number,
  ): Promise<LedgerEvent> {
    const identityKey = backendProtocolEventIdentityKey(spec.identity);
    const rows = await this.#sql.jsonArrayStatement<LedgerEvent>(`
      WITH inserted_event AS (
        INSERT INTO agentos_events (
          ts, kind, truth_key, identity_key, scope_ref, fact_owner_ref, effect_authority_ref, payload
        )
        VALUES (
          ${sqlNumber(spec.ts)},
          ${sqlString(spec.kind)},
          ${sqlString(backendProtocolTruthIdentityKey(spec.identity))},
          ${sqlString(identityKey)},
          ${sqlJson(spec.identity.scopeRef)},
          ${sqlJson(spec.identity.factOwnerRef)},
          ${sqlJson(spec.identity.effectAuthorityRef)},
          ${sqlPayload(spec.payload)}
        )
        RETURNING
          id::int AS "id",
          ts AS "ts",
          kind AS "kind",
          scope_ref AS "scopeRef",
          fact_owner_ref #>> '{}' AS "factOwnerRef",
          effect_authority_ref AS "effectAuthorityRef",
          payload AS "payload"
      ),
      inserted_due_work AS (
        INSERT INTO agentos_due_work (
          identity_key, identity, fire_at, kind, payload
        )
        SELECT
          ${sqlString(identityKey)},
          ${sqlJson(spec.identity)},
          ${sqlNumber(fireAt)},
          ${sqlString(dueKind)},
          jsonb_build_object('intentEventId', inserted_event.id)
        FROM inserted_event
        RETURNING id
      ),
      agentos_json_rows AS (
        SELECT inserted_event.*
        FROM inserted_event
        JOIN inserted_due_work ON true
      )
      SELECT COALESCE(json_agg(row_to_json(agentos_json_rows)), '[]'::json)::text
      FROM agentos_json_rows
    `);
    const event = rows[0];
    if (event === undefined)
      throw new SqlError({ cause: "atomic event+due commit returned no event" });
    await this.#fireMany([event]);
    return event;
  }

  async #appendEventsAndCompleteDue(
    specs: ReadonlyArray<{
      readonly ts: number;
      readonly kind: string;
      readonly identity: BackendProtocolEventIdentity;
      readonly payload: unknown;
    }>,
    row: DueWorkRow,
    now: number,
    nextDue?: {
      readonly kind: string;
      readonly intentEventId: number;
      readonly fireAt: number;
    },
  ): Promise<ReadonlyArray<LedgerEvent>> {
    const rows = await this.#sql.jsonArrayStatement<LedgerEvent>(`
      WITH completed_due AS (
        UPDATE agentos_due_work
        SET completed_at = ${sqlNumber(now)}
        WHERE id = ${sqlNumber(row.id)}
          AND completed_at IS NULL
          ${row.claimToken === null ? "" : `AND claim_token = ${sqlString(row.claimToken)}`}
        RETURNING identity_key, identity
      ),
      input AS (
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
      inserted_events AS (
        INSERT INTO agentos_events (
          ts, kind, truth_key, identity_key, scope_ref, fact_owner_ref, effect_authority_ref, payload
        )
        SELECT
          input."ts",
          input."kind",
          input."truthKey",
          input."identityKey",
          input."scopeRef",
          input."factOwnerRef",
          input."effectAuthorityRef",
          input."payload"
        FROM input
        JOIN completed_due ON true
        RETURNING
          id::int AS "id",
          ts AS "ts",
          kind AS "kind",
          scope_ref AS "scopeRef",
          fact_owner_ref #>> '{}' AS "factOwnerRef",
          effect_authority_ref AS "effectAuthorityRef",
          payload AS "payload"
      ),
      due_input AS (
        SELECT *
        FROM jsonb_to_recordset(${sqlPayload(nextDue === undefined ? [] : [nextDue])})
        AS x(
          "fireAt" double precision,
          "kind" text,
          "intentEventId" bigint
        )
      ),
      inserted_due_work AS (
        INSERT INTO agentos_due_work (
          identity_key, identity, fire_at, kind, payload
        )
        SELECT
          completed_due.identity_key,
          completed_due.identity,
          due_input."fireAt",
          due_input."kind",
          jsonb_build_object('intentEventId', due_input."intentEventId")
        FROM due_input
        JOIN completed_due ON true
        RETURNING id
      ),
      agentos_json_rows AS (
        SELECT * FROM inserted_events ORDER BY id ASC
      )
      SELECT COALESCE(json_agg(row_to_json(agentos_json_rows)), '[]'::json)::text
      FROM agentos_json_rows
    `);
    if (rows.length !== specs.length) {
      throw new SqlError({ cause: "atomic due outcome commit returned partial event set" });
    }
    await this.#fireMany(rows);
    return rows;
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
      , intent AS (
        ${eventRowSelect}
        WHERE id = (
          SELECT (claimed."payload" ->> 'intentEventId')::bigint
          FROM claimed
        )
        AND identity_key = ${sqlString(backendProtocolEventIdentityKey(identity))}
      )
      , related AS (
        SELECT kind
        FROM agentos_events
        WHERE identity_key = ${sqlString(backendProtocolEventIdentityKey(identity))}
          AND kind = ANY(ARRAY[
            ${sqlString(DISPATCH_EVENT_KINDS.OUTBOUND_ENQUEUED)},
            ${sqlString(DISPATCH_EVENT_KINDS.OUTBOUND_DELIVERED)},
            ${sqlString(DISPATCH_EVENT_KINDS.OUTBOUND_FAILED)}
          ]::text[])
          AND (payload ->> 'outboundEventId')::bigint = (
            SELECT (claimed."payload" ->> 'intentEventId')::bigint
            FROM claimed
          )
      )
      , agentos_json_rows AS (
        SELECT
          claimed.*,
          CASE
            WHEN claimed."kind" = ${sqlString(DELIVERY_RETRY_TRIGGER_KIND)}
            THEN (SELECT row_to_json(intent) FROM intent)
            ELSE NULL
          END AS "dispatchIntent",
          (SELECT COUNT(*)::int FROM related WHERE kind = ANY(ARRAY[
            ${sqlString(DISPATCH_EVENT_KINDS.OUTBOUND_ENQUEUED)},
            ${sqlString(DISPATCH_EVENT_KINDS.OUTBOUND_DELIVERED)}
          ]::text[])) AS "dispatchSuccessCount",
          (SELECT COUNT(*)::int FROM related) AS "dispatchAttemptCount"
        FROM claimed
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
    const limit = Math.min(
      MAX_EVENT_LIMIT,
      Math.max(1, Math.floor(opts.limit ?? DEFAULT_EVENT_LIMIT)),
    );
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

  async #eventsForIdentityKey(identityKey: string): Promise<ReadonlyArray<LedgerEvent>> {
    return this.#sql.json<LedgerEvent>(`
      ${eventRowSelect}
      WHERE identity_key = ${sqlString(identityKey)}
      ORDER BY id ASC
    `);
  }

  async #maxEventId(): Promise<number> {
    const rows = await this.#sql.json<{ readonly id: number }>(`
      SELECT COALESCE(MAX(id), 0)::int AS "id"
      FROM agentos_events
    `);
    return rows[0]?.id ?? 0;
  }

  async #assertRuntimeAppendTransitions(
    specs: ReadonlyArray<{
      readonly ts: number;
      readonly kind: string;
      readonly identity: BackendProtocolEventIdentity;
      readonly payload: unknown;
    }>,
  ): Promise<void> {
    try {
      const maxEventId = await this.#maxEventId();
      const candidates = specs.map(
        (spec, index): LedgerEvent => ({
          id: maxEventId + index + 1,
          ts: spec.ts,
          kind: spec.kind,
          scopeRef: spec.identity.scopeRef,
          factOwnerRef: spec.identity.factOwnerRef,
          effectAuthorityRef: spec.identity.effectAuthorityRef,
          payload: spec.payload,
        }),
      );
      for (const [identityKey, events] of groupRuntimeEventsByIdentityKey(candidates)) {
        assertRuntimeLedgerTransitions({
          history: await this.#eventsForIdentityKey(identityKey),
          events,
        });
      }
    } catch (cause) {
      if (cause instanceof SqlError) throw cause;
      throw new SqlError({ cause });
    }
  }

  async #appendEvents(
    specs: ReadonlyArray<{
      readonly ts: number;
      readonly kind: string;
      readonly identity: BackendProtocolEventIdentity;
      readonly payload: unknown;
    }>,
  ): Promise<ReadonlyArray<LedgerEvent>> {
    await this.#assertRuntimeAppendTransitions(specs);
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
