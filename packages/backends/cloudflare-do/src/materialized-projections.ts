import { Effect, Layer, Schema } from "effect";
import { SqlError } from "@agent-os/kernel/errors";
import type { LedgerEvent } from "@agent-os/kernel/types";
import {
  MaterializedProjectionRegistry,
  MaterializedProjections,
  ProjectionApplicationError,
  applyProjectionEventResult,
  getProjection,
  type AnyMaterializedProjectionDefinition,
  type MaterializedProjectionRebuildResult,
  type MaterializedProjectionRow,
  type MaterializedProjectionStatus,
  type ProjectionReducerReturnedThenable,
  type ProjectionRegistry,
} from "@agent-os/runtime";
import { sqlText } from "./storage/sql-row";
import {
  LegacyLedgerSchemaError,
  eventIdentityFromQuerySpec,
  ledgerEventFromRow,
  projectionIdentityColumns,
  type LedgerEventSqlRow,
} from "./ledger/identity";
import type {
  BackendProtocolEventIdentity,
  BackendProtocolProjectionKey,
} from "@agent-os/backend-protocol";

const DEFAULT_LIMIT = 1000;
const MAX_LIMIT = 1000;

const registries = new WeakMap<SqlStorage, ProjectionRegistry>();

const normalizeLimit = (value: number | undefined): number =>
  value === undefined || !Number.isFinite(value)
    ? DEFAULT_LIMIT
    : Math.max(0, Math.min(MAX_LIMIT, Math.floor(value)));

type ProjectionTransactionFailure = ProjectionApplicationError | ProjectionReducerReturnedThenable;

type JsonEncodeResult =
  | {
      readonly _tag: "success";
      readonly value: string;
    }
  | {
      readonly _tag: "failure";
      readonly error: ProjectionApplicationError;
    };

const abortProjectionTransaction = (error: ProjectionTransactionFailure): never => {
  // Cloudflare `transactionSync` exposes rollback through synchronous exception only.
  // This helper is the owned adapter boundary; runtime projection algebra returns typed results.
  throw error;
};

const json = (
  projection: AnyMaterializedProjectionDefinition,
  event: LedgerEvent,
  value: unknown,
  label: string,
): JsonEncodeResult => {
  const encoded = JSON.stringify(value);
  if (typeof encoded !== "string") {
    return {
      _tag: "failure",
      error: new ProjectionApplicationError({
        kind: projection.kind,
        eventId: event.id,
        reason: `${label} must be JSON serializable`,
      }),
    };
  }
  return { _tag: "success", value: encoded };
};

export const ensureMaterializedProjectionSchema = (sql: SqlStorage): void => {
  const existingRows = new Set(
    sql
      .exec("PRAGMA table_info(materialized_projection_rows)")
      .toArray()
      .map((row) => String((row as { readonly name?: unknown }).name)),
  );
  if (existingRows.has("scope")) {
    throw new LegacyLedgerSchemaError({
      table: "materialized_projection_rows",
      reason: "legacy scope column is invalid",
    });
  }
  const existingMeta = new Set(
    sql
      .exec("PRAGMA table_info(materialized_projection_meta)")
      .toArray()
      .map((row) => String((row as { readonly name?: unknown }).name)),
  );
  if (existingMeta.has("scope")) {
    throw new LegacyLedgerSchemaError({
      table: "materialized_projection_meta",
      reason: "legacy scope column is invalid",
    });
  }
  sql.exec(`
    CREATE TABLE IF NOT EXISTS materialized_projection_rows (
      projection_key TEXT PRIMARY KEY,
      scope_ref TEXT NOT NULL,
      scope_key TEXT NOT NULL,
      fact_owner_ref TEXT NOT NULL,
      fact_owner_key TEXT NOT NULL,
      effect_authority_ref TEXT NOT NULL,
      effect_authority_key TEXT NOT NULL,
      event_identity_key TEXT NOT NULL,
      kind TEXT NOT NULL,
      identity_key TEXT NOT NULL,
      identity_json TEXT NOT NULL,
      state_json TEXT NOT NULL,
      version INTEGER NOT NULL,
      updated_event_id INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  sql.exec(`
    CREATE INDEX IF NOT EXISTS materialized_projection_rows_identity
      ON materialized_projection_rows (event_identity_key, kind, identity_key)
  `);
  sql.exec(`
    CREATE TABLE IF NOT EXISTS materialized_projection_meta (
      event_identity_key TEXT NOT NULL,
      scope_ref TEXT NOT NULL,
      scope_key TEXT NOT NULL,
      fact_owner_ref TEXT NOT NULL,
      fact_owner_key TEXT NOT NULL,
      effect_authority_ref TEXT NOT NULL,
      effect_authority_key TEXT NOT NULL,
      kind TEXT NOT NULL,
      version INTEGER NOT NULL,
      status TEXT NOT NULL,
      last_applied_event_id INTEGER NOT NULL,
      last_rebuilt_event_id INTEGER,
      updated_at INTEGER,
      PRIMARY KEY (event_identity_key, kind)
    )
  `);
};

export const registerMaterializedProjectionRegistry = (
  sql: SqlStorage,
  registry: ProjectionRegistry,
): void => {
  ensureMaterializedProjectionSchema(sql);
  registries.set(sql, registry);
};

const currentRow = (
  sql: SqlStorage,
  identity: BackendProtocolEventIdentity,
  kind: string,
  identityKey: string,
): { readonly identity: unknown; readonly state: unknown } | null => {
  const projectionKey: BackendProtocolProjectionKey = {
    ...identity,
    projectionKind: kind,
    projectionId: identityKey,
  };
  const columns = projectionIdentityColumns(projectionKey);
  const row = sql
    .exec(
      `
        SELECT identity_json, state_json
        FROM materialized_projection_rows
        WHERE projection_key = ?
      `,
      columns.projection_key,
    )
    .toArray()[0];
  if (row === undefined) return null;
  return {
    identity: JSON.parse(sqlText(row.identity_json, "materialized_projection_rows.identity_json")),
    state: JSON.parse(sqlText(row.state_json, "materialized_projection_rows.state_json")),
  };
};

const touchMeta = (
  sql: SqlStorage,
  projection: AnyMaterializedProjectionDefinition,
  event: LedgerEvent,
): void => {
  const identityColumns = projectionIdentityColumns({
    ...event,
    projectionKind: projection.kind,
    projectionId: "meta",
  });
  sql.exec(
    `
      INSERT INTO materialized_projection_meta
        (
          event_identity_key,
          scope_ref,
          scope_key,
          fact_owner_ref,
          fact_owner_key,
          effect_authority_ref,
          effect_authority_key,
          kind,
          version,
          status,
          last_applied_event_id,
          last_rebuilt_event_id,
          updated_at
        )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'current', ?, NULL, ?)
      ON CONFLICT(event_identity_key, kind) DO UPDATE SET
        version = excluded.version,
        status = 'current',
        last_applied_event_id = excluded.last_applied_event_id,
        updated_at = excluded.updated_at
    `,
    identityColumns.event_identity_key,
    identityColumns.scope_ref,
    identityColumns.scope_key,
    identityColumns.fact_owner_ref,
    identityColumns.fact_owner_key,
    identityColumns.effect_authority_ref,
    identityColumns.effect_authority_key,
    projection.kind,
    projection.version,
    event.id,
    event.ts,
  );
};

const applyEvents = (
  sql: SqlStorage,
  events: ReadonlyArray<LedgerEvent>,
  definitionsForEvent: (eventKind: string) => ReadonlyArray<AnyMaterializedProjectionDefinition>,
): void => {
  if (events.length === 0) return;
  ensureMaterializedProjectionSchema(sql);
  for (const event of events) {
    for (const projection of definitionsForEvent(event.kind)) {
      const applied = applyProjectionEventResult(projection, event, (identityKey) =>
        currentRow(sql, event, projection.kind, identityKey),
      );
      if (applied._tag === "failure") {
        return abortProjectionTransaction(applied.error);
      }
      const result = applied.result;
      if (result._tag === "put") {
        const identityJson = json(projection, event, result.identity, "projection identity");
        if (identityJson._tag === "failure") {
          return abortProjectionTransaction(identityJson.error);
        }
        const stateJson = json(projection, event, result.state, "projection state");
        if (stateJson._tag === "failure") {
          return abortProjectionTransaction(stateJson.error);
        }
        sql.exec(
          `
            INSERT INTO materialized_projection_rows
              (
                projection_key,
                scope_ref,
                scope_key,
                fact_owner_ref,
                fact_owner_key,
                effect_authority_ref,
                effect_authority_key,
                event_identity_key,
                kind,
                identity_key,
                identity_json,
                state_json,
                version,
                updated_event_id,
                updated_at
              )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(projection_key) DO UPDATE SET
              identity_json = excluded.identity_json,
              state_json = excluded.state_json,
              version = excluded.version,
              updated_event_id = excluded.updated_event_id,
              updated_at = excluded.updated_at
          `,
          projectionIdentityColumns({
            ...event,
            projectionKind: projection.kind,
            projectionId: result.identityKey,
          }).projection_key,
          projectionIdentityColumns({
            ...event,
            projectionKind: projection.kind,
            projectionId: result.identityKey,
          }).scope_ref,
          projectionIdentityColumns({
            ...event,
            projectionKind: projection.kind,
            projectionId: result.identityKey,
          }).scope_key,
          projectionIdentityColumns({
            ...event,
            projectionKind: projection.kind,
            projectionId: result.identityKey,
          }).fact_owner_ref,
          projectionIdentityColumns({
            ...event,
            projectionKind: projection.kind,
            projectionId: result.identityKey,
          }).fact_owner_key,
          projectionIdentityColumns({
            ...event,
            projectionKind: projection.kind,
            projectionId: result.identityKey,
          }).effect_authority_ref,
          projectionIdentityColumns({
            ...event,
            projectionKind: projection.kind,
            projectionId: result.identityKey,
          }).effect_authority_key,
          projectionIdentityColumns({
            ...event,
            projectionKind: projection.kind,
            projectionId: result.identityKey,
          }).event_identity_key,
          projection.kind,
          result.identityKey,
          identityJson.value,
          stateJson.value,
          projection.version,
          event.id,
          event.ts,
        );
      } else if (result._tag === "delete") {
        sql.exec(
          `
            DELETE FROM materialized_projection_rows
            WHERE projection_key = ?
          `,
          projectionIdentityColumns({
            ...event,
            projectionKind: projection.kind,
            projectionId: result.identityKey,
          }).projection_key,
        );
      }
      touchMeta(sql, projection, event);
    }
  }
};

export const applyRegisteredMaterializedProjectionEvents = (
  sql: SqlStorage,
  events: ReadonlyArray<LedgerEvent>,
): void => {
  const registry = registries.get(sql);
  if (registry === undefined || registry.size === 0) return;
  applyEvents(sql, events, (eventKind) =>
    Array.from(registry.values()).filter((projection) => projection.eventKinds.includes(eventKind)),
  );
};

const parseProjectionRow = (row: Record<string, unknown>): MaterializedProjectionRow => ({
  kind: sqlText(row.kind, "materialized_projection_rows.kind"),
  scope: sqlText(row.scope_key, "materialized_projection_rows.scope_key"),
  identityKey: sqlText(row.identity_key, "materialized_projection_rows.identity_key"),
  identity: JSON.parse(sqlText(row.identity_json, "materialized_projection_rows.identity_json")),
  state: JSON.parse(sqlText(row.state_json, "materialized_projection_rows.state_json")),
  version: Number(row.version),
  updatedEventId: Number(row.updated_event_id),
  updatedAt: Number(row.updated_at),
});

const statusFromMeta = (
  projection: AnyMaterializedProjectionDefinition,
  identity: BackendProtocolEventIdentity,
  row: Record<string, unknown> | undefined,
): MaterializedProjectionStatus => {
  if (row === undefined) {
    return {
      kind: projection.kind,
      scope: identity.scopeRef.scopeId,
      version: projection.version,
      status: "current",
      lastAppliedEventId: 0,
      lastRebuiltEventId: null,
      updatedAt: null,
    };
  }
  const version = Number(row.version);
  const status = sqlText(row.status, "materialized_projection_meta.status");
  return {
    kind: projection.kind,
    scope: sqlText(row.scope_key, "materialized_projection_meta.scope_key"),
    version: projection.version,
    status: status === "current" && version === projection.version ? "current" : "needs_rebuild",
    lastAppliedEventId: Number(row.last_applied_event_id),
    lastRebuiltEventId:
      row.last_rebuilt_event_id === null || row.last_rebuilt_event_id === undefined
        ? null
        : Number(row.last_rebuilt_event_id),
    updatedAt:
      row.updated_at === null || row.updated_at === undefined ? null : Number(row.updated_at),
  };
};

const projectionStatusSync = (
  sql: SqlStorage,
  projection: AnyMaterializedProjectionDefinition,
  identity: BackendProtocolEventIdentity,
): MaterializedProjectionStatus => {
  ensureMaterializedProjectionSchema(sql);
  const identityColumns = projectionIdentityColumns({
    ...identity,
    projectionKind: projection.kind,
    projectionId: "meta",
  });
  const row = sql
    .exec(
      `
        SELECT *
        FROM materialized_projection_meta
        WHERE event_identity_key = ? AND kind = ?
      `,
      identityColumns.event_identity_key,
      projection.kind,
    )
    .toArray()[0] as Record<string, unknown> | undefined;
  return statusFromMeta(projection, identity, row);
};

const selectProjectionEvents = (
  sql: SqlStorage,
  identity: BackendProtocolEventIdentity,
  eventKinds: ReadonlyArray<string>,
): ReadonlyArray<LedgerEvent> => {
  if (eventKinds.length === 0) return [];
  const placeholders = eventKinds.map(() => "?").join(", ");
  const identityColumns = projectionIdentityColumns({
    ...identity,
    projectionKind: "event-select",
    projectionId: "event-select",
  });
  return sql
    .exec(
      `
        SELECT *
        FROM events
        WHERE event_identity_key = ? AND kind IN (${placeholders})
        ORDER BY id ASC
      `,
      identityColumns.event_identity_key,
      ...eventKinds,
    )
    .toArray()
    .map((row): LedgerEvent => ledgerEventFromRow(row as unknown as LedgerEventSqlRow));
};

const countRows = (sql: SqlStorage, identity: BackendProtocolEventIdentity, kind: string): number =>
  Number(
    sql
      .exec(
        `
          SELECT COUNT(*) AS count
          FROM materialized_projection_rows
          WHERE event_identity_key = ? AND kind = ?
        `,
        projectionIdentityColumns({
          ...identity,
          projectionKind: kind,
          projectionId: "count",
        }).event_identity_key,
        kind,
      )
      .one().count,
  );

export const CloudflareMaterializedProjectionsLive = (
  ctx: DurableObjectState,
): Layer.Layer<MaterializedProjections, SqlError, MaterializedProjectionRegistry> =>
  Layer.effect(
    MaterializedProjections,
    Effect.gen(function* () {
      const sql = ctx.storage.sql;
      const registry = yield* MaterializedProjectionRegistry;
      registerMaterializedProjectionRegistry(sql, registry);
      return {
        get: (spec) =>
          Effect.gen(function* () {
            const projection = yield* getProjection(registry, spec.kind);
            return yield* Effect.try({
              try: () => {
                const eventIdentity = eventIdentityFromQuerySpec(spec, "projection get spec");
                const projectionIdentity = Schema.decodeUnknownSync(projection.identity)(
                  spec.identity,
                );
                const identityKey = projection.identityKey(projectionIdentity);
                const projectionKey = projectionIdentityColumns({
                  ...eventIdentity,
                  projectionKind: spec.kind,
                  projectionId: identityKey,
                }).projection_key;
                const row = sql
                  .exec(
                    `
                      SELECT *
                      FROM materialized_projection_rows
                      WHERE projection_key = ?
                    `,
                    projectionKey,
                  )
                  .toArray()[0] as Record<string, unknown> | undefined;
                return row === undefined ? null : parseProjectionRow(row);
              },
              catch: (cause) => new SqlError({ cause }),
            });
          }),
        list: (spec) =>
          Effect.gen(function* () {
            yield* getProjection(registry, spec.kind);
            return yield* Effect.try({
              try: () => {
                const eventIdentity = eventIdentityFromQuerySpec(spec, "projection list spec");
                const limit = normalizeLimit(spec.limit);
                const identityColumns = projectionIdentityColumns({
                  ...eventIdentity,
                  projectionKind: spec.kind,
                  projectionId: "list",
                });
                const rows =
                  spec.afterKey === undefined
                    ? sql
                        .exec(
                          `
                            SELECT *
                            FROM materialized_projection_rows
                            WHERE scope_key = ? AND effect_authority_key = ? AND kind = ?
                            ORDER BY identity_key ASC
                            LIMIT ?
                          `,
                          identityColumns.scope_key,
                          identityColumns.effect_authority_key,
                          spec.kind,
                          limit,
                        )
                        .toArray()
                    : sql
                        .exec(
                          `
                            SELECT *
                            FROM materialized_projection_rows
                            WHERE scope_key = ? AND effect_authority_key = ? AND kind = ? AND identity_key > ?
                            ORDER BY identity_key ASC
                            LIMIT ?
                          `,
                          identityColumns.scope_key,
                          identityColumns.effect_authority_key,
                          spec.kind,
                          spec.afterKey,
                          limit,
                        )
                        .toArray();
                return rows.map((row) => parseProjectionRow(row as Record<string, unknown>));
              },
              catch: (cause) => new SqlError({ cause }),
            });
          }),
        status: (spec) =>
          Effect.gen(function* () {
            const projection = yield* getProjection(registry, spec.kind);
            return yield* Effect.try({
              try: () =>
                projectionStatusSync(
                  sql,
                  projection,
                  eventIdentityFromQuerySpec(spec, "projection status spec"),
                ),
              catch: (cause) => new SqlError({ cause }),
            });
          }),
        rebuild: (spec) =>
          Effect.gen(function* () {
            const projection = yield* getProjection(registry, spec.kind);
            return yield* Effect.try({
              try: (): MaterializedProjectionRebuildResult =>
                ctx.storage.transactionSync(() => {
                  ensureMaterializedProjectionSchema(sql);
                  const identity = eventIdentityFromQuerySpec(spec, "projection rebuild spec");
                  const identityColumns = projectionIdentityColumns({
                    ...identity,
                    projectionKind: spec.kind,
                    projectionId: "rebuild",
                  });
                  sql.exec(
                    `
                      DELETE FROM materialized_projection_rows
                      WHERE scope_key = ? AND effect_authority_key = ? AND kind = ?
                    `,
                    identityColumns.scope_key,
                    identityColumns.effect_authority_key,
                    spec.kind,
                  );
                  sql.exec(
                    `
                      DELETE FROM materialized_projection_meta
                      WHERE event_identity_key = ? AND kind = ?
                    `,
                    identityColumns.event_identity_key,
                    spec.kind,
                  );
                  const events = selectProjectionEvents(sql, identity, projection.eventKinds);
                  applyEvents(sql, events, (eventKind) =>
                    projection.eventKinds.includes(eventKind) ? [projection] : [],
                  );
                  const lastEventId = events.at(-1)?.id ?? 0;
                  const current = projectionStatusSync(sql, projection, identity);
                  sql.exec(
                    `
                      INSERT INTO materialized_projection_meta
                        (
                          event_identity_key,
                          scope_ref,
                          scope_key,
                          fact_owner_ref,
                          fact_owner_key,
                          effect_authority_ref,
                          effect_authority_key,
                          kind,
                          version,
                          status,
                          last_applied_event_id,
                          last_rebuilt_event_id,
                          updated_at
                        )
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'current', ?, ?, ?)
                      ON CONFLICT(event_identity_key, kind) DO UPDATE SET
                        version = excluded.version,
                        status = 'current',
                        last_applied_event_id = excluded.last_applied_event_id,
                        last_rebuilt_event_id = excluded.last_rebuilt_event_id,
                        updated_at = excluded.updated_at
                    `,
                    identityColumns.event_identity_key,
                    identityColumns.scope_ref,
                    identityColumns.scope_key,
                    identityColumns.fact_owner_ref,
                    identityColumns.fact_owner_key,
                    identityColumns.effect_authority_ref,
                    identityColumns.effect_authority_key,
                    spec.kind,
                    projection.version,
                    current.lastAppliedEventId,
                    lastEventId,
                    current.updatedAt,
                  );
                  return {
                    ...projectionStatusSync(sql, projection, identity),
                    rows: countRows(sql, identity, spec.kind),
                  };
                }),
              catch: (cause) => new SqlError({ cause }),
            });
          }),
      };
    }),
  );
