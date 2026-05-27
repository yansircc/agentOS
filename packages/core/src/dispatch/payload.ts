/**
 * Payload parsers + trace-context helpers shared by sender and receiver.
 *
 * Leaf module within dispatch/: imports nothing from sibling dispatch
 * files. Both outbox.ts (for the requested payload it pulls off the
 * outbox queue) and receiver.ts (for inbound accepted payload tagging)
 * reach in here; dispatch.ts (orchestrator) uses copyTraceContext +
 * parseRequestedPayload + describeCause.
 */

import type { DispatchTargetSpec, TraceContext } from "../types";
import { isScopeRef, validateEffectClaim, type PreClaim } from "../effect-claim";
import { isMaterialRef, type BindingMaterialRef } from "../material-ref";

export interface DispatchRequestedPayload {
  readonly target: DispatchTargetSpec;
  readonly event: string;
  readonly data: unknown;
  readonly idempotencyKey: string;
  readonly claim: PreClaim;
  readonly traceContext?: TraceContext;
}

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

export interface DispatchPayloadParseFailure {
  readonly _tag: "agent_os.dispatch_payload_parse_failure";
  readonly reason: string;
}

export type DispatchPayloadParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: DispatchPayloadParseFailure };

export const dispatchPayloadParseFailure = (
  reason: string,
): DispatchPayloadParseFailure => ({
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
  if (value === undefined) return parseOk(undefined);
  if (!isRecord(value)) {
    return parseFail("traceContext must be object");
  }
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
  if (!isMaterialRef(value) || value.kind !== "binding") {
    return parseFail("dispatch target bindingRef must be a BindingMaterialRef");
  }
  return parseOk(value);
};

export const parseRequestedPayload = (
  raw: string,
): DispatchPayloadParseResult<DispatchRequestedPayload> => {
  const value = JSON.parse(raw) as unknown;
  if (!isRecord(value)) {
    return parseFail("dispatch.outbound.requested payload must be object");
  }
  const target = value.target;
  if (!isRecord(target)) {
    return parseFail("dispatch target must be object");
  }
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
  if (!isScopeRef(scopeRef)) {
    return parseFail("dispatch target scopeRef malformed");
  }
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

export const describeCause = (cause: unknown): string => {
  if (typeof cause === "string") return cause;
  if (cause instanceof Error) {
    return `${cause.name}: ${cause.message}`;
  }
  if (isRecord(cause) && typeof cause._tag === "string") {
    return cause._tag;
  }
  return Object.prototype.toString.call(cause);
};
