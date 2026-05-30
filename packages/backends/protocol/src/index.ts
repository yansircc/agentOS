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

export const DISPATCH_MAX_ATTEMPTS = 8;

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

export const DUE_WORK_SCHEDULED_EVENT = "scheduled_event";
export const DUE_WORK_DELIVERY_RETRY = "delivery_retry";

export type DueWorkKind = typeof DUE_WORK_SCHEDULED_EVENT | typeof DUE_WORK_DELIVERY_RETRY;

export interface ScheduledEventDuePayload {
  readonly eventKind: string;
  readonly data: unknown;
}

export interface DeliveryRetryDuePayload {
  readonly intentEventId: number;
}

export type DueWorkPayload<K extends DueWorkKind = DueWorkKind> =
  K extends typeof DUE_WORK_SCHEDULED_EVENT
    ? ScheduledEventDuePayload
    : K extends typeof DUE_WORK_DELIVERY_RETRY
      ? DeliveryRetryDuePayload
      : never;

type DueWorkPayloadParseResult<Payload> =
  | { readonly ok: true; readonly payload: Payload }
  | { readonly ok: false; readonly cause: TypeError };

interface DueWorkKindDefinition<K extends string, Payload> {
  readonly kind: K;
  readonly parse: (value: unknown) => DueWorkPayloadParseResult<Payload>;
}

const defineDueWorkKind = <const K extends string, Payload>(
  definition: DueWorkKindDefinition<K, Payload>,
): DueWorkKindDefinition<K, Payload> => definition;

const parseScheduledEventDuePayload = (
  value: unknown,
): DueWorkPayloadParseResult<ScheduledEventDuePayload> => {
  if (!Predicate.isRecord(value) || typeof value.eventKind !== "string") {
    return { ok: false, cause: new TypeError("scheduled due-work payload malformed") };
  }
  return { ok: true, payload: value as unknown as ScheduledEventDuePayload };
};

const parseDeliveryRetryDuePayload = (
  value: unknown,
): DueWorkPayloadParseResult<DeliveryRetryDuePayload> => {
  if (!Predicate.isRecord(value) || typeof value.intentEventId !== "number") {
    return { ok: false, cause: new TypeError("delivery retry due-work payload malformed") };
  }
  return { ok: true, payload: value as unknown as DeliveryRetryDuePayload };
};

const scheduledEventDueWorkKind = defineDueWorkKind({
  kind: DUE_WORK_SCHEDULED_EVENT,
  parse: parseScheduledEventDuePayload,
});

const deliveryRetryDueWorkKind = defineDueWorkKind({
  kind: DUE_WORK_DELIVERY_RETRY,
  parse: parseDeliveryRetryDuePayload,
});

type DueWorkKindRegistry = {
  readonly [DUE_WORK_SCHEDULED_EVENT]: typeof scheduledEventDueWorkKind;
  readonly [DUE_WORK_DELIVERY_RETRY]: typeof deliveryRetryDueWorkKind;
};

const dueWorkKindRegistry = {
  [DUE_WORK_SCHEDULED_EVENT]: scheduledEventDueWorkKind,
  [DUE_WORK_DELIVERY_RETRY]: deliveryRetryDueWorkKind,
} satisfies DueWorkKindRegistry;

export const isDueWorkKind = (kind: string): kind is DueWorkKind =>
  kind === DUE_WORK_SCHEDULED_EVENT || kind === DUE_WORK_DELIVERY_RETRY;

export const parseDueWorkPayload = <K extends DueWorkKind>(
  kind: K,
  value: unknown,
): DueWorkPayloadParseResult<DueWorkPayload<K>> => {
  const definition = (
    dueWorkKindRegistry as Readonly<
      Record<string, DueWorkKindDefinition<string, unknown> | undefined>
    >
  )[kind];
  if (definition === undefined) {
    return { ok: false, cause: new TypeError(`unknown due-work kind: ${kind}`) };
  }
  return definition.parse(value) as DueWorkPayloadParseResult<DueWorkPayload<K>>;
};

export interface DispatchRequestedPayload {
  readonly target: DispatchTargetSpec;
  readonly event: string;
  readonly data: unknown;
  readonly idempotencyKey: string;
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
  Math.min(60_000, 1_000 * 2 ** Math.min(Math.max(attempt - 1, 0), 6));

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
