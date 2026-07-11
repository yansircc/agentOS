import { randomUUID } from "node:crypto";
import { SqlError } from "@agent-os/core/errors";
import { type FactOwnerRef } from "@agent-os/core/effect-claim";
import { materialRefKey, type BindingMaterialRef } from "@agent-os/core/material-ref";
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
} from "@agent-os/core/types";
import {
  canonicalLedgerArchiveJson,
  createLedgerArchiveArtifact,
  createLedgerArchiveReceipt,
  decodeLedgerArchiveArtifact,
  DELIVERY_RETRY_TRIGGER_KIND,
  DISPATCH_EVENT_KINDS,
  DISPATCH_INBOUND_ACCEPTED,
  DURABLE_TRIGGER_SCHEDULED_REQUESTED,
  RESOURCE_EVENT_KIND,
  SCHEDULED_EVENT_TRIGGER_KIND,
  backendProtocolEventIdentityKey,
  backendProtocolProjectionKey,
  backendProtocolTruthIdentityKey,
  describeDispatchCause,
  dispatchBackoffMs,
  dispatchTargetDelivered,
  emptyResourceProjection,
  normalizeBackendPageLimit,
  parseDispatchLivedClaim,
  parseScheduledEventIntentPayload,
  parseRequestedPayloadValue,
  projectResourceEvents,
  scheduledEventIntentPayload,
  settleDispatchOutboundEnqueued,
  settleDispatchOutboundDelivered,
  settleDispatchOutboundRetryPending,
  type BackendProtocolEventIdentity,
  type BackendProtocolProjectionKey,
  type BackendProtocolTruthIdentity,
  type DispatchEnqueueAcknowledgement,
  type DispatchEnvelope,
  type DispatchReceiverResult,
  type DispatchTargetAdapter,
  type DispatchTargetResult,
  type GrantResult,
  type LedgerArchiveReceipt,
  type ProjectedResourceState,
  type ResourceProjection,
} from "@agent-os/core/backend-protocol";
import {
  assertRuntimeLedgerTransitions,
  type LedgerCommitEventSpec,
  type LedgerTruthIdentity,
} from "@agent-os/core/runtime-protocol";
import { type TelemetryFanoutDiagnostic } from "@agent-os/core/telemetry-protocol";
import {
  PsqlCli,
  quoteIdentifier,
  sqlJson,
  sqlNumber,
  sqlString,
  systemTimeNow,
  type NodePostgresNow,
} from "./host";
import {
  eventRowSelect,
  finiteNumberField,
  groupRuntimeEventsByIdentityKey,
  ledgerWriteLockKey,
  positiveAmount,
  recordOf,
  resourceLockKey,
  resourceProjectionCtes,
  runtimeIdentity,
  schemaName,
  sqlPayload,
} from "./backend-helpers";
import { type NodePostgresDueWorkRow, withNodePostgresDueDrainLock } from "./due-work";
import { fireNodePostgresEvents, type NodePostgresEventSink } from "./telemetry";
import {
  assertNodePostgresDispatchEnvelope,
  nodePostgresDispatchAcceptedPayload,
  nodePostgresDispatchReceipt,
  prepareNodePostgresDispatchRequest,
} from "./dispatch";
import { nodePostgresQuotaGrantDecision } from "./quota";
import {
  decodeLedgerArchiveSegments,
  ledgerArchiveReceiptForExactCut,
  mergeLedgerArchiveEvents,
  queryLedgerArchiveEvents,
  type StoredLedgerArchiveSegment,
} from "../ledger-archive";
import {
  assertNodePostgresResourceTerminalResult,
  nodePostgresResourceReserveResult,
  type ResourceReserveTransactionRow,
  type ResourceTerminalTransactionRow,
} from "./resource";

interface NodePostgresArchiveRow extends StoredLedgerArchiveSegment {
  readonly encodedBytes: string;
}

const archiveSnapshotSql = (
  truthKey: string,
  stored: ReadonlyArray<NodePostgresArchiveRow>,
): string => {
  const exactRows =
    stored.length === 0
      ? "FALSE"
      : stored
          .map(
            (entry) =>
              `(segment_sha256 = ${sqlString(entry.receipt.segmentSha256)} AND ` +
              `previous_segment_sha256 IS NOT DISTINCT FROM ${
                entry.receipt.previousSegmentSha256 === null
                  ? "NULL"
                  : sqlString(entry.receipt.previousSegmentSha256)
              } AND ` +
              `first_event_id = ${sqlNumber(entry.receipt.firstEventId)} AND ` +
              `last_event_id = ${sqlNumber(entry.receipt.lastEventId)} AND ` +
              `archive_ref = ${sqlString(entry.receipt.archiveRef)} AND ` +
              `bytes = ${sqlString(entry.encodedBytes)} AND receipt = ${sqlJson(entry.receipt)})`,
          )
          .join(" OR ");
  return `
    (SELECT COUNT(*) FROM agentos_event_archive_segments
      WHERE truth_key = ${sqlString(truthKey)}) = ${stored.length}
    AND NOT EXISTS (
      SELECT 1 FROM agentos_event_archive_segments
      WHERE truth_key = ${sqlString(truthKey)} AND NOT (${exactRows})
    )
  `;
};

export interface NodePostgresBackendOptions {
  readonly databaseUrl: string;
  readonly schema?: string;
  readonly psqlPath?: string;
  readonly bindingRef: BindingMaterialRef;
}

export interface NodePostgresEventSubscription {
  readonly unsubscribe: () => void;
}

export class NodePostgresBackend {
  readonly bindingRef: BindingMaterialRef;
  readonly #sql: PsqlCli;
  readonly #schema: string;
  readonly #handlers = new Map<string, Set<EventHandler>>();
  readonly #sinks = new Set<NodePostgresEventSink>();
  readonly #diagnostics: TelemetryFanoutDiagnostic[] = [];
  readonly #targets = new Map<string, DispatchTargetAdapter>();
  readonly #dueDrainLocks = new Map<string, Promise<void>>();
  readonly #archiveLocks = new Map<string, Promise<void>>();
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

      CREATE TABLE IF NOT EXISTS agentos_event_archive_segments (
        segment_sha256 TEXT PRIMARY KEY,
        truth_key TEXT NOT NULL,
        previous_segment_sha256 TEXT,
        first_event_id BIGINT NOT NULL,
        last_event_id BIGINT NOT NULL,
        archive_ref TEXT NOT NULL,
        bytes TEXT NOT NULL,
        receipt JSONB NOT NULL
      );
      CREATE INDEX IF NOT EXISTS agentos_archive_truth_first_idx
        ON agentos_event_archive_segments (truth_key, first_event_id);
      CREATE UNIQUE INDEX IF NOT EXISTS agentos_archive_truth_predecessor_idx
        ON agentos_event_archive_segments (truth_key, COALESCE(previous_segment_sha256, ''));

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

  async archiveLedger(spec: {
    readonly identity: BackendProtocolTruthIdentity;
    readonly throughEventId: number;
  }): Promise<LedgerArchiveReceipt> {
    const truthKey = backendProtocolTruthIdentityKey(spec.identity);
    return this.#withArchiveLock(truthKey, async () => {
      const stored = await this.#archiveSegments(spec.identity);
      const artifacts = await decodeLedgerArchiveSegments(spec.identity, stored);
      const retry = ledgerArchiveReceiptForExactCut(stored, spec.throughEventId);
      if (retry !== undefined) return retry;
      const previous = artifacts.at(-1);
      const previousLastId = previous?.segment.events.at(-1)?.id ?? 0;
      const hot = await this.#hotTruthEvents(spec.identity);
      const events = hot.filter(
        (event) => event.id > previousLastId && event.id <= spec.throughEventId,
      );
      if (events.length === 0) {
        throw new SqlError({ cause: "no hot events to archive" });
      }
      const artifact = await createLedgerArchiveArtifact({
        identity: spec.identity,
        previousSegmentSha256: previous?.sha256 ?? null,
        events,
      });
      const archiveRef = `postgres:${truthKey}:${artifact.sha256}`;
      const receipt = await createLedgerArchiveReceipt({
        artifact,
        archiveRef,
        readback: artifact.bytes,
      });
      await this.#sql.exec(`
        INSERT INTO agentos_event_archive_segments
          (segment_sha256, truth_key, previous_segment_sha256, first_event_id,
           last_event_id, archive_ref, bytes, receipt)
        SELECT
          ${sqlString(receipt.segmentSha256)}, ${sqlString(truthKey)},
          ${receipt.previousSegmentSha256 === null ? "NULL" : sqlString(receipt.previousSegmentSha256)},
          ${sqlNumber(receipt.firstEventId)}, ${sqlNumber(receipt.lastEventId)},
          ${sqlString(receipt.archiveRef)}, ${sqlString(Buffer.from(artifact.bytes).toString("base64"))},
          ${sqlJson(receipt)}
        WHERE ${archiveSnapshotSql(truthKey, stored)}
        ON CONFLICT DO NOTHING
      `);
      const readback = (await this.#archiveSegments(spec.identity)).find(
        (segment) => segment.receipt.previousSegmentSha256 === receipt.previousSegmentSha256,
      );
      if (readback === undefined) throw new SqlError({ cause: "archive readback missing" });
      if (readback.receipt.segmentSha256 !== receipt.segmentSha256) {
        throw new SqlError({
          cause: "archive chain predecessor already has a different successor",
        });
      }
      const readbackReceipt = await createLedgerArchiveReceipt({
        artifact,
        archiveRef,
        readback: readback.bytes,
      });
      if (
        canonicalLedgerArchiveJson(readback.receipt) !== canonicalLedgerArchiveJson(readbackReceipt)
      ) {
        throw new SqlError({ cause: "archive readback receipt mismatch" });
      }
      return readbackReceipt;
    });
  }

  async evictArchivedLedger(receipt: LedgerArchiveReceipt): Promise<{ readonly evicted: number }> {
    return this.#withArchiveLock(receipt.truthKey, async () => {
      const stored = await this.#archiveSegmentsForTruthKey(receipt.truthKey);
      const targetIndex = stored.findIndex(
        (entry) =>
          entry.receipt.segmentSha256 === receipt.segmentSha256 &&
          canonicalLedgerArchiveJson(entry.receipt) === canonicalLedgerArchiveJson(receipt),
      );
      if (targetIndex < 0) {
        throw new SqlError({ cause: "archive receipt is not authoritative" });
      }
      const target = stored[targetIndex]!;
      const decodedTarget = await decodeLedgerArchiveArtifact(
        target.bytes,
        target.receipt.segmentSha256,
      );
      const artifacts = await decodeLedgerArchiveSegments(decodedTarget.segment.identity, stored);
      const artifact = artifacts[targetIndex]!;
      const hot = await this.#hotTruthEvents(artifact.segment.identity);
      const ids = new Set(artifact.segment.events.map((event) => event.id));
      const candidates = hot.filter((event) => ids.has(event.id));
      if (candidates.length === 0) return { evicted: 0 };
      if (
        candidates.length !== ids.size ||
        candidates.some((event) => {
          const archived = artifact.segment.events.find((candidate) => candidate.id === event.id);
          return (
            archived === undefined ||
            canonicalLedgerArchiveJson(event) !== canonicalLedgerArchiveJson(archived)
          );
        })
      ) {
        throw new SqlError({ cause: "hot event set mismatch" });
      }
      const deleted = await this.#sql.jsonValue<{ readonly count: number }>(`
        WITH deleted AS (
          DELETE FROM agentos_events
          WHERE truth_key = ${sqlString(receipt.truthKey)}
            AND id IN (${Array.from(ids, sqlNumber).join(", ")})
            AND ${archiveSnapshotSql(receipt.truthKey, stored)}
          RETURNING id
        )
        SELECT json_build_object('count', COUNT(*)::int)::text FROM deleted
      `);
      if (deleted.count !== candidates.length) {
        throw new SqlError({ cause: "archive chain changed before eviction" });
      }
      return { evicted: deleted.count };
    });
  }

  async corruptArchiveForTest(receipt: LedgerArchiveReceipt): Promise<void> {
    await this.#sql.exec(`
      UPDATE agentos_event_archive_segments
      SET bytes = ${sqlString(Buffer.from("corrupt").toString("base64"))}
      WHERE segment_sha256 = ${sqlString(receipt.segmentSha256)}
    `);
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
    const result = await this.#drainDueLocked(identity, now);
    return { fired: result.drained };
  }

  async drainDispatchDue(
    identity: BackendProtocolEventIdentity,
    now: number,
  ): Promise<{ readonly delivered: number; readonly failed: number }> {
    const before = await this.#events(identity);
    const result = await this.#drainDueLocked(identity, now);
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
    const requested = prepareNodePostgresDispatchRequest(identity, spec, (bindingKey) =>
      this.#targets.has(bindingKey),
    );
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
    await this.#drainDueLocked(identity, now);
    return { outboundEventId: event.id };
  }

  async receive(
    identity: BackendProtocolEventIdentity,
    envelope: DispatchEnvelope,
  ): Promise<DispatchReceiverResult> {
    const scopeLabel = assertNodePostgresDispatchEnvelope(identity, envelope);
    const accepted = await this.#findAcceptedDeliveryId(identity, envelope);
    if (accepted !== null) {
      return nodePostgresDispatchReceipt(scopeLabel, accepted);
    }
    const deliveredEventId = await this.#nextEventId(1);
    const acceptedEventId = deliveredEventId - 1;
    const events = await this.#appendDispatchReceiveEvents({
      identity,
      acceptedEventId,
      deliveredEventId,
      acceptedPayload: nodePostgresDispatchAcceptedPayload(envelope, scopeLabel, deliveredEventId),
      deliveredKind: envelope.event,
      deliveredPayload: envelope.data,
    });
    if (events.length === 0) {
      const concurrentAccepted = await this.#findAcceptedDeliveryId(identity, envelope);
      if (concurrentAccepted === null) {
        throw new SqlError({ cause: "dispatch receive conflict returned no accepted event" });
      }
      return nodePostgresDispatchReceipt(scopeLabel, concurrentAccepted);
    }
    const delivered = events.find((event) => event.id === deliveredEventId);
    if (delivered === undefined)
      throw new SqlError({ cause: "dispatch receive returned no event" });
    return nodePostgresDispatchReceipt(scopeLabel, delivered.id);
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
    if (row.event !== null) await this.#fireMany([row.event]);
    return nodePostgresResourceReserveResult(row, spec);
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
    const events = await this.#events(identity);
    const decision = nodePostgresQuotaGrantDecision(events, {
      now,
      identity,
      key,
      amount,
      windowMs,
      limit,
      toolName,
      operationRef,
    });
    if (decision.event !== undefined) {
      await this.#appendEvents([decision.event]);
    }
    return decision.result;
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
      await this.#completeDue(row, now);
      drained += 1;
    }
  }

  async #commitScheduled(row: NodePostgresDueWorkRow, now: number): Promise<void> {
    const [intent] = await this.#eventById(row.identity, row.payload.intentEventId);
    if (intent === undefined) {
      await this.#completeDue(row, now);
      return;
    }
    const parsed = parseScheduledEventIntentPayload(intent.payload);
    if (!parsed.ok) {
      await this.#completeDue(row, now);
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

  async #commitDispatchRetry(row: NodePostgresDueWorkRow, now: number): Promise<void> {
    const intent = row.dispatchIntent;
    if (intent === null) {
      await this.#completeDue(row, now);
      return;
    }
    const parsed = parseRequestedPayloadValue(intent.payload);
    if (!parsed.ok) {
      await this.#completeDue(row, now);
      return;
    }
    const requested = parsed.value;
    if (row.dispatchSuccessCount > 0) {
      await this.#completeDue(row, now);
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
              claim: settleDispatchOutboundEnqueued(requested.claim, {
                bindingKey,
                acknowledgement,
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
            ...(terminal
              ? {}
              : {
                  claim: settleDispatchOutboundRetryPending(requested.claim, {
                    bindingKey,
                    outboundEventId: intent.id,
                    attempt: attempts,
                  }),
                }),
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
    if (row.event !== null) await this.#fireMany([row.event]);
    assertNodePostgresResourceTerminalResult(row, spec, terminalKind);
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
      BEGIN;
      SELECT pg_advisory_xact_lock(hashtextextended(${sqlString(ledgerWriteLockKey(identityKey))}, 0));

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
      FROM agentos_json_rows;
      COMMIT
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
    row: NodePostgresDueWorkRow,
    now: number,
    nextDue?: {
      readonly kind: string;
      readonly intentEventId: number;
      readonly fireAt: number;
    },
  ): Promise<ReadonlyArray<LedgerEvent>> {
    const rows = await this.#sql.jsonArrayStatement<LedgerEvent>(`
      BEGIN;
      SELECT pg_advisory_xact_lock(hashtextextended(${sqlString(ledgerWriteLockKey(row.identityKey))}, 0));

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
      FROM agentos_json_rows;
      COMMIT
    `);
    if (rows.length !== specs.length) {
      throw new SqlError({ cause: "atomic due outcome commit returned partial event set" });
    }
    await this.#fireMany(rows);
    return rows;
  }

  async #claimDue(
    identity: BackendProtocolEventIdentity,
    now: number,
  ): Promise<NodePostgresDueWorkRow | null> {
    const identityKey = backendProtocolEventIdentityKey(identity);
    const token = randomUUID();
    const deadlineAt = now + 60_000;
    const rows = await this.#sql.jsonArrayStatement<NodePostgresDueWorkRow>(`
      WITH lock AS (
        SELECT pg_try_advisory_xact_lock(hashtextextended(${sqlString(ledgerWriteLockKey(identityKey))}, 0)) AS acquired
      ),
      candidate AS (
        SELECT id, claim_token
        FROM agentos_due_work
        JOIN lock ON lock.acquired
        WHERE identity_key = ${sqlString(identityKey)}
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
        AND identity_key = ${sqlString(identityKey)}
      )
      , related AS (
        SELECT kind
        FROM agentos_events
        WHERE identity_key = ${sqlString(identityKey)}
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

  async #drainDueLocked(
    identity: BackendProtocolEventIdentity,
    now: number,
  ): Promise<{ readonly drained: number }> {
    return withNodePostgresDueDrainLock(this.#dueDrainLocks, identity, () =>
      this.#drainDue(identity, now),
    );
  }

  async #completeDue(row: NodePostgresDueWorkRow, now: number): Promise<void> {
    await this.#sql.exec(`
      BEGIN;
      SELECT pg_advisory_xact_lock(hashtextextended(${sqlString(ledgerWriteLockKey(row.identityKey))}, 0));

      UPDATE agentos_due_work
      SET completed_at = ${sqlNumber(now)}
      WHERE id = ${sqlNumber(row.id)}
        AND completed_at IS NULL
        ${row.claimToken === null ? "" : `AND claim_token = ${sqlString(row.claimToken)}`};
      COMMIT
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
    if (
      opts.factOwnerRefs !== undefined &&
      opts.factOwnerRefs.length > 0 &&
      !opts.factOwnerRefs.includes(identity.factOwnerRef)
    ) {
      return [];
    }
    const hot = await this.#hotEvents(identity);
    const stored = await this.#archiveSegments(identity);
    if (stored.length === 0) {
      return queryLedgerArchiveEvents(hot as never, opts);
    }
    const artifacts = await decodeLedgerArchiveSegments(identity, stored);
    return queryLedgerArchiveEvents(mergeLedgerArchiveEvents(identity, artifacts, hot), {
      ...opts,
      factOwnerRefs: [identity.factOwnerRef],
    });
  }

  async #hotEvents(identity: BackendProtocolEventIdentity): Promise<ReadonlyArray<LedgerEvent>> {
    return this.#sql.json<LedgerEvent>(`
      ${eventRowSelect}
      WHERE identity_key = ${sqlString(backendProtocolEventIdentityKey(identity))}
      ORDER BY id ASC
    `);
  }

  async #hotTruthEvents(
    identity: BackendProtocolTruthIdentity,
  ): Promise<ReadonlyArray<LedgerEvent>> {
    return this.#sql.json<LedgerEvent>(`
      ${eventRowSelect}
      WHERE truth_key = ${sqlString(backendProtocolTruthIdentityKey(identity))}
      ORDER BY id ASC
    `);
  }

  async #archiveSegments(
    identity: BackendProtocolTruthIdentity,
  ): Promise<ReadonlyArray<NodePostgresArchiveRow>> {
    return this.#archiveSegmentsForTruthKey(backendProtocolTruthIdentityKey(identity));
  }

  async #archiveSegmentsForTruthKey(
    truthKey: string,
  ): Promise<ReadonlyArray<NodePostgresArchiveRow>> {
    const rows = await this.#sql.json<{
      readonly receipt: LedgerArchiveReceipt;
      readonly bytes: string;
      readonly segmentSha256: string;
      readonly truthKey: string;
      readonly previousSegmentSha256: string | null;
      readonly firstEventId: number;
      readonly lastEventId: number;
      readonly archiveRef: string;
    }>(`
      SELECT receipt AS "receipt", bytes AS "bytes",
             segment_sha256 AS "segmentSha256", truth_key AS "truthKey",
             previous_segment_sha256 AS "previousSegmentSha256",
             first_event_id::int AS "firstEventId", last_event_id::int AS "lastEventId",
             archive_ref AS "archiveRef"
      FROM agentos_event_archive_segments
      WHERE truth_key = ${sqlString(truthKey)}
      ORDER BY first_event_id ASC
    `);
    return rows.map((row) => {
      if (
        row.segmentSha256 !== row.receipt.segmentSha256 ||
        row.truthKey !== row.receipt.truthKey ||
        row.previousSegmentSha256 !== row.receipt.previousSegmentSha256 ||
        row.firstEventId !== row.receipt.firstEventId ||
        row.lastEventId !== row.receipt.lastEventId ||
        row.archiveRef !== row.receipt.archiveRef
      ) {
        throw new SqlError({ cause: "archive row mismatch" });
      }
      return {
        receipt: row.receipt,
        bytes: Uint8Array.from(Buffer.from(row.bytes, "base64")),
        encodedBytes: row.bytes,
      };
    });
  }

  async #withArchiveLock<A>(key: string, run: () => Promise<A>): Promise<A> {
    const prior = this.#archiveLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = prior.then(() => current);
    this.#archiveLocks.set(key, tail);
    await prior;
    try {
      return await run();
    } finally {
      release();
      if (this.#archiveLocks.get(key) === tail) this.#archiveLocks.delete(key);
    }
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
    await fireNodePostgresEvents(events, {
      sinks: this.#sinks,
      handlers: this.#handlers,
      diagnostics: this.#diagnostics,
    });
  }
}

export const nodePostgresRuntimeIdentity = runtimeIdentity;
export const nodePostgresProjectionKey = backendProtocolProjectionKey;
export type { FactOwnerRef };
