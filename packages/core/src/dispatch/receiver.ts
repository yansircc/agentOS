/**
 * Receive-side dedupe ledger projection.
 *
 * Receiver idempotency is `(sourceScope, idempotencyKey)`. The sender's
 * `outboundEventId` is trace metadata only and must not decide
 * duplicates — sender retries reuse the same outbound id, but a
 * SECOND deliver call from a separately-issued sender intent could
 * collide on id while having different application data.
 *
 * `findAccepted` scans `events.kind = dispatch.inbound.accepted` for a
 * matching `(sourceScope, idempotencyKey)` pair and returns the prior
 * deliveredEventId, letting the receiver short-circuit instead of
 * appending a duplicate application row.
 */

import type { TraceContext } from "../types";
import { validateEffectClaim, type LivedClaim } from "../effect-claim";
import { sqlText } from "../storage/sql-row";
import { isRecord, parseTraceContext } from "./payload";

export interface InboundAcceptedPayload {
  readonly sourceScope: string;
  readonly outboundEventId: number;
  readonly idempotencyKey: string;
  readonly deliveredEventId: number;
  readonly claim?: LivedClaim;
  readonly traceContext?: TraceContext;
}

export const DISPATCH_INBOUND_ACCEPTED = "dispatch.inbound.accepted";

export const parseInboundAcceptedPayload = (raw: string): InboundAcceptedPayload => {
  const value = JSON.parse(raw) as unknown;
  if (!isRecord(value)) {
    throw new TypeError("dispatch.inbound.accepted payload must be object");
  }
  if (
    typeof value.sourceScope !== "string" ||
    typeof value.outboundEventId !== "number" ||
    typeof value.idempotencyKey !== "string" ||
    typeof value.deliveredEventId !== "number"
  ) {
    throw new TypeError("dispatch.inbound.accepted payload malformed");
  }
  const traceContext = parseTraceContext(value.traceContext);
  const parsedClaim = value.claim === undefined ? undefined : validateEffectClaim(value.claim);
  let claim: LivedClaim | undefined;
  if (parsedClaim !== undefined) {
    if (!parsedClaim.ok || parsedClaim.claim.phase !== "lived") {
      throw new TypeError("dispatch.inbound.accepted claim must be LivedClaim");
    }
    claim = parsedClaim.claim;
  }
  return {
    sourceScope: value.sourceScope,
    outboundEventId: value.outboundEventId,
    idempotencyKey: value.idempotencyKey,
    deliveredEventId: value.deliveredEventId,
    ...(claim === undefined ? {} : { claim }),
    ...(traceContext === undefined ? {} : { traceContext }),
  };
};

export const findAcceptedInRows = (
  rows: ReadonlyArray<{ readonly payload: unknown }>,
  sourceScope: string,
  idempotencyKey: string,
): InboundAcceptedPayload | null => {
  for (const row of rows) {
    const payload = parseInboundAcceptedPayload(sqlText(row.payload, "events.payload"));
    if (payload.sourceScope === sourceScope && payload.idempotencyKey === idempotencyKey) {
      return payload;
    }
  }
  return null;
};

export const findAccepted = (
  sql: SqlStorage,
  scope: string,
  sourceScope: string,
  idempotencyKey: string,
): InboundAcceptedPayload | null => {
  const rows = sql
    .exec(
      "SELECT payload FROM events WHERE scope = ? AND kind = ? ORDER BY id",
      scope,
      DISPATCH_INBOUND_ACCEPTED,
    )
    .toArray();
  return findAcceptedInRows(
    rows as unknown as ReadonlyArray<{ readonly payload: unknown }>,
    sourceScope,
    idempotencyKey,
  );
};
