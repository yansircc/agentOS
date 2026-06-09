import { Either, Predicate, pipe } from "effect";
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
  type LivedClaim,
  type PreClaim,
  type ScopeRef,
} from "@agent-os/kernel/effect-claim";
import { isMaterialRef, type BindingMaterialRef } from "@agent-os/kernel/material-ref";
import {
  defineSettlementContract,
  settleLived,
  symbolicSettlementRef,
  validateTerminalClaim,
} from "@agent-os/kernel/settlement-contract";
import type { DeliveryReceipt } from "@agent-os/kernel/types";
import { validateOptionalTraceContext, type TraceContext } from "@agent-os/telemetry-protocol";

export { copyTraceContext } from "@agent-os/telemetry-protocol";

export const DISPATCH_OUTBOUND_REQUESTED = "dispatch.outbound.requested";
export const DISPATCH_OUTBOUND_DELIVERED = "dispatch.outbound.delivered";
export const DISPATCH_OUTBOUND_FAILED = "dispatch.outbound.failed";
export const DISPATCH_INBOUND_ACCEPTED = "dispatch.inbound.accepted";
export const DELIVERY_RETRY_TRIGGER_KIND = "delivery_retry";

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
  Predicate.isRecord(value) &&
  hasOnlyProtocolKeys(value, truthIdentityKeys) &&
  isScopeRef(value.scopeRef) &&
  isAuthorityRef(value.effectAuthorityRef);

export const isBackendProtocolEventIdentity = (
  value: unknown,
): value is BackendProtocolEventIdentity =>
  Predicate.isRecord(value) &&
  hasOnlyProtocolKeys(value, eventIdentityKeys) &&
  isScopeRef(value.scopeRef) &&
  isAuthorityRef(value.effectAuthorityRef) &&
  isFactOwnerRef(value.factOwnerRef);

export const isBackendProtocolProjectionKey = (
  value: unknown,
): value is BackendProtocolProjectionKey =>
  Predicate.isRecord(value) &&
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
  OUTBOUND_DELIVERED: DISPATCH_OUTBOUND_DELIVERED,
  OUTBOUND_FAILED: DISPATCH_OUTBOUND_FAILED,
  INBOUND_ACCEPTED: DISPATCH_INBOUND_ACCEPTED,
} as const;

export const dispatchSettlementContract = defineSettlementContract({
  settlementId: "@agent-os/dispatch",
  anchorKinds: ["ledger_event", "external_receipt"],
  rejectionKinds: [],
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

export interface DispatchReceiver {
  readonly __agentosReceiveDispatch: (
    envelope: DispatchEnvelope,
  ) => Promise<DispatchReceiverResult>;
}

export interface DispatchTargetAdapter {
  // The substrate may invoke deliver more than once for the same envelope
  // across drain races, redrive, and adapter retries. Implementations must be
  // idempotent by (targetScope, idempotencyKey) or a target-owned receipt key.
  readonly deliver: (envelope: DispatchEnvelope) => Promise<DispatchDeliveryResult>;
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

export const dispatchLedgerDeliveryReceipt = (spec: {
  readonly targetScope: string;
  readonly deliveredEventId: number;
}): DispatchDeliveryReceipt => ({
  anchorId: symbolicSettlementRef("dispatch.outbound", [spec.targetScope, spec.deliveredEventId]),
  anchorKind: "ledger_event",
});

export const dispatchExternalDeliveryReceipt = (spec: {
  readonly targetKind: string;
  readonly targetScope: string;
  readonly idempotencyKey: string;
}): DispatchDeliveryReceipt => ({
  anchorId: symbolicSettlementRef(`dispatch.${spec.targetKind}`, [
    spec.targetScope,
    spec.idempotencyKey,
  ]),
  anchorKind: "external_receipt",
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
    !Predicate.isRecord(value) ||
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

const RETRY_POLICY_KEYS = new Set(["maxAttempts", "initialDelayMs", "maxDelayMs", "multiplier"]);

export const parseDurableTriggerRetryPolicy = (
  value: unknown,
): ProtocolPayloadParseResult<DurableTriggerRetryPolicy> => {
  if (!Predicate.isRecord(value)) {
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

export interface DispatchOutboundFailedPayload {
  readonly outboundEventId: number;
  readonly target: BackendProtocolDispatchTarget;
  readonly event: string;
  readonly idempotencyKey: string;
  readonly attempt: number;
  readonly error: string;
  readonly terminal: boolean;
  readonly nextAttemptAt?: number;
  readonly traceContext?: TraceContext;
}

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
  if (!Predicate.isRecord(value)) {
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
  if (!Predicate.isRecord(value))
    return parseFail("dispatch.outbound.requested payload must be object");
  const target = value.target;
  if (!Predicate.isRecord(target)) return parseFail("dispatch target must be object");
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
    Either.try({
      try: () => JSON.parse(raw) as unknown,
      catch: (cause) => describeDispatchCause(cause),
    }),
    Either.match({
      onLeft: (reason) => parseFail(reason),
      onRight: (parsed) => parseRequestedPayloadValue(parsed),
    }),
  );

export const dispatchBackoffMs = (attempt: number): number =>
  durableTriggerBackoffMs(DISPATCH_RETRY_POLICY, attempt);

export const describeDispatchCause = (cause: unknown): string => {
  if (typeof cause === "string") return cause;
  if (cause instanceof Error) return `${cause.name}: ${cause.message}`;
  if (Predicate.isRecord(cause) && typeof cause._tag === "string") return cause._tag;
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
