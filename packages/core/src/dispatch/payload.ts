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
  readonly claim?: PreClaim;
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

export const parseTraceContext = (value: unknown): TraceContext | undefined => {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new TypeError("traceContext must be object");
  }
  const traceparent = value.traceparent;
  const tracestate = value.tracestate;
  if (
    (traceparent !== undefined && typeof traceparent !== "string") ||
    (tracestate !== undefined && typeof tracestate !== "string")
  ) {
    throw new TypeError("traceContext fields must be strings");
  }
  return copyTraceContext({
    ...(traceparent === undefined ? {} : { traceparent }),
    ...(tracestate === undefined ? {} : { tracestate }),
  });
};

export const parseDispatchBindingRef = (value: unknown): BindingMaterialRef => {
  if (!isMaterialRef(value) || value.kind !== "binding") {
    throw new TypeError("dispatch target bindingRef must be a BindingMaterialRef");
  }
  return value;
};

export const parseRequestedPayload = (raw: string): DispatchRequestedPayload => {
  const value = JSON.parse(raw) as unknown;
  if (!isRecord(value)) {
    throw new TypeError("dispatch.outbound.requested payload must be object");
  }
  const target = value.target;
  if (!isRecord(target)) {
    throw new TypeError("dispatch target must be object");
  }
  if (
    typeof target.scope !== "string" ||
    typeof value.event !== "string" ||
    typeof value.idempotencyKey !== "string"
  ) {
    throw new TypeError("dispatch.outbound.requested payload malformed");
  }
  const bindingRef = parseDispatchBindingRef(target.bindingRef);
  const scopeRef = target.scopeRef;
  if (scopeRef !== undefined && !isScopeRef(scopeRef)) {
    throw new TypeError("dispatch target scopeRef malformed");
  }
  const traceContext = parseTraceContext(value.traceContext);
  const parsedClaim = value.claim === undefined ? undefined : validateEffectClaim(value.claim);
  let claim: PreClaim | undefined;
  if (parsedClaim !== undefined) {
    if (!parsedClaim.ok || parsedClaim.claim.phase !== "pre") {
      throw new TypeError("dispatch claim must be a PreClaim");
    }
    claim = parsedClaim.claim;
  }
  return {
    target: {
      bindingRef,
      scope: target.scope,
      ...(scopeRef === undefined ? {} : { scopeRef }),
    },
    event: value.event,
    data: value.data,
    idempotencyKey: value.idempotencyKey,
    ...(claim === undefined ? {} : { claim }),
    ...(traceContext === undefined ? {} : { traceContext }),
  };
};

export const describeCause = (cause: unknown): string => {
  if (cause instanceof Error) {
    return `${cause.name}: ${cause.message}`;
  }
  if (isRecord(cause) && typeof cause._tag === "string") {
    return cause._tag;
  }
  try {
    return JSON.stringify(cause);
  } catch {
    return String(cause);
  }
};
