import { Effect, Either, Predicate, pipe } from "effect";
import {
  isScopeRef,
  validateEffectClaim,
  type LivedClaim,
  type PreClaim,
} from "@agent-os/kernel/effect-claim";
import { isMaterialRef, type BindingMaterialRef } from "@agent-os/kernel/material-ref";
import {
  defineSettlementContract,
  settleLived,
  symbolicSettlementRef,
  validateTerminalClaim,
} from "@agent-os/kernel/settlement-contract";
import type { DeliveryReceipt, DispatchTargetSpec, TraceContext } from "@agent-os/kernel/types";

export const DISPATCH_OUTBOUND_REQUESTED = "dispatch.outbound.requested";
export const DISPATCH_OUTBOUND_DELIVERED = "dispatch.outbound.delivered";
export const DISPATCH_OUTBOUND_FAILED = "dispatch.outbound.failed";
export const DISPATCH_INBOUND_ACCEPTED = "dispatch.inbound.accepted";

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

export const DURABLE_TRIGGER_SCHEDULED_REQUESTED = "durable_trigger.scheduled.requested";

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

export const scheduledEventIntentPayload = (
  eventKind: string,
  data: unknown,
): ScheduledEventIntentPayload => ({ eventKind, data });

export const parseScheduledEventIntentPayload = (
  value: unknown,
): DispatchPayloadParseResult<ScheduledEventIntentPayload> => {
  if (!Predicate.isRecord(value) || typeof value.eventKind !== "string") {
    return parseFail("scheduled event intent payload malformed");
  }
  return parseOk({
    eventKind: value.eventKind,
    data: value.data,
  });
};

export interface DispatchRequestedPayload {
  readonly target: DispatchTargetSpec;
  readonly event: string;
  readonly data: unknown;
  readonly idempotencyKey: string;
  readonly retryPolicy: DurableTriggerRetryPolicy;
  readonly claim: PreClaim;
  readonly traceContext?: TraceContext;
}

export interface DispatchOutboundDeliveredPayload {
  readonly outboundEventId: number;
  readonly target: DispatchTargetSpec;
  readonly event: string;
  readonly idempotencyKey: string;
  readonly deliveryReceipt: DispatchDeliveryReceipt;
  readonly attempt: number;
  readonly claim?: unknown;
  readonly traceContext?: TraceContext;
}

export interface DispatchOutboundFailedPayload {
  readonly outboundEventId: number;
  readonly target: DispatchTargetSpec;
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
  readonly scope: string;
  readonly payload: unknown;
}

export type BackendProtocolEventHandler = (
  event: BackendProtocolLedgerEventRpc,
) => Promise<void> | void;

export const dispatchPayloadParseFailure = (reason: string): DispatchPayloadParseFailure => ({
  _tag: "agent_os.dispatch_payload_parse_failure",
  reason,
});

const parseOk = <T>(value: T): DispatchPayloadParseResult<T> => ({ ok: true, value });

const parseFail = <T = never>(reason: string): DispatchPayloadParseResult<T> => ({
  ok: false,
  failure: dispatchPayloadParseFailure(reason),
});

export const copyTraceContext = (
  traceContext: TraceContext | undefined,
): TraceContext | undefined => {
  if (traceContext === undefined) return undefined;
  return {
    ...(traceContext.traceparent === undefined ? {} : { traceparent: traceContext.traceparent }),
    ...(traceContext.tracestate === undefined ? {} : { tracestate: traceContext.tracestate }),
  };
};

export const parseTraceContext = (
  value: unknown,
): DispatchPayloadParseResult<TraceContext | undefined> => {
  if (value === undefined) return parseOk(undefined);
  if (!Predicate.isRecord(value)) return parseFail("traceContext must be object");
  const traceparent = value.traceparent;
  const tracestate = value.tracestate;
  if (
    (traceparent !== undefined && typeof traceparent !== "string") ||
    (tracestate !== undefined && typeof tracestate !== "string")
  ) {
    return parseFail("traceContext fields must be strings");
  }
  return parseOk(
    copyTraceContext({
      ...(traceparent === undefined ? {} : { traceparent }),
      ...(tracestate === undefined ? {} : { tracestate }),
    }),
  );
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
  if (
    typeof target.scope !== "string" ||
    typeof value.event !== "string" ||
    typeof value.idempotencyKey !== "string"
  ) {
    return parseFail("dispatch.outbound.requested payload malformed");
  }
  const bindingRef = parseDispatchBindingRef(target.bindingRef);
  if (!bindingRef.ok) return bindingRef;
  const scopeRef = target.scopeRef;
  if (!isScopeRef(scopeRef)) return parseFail("dispatch target scopeRef malformed");
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
      scope: target.scope,
      scopeRef,
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
  scope: event.scope,
  payload: event.payload,
});

export const fireBackendEventHandlers = (
  handlers: ReadonlyArray<BackendProtocolEventHandler>,
  event: BackendProtocolLedgerEventRpc,
  label: string,
): Effect.Effect<void> =>
  Effect.forEach(
    handlers,
    (handler) =>
      Effect.tryPromise({
        try: () => Promise.resolve(handler(event)),
        catch: (cause) => cause,
      }).pipe(
        Effect.timeout("5 seconds"),
        Effect.catchAll((cause) =>
          Effect.sync(() => {
            console.error(`[agent-os] ${label} "${event.kind}" failed/timed:`, cause);
          }),
        ),
      ),
    { concurrency: 1, discard: true },
  );
