import { Data, Predicate } from "effect";
import {
  authorityRefKey,
  factOwnerKey,
  isAuthorityRef,
  isFactOwnerRef,
  isScopeRef,
  scopeRefKey,
  type AuthorityRef,
  type FactOwnerRef,
  type ScopeRef,
} from "@agent-os/kernel/effect-claim";
import type { LedgerEvent } from "@agent-os/kernel/types";
import {
  backendProtocolEventIdentityKey,
  backendProtocolProjectionKey,
  backendProtocolTruthIdentityKey,
  isBackendProtocolTruthIdentity,
  type BackendProtocolEventIdentity,
  type BackendProtocolProjectionKey,
  type BackendProtocolTruthIdentity,
} from "@agent-os/backend-protocol";
import { sqlText } from "../storage/sql-row";

export class CloudflareLedgerSchemaError extends Data.TaggedError(
  "agent_os.cloudflare_ledger_schema_error",
)<{
  readonly table: string;
  readonly reason: string;
}> {}

export const CLOUDFLARE_FACT_OWNER_REF: FactOwnerRef = "@agent-os/backend-cloudflare-do";
export const BACKEND_PROTOCOL_FACT_OWNER_REF: FactOwnerRef = "@agent-os/backend-protocol";

type CloudflareRoutingScopeKind = Exclude<ScopeRef["kind"], "external">;

export const cloudflareDefaultTruthIdentityFromRoutingScope = (
  scope: string,
  kind: CloudflareRoutingScopeKind = "conversation",
): BackendProtocolTruthIdentity => ({
  scopeRef: { kind, scopeId: scope },
  effectAuthorityRef: { authorityClass: "effect", authorityId: scope },
});

export const cloudflareRouteKeyFromScopeRef = (scopeRef: ScopeRef): string => scopeRef.scopeId;

export const sameCloudflareTruthIdentity = (
  left: BackendProtocolTruthIdentity,
  right: BackendProtocolTruthIdentity,
): boolean => backendProtocolTruthIdentityKey(left) === backendProtocolTruthIdentityKey(right);

export const cloudflareTruthIdentity = (
  value: BackendProtocolTruthIdentity,
  label: string,
): BackendProtocolTruthIdentity | CloudflareLedgerSchemaError => {
  if (!isBackendProtocolTruthIdentity(value)) {
    return new CloudflareLedgerSchemaError({
      table: "events",
      reason: `${label} missing structured truth identity`,
    });
  }
  return value;
};

export interface LedgerIdentityKeys {
  readonly scopeKey: string;
  readonly effectAuthorityKey: string;
  readonly factOwnerKey: string;
  readonly truthIdentityKey: string;
  readonly eventIdentityKey: string;
}

export interface EventSqlIdentityColumns {
  readonly scope_ref: string;
  readonly scope_key: string;
  readonly effect_authority_ref: string;
  readonly effect_authority_key: string;
  readonly fact_owner_ref: string;
  readonly fact_owner_key: string;
  readonly event_identity_key: string;
}

export interface ProjectionSqlIdentityColumns extends EventSqlIdentityColumns {
  readonly projection_key: string;
}

export interface LedgerEventSqlRow extends EventSqlIdentityColumns {
  readonly id: unknown;
  readonly ts: unknown;
  readonly kind: unknown;
  readonly payload: unknown;
}

export const cloudflareScopeRefKey = (scopeRef: ScopeRef): string => scopeRefKey(scopeRef);

export const cloudflareEffectAuthorityKey = (effectAuthorityRef: AuthorityRef): string =>
  authorityRefKey(effectAuthorityRef);

export const ledgerIdentityKeys = (identity: BackendProtocolEventIdentity): LedgerIdentityKeys => ({
  scopeKey: cloudflareScopeRefKey(identity.scopeRef),
  effectAuthorityKey: cloudflareEffectAuthorityKey(identity.effectAuthorityRef),
  factOwnerKey: factOwnerKey(identity.factOwnerRef),
  truthIdentityKey: backendProtocolTruthIdentityKey(identity),
  eventIdentityKey: backendProtocolEventIdentityKey(identity),
});

const encodeJson = (value: unknown): string => {
  const encoded = JSON.stringify(value);
  if (typeof encoded !== "string") {
    throw new TypeError("ledger identity must be JSON serializable");
  }
  return encoded;
};

export const eventIdentity = (
  truthIdentity: BackendProtocolTruthIdentity,
  factOwnerRef: FactOwnerRef,
): BackendProtocolEventIdentity => ({
  scopeRef: truthIdentity.scopeRef,
  effectAuthorityRef: truthIdentity.effectAuthorityRef,
  factOwnerRef,
});

export const eventIdentityColumns = (
  identity: BackendProtocolEventIdentity,
): EventSqlIdentityColumns => {
  const keys = ledgerIdentityKeys(identity);
  return {
    scope_ref: encodeJson(identity.scopeRef),
    scope_key: keys.scopeKey,
    effect_authority_ref: encodeJson(identity.effectAuthorityRef),
    effect_authority_key: keys.effectAuthorityKey,
    fact_owner_ref: identity.factOwnerRef,
    fact_owner_key: keys.factOwnerKey,
    event_identity_key: keys.eventIdentityKey,
  };
};

export const projectionIdentityColumns = (
  key: BackendProtocolProjectionKey,
): ProjectionSqlIdentityColumns => ({
  ...eventIdentityColumns(key),
  projection_key: backendProtocolProjectionKey(key),
});

const decodeJsonColumn = (value: unknown, column: string): unknown =>
  JSON.parse(sqlText(value, column)) as unknown;

export const eventIdentityFromRow = (
  row: Pick<
    LedgerEventSqlRow,
    | "scope_ref"
    | "scope_key"
    | "effect_authority_ref"
    | "effect_authority_key"
    | "fact_owner_ref"
    | "fact_owner_key"
    | "event_identity_key"
  >,
): BackendProtocolEventIdentity => {
  const scopeRef = decodeJsonColumn(row.scope_ref, "events.scope_ref");
  const effectAuthorityRef = decodeJsonColumn(
    row.effect_authority_ref,
    "events.effect_authority_ref",
  );
  const factOwnerRef = sqlText(row.fact_owner_ref, "events.fact_owner_ref");
  if (
    !isScopeRef(scopeRef) ||
    !isAuthorityRef(effectAuthorityRef) ||
    !isFactOwnerRef(factOwnerRef)
  ) {
    throw new TypeError("events identity columns malformed");
  }
  const identity = {
    scopeRef,
    effectAuthorityRef,
    factOwnerRef,
  } satisfies BackendProtocolEventIdentity;
  const keys = ledgerIdentityKeys(identity);
  if (
    sqlText(row.scope_key, "events.scope_key") !== keys.scopeKey ||
    sqlText(row.effect_authority_key, "events.effect_authority_key") !== keys.effectAuthorityKey ||
    sqlText(row.fact_owner_key, "events.fact_owner_key") !== keys.factOwnerKey ||
    sqlText(row.event_identity_key, "events.event_identity_key") !== keys.eventIdentityKey
  ) {
    throw new TypeError("events identity keys do not match identity columns");
  }
  return identity;
};

export const ledgerEventFromRow = (row: LedgerEventSqlRow): LedgerEvent => ({
  id: Number(row.id),
  ts: Number(row.ts),
  kind: sqlText(row.kind, "events.kind"),
  ...eventIdentityFromRow(row),
  payload: JSON.parse(sqlText(row.payload, "events.payload")) as unknown,
});

export const truthIdentityFromCommitSpec = (
  value: unknown,
  label: string,
): BackendProtocolTruthIdentity => {
  if (!Predicate.isObject(value)) {
    throw new CloudflareLedgerSchemaError({ table: "events", reason: `${label} must be an object` });
  }
  if ("scope" in value) {
    throw new CloudflareLedgerSchemaError({
      table: "events",
      reason: `${label} must not include legacy scope`,
    });
  }
  if (!isScopeRef(value.scopeRef) || !isAuthorityRef(value.effectAuthorityRef)) {
    throw new CloudflareLedgerSchemaError({
      table: "events",
      reason: `${label} missing structured truth identity`,
    });
  }
  return {
    scopeRef: value.scopeRef,
    effectAuthorityRef: value.effectAuthorityRef,
  };
};

export const eventIdentityFromQuerySpec = (
  value: unknown,
  label: string,
): BackendProtocolEventIdentity => {
  const truthIdentity = truthIdentityFromCommitSpec(value, label);
  if (!Predicate.isObject(value) || !isFactOwnerRef(value.factOwnerRef)) {
    throw new CloudflareLedgerSchemaError({
      table: "events",
      reason: `${label} missing factOwnerRef`,
    });
  }
  return eventIdentity(truthIdentity, value.factOwnerRef);
};

export const assertNoFactOwnerOverride = (value: unknown, label: string): void => {
  if (Predicate.isObject(value) && "factOwnerRef" in value) {
    throw new CloudflareLedgerSchemaError({
      table: "events",
      reason: `${label} must not include caller-controlled factOwnerRef`,
    });
  }
};
