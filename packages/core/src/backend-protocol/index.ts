import { Option, Result, Predicate, Schema, pipe } from "effect";
import {
  authorityRefKey,
  factOwnerKey,
  isAuthorityRef,
  isFactOwnerRef,
  isScopeRef,
  ledgerTruthKey,
  scopeRefKey,
  validateEffectClaim,
  type AuthorityRef,
  type FactOwnerRef,
  type IndeterminateClaim,
  type LivedClaim,
  type PreClaim,
  type ScopeRef,
} from "@agent-os/core/effect-claim";
import { coreClaimedEventNamespacePrefixes } from "@agent-os/core/errors";
import { isMaterialRef, type BindingMaterialRef } from "@agent-os/core/material-ref";
import {
  defineSettlementContract,
  settleIndeterminate,
  settleLived,
  symbolicSettlementRef,
  validateIndeterminateClaim,
  validateTerminalClaim,
} from "@agent-os/core/settlement-contract";
import type {
  DeliveryReceipt,
  LedgerEvent,
  QuotaState,
  QuotaStateSpec,
  ResourceState,
} from "@agent-os/core/types";
import { validateOptionalTraceContext, type TraceContext } from "@agent-os/core/telemetry-protocol";

export { copyTraceContext } from "@agent-os/core/telemetry-protocol";
export {
  BACKEND_PAGE_POLICY,
  normalizeBackendPageLimit,
  type BackendPagePolicy,
} from "./page-policy";

export const DISPATCH_OUTBOUND_REQUESTED = "dispatch.outbound.requested";
export const DISPATCH_OUTBOUND_ENQUEUED = "dispatch.outbound.enqueued";
export const DISPATCH_OUTBOUND_DELIVERED = "dispatch.outbound.delivered";
export const DISPATCH_OUTBOUND_FAILED = "dispatch.outbound.failed";
export const DISPATCH_INBOUND_ACCEPTED = "dispatch.inbound.accepted";
export const SCHEDULED_EVENT_TRIGGER_KIND = "scheduled_event";
export const DURABLE_TRIGGER_SCHEDULED_REQUESTED = "durable_trigger.scheduled.requested";
export const DURABLE_TRIGGER_SCHEDULED_CANCELLED = "durable_trigger.scheduled.cancelled";
export const DELIVERY_RETRY_TRIGGER_KIND = "delivery_retry";

export const BACKEND_PROTOCOL_EVENT_PREFIXES = coreClaimedEventNamespacePrefixes(
  "@agent-os/backend-protocol",
);

export interface BackendProtocolTruthIdentity {
  readonly scopeRef: ScopeRef;
  readonly effectAuthorityRef: AuthorityRef;
  readonly scope?: never;
}

export interface BackendProtocolEventIdentity extends BackendProtocolTruthIdentity {
  readonly factOwnerRef: FactOwnerRef;
}

export interface BackendProtocolProjectionKey extends BackendProtocolEventIdentity {
  readonly projectionKind: string;
  readonly projectionId: string;
}

export interface BackendProtocolDispatchTarget extends BackendProtocolTruthIdentity {
  readonly bindingRef: BindingMaterialRef;
}

export interface BackendProtocolParseFailure {
  readonly _tag: "agent_os.backend_protocol_parse_failure";
  readonly reason: string;
}

export type BackendProtocolParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: BackendProtocolParseFailure };

const backendProtocolParseOk = <T>(value: T): BackendProtocolParseResult<T> => ({
  ok: true,
  value,
});

const backendProtocolParseFail = <T = never>(reason: string): BackendProtocolParseResult<T> => ({
  ok: false,
  failure: {
    _tag: "agent_os.backend_protocol_parse_failure",
    reason,
  },
});

const truthIdentityKeys = new Set(["scopeRef", "effectAuthorityRef"]);
const eventIdentityKeys = new Set(["scopeRef", "effectAuthorityRef", "factOwnerRef"]);
const projectionKeyKeys = new Set([
  "scopeRef",
  "effectAuthorityRef",
  "factOwnerRef",
  "projectionKind",
  "projectionId",
]);
const ledgerEventRpcKeys = new Set([
  "id",
  "ts",
  "kind",
  "scopeRef",
  "factOwnerRef",
  "effectAuthorityRef",
  "payload",
]);
const dispatchTargetKeys = new Set(["bindingRef", "scopeRef", "effectAuthorityRef"]);

const hasOnlyProtocolKeys = (value: Record<string, unknown>, keys: ReadonlySet<string>): boolean =>
  Object.keys(value).every((key) => keys.has(key));

const isNonEmptyProtocolString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

const protocolKeyPart = (part: string): string => encodeURIComponent(part).replace(/\./g, "%2E");

export const isBackendProtocolTruthIdentity = (
  value: unknown,
): value is BackendProtocolTruthIdentity =>
  Predicate.isObject(value) &&
  hasOnlyProtocolKeys(value, truthIdentityKeys) &&
  isScopeRef(value.scopeRef) &&
  isAuthorityRef(value.effectAuthorityRef);

export const isBackendProtocolEventIdentity = (
  value: unknown,
): value is BackendProtocolEventIdentity =>
  Predicate.isObject(value) &&
  hasOnlyProtocolKeys(value, eventIdentityKeys) &&
  isScopeRef(value.scopeRef) &&
  isAuthorityRef(value.effectAuthorityRef) &&
  isFactOwnerRef(value.factOwnerRef);

export const isBackendProtocolProjectionKey = (
  value: unknown,
): value is BackendProtocolProjectionKey =>
  Predicate.isObject(value) &&
  hasOnlyProtocolKeys(value, projectionKeyKeys) &&
  isScopeRef(value.scopeRef) &&
  isAuthorityRef(value.effectAuthorityRef) &&
  isFactOwnerRef(value.factOwnerRef) &&
  isNonEmptyProtocolString(value.projectionKind) &&
  isNonEmptyProtocolString(value.projectionId);

export const backendProtocolTruthIdentityKey = (identity: BackendProtocolTruthIdentity): string =>
  ledgerTruthKey(identity);

export const backendProtocolEventIdentityKey = (identity: BackendProtocolEventIdentity): string =>
  [backendProtocolTruthIdentityKey(identity), factOwnerKey(identity.factOwnerRef)].join("|");

export const backendProtocolProjectionKey = (key: BackendProtocolProjectionKey): string =>
  [
    "projection",
    protocolKeyPart(key.projectionKind),
    protocolKeyPart(key.projectionId),
    scopeRefKey(key.scopeRef),
    authorityRefKey(key.effectAuthorityRef),
    factOwnerKey(key.factOwnerRef),
  ].join("|");

export const DISPATCH_EVENT_KINDS = {
  OUTBOUND_REQUESTED: DISPATCH_OUTBOUND_REQUESTED,
  OUTBOUND_ENQUEUED: DISPATCH_OUTBOUND_ENQUEUED,
  OUTBOUND_DELIVERED: DISPATCH_OUTBOUND_DELIVERED,
  OUTBOUND_FAILED: DISPATCH_OUTBOUND_FAILED,
  INBOUND_ACCEPTED: DISPATCH_INBOUND_ACCEPTED,
} as const;

export interface DispatchDeliveryHistoryState {
  readonly successCount: number;
  readonly attemptCount: number;
}

const dispatchDeliveryHistoryKinds = new Set<string>([
  DISPATCH_EVENT_KINDS.OUTBOUND_ENQUEUED,
  DISPATCH_EVENT_KINDS.OUTBOUND_DELIVERED,
  DISPATCH_EVENT_KINDS.OUTBOUND_FAILED,
]);

export const dispatchDeliveryHistoryState = (
  events: Iterable<Pick<LedgerEvent, "kind" | "payload">>,
  outboundEventId: number,
): DispatchDeliveryHistoryState => {
  let successCount = 0;
  let attemptCount = 0;
  for (const event of events) {
    if (!dispatchDeliveryHistoryKinds.has(event.kind)) continue;
    const payload = event.payload;
    if (
      !Predicate.isObject(payload) ||
      typeof payload.outboundEventId !== "number" ||
      payload.outboundEventId !== outboundEventId
    ) {
      continue;
    }
    attemptCount += 1;
    if (
      event.kind === DISPATCH_EVENT_KINDS.OUTBOUND_DELIVERED ||
      event.kind === DISPATCH_EVENT_KINDS.OUTBOUND_ENQUEUED
    ) {
      successCount += 1;
    }
  }
  return { successCount, attemptCount };
};

export const dispatchSettlementContract = defineSettlementContract({
  settlementId: "@agent-os/dispatch",
  anchorKinds: ["ledger_event", "external_receipt"],
  rejectionKinds: [],
  indeterminateKinds: ["provider_pending", "retry_pending"],
});

export const dispatchCarrierRef = (key: string): string => symbolicSettlementRef("dispatch", [key]);

export type DispatchDeliveryReceipt = DeliveryReceipt;

export interface DispatchEnvelope {
  readonly sourceScope: string;
  readonly outboundEventId: number;
  readonly targetScope: string;
  readonly event: string;
  readonly data: unknown;
  readonly idempotencyKey: string;
  readonly claim: PreClaim;
  readonly traceContext?: TraceContext;
}

export interface DispatchDeliveryResult {
  readonly receipt: DispatchDeliveryReceipt;
}

export interface DispatchReceiverResult extends DispatchDeliveryResult {
  readonly deliveredEventId: number;
}

export interface DispatchEnqueueAcknowledgement {
  readonly acknowledgementId: string;
  readonly acknowledgementKind: "external_enqueue";
}

export interface DispatchTargetDeliveredResult extends DispatchDeliveryResult {
  readonly _tag: "delivered";
}

export interface DispatchTargetEnqueuedResult {
  readonly _tag: "enqueued";
  readonly acknowledgement: DispatchEnqueueAcknowledgement;
}

export type DispatchTargetResult = DispatchTargetDeliveredResult | DispatchTargetEnqueuedResult;

export const dispatchTargetDelivered = (
  result: DispatchDeliveryResult,
): DispatchTargetDeliveredResult => ({
  _tag: "delivered",
  receipt: result.receipt,
});

export const dispatchTargetEnqueued = (
  acknowledgement: DispatchEnqueueAcknowledgement,
): DispatchTargetEnqueuedResult => ({
  _tag: "enqueued",
  acknowledgement,
});

export interface DispatchReceiver {
  readonly __agentosReceiveDispatch: (
    envelope: DispatchEnvelope,
  ) => Promise<DispatchReceiverResult>;
}

export interface DispatchTargetAdapter {
  // The substrate may invoke deliver more than once for the same envelope
  // across drain races, redrive, and adapter retries. Implementations must be
  // idempotent by (targetScope, idempotencyKey) or a target-owned receipt key.
  readonly deliver: (envelope: DispatchEnvelope) => Promise<DispatchTargetResult>;
}

export interface ResourceProjection {
  readonly available: number;
  readonly reserved: number;
  readonly consumed: number;
}

export interface GrantResult {
  readonly granted: boolean;
  readonly consumed: number;
  readonly limit: number;
}

export const RESOURCE_EVENT_KIND = {
  GRANTED: "resource_pool.granted",
  RESERVED: "resource_pool.reserved",
  RESERVE_REJECTED: "resource_pool.reserve_rejected",
  CONSUMED: "resource_pool.consumed",
  RELEASED: "resource_pool.released",
} as const;

export const QUOTA_EVENT_KIND = {
  CONSUMED: "quota.consumed",
  RATE_LIMITED: "quota.rate_limited",
} as const;

export const ResourceGrantPayloadSchema = Schema.Struct({
  key: Schema.String,
  amount: Schema.Finite,
  ref: Schema.String,
});

export const ResourceReservePayloadSchema = Schema.Struct({
  key: Schema.String,
  amount: Schema.Finite,
  ref: Schema.String,
  idempotencyKey: Schema.String,
  reservationId: Schema.String,
});

export const ResourceReserveRejectedPayloadSchema = Schema.Struct({
  key: Schema.String,
  amount: Schema.Finite,
  ref: Schema.String,
  idempotencyKey: Schema.String,
  available: Schema.Finite,
});

export const ResourceTerminalPayloadSchema = Schema.Struct({
  reservationId: Schema.String,
  ref: Schema.String,
});

export const QuotaConsumedPayloadSchema = Schema.Struct({
  key: Schema.String,
  amount: Schema.Finite,
  toolName: Schema.String,
  operationRef: Schema.String,
});

export const decodeResourceGrantPayloadSync = Schema.decodeUnknownSync(ResourceGrantPayloadSchema);
export const decodeResourceReservePayloadSync = Schema.decodeUnknownSync(
  ResourceReservePayloadSchema,
);
export const decodeResourceReserveRejectedPayloadSync = Schema.decodeUnknownSync(
  ResourceReserveRejectedPayloadSchema,
);
export const decodeResourceTerminalPayloadSync = Schema.decodeUnknownSync(
  ResourceTerminalPayloadSchema,
);
export const decodeQuotaConsumedPayloadSync = Schema.decodeUnknownSync(QuotaConsumedPayloadSchema);
const decodeResourceEventKindSync = Schema.decodeUnknownSync(Schema.String);

export type ResourceReservationStatus = "active" | "consumed" | "released";

export interface ResourceReservationProjection {
  readonly reservationId: string;
  readonly key: string;
  readonly amount: number;
  readonly ref: string;
  readonly idempotencyKey: string;
  readonly status: ResourceReservationStatus;
}

export interface ProjectedResourceState {
  readonly byId: Map<string, ResourceReservationProjection>;
  readonly byIdempotencyKey: Map<string, ResourceReservationProjection>;
  readonly byKey: Map<string, ResourceProjection>;
}

export interface ResourceProtocolEventRow {
  readonly kind: unknown;
  readonly payload: unknown;
}

export const emptyResourceProjection = (): ResourceProjection => ({
  available: 0,
  reserved: 0,
  consumed: 0,
});

const resourceKind = (value: unknown): string => decodeResourceEventKindSync(value);

const resourcePayload = (value: unknown): unknown =>
  typeof value === "string" ? (JSON.parse(value) as unknown) : value;

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

export const projectResourceRows = (
  rows: ReadonlyArray<ResourceProtocolEventRow>,
): ProjectedResourceState => {
  const grants: Array<{ readonly key: string; readonly amount: number }> = [];
  const reservations = new Map<string, ResourceReservationProjection>();
  const byIdempotencyKey = new Map<string, ResourceReservationProjection>();

  for (const row of rows) {
    const kind = resourceKind(row.kind);
    if (!kind.startsWith("resource_pool.")) continue;
    const payload = resourcePayload(row.payload);
    switch (kind) {
      case RESOURCE_EVENT_KIND.GRANTED: {
        const decoded = decodeResourceGrantPayloadSync(payload);
        grants.push({ key: decoded.key, amount: decoded.amount });
        break;
      }
      case RESOURCE_EVENT_KIND.RESERVED: {
        const decoded = decodeResourceReservePayloadSync(payload);
        const reservation: ResourceReservationProjection = {
          reservationId: decoded.reservationId,
          key: decoded.key,
          amount: decoded.amount,
          ref: decoded.ref,
          idempotencyKey: decoded.idempotencyKey,
          status: "active",
        };
        reservations.set(reservation.reservationId, reservation);
        byIdempotencyKey.set(reservation.idempotencyKey, reservation);
        break;
      }
      case RESOURCE_EVENT_KIND.RESERVE_REJECTED:
        decodeResourceReserveRejectedPayloadSync(payload);
        break;
      case RESOURCE_EVENT_KIND.CONSUMED:
      case RESOURCE_EVENT_KIND.RELEASED: {
        const decoded = decodeResourceTerminalPayloadSync(payload);
        const existing = reservations.get(decoded.reservationId);
        if (existing !== undefined) {
          const next = {
            ...existing,
            status: kind === RESOURCE_EVENT_KIND.CONSUMED ? "consumed" : "released",
          } satisfies ResourceReservationProjection;
          reservations.set(decoded.reservationId, next);
          byIdempotencyKey.set(next.idempotencyKey, next);
        }
        break;
      }
      default:
        break;
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

  return { byId: reservations, byIdempotencyKey, byKey };
};

export const projectResourceEvents = (events: ReadonlyArray<LedgerEvent>): ProjectedResourceState =>
  projectResourceRows(events.map((event) => ({ kind: event.kind, payload: event.payload })));

export const projectResourceState = (
  events: ReadonlyArray<LedgerEvent>,
  key: string,
): ResourceState => {
  const state = projectResourceEvents(events);
  const projection = state.byKey.get(key) ?? emptyResourceProjection();
  const reservations = Array.from(state.byId.values())
    .filter((reservation) => reservation.key === key && reservation.status === "active")
    .map((reservation) => ({
      id: reservation.reservationId,
      amount: reservation.amount,
    }));
  return {
    granted: projection.available + projection.reserved + projection.consumed,
    reserved: projection.reserved,
    consumed: projection.consumed,
    available: projection.available,
    reservations,
  };
};

export const projectQuotaState = (
  events: ReadonlyArray<LedgerEvent>,
  spec: QuotaStateSpec,
  now: number,
): QuotaState => {
  const windowStart = spec.windowMs === Number.POSITIVE_INFINITY ? 0 : now - spec.windowMs;
  let consumed = 0;
  for (const event of events) {
    if (event.kind !== QUOTA_EVENT_KIND.CONSUMED || event.ts < windowStart) continue;
    const payload = decodeQuotaConsumedPayloadSync(event.payload);
    if (payload.key === spec.key) consumed += payload.amount;
  }
  return {
    consumed,
    limit: spec.limit,
    remaining: Math.max(0, spec.limit - consumed),
    refundable: 0,
    ...(spec.windowMs === Number.POSITIVE_INFINITY ? {} : { windowStart }),
  };
};

export const projectQuotaGrantUsage = (
  events: ReadonlyArray<LedgerEvent>,
  spec: {
    readonly key: string;
    readonly windowStart: number;
    readonly operationRef: string;
  },
): { readonly consumed: number; readonly alreadyGranted: boolean } => {
  let consumed = 0;
  for (const event of events) {
    if (event.kind !== QUOTA_EVENT_KIND.CONSUMED || event.ts < spec.windowStart) continue;
    const payload = decodeQuotaConsumedPayloadSync(event.payload);
    if (payload.operationRef === spec.operationRef) {
      return { consumed, alreadyGranted: true };
    }
    if (payload.key === spec.key) consumed += payload.amount;
  }
  return { consumed, alreadyGranted: false };
};

export const dispatchLedgerDeliveryReceipt = (spec: {
  readonly targetScope: string;
  readonly deliveredEventId: number;
}): DispatchDeliveryReceipt => ({
  anchorId: symbolicSettlementRef("dispatch.outbound", [spec.targetScope, spec.deliveredEventId]),
  anchorKind: "ledger_event",
});

export const dispatchExternalEnqueueAcknowledgement = (spec: {
  readonly targetKind: string;
  readonly targetScope: string;
  readonly idempotencyKey: string;
}): DispatchEnqueueAcknowledgement => ({
  acknowledgementId: symbolicSettlementRef(`dispatch.${spec.targetKind}.enqueued`, [
    spec.targetScope,
    spec.idempotencyKey,
  ]),
  acknowledgementKind: "external_enqueue",
});

export const settleDispatchOutboundDelivered = (
  claim: PreClaim,
  spec: {
    readonly bindingKey: string;
    readonly deliveryReceipt: DispatchDeliveryReceipt;
  },
): LivedClaim =>
  settleLived(dispatchSettlementContract, claim, {
    anchorId: spec.deliveryReceipt.anchorId,
    anchorKind: spec.deliveryReceipt.anchorKind,
    carrierRef: dispatchCarrierRef(spec.bindingKey),
  });

export const settleDispatchOutboundEnqueued = (
  claim: PreClaim,
  spec: {
    readonly bindingKey: string;
    readonly acknowledgement: DispatchEnqueueAcknowledgement;
  },
): IndeterminateClaim =>
  settleIndeterminate(dispatchSettlementContract, claim, {
    indeterminateId: spec.acknowledgement.acknowledgementId,
    indeterminateKind: "provider_pending",
    reason: "provider_pending",
    carrierRef: dispatchCarrierRef(spec.bindingKey),
  });

export const settleDispatchOutboundRetryPending = (
  claim: PreClaim,
  spec: {
    readonly bindingKey: string;
    readonly outboundEventId: number;
    readonly attempt: number;
  },
): IndeterminateClaim =>
  settleIndeterminate(dispatchSettlementContract, claim, {
    indeterminateId: symbolicSettlementRef("dispatch.retry", [spec.outboundEventId, spec.attempt]),
    indeterminateKind: "retry_pending",
    reason: "retry_pending",
    carrierRef: dispatchCarrierRef(spec.bindingKey),
  });

export const settleDispatchInboundAccepted = (
  claim: PreClaim,
  spec: {
    readonly sourceScope: string;
    readonly targetScope: string;
    readonly deliveredEventId: number;
  },
): LivedClaim =>
  settleLived(dispatchSettlementContract, claim, {
    anchorId: symbolicSettlementRef("dispatch.inbound", [spec.targetScope, spec.deliveredEventId]),
    anchorKind: "ledger_event",
    carrierRef: dispatchCarrierRef(spec.sourceScope),
  });

export const parseDispatchLivedClaim = (
  value: unknown,
  label: string,
): DispatchPayloadParseResult<LivedClaim> => {
  const validation = validateTerminalClaim(dispatchSettlementContract, value);
  if (!validation.ok || validation.claim.phase !== "lived") {
    return parseFail(`${label} claim must be a dispatch LivedClaim`);
  }
  return parseOk(validation.claim);
};

export const parseDispatchIndeterminateClaim = (
  value: unknown,
  label: string,
): DispatchPayloadParseResult<IndeterminateClaim> => {
  const validation = validateIndeterminateClaim(dispatchSettlementContract, value);
  if (!validation.ok || validation.claim.phase !== "indeterminate") {
    return parseFail(`${label} claim must be a dispatch IndeterminateClaim`);
  }
  return parseOk(validation.claim);
};

export interface DurableTriggerRetryPolicy {
  readonly maxAttempts: number;
  readonly initialDelayMs: number;
  readonly maxDelayMs: number;
  readonly multiplier: number;
}

export const DISPATCH_RETRY_POLICY = {
  maxAttempts: 8,
  initialDelayMs: 1_000,
  maxDelayMs: 60_000,
  multiplier: 2,
} as const satisfies DurableTriggerRetryPolicy;

export const DISPATCH_MAX_ATTEMPTS = DISPATCH_RETRY_POLICY.maxAttempts;

export interface IntentPointerDuePayload {
  readonly intentEventId: number;
}

export interface ScheduledEventIntentPayload {
  readonly eventKind: string;
  readonly data: unknown;
}

export interface DurableProcessLifecycleSnapshot {
  readonly id: number;
  readonly fireAt: number;
  readonly kind: string;
  readonly intentEventId: number;
  readonly completedAt: number | null;
  readonly claimedAt: number | null;
  readonly claimToken: string | null;
  readonly claimDeadlineAt: number | null;
  readonly redriveCount: number;
  readonly cancelRequestedAt: number | null;
  readonly cancelReason: string | null;
  readonly cancelledAt: number | null;
}

export interface DurableProcessClaimState {
  readonly token: string;
  readonly claimedAt: number;
  readonly deadlineAt: number;
}

export interface DurableProcessCancellationState {
  readonly requestedAt: number;
  readonly reason: string | null;
}

interface DurableProcessLifecycleBase {
  readonly id: number;
  readonly fireAt: number;
  readonly kind: string;
  readonly intentEventId: number;
  readonly redriveCount: number;
}

export type DurableProcessLifecycleState =
  | (DurableProcessLifecycleBase & {
      readonly phase: "scheduled";
    })
  | (DurableProcessLifecycleBase & {
      readonly phase: "claimed";
      readonly claim: DurableProcessClaimState;
    })
  | (DurableProcessLifecycleBase & {
      readonly phase: "redriven";
      readonly claim: DurableProcessClaimState;
    })
  | (DurableProcessLifecycleBase & {
      readonly phase: "cancel_requested";
      readonly cancellation: DurableProcessCancellationState;
      readonly claim?: DurableProcessClaimState;
    })
  | (DurableProcessLifecycleBase & {
      readonly phase: "completed";
      readonly completedAt: number;
      readonly claim?: DurableProcessClaimState;
    })
  | (DurableProcessLifecycleBase & {
      readonly phase: "completed_after_cancel_requested";
      readonly completedAt: number;
      readonly cancellation: DurableProcessCancellationState;
      readonly claim?: DurableProcessClaimState;
    })
  | (DurableProcessLifecycleBase & {
      readonly phase: "cancelled";
      readonly completedAt: number;
      readonly cancellation: DurableProcessCancellationState & {
        readonly cancelledAt: number;
      };
      readonly claim?: DurableProcessClaimState;
    });

type DurableProcessLifecycleResult =
  | { readonly ok: true; readonly state: DurableProcessLifecycleState }
  | { readonly ok: false; readonly cause: TypeError };

const durableProcessBase = (
  snapshot: DurableProcessLifecycleSnapshot,
): DurableProcessLifecycleBase => ({
  id: snapshot.id,
  fireAt: snapshot.fireAt,
  kind: snapshot.kind,
  intentEventId: snapshot.intentEventId,
  redriveCount: snapshot.redriveCount,
});

const durableProcessClaimState = (
  snapshot: DurableProcessLifecycleSnapshot,
): DurableProcessClaimState | null => {
  if (snapshot.claimToken === null) return null;
  if (snapshot.claimedAt === null || snapshot.claimDeadlineAt === null) return null;
  return {
    token: snapshot.claimToken,
    claimedAt: snapshot.claimedAt,
    deadlineAt: snapshot.claimDeadlineAt,
  };
};

const durableProcessCancellationState = (
  snapshot: DurableProcessLifecycleSnapshot,
): DurableProcessCancellationState | null =>
  snapshot.cancelRequestedAt === null
    ? null
    : {
        requestedAt: snapshot.cancelRequestedAt,
        reason: snapshot.cancelReason,
      };

export const durableProcessLifecycleState = (
  snapshot: DurableProcessLifecycleSnapshot,
): DurableProcessLifecycleResult => {
  if (!Number.isInteger(snapshot.id) || snapshot.id < 1) {
    return { ok: false, cause: new TypeError("durable process id malformed") };
  }
  if (!Number.isFinite(snapshot.fireAt)) {
    return { ok: false, cause: new TypeError("durable process fireAt malformed") };
  }
  if (snapshot.kind.length === 0) {
    return { ok: false, cause: new TypeError("durable process kind malformed") };
  }
  if (!Number.isInteger(snapshot.intentEventId) || snapshot.intentEventId < 1) {
    return { ok: false, cause: new TypeError("durable process intentEventId malformed") };
  }
  if (!Number.isInteger(snapshot.redriveCount) || snapshot.redriveCount < 0) {
    return { ok: false, cause: new TypeError("durable process redriveCount malformed") };
  }
  if (snapshot.cancelReason !== null && snapshot.cancelRequestedAt === null) {
    return {
      ok: false,
      cause: new TypeError("durable process cancelReason requires cancelRequestedAt"),
    };
  }
  if (snapshot.cancelledAt !== null && snapshot.completedAt === null) {
    return {
      ok: false,
      cause: new TypeError("durable process cancelledAt requires completedAt"),
    };
  }
  const claim = durableProcessClaimState(snapshot);
  if (snapshot.claimToken !== null && claim === null) {
    return {
      ok: false,
      cause: new TypeError("durable process claimToken requires claimedAt and claimDeadlineAt"),
    };
  }
  const cancellation = durableProcessCancellationState(snapshot);
  const base = durableProcessBase(snapshot);
  if (snapshot.cancelledAt !== null) {
    const completedAt = snapshot.completedAt;
    if (completedAt === null) {
      return {
        ok: false,
        cause: new TypeError("durable process cancelledAt requires completedAt"),
      };
    }
    if (cancellation === null) {
      return {
        ok: false,
        cause: new TypeError("durable process cancelledAt requires cancelRequestedAt"),
      };
    }
    return {
      ok: true,
      state: {
        ...base,
        phase: "cancelled",
        completedAt,
        cancellation: { ...cancellation, cancelledAt: snapshot.cancelledAt },
        ...(claim === null ? {} : { claim }),
      },
    };
  }
  if (snapshot.completedAt !== null) {
    if (cancellation !== null) {
      return {
        ok: true,
        state: {
          ...base,
          phase: "completed_after_cancel_requested",
          completedAt: snapshot.completedAt,
          cancellation,
          ...(claim === null ? {} : { claim }),
        },
      };
    }
    return {
      ok: true,
      state: {
        ...base,
        phase: "completed",
        completedAt: snapshot.completedAt,
        ...(claim === null ? {} : { claim }),
      },
    };
  }
  if (cancellation !== null) {
    return {
      ok: true,
      state: {
        ...base,
        phase: "cancel_requested",
        cancellation,
        ...(claim === null ? {} : { claim }),
      },
    };
  }
  if (claim !== null) {
    return {
      ok: true,
      state: {
        ...base,
        phase: snapshot.redriveCount > 0 ? "redriven" : "claimed",
        claim,
      },
    };
  }
  return {
    ok: true,
    state: { ...base, phase: "scheduled" },
  };
};

type ProtocolPayloadParseResult<Payload> =
  | { readonly ok: true; readonly payload: Payload }
  | { readonly ok: false; readonly cause: TypeError };

export const parseIntentPointerDuePayload = (
  value: unknown,
): ProtocolPayloadParseResult<IntentPointerDuePayload> => {
  if (
    !Predicate.isObject(value) ||
    Object.keys(value).length !== 1 ||
    typeof value.intentEventId !== "number" ||
    !Number.isInteger(value.intentEventId) ||
    value.intentEventId < 1
  ) {
    return { ok: false, cause: new TypeError("durable trigger due-work payload malformed") };
  }
  return { ok: true, payload: { intentEventId: value.intentEventId } };
};

export const durableTriggerDuePayload = (intentEventId: number): IntentPointerDuePayload => ({
  intentEventId,
});

export const scheduledEventIntentPayload = (
  eventKind: string,
  data: unknown,
): ScheduledEventIntentPayload => ({ eventKind, data });

export const parseScheduledEventIntentPayload = (
  raw: unknown,
): ProtocolPayloadParseResult<ScheduledEventIntentPayload> => {
  if (
    !Predicate.isObject(raw) ||
    Object.keys(raw).some((key) => key !== "eventKind" && key !== "data") ||
    typeof raw.eventKind !== "string"
  ) {
    return { ok: false, cause: new TypeError("scheduled event intent payload malformed") };
  }
  return { ok: true, payload: { eventKind: raw.eventKind, data: raw.data } };
};

const RETRY_POLICY_KEYS = new Set(["maxAttempts", "initialDelayMs", "maxDelayMs", "multiplier"]);

export const parseDurableTriggerRetryPolicy = (
  value: unknown,
): ProtocolPayloadParseResult<DurableTriggerRetryPolicy> => {
  if (!Predicate.isObject(value)) {
    return { ok: false, cause: new TypeError("durable trigger retry policy malformed") };
  }
  for (const key of Object.keys(value)) {
    if (!RETRY_POLICY_KEYS.has(key)) {
      return { ok: false, cause: new TypeError("durable trigger retry policy malformed") };
    }
  }
  const { maxAttempts, initialDelayMs, maxDelayMs, multiplier } = value;
  if (
    typeof maxAttempts !== "number" ||
    !Number.isInteger(maxAttempts) ||
    maxAttempts < 1 ||
    typeof initialDelayMs !== "number" ||
    !Number.isFinite(initialDelayMs) ||
    initialDelayMs < 0 ||
    typeof maxDelayMs !== "number" ||
    !Number.isFinite(maxDelayMs) ||
    maxDelayMs < initialDelayMs ||
    typeof multiplier !== "number" ||
    !Number.isFinite(multiplier) ||
    multiplier < 1
  ) {
    return { ok: false, cause: new TypeError("durable trigger retry policy malformed") };
  }
  return {
    ok: true,
    payload: {
      maxAttempts,
      initialDelayMs,
      maxDelayMs,
      multiplier,
    },
  };
};

export const durableTriggerBackoffMs = (
  policy: DurableTriggerRetryPolicy,
  attempt: number,
): number => {
  const normalizedAttempt = Math.max(1, Math.floor(attempt));
  const exponent = Math.max(0, normalizedAttempt - 1);
  const delay = policy.initialDelayMs * policy.multiplier ** exponent;
  return Math.floor(Math.min(policy.maxDelayMs, delay));
};

export interface DispatchRequestedPayload {
  readonly target: BackendProtocolDispatchTarget;
  readonly event: string;
  readonly data: unknown;
  readonly idempotencyKey: string;
  readonly retryPolicy: DurableTriggerRetryPolicy;
  readonly claim: PreClaim;
  readonly traceContext?: TraceContext;
}

export interface DispatchOutboundDeliveredPayload {
  readonly outboundEventId: number;
  readonly target: BackendProtocolDispatchTarget;
  readonly event: string;
  readonly idempotencyKey: string;
  readonly deliveryReceipt: DispatchDeliveryReceipt;
  readonly attempt: number;
  readonly claim?: unknown;
  readonly traceContext?: TraceContext;
}

export interface DispatchOutboundEnqueuedPayload {
  readonly outboundEventId: number;
  readonly target: BackendProtocolDispatchTarget;
  readonly event: string;
  readonly idempotencyKey: string;
  readonly enqueueAcknowledgement: DispatchEnqueueAcknowledgement;
  readonly attempt: number;
  readonly claim: IndeterminateClaim;
  readonly traceContext?: TraceContext;
}

export interface DispatchReplaySnapshot {
  readonly kind: "dispatch.delivery";
  readonly outboundEventId: number;
  readonly target: BackendProtocolDispatchTarget;
  readonly event: string;
  readonly idempotencyKey: string;
  readonly deliveryReceipt: DispatchDeliveryReceipt;
  readonly attempt: number;
  readonly traceContext?: TraceContext;
}

export const dispatchReplaySnapshotFromDeliveredPayload = (
  payload: DispatchOutboundDeliveredPayload,
): DispatchReplaySnapshot => ({
  kind: "dispatch.delivery",
  outboundEventId: payload.outboundEventId,
  target: payload.target,
  event: payload.event,
  idempotencyKey: payload.idempotencyKey,
  deliveryReceipt: payload.deliveryReceipt,
  attempt: payload.attempt,
  ...(payload.traceContext === undefined ? {} : { traceContext: payload.traceContext }),
});

export const replayDispatchDeliveryFromSnapshot = (
  snapshot: DispatchReplaySnapshot,
): DispatchDeliveryResult => ({
  receipt: snapshot.deliveryReceipt,
});

export interface DispatchOutboundFailedPayload {
  readonly outboundEventId: number;
  readonly target: BackendProtocolDispatchTarget;
  readonly event: string;
  readonly idempotencyKey: string;
  readonly attempt: number;
  readonly error: string;
  readonly terminal: boolean;
  readonly nextAttemptAt?: number;
  readonly claim?: IndeterminateClaim;
  readonly traceContext?: TraceContext;
}

export interface DispatchReceiptBeforeTerminalProof {
  readonly eventKind: typeof DISPATCH_OUTBOUND_DELIVERED;
  readonly outboundEventId: number;
  readonly idempotencyKey: string;
  readonly deliveryReceipt: DispatchDeliveryReceipt;
  readonly attempt: number;
}

export const dispatchReceiptBeforeTerminalProof = (
  payload: DispatchOutboundDeliveredPayload,
): DispatchReceiptBeforeTerminalProof => ({
  eventKind: DISPATCH_OUTBOUND_DELIVERED,
  outboundEventId: payload.outboundEventId,
  idempotencyKey: payload.idempotencyKey,
  deliveryReceipt: payload.deliveryReceipt,
  attempt: payload.attempt,
});

export const dispatchFailedHasNoDeliveryReceipt = (
  payload: DispatchOutboundFailedPayload,
): boolean => !Object.prototype.hasOwnProperty.call(payload, "deliveryReceipt");

export interface DispatchPayloadParseFailure {
  readonly _tag: "agent_os.dispatch_payload_parse_failure";
  readonly reason: string;
}

export type DispatchPayloadParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: DispatchPayloadParseFailure };

export interface BackendProtocolLedgerEventRpc {
  readonly id: number;
  readonly ts: number;
  readonly kind: string;
  readonly scopeRef: ScopeRef;
  readonly factOwnerRef: FactOwnerRef;
  readonly effectAuthorityRef: AuthorityRef;
  readonly payload: unknown;
  readonly scope?: never;
}

export type BackendProtocolEventHandler = (
  event: BackendProtocolLedgerEventRpc,
) => Promise<void> | void;

export const parseBackendProtocolLedgerEventRpc = (
  value: unknown,
): BackendProtocolParseResult<BackendProtocolLedgerEventRpc> => {
  if (!Predicate.isObject(value)) {
    return backendProtocolParseFail("ledger event must be object");
  }
  if ("scope" in value) {
    return backendProtocolParseFail("ledger event must not include legacy scope");
  }
  if (!hasOnlyProtocolKeys(value, ledgerEventRpcKeys)) {
    return backendProtocolParseFail("ledger event fields malformed");
  }
  if (
    typeof value.id !== "number" ||
    !Number.isInteger(value.id) ||
    value.id < 1 ||
    typeof value.ts !== "number" ||
    !Number.isFinite(value.ts) ||
    value.ts < 0 ||
    typeof value.kind !== "string" ||
    !isScopeRef(value.scopeRef) ||
    !isFactOwnerRef(value.factOwnerRef) ||
    !isAuthorityRef(value.effectAuthorityRef)
  ) {
    return backendProtocolParseFail("ledger event fields malformed");
  }
  return backendProtocolParseOk({
    id: value.id,
    ts: value.ts,
    kind: value.kind,
    scopeRef: value.scopeRef,
    factOwnerRef: value.factOwnerRef,
    effectAuthorityRef: value.effectAuthorityRef,
    payload: value.payload,
  });
};

export const parseBackendProtocolLedgerEventRpcJson = (
  data: string,
): BackendProtocolParseResult<BackendProtocolLedgerEventRpc> => {
  const decoded = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(data);
  if (Option.isNone(decoded)) {
    return backendProtocolParseFail("ledger event JSON malformed");
  }
  return parseBackendProtocolLedgerEventRpc(decoded.value);
};

export const dispatchPayloadParseFailure = (reason: string): DispatchPayloadParseFailure => ({
  _tag: "agent_os.dispatch_payload_parse_failure",
  reason,
});

const parseOk = <T>(value: T): DispatchPayloadParseResult<T> => ({ ok: true, value });

const parseFail = <T = never>(reason: string): DispatchPayloadParseResult<T> => ({
  ok: false,
  failure: dispatchPayloadParseFailure(reason),
});

export const parseTraceContext = (
  value: unknown,
): DispatchPayloadParseResult<TraceContext | undefined> => {
  const parsed = validateOptionalTraceContext(value);
  return parsed.ok ? parseOk(parsed.traceContext) : parseFail(parsed.reason);
};

export const parseDispatchBindingRef = (
  value: unknown,
): DispatchPayloadParseResult<BindingMaterialRef> => {
  const ref = isMaterialRef(value) ? value : null;
  if (ref === null || ref.kind !== "binding") {
    return parseFail("dispatch target bindingRef must be a BindingMaterialRef");
  }
  return parseOk(ref);
};

export const parseRequestedPayloadValue = (
  value: unknown,
): DispatchPayloadParseResult<DispatchRequestedPayload> => {
  if (!Predicate.isObject(value))
    return parseFail("dispatch.outbound.requested payload must be object");
  const target = value.target;
  if (!Predicate.isObject(target)) return parseFail("dispatch target must be object");
  if (typeof value.event !== "string" || typeof value.idempotencyKey !== "string") {
    return parseFail("dispatch.outbound.requested payload malformed");
  }
  if ("scope" in target) return parseFail("dispatch target must not include legacy scope");
  if (!hasOnlyProtocolKeys(target, dispatchTargetKeys)) {
    return parseFail("dispatch target fields malformed");
  }
  const bindingRef = parseDispatchBindingRef(target.bindingRef);
  if (!bindingRef.ok) return bindingRef;
  const scopeRef = target.scopeRef;
  if (!isScopeRef(scopeRef)) return parseFail("dispatch target scopeRef malformed");
  const effectAuthorityRef = target.effectAuthorityRef;
  if (!isAuthorityRef(effectAuthorityRef)) {
    return parseFail("dispatch target effectAuthorityRef malformed");
  }
  const traceContext = parseTraceContext(value.traceContext);
  if (!traceContext.ok) return traceContext;
  const retryPolicy = parseDurableTriggerRetryPolicy(value.retryPolicy);
  if (!retryPolicy.ok) return parseFail(retryPolicy.cause.message);
  const parsedClaim = validateEffectClaim(value.claim);
  if (!parsedClaim.ok || parsedClaim.claim.phase !== "pre") {
    return parseFail("dispatch claim must be a PreClaim");
  }
  return parseOk({
    target: {
      bindingRef: bindingRef.value,
      scopeRef,
      effectAuthorityRef,
    },
    event: value.event,
    data: value.data,
    idempotencyKey: value.idempotencyKey,
    retryPolicy: retryPolicy.payload,
    claim: parsedClaim.claim,
    ...(traceContext.value === undefined ? {} : { traceContext: traceContext.value }),
  });
};

export const parseRequestedPayload = (
  raw: string,
): DispatchPayloadParseResult<DispatchRequestedPayload> =>
  pipe(
    Result.try({
      try: () => JSON.parse(raw) as unknown,
      catch: (cause) => describeDispatchCause(cause),
    }),
    Result.match({
      onFailure: (reason) => parseFail(reason),
      onSuccess: (parsed) => parseRequestedPayloadValue(parsed),
    }),
  );

export const dispatchBackoffMs = (attempt: number): number =>
  durableTriggerBackoffMs(DISPATCH_RETRY_POLICY, attempt);

export const describeDispatchCause = (cause: unknown): string => {
  if (typeof cause === "string") return cause;
  if (cause instanceof Error) return `${cause.name}: ${cause.message}`;
  if (Predicate.isObject(cause) && typeof cause._tag === "string") return cause._tag;
  return Object.prototype.toString.call(cause);
};

export const eventToProtocolRpc = (
  event: BackendProtocolLedgerEventRpc,
): BackendProtocolLedgerEventRpc => ({
  id: event.id,
  ts: event.ts,
  kind: event.kind,
  scopeRef: event.scopeRef,
  factOwnerRef: event.factOwnerRef,
  effectAuthorityRef: event.effectAuthorityRef,
  payload: event.payload,
});
