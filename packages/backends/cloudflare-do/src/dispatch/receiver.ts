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

import { Predicate } from "effect";
import type { TraceContext } from "@agent-os/telemetry-protocol";
import type { LivedClaim } from "@agent-os/kernel/effect-claim";
import { sqlText } from "../storage/sql-row";
import { projectionIdentityColumns } from "../ledger/identity";
import {
  DISPATCH_INBOUND_ACCEPTED,
  dispatchPayloadParseFailure,
  parseDispatchLivedClaim,
  parseTraceContext,
  type DispatchPayloadParseResult,
} from "@agent-os/backend-protocol";
import type { BackendProtocolEventIdentity } from "@agent-os/backend-protocol";

export interface InboundAcceptedPayload {
  readonly sourceScope: string;
  readonly outboundEventId: number;
  readonly idempotencyKey: string;
  readonly deliveredEventId: number;
  readonly claim: LivedClaim;
  readonly traceContext?: TraceContext;
}

const parseOk = <T>(value: T): DispatchPayloadParseResult<T> => ({ ok: true, value });

const parseFail = <T = never>(reason: string): DispatchPayloadParseResult<T> => ({
  ok: false,
  failure: dispatchPayloadParseFailure(reason),
});

export const parseInboundAcceptedPayload = (
  raw: string,
): DispatchPayloadParseResult<InboundAcceptedPayload> => {
  const value = JSON.parse(raw) as unknown;
  if (!Predicate.isObject(value)) {
    return parseFail("dispatch.inbound.accepted payload must be object");
  }
  if (
    typeof value.sourceScope !== "string" ||
    typeof value.outboundEventId !== "number" ||
    typeof value.idempotencyKey !== "string" ||
    typeof value.deliveredEventId !== "number"
  ) {
    return parseFail("dispatch.inbound.accepted payload malformed");
  }
  const traceContext = parseTraceContext(value.traceContext);
  if (!traceContext.ok) return traceContext;
  const parsedClaim = parseDispatchLivedClaim(value.claim, DISPATCH_INBOUND_ACCEPTED);
  if (!parsedClaim.ok) return parsedClaim;
  return parseOk({
    sourceScope: value.sourceScope,
    outboundEventId: value.outboundEventId,
    idempotencyKey: value.idempotencyKey,
    deliveredEventId: value.deliveredEventId,
    claim: parsedClaim.value,
    ...(traceContext.value === undefined ? {} : { traceContext: traceContext.value }),
  });
};

export type FindAcceptedResult = DispatchPayloadParseResult<InboundAcceptedPayload | null>;

export const findAcceptedInRows = (
  rows: ReadonlyArray<{ readonly payload: unknown }>,
  sourceScope: string,
  idempotencyKey: string,
): FindAcceptedResult => {
  for (const row of rows) {
    const payload = parseInboundAcceptedPayload(sqlText(row.payload, "events.payload"));
    if (!payload.ok) return payload;
    if (
      payload.value.sourceScope === sourceScope &&
      payload.value.idempotencyKey === idempotencyKey
    ) {
      return parseOk(payload.value);
    }
  }
  return parseOk(null);
};

export const findAccepted = (
  sql: SqlStorage,
  identity: BackendProtocolEventIdentity,
  sourceScope: string,
  idempotencyKey: string,
): FindAcceptedResult => {
  const columns = projectionIdentityColumns({
    ...identity,
    projectionKind: "dispatch",
    projectionId: "inbound-accepted",
  });
  const rows = sql
    .exec(
      "SELECT payload FROM events WHERE event_identity_key = ? AND kind = ? ORDER BY id",
      columns.event_identity_key,
      DISPATCH_INBOUND_ACCEPTED,
    )
    .toArray();
  return findAcceptedInRows(
    rows as unknown as ReadonlyArray<{ readonly payload: unknown }>,
    sourceScope,
    idempotencyKey,
  );
};
