import { randomUUID } from "node:crypto";
import { InvalidResourceAmount, JsonStringifyError, SqlError } from "@agent-os/core/errors";
import type { LedgerEvent } from "@agent-os/core/types";
import {
  RESOURCE_EVENT_KIND,
  backendProtocolEventIdentityKey,
  type BackendProtocolEventIdentity,
  type BackendProtocolTruthIdentity,
} from "@agent-os/core/backend-protocol";
import { RUNTIME_FACT_OWNER } from "@agent-os/core/runtime-protocol";
import { sqlJson, sqlString } from "./host";

export const schemaName = (schema: string | undefined): string =>
  schema ?? `agentos_node_postgres_${randomUUID().replace(/-/g, "_")}`;

export const runtimeIdentity = (
  identity: BackendProtocolTruthIdentity,
): BackendProtocolEventIdentity => ({
  scopeRef: identity.scopeRef,
  effectAuthorityRef: identity.effectAuthorityRef,
  factOwnerRef: RUNTIME_FACT_OWNER,
});

export const eventToRpc = (event: LedgerEvent): LedgerEvent => ({
  id: event.id,
  ts: event.ts,
  kind: event.kind,
  scopeRef: event.scopeRef,
  factOwnerRef: event.factOwnerRef,
  effectAuthorityRef: event.effectAuthorityRef,
  payload: event.payload,
});

export const groupRuntimeEventsByIdentityKey = (
  events: ReadonlyArray<LedgerEvent>,
): Map<string, LedgerEvent[]> => {
  const groups = new Map<string, LedgerEvent[]>();
  for (const event of events) {
    if (event.factOwnerRef !== RUNTIME_FACT_OWNER) continue;
    const key = backendProtocolEventIdentityKey(event);
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, [event]);
    } else {
      group.push(event);
    }
  }
  return groups;
};

export const validateSerializablePayload = (payload: unknown): void => {
  try {
    const encoded = JSON.stringify(payload);
    if (typeof encoded !== "string") {
      throw new TypeError("ledger event payload must be JSON serializable");
    }
  } catch (cause) {
    throw new JsonStringifyError({ cause });
  }
};

export const sqlPayload = (payload: unknown): string => {
  validateSerializablePayload(payload);
  return sqlJson(payload);
};

export const positiveAmount = (amount: number): void => {
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new InvalidResourceAmount({ amount });
  }
};

export const recordOf = (value: unknown, label: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SqlError({ cause: `${label} payload must be object` });
  }
  return value as Record<string, unknown>;
};

export const finiteNumberField = (value: Record<string, unknown>, key: string): number => {
  const field = value[key];
  if (typeof field !== "number" || !Number.isFinite(field)) {
    throw new SqlError({ cause: `${key} must be finite number` });
  }
  return field;
};

const MIN_SAFE_INTEGER = BigInt(Number.MIN_SAFE_INTEGER);
const MAX_SAFE_INTEGER = BigInt(Number.MAX_SAFE_INTEGER);
const DECIMAL_INTEGER = /^(?:0|-?[1-9]\d*)$/u;

export const safeIntegerFromDecimalText = (value: unknown, label: string): number => {
  if (typeof value !== "string" || !DECIMAL_INTEGER.test(value)) {
    throw new SqlError({ cause: `${label} must be canonical decimal integer text` });
  }
  const exact = BigInt(value);
  if (exact < MIN_SAFE_INTEGER || exact > MAX_SAFE_INTEGER) {
    throw new SqlError({ cause: `${label} exceeds the JavaScript safe integer range` });
  }
  return Number(exact);
};

export const safeIntegerSum = (left: number, right: number, label: string): number => {
  if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right)) {
    throw new SqlError({ cause: `${label} operands must be JavaScript safe integers` });
  }
  const exact = BigInt(left) + BigInt(right);
  if (exact < MIN_SAFE_INTEGER || exact > MAX_SAFE_INTEGER) {
    throw new SqlError({ cause: `${label} exceeds the JavaScript safe integer range` });
  }
  return Number(exact);
};

export type DecimalLedgerEventRow = Omit<LedgerEvent, "id"> & { readonly id: string };

export const ledgerEventFromDecimalRow = (row: DecimalLedgerEventRow): LedgerEvent => ({
  ...row,
  id: safeIntegerFromDecimalText(row.id, "ledger event id"),
});

export const ledgerEventsFromDecimalRows = (
  rows: ReadonlyArray<DecimalLedgerEventRow>,
): ReadonlyArray<LedgerEvent> => rows.map(ledgerEventFromDecimalRow);

export const eventRowSelect = `
  SELECT
    id::text AS "id",
    ts AS "ts",
    kind AS "kind",
    scope_ref AS "scopeRef",
    fact_owner_ref #>> '{}' AS "factOwnerRef",
    effect_authority_ref AS "effectAuthorityRef",
    payload AS "payload"
  FROM agentos_events
`;

export const ledgerWriteLockKey = (identityKey: string): string => `agentos:ledger:${identityKey}`;

export const resourceLockKey = (identityKey: string): string => `agentos:resource:${identityKey}`;

export const resourceProjectionCtes = (identityKey: string): string => `
  resource_events AS (
    SELECT id, kind, payload
    FROM agentos_events
    WHERE identity_key = ${sqlString(identityKey)}
      AND kind LIKE 'resource_pool.%'
    ORDER BY id ASC
  ),
  resource_grants AS (
    SELECT
      id,
      payload ->> 'key' AS resource_key,
      (payload ->> 'amount')::double precision AS amount
    FROM resource_events
    WHERE kind = ${sqlString(RESOURCE_EVENT_KIND.GRANTED)}
  ),
  resource_reserved AS (
    SELECT
      id,
      payload ->> 'reservationId' AS reservation_id,
      payload ->> 'idempotencyKey' AS idempotency_key,
      payload ->> 'key' AS resource_key,
      (payload ->> 'amount')::double precision AS amount
    FROM resource_events
    WHERE kind = ${sqlString(RESOURCE_EVENT_KIND.RESERVED)}
  ),
  resource_rejections AS (
    SELECT
      id,
      payload ->> 'idempotencyKey' AS idempotency_key,
      payload ->> 'key' AS resource_key,
      (payload ->> 'amount')::double precision AS amount,
      (payload ->> 'available')::double precision AS available
    FROM resource_events
    WHERE kind = ${sqlString(RESOURCE_EVENT_KIND.RESERVE_REJECTED)}
  ),
  resource_terminal AS (
    SELECT
      payload ->> 'reservationId' AS reservation_id,
      kind,
      id,
      row_number() OVER (PARTITION BY payload ->> 'reservationId' ORDER BY id DESC) AS ordinal
    FROM resource_events
    WHERE kind IN (
      ${sqlString(RESOURCE_EVENT_KIND.CONSUMED)},
      ${sqlString(RESOURCE_EVENT_KIND.RELEASED)}
    )
  ),
  resource_reservations AS (
    SELECT
      reserved.id,
      reserved.reservation_id,
      reserved.idempotency_key,
      reserved.resource_key,
      reserved.amount,
      terminal.kind AS terminal_kind
    FROM resource_reserved reserved
    LEFT JOIN resource_terminal terminal
      ON terminal.reservation_id = reserved.reservation_id
     AND terminal.ordinal = 1
  ),
  resource_projection_validation AS (
    SELECT
      (SELECT COUNT(*) FROM resource_grants)
      + (SELECT COUNT(*) FROM resource_reserved)
      + (SELECT COUNT(*) FROM resource_rejections)
      + (SELECT COUNT(*) FROM resource_terminal) AS row_count
  )
`;
