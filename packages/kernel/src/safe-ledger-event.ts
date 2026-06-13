import { scopeRefKey } from "./effect-claim";
import type { LedgerEvent } from "./types";

/**
 * Browser-safe JSON value emitted by a ledger fact owner.
 *
 * @public
 */
export type SafeLedgerValue =
  | null
  | boolean
  | number
  | string
  | ReadonlyArray<SafeLedgerValue>
  | { readonly [key: string]: SafeLedgerValue };

export type SafeLedgerPayload = Readonly<Record<string, SafeLedgerValue>>;

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
  safePayload?: SafeLedgerPayload,
): SafeLedgerEvent => ({
  id: event.id,
  ts: event.ts,
  kind: event.kind,
  scopeKey: scopeRefKey(event.scopeRef),
  factOwnerRef: event.factOwnerRef,
  ...(safePayload === undefined ? {} : { safePayload }),
});

const bytesOf = (value: string): number => new TextEncoder().encode(value).byteLength;

const sortedOwnKeys = (value: Record<string, unknown>): ReadonlyArray<string> =>
  Object.keys(value).sort((left, right) => left.localeCompare(right));

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
