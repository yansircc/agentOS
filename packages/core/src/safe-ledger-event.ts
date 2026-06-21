import { Option } from "effect";
import { scopeRefKey } from "./effect-claim";
import type { LedgerEvent } from "./types";
import type { RecordedPayloadValue } from "./value-brands";

const safeLedgerPayloadBrand: unique symbol = Symbol("@agent-os/kernel/SafeLedgerPayload");

/**
 * Browser-safe JSON value emitted by a ledger fact owner.
 *
 * @public
 */
export type SafeLedgerValue = RecordedPayloadValue;

export type SafeLedgerPayloadShape = Readonly<Record<string, SafeLedgerValue>>;
export type SafeLedgerPayload = SafeLedgerPayloadShape & {
  readonly [safeLedgerPayloadBrand]: "SafeLedgerPayload";
};

/**
 * Owner-owned browser read projection for one durable ledger event.
 *
 * @agentosPrimitive primitive.kernel.SafeLedgerEvent
 * @agentosInvariant invariant.boundary.owner-owned-safe-projection
 * @agentosDocs docs/concepts/durable-truth.md
 * @public
 */
export interface SafeLedgerEvent {
  readonly id: number;
  readonly ts: number;
  readonly kind: string;
  readonly scopeKey: string;
  readonly factOwnerRef: string;
  readonly safePayload?: SafeLedgerPayload;
}

export type SafeLedgerEventProjector = (event: LedgerEvent) => SafeLedgerEvent | undefined;

export type RedactedSafeSummaryReason =
  | "provider_error"
  | "run_input"
  | "run_output"
  | "tool_arguments"
  | "tool_result";

export const safeLedgerEvent = (
  event: LedgerEvent,
  safePayload?: Readonly<Record<string, unknown>> | SafeLedgerPayload,
): SafeLedgerEvent => ({
  id: event.id,
  ts: event.ts,
  kind: event.kind,
  scopeKey: scopeRefKey(event.scopeRef),
  factOwnerRef: event.factOwnerRef,
  ...(safePayload === undefined ? {} : { safePayload: safeLedgerPayload(safePayload) }),
});

const bytesOf = (value: string): number => new TextEncoder().encode(value).byteLength;

const sortedOwnKeys = (value: Record<string, unknown>): ReadonlyArray<string> =>
  Object.keys(value).sort((left, right) => left.localeCompare(right));

const failSafePayload = (message: string): never => {
  return Option.getOrThrowWith(Option.none(), () => new TypeError(message));
};

const isJsonRecord = (value: object): value is Readonly<Record<string, unknown>> => {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const valueTypeOf = (value: unknown): string => {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
};

export const safeValueFromUnknown = (value: unknown): SafeLedgerValue | undefined => {
  if (
    value === null ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value)) ||
    typeof value === "string"
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    const items: SafeLedgerValue[] = [];
    for (const item of value) {
      const safeItem = safeValueFromUnknown(item);
      if (safeItem === undefined) return undefined;
      items.push(safeItem);
    }
    return items;
  }

  if (value !== null && typeof value === "object") {
    if (!isJsonRecord(value)) return undefined;
    const record: Record<string, SafeLedgerValue> = {};
    for (const [key, item] of Object.entries(value)) {
      const safeItem = safeValueFromUnknown(item);
      if (safeItem === undefined) return undefined;
      record[key] = safeItem;
    }
    return record;
  }

  return undefined;
};

export const safeLedgerPayload = (value: Readonly<Record<string, unknown>>): SafeLedgerPayload => {
  const payload = safeValueFromUnknown(value);
  if (payload === undefined) return failSafePayload("safe ledger payload must be JSON-safe");
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return failSafePayload("safe ledger payload must be an object");
  }
  Object.defineProperty(payload, safeLedgerPayloadBrand, {
    value: "SafeLedgerPayload",
    enumerable: false,
  });
  return payload as SafeLedgerPayload;
};

export const redactedSafeSummary = (
  value: unknown,
  reason: RedactedSafeSummaryReason,
): SafeLedgerValue => {
  if (typeof value === "string") {
    return {
      redacted: true,
      reason,
      type: "string",
      bytes: bytesOf(value),
    };
  }

  if (Array.isArray(value)) {
    return {
      redacted: true,
      reason,
      type: "array",
      items: value.length,
    };
  }

  if (value !== null && typeof value === "object") {
    return {
      redacted: true,
      reason,
      type: "object",
      keys: sortedOwnKeys(value as Record<string, unknown>),
    };
  }

  return {
    redacted: true,
    reason,
    type: valueTypeOf(value),
  };
};

export const redactedSafeSummaryText = (
  value: unknown,
  reason: RedactedSafeSummaryReason,
): string => JSON.stringify(redactedSafeSummary(value, reason));
