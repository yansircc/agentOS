import { Effect, Either, pipe } from "effect";
import type { DispatchTargetSpec, TraceContext } from "@agent-os/runtime";
import { isScopeRef, validateEffectClaim, type PreClaim } from "@agent-os/kernel/effect-claim";
import { isMaterialRef, type BindingMaterialRef } from "@agent-os/kernel/material-ref";

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

export const DUE_WORK_SCHEDULED_EVENT = "scheduled_event";
export const DUE_WORK_DISPATCH_RETRY = "dispatch_retry";

export type DueWorkKind = typeof DUE_WORK_SCHEDULED_EVENT | typeof DUE_WORK_DISPATCH_RETRY;

export interface ScheduledEventDuePayload {
  readonly eventKind: string;
  readonly data: unknown;
}

export interface DispatchRetryDuePayload {
  readonly outboundEventId: number;
}

export type DueWorkPayload<K extends DueWorkKind = DueWorkKind> =
  K extends typeof DUE_WORK_SCHEDULED_EVENT
    ? ScheduledEventDuePayload
    : K extends typeof DUE_WORK_DISPATCH_RETRY
      ? DispatchRetryDuePayload
      : never;

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
  readonly deliveredEventId: number;
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

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

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
  if (!isRecord(value)) return parseFail("traceContext must be object");
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
  if (!isRecord(value)) return parseFail("dispatch.outbound.requested payload must be object");
  const target = value.target;
  if (!isRecord(target)) return parseFail("dispatch target must be object");
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
  if (isRecord(cause) && typeof cause._tag === "string") return cause._tag;
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
