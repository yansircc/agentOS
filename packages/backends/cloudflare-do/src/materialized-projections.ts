import { Effect, Layer, Schema } from "effect";
import { SqlError } from "@agent-os/kernel/errors";
import type { LedgerEvent, LedgerEventIdentity } from "@agent-os/kernel/types";
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

const DEFAULT_LIMIT = 1000;
const MAX_LIMIT = 1000;

const registries = new WeakMap<SqlStorage, ProjectionRegistry>();

const rowKey = (
  scope: string,
  kind: string,
  identityKey: string,
): readonly [string, string, string] => [scope, kind, identityKey];

const transitionIdentityFromScope = (scope: string): LedgerEventIdentity => ({
  scopeRef: { kind: "conversation", scopeId: scope },
  factOwnerRef: "@agent-os/transition-unowned",
  effectAuthorityRef: { authorityClass: "legacy-scope", authorityId: scope },
});

const transitionScopeString = (event: LedgerEvent): string => event.scopeRef.scopeId;

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
  sql.exec(`
    CREATE TABLE IF NOT EXISTS materialized_projection_rows (
      scope TEXT NOT NULL,
      kind TEXT NOT NULL,
      identity_key TEXT NOT NULL,
      identity_json TEXT NOT NULL,
      state_json TEXT NOT NULL,
      version INTEGER NOT NULL,
      updated_event_id INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (scope, kind, identity_key)
    )
  `);
  sql.exec(`
    CREATE TABLE IF NOT EXISTS materialized_projection_meta (
      scope TEXT NOT NULL,
      kind TEXT NOT NULL,
      version INTEGER NOT NULL,
      status TEXT NOT NULL,
      last_applied_event_id INTEGER NOT NULL,
      last_rebuilt_event_id INTEGER,
      updated_at INTEGER,
      PRIMARY KEY (scope, kind)
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
  scope: string,
  kind: string,
  identityKey: string,
): { readonly identity: unknown; readonly state: unknown } | null => {
  const [s, k, key] = rowKey(scope, kind, identityKey);
  const row = sql
    .exec(
      `
        SELECT identity_json, state_json
        FROM materialized_projection_rows
        WHERE scope = ? AND kind = ? AND identity_key = ?
      `,
      s,
      k,
      key,
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
  const eventScopeKey = transitionScopeString(event);
  sql.exec(
    `
      INSERT INTO materialized_projection_meta
        (scope, kind, version, status, last_applied_event_id, last_rebuilt_event_id, updated_at)
      VALUES (?, ?, ?, 'current', ?, NULL, ?)
      ON CONFLICT(scope, kind) DO UPDATE SET
        version = excluded.version,
        status = 'current',
        last_applied_event_id = excluded.last_applied_event_id,
        updated_at = excluded.updated_at
    `,
    eventScopeKey,
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
    const eventScopeKey = transitionScopeString(event);
    for (const projection of definitionsForEvent(event.kind)) {
      const applied = applyProjectionEventResult(projection, event, (identityKey) =>
        currentRow(sql, eventScopeKey, projection.kind, identityKey),
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
              (scope, kind, identity_key, identity_json, state_json, version, updated_event_id, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(scope, kind, identity_key) DO UPDATE SET
              identity_json = excluded.identity_json,
              state_json = excluded.state_json,
              version = excluded.version,
              updated_event_id = excluded.updated_event_id,
              updated_at = excluded.updated_at
          `,
          eventScopeKey,
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
            WHERE scope = ? AND kind = ? AND identity_key = ?
          `,
          eventScopeKey,
          projection.kind,
          result.identityKey,
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
  scope: sqlText(row.scope, "materialized_projection_rows.scope"),
  identityKey: sqlText(row.identity_key, "materialized_projection_rows.identity_key"),
  identity: JSON.parse(sqlText(row.identity_json, "materialized_projection_rows.identity_json")),
  state: JSON.parse(sqlText(row.state_json, "materialized_projection_rows.state_json")),
  version: Number(row.version),
  updatedEventId: Number(row.updated_event_id),
  updatedAt: Number(row.updated_at),
});

const statusFromMeta = (
  projection: AnyMaterializedProjectionDefinition,
  scope: string,
  row: Record<string, unknown> | undefined,
): MaterializedProjectionStatus => {
  if (row === undefined) {
    return {
      kind: projection.kind,
      scope,
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
    scope,
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
  scope: string,
): MaterializedProjectionStatus => {
  ensureMaterializedProjectionSchema(sql);
  const row = sql
    .exec(
      `
        SELECT *
        FROM materialized_projection_meta
        WHERE scope = ? AND kind = ?
      `,
      scope,
      projection.kind,
    )
    .toArray()[0] as Record<string, unknown> | undefined;
  return statusFromMeta(projection, scope, row);
};

const selectProjectionEvents = (
  sql: SqlStorage,
  scope: string,
  eventKinds: ReadonlyArray<string>,
): ReadonlyArray<LedgerEvent> => {
  if (eventKinds.length === 0) return [];
  const placeholders = eventKinds.map(() => "?").join(", ");
  return sql
    .exec(
      `
        SELECT *
        FROM events
        WHERE scope = ? AND kind IN (${placeholders})
        ORDER BY id ASC
      `,
      scope,
      ...eventKinds,
    )
    .toArray()
    .map(
      (row): LedgerEvent => ({
        id: Number(row.id),
        ts: Number(row.ts),
        kind: sqlText(row.kind, "events.kind"),
        ...transitionIdentityFromScope(sqlText(row.scope, "events.scope")),
        payload: JSON.parse(sqlText(row.payload, "events.payload")) as unknown,
      }),
    );
};

const countRows = (sql: SqlStorage, scope: string, kind: string): number =>
  Number(
    sql
      .exec(
        `
          SELECT COUNT(*) AS count
          FROM materialized_projection_rows
          WHERE scope = ? AND kind = ?
        `,
        scope,
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
                const identity = Schema.decodeUnknownSync(projection.identity)(spec.identity);
                const identityKey = projection.identityKey(identity);
                const row = sql
                  .exec(
                    `
                      SELECT *
                      FROM materialized_projection_rows
                      WHERE scope = ? AND kind = ? AND identity_key = ?
                    `,
                    spec.scope,
                    spec.kind,
                    identityKey,
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
                const limit = normalizeLimit(spec.limit);
                const rows =
                  spec.afterKey === undefined
                    ? sql
                        .exec(
                          `
                            SELECT *
                            FROM materialized_projection_rows
                            WHERE scope = ? AND kind = ?
                            ORDER BY identity_key ASC
                            LIMIT ?
                          `,
                          spec.scope,
                          spec.kind,
                          limit,
                        )
                        .toArray()
                    : sql
                        .exec(
                          `
                            SELECT *
                            FROM materialized_projection_rows
                            WHERE scope = ? AND kind = ? AND identity_key > ?
                            ORDER BY identity_key ASC
                            LIMIT ?
                          `,
                          spec.scope,
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
              try: () => projectionStatusSync(sql, projection, spec.scope),
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
                  sql.exec(
                    `
                      DELETE FROM materialized_projection_rows
                      WHERE scope = ? AND kind = ?
                    `,
                    spec.scope,
                    spec.kind,
                  );
                  sql.exec(
                    `
                      DELETE FROM materialized_projection_meta
                      WHERE scope = ? AND kind = ?
                    `,
                    spec.scope,
                    spec.kind,
                  );
                  const events = selectProjectionEvents(sql, spec.scope, projection.eventKinds);
                  applyEvents(sql, events, (eventKind) =>
                    projection.eventKinds.includes(eventKind) ? [projection] : [],
                  );
                  const lastEventId = events.at(-1)?.id ?? 0;
                  const current = projectionStatusSync(sql, projection, spec.scope);
                  sql.exec(
                    `
                      INSERT INTO materialized_projection_meta
                        (scope, kind, version, status, last_applied_event_id, last_rebuilt_event_id, updated_at)
                      VALUES (?, ?, ?, 'current', ?, ?, ?)
                      ON CONFLICT(scope, kind) DO UPDATE SET
                        version = excluded.version,
                        status = 'current',
                        last_applied_event_id = excluded.last_applied_event_id,
                        last_rebuilt_event_id = excluded.last_rebuilt_event_id,
                        updated_at = excluded.updated_at
                    `,
                    spec.scope,
                    spec.kind,
                    projection.version,
                    current.lastAppliedEventId,
                    lastEventId,
                    current.updatedAt,
                  );
                  return {
                    ...projectionStatusSync(sql, projection, spec.scope),
                    rows: countRows(sql, spec.scope, spec.kind),
                  };
                }),
              catch: (cause) => new SqlError({ cause }),
            });
          }),
      };
    }),
  );
