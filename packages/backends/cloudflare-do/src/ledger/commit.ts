import type { FactOwnerRef } from "@agent-os/kernel/effect-claim";
import type { LedgerEvent } from "@agent-os/kernel/types";
import { JsonStringifyError, SqlError } from "@agent-os/kernel/errors";
import { Effect } from "effect";
import { assertRuntimeLedgerTransitions, RUNTIME_FACT_OWNER } from "@agent-os/runtime-protocol";
import { applyRegisteredMaterializedProjectionEvents } from "../materialized-projections";
import type { EventBusService } from "./event-bus";
import {
  LegacyLedgerSchemaError,
  assertNoFactOwnerOverride,
  eventIdentity,
  eventIdentityColumns,
  ledgerEventFromRow,
  truthIdentityFromCommitSpec,
  type LedgerEventSqlRow,
} from "./identity";
import type { BackendProtocolTruthIdentity } from "@agent-os/backend-protocol";

export type LedgerEventRef = {
  readonly key: string;
};

export type LedgerPayloadContext = {
  readonly id: (ref: LedgerEventRef) => number;
};

export type LedgerCommitContext = LedgerPayloadContext & {
  readonly event: (ref: LedgerEventRef) => LedgerEvent;
  readonly events: ReadonlyArray<LedgerEvent>;
};

export type LedgerEventPayloadBuilder = (context: LedgerPayloadContext) => unknown;

type LedgerEventRecipeBase = {
  readonly ts: number;
  readonly kind: string;
  readonly scopeRef: BackendProtocolTruthIdentity["scopeRef"];
  readonly effectAuthorityRef: BackendProtocolTruthIdentity["effectAuthorityRef"];
  readonly scope?: never;
  readonly factOwnerRef?: never;
};

export type LedgerEventRecipe =
  | (LedgerEventRecipeBase & {
      readonly payload: unknown;
      readonly buildPayload?: never;
    })
  | (LedgerEventRecipeBase & {
      readonly payload?: never;
      readonly buildPayload: LedgerEventPayloadBuilder;
    });

type InternalRecipe = LedgerEventRecipe & {
  readonly ref: LedgerEventRef;
  readonly id: number;
};

export type LedgerTransactionBuilder = {
  readonly ref: (key: string) => LedgerEventRef;
  readonly id: (ref: LedgerEventRef) => number;
  readonly append: {
    (recipe: LedgerEventRecipe): LedgerEventRef;
    (ref: LedgerEventRef, recipe: LedgerEventRecipe): LedgerEventRef;
  };
  readonly afterInsert: (effect: (context: LedgerCommitContext) => void) => void;
};

export type LedgerCommitResult<A> = {
  readonly value: A;
  readonly events: ReadonlyArray<LedgerEvent>;
  readonly id: (ref: LedgerEventRef) => number;
  readonly event: (ref: LedgerEventRef) => LedgerEvent;
};

class LedgerCommitBuilderImpl implements LedgerTransactionBuilder {
  private readonly refs = new Map<string, LedgerEventRef>();
  private readonly ids = new Map<string, number>();
  readonly recipes: InternalRecipe[] = [];
  readonly sideEffects: Array<(context: LedgerCommitContext) => void> = [];
  private nextAnonymousRef = 0;
  private readonly appended = new Set<string>();

  constructor(private nextId: number) {}

  ref(key: string): LedgerEventRef {
    const existing = this.refs.get(key);
    if (existing !== undefined) return existing;
    const ref = { key };
    this.refs.set(key, ref);
    return ref;
  }

  append(
    refOrRecipe: LedgerEventRef | LedgerEventRecipe,
    maybeRecipe?: LedgerEventRecipe,
  ): LedgerEventRef {
    const ref =
      maybeRecipe === undefined
        ? this.ref(`event:${this.nextAnonymousRef++}`)
        : (refOrRecipe as LedgerEventRef);
    const recipe = maybeRecipe === undefined ? (refOrRecipe as LedgerEventRecipe) : maybeRecipe;
    if (this.appended.has(ref.key)) {
      throw new TypeError(`ledger event ref already appended: ${ref.key}`);
    }
    this.appended.add(ref.key);
    const id = this.nextId;
    this.nextId += 1;
    this.ids.set(ref.key, id);
    this.recipes.push({ ...recipe, ref, id });
    return ref;
  }

  afterInsert(effect: (context: LedgerCommitContext) => void): void {
    this.sideEffects.push(effect);
  }

  id(ref: LedgerEventRef): number {
    const id = this.ids.get(ref.key);
    if (id === undefined) throw new TypeError(`unknown ledger event ref: ${ref.key}`);
    return id;
  }

  sequenceNextId(): number {
    return this.nextId;
  }
}

const tableColumns = (sql: SqlStorage, table: string): ReadonlySet<string> =>
  new Set(
    sql
      .exec(`PRAGMA table_info(${table})`)
      .toArray()
      .map((row) => String((row as { readonly name?: unknown }).name)),
  );

const ensureNoLegacyLedgerSchema = (columns: ReadonlySet<string>): void => {
  if (columns.has("scope")) {
    throw new LegacyLedgerSchemaError({
      table: "events",
      reason: "legacy scope column is invalid",
    });
  }
  const required = [
    "id",
    "ts",
    "kind",
    "scope_ref",
    "scope_key",
    "fact_owner_ref",
    "fact_owner_key",
    "effect_authority_ref",
    "effect_authority_key",
    "event_identity_key",
    "payload",
  ];
  for (const column of required) {
    if (!columns.has(column)) {
      throw new LegacyLedgerSchemaError({
        table: "events",
        reason: `missing identity column ${column}`,
      });
    }
  }
};

export const ensureLedgerSchema = (sql: SqlStorage): void => {
  const eventColumns = tableColumns(sql, "events");
  if (eventColumns.size > 0) {
    ensureNoLegacyLedgerSchema(eventColumns);
  }
  sql.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY,
      ts INTEGER NOT NULL,
      kind TEXT NOT NULL,
      scope_ref TEXT NOT NULL,
      scope_key TEXT NOT NULL,
      fact_owner_ref TEXT NOT NULL,
      fact_owner_key TEXT NOT NULL,
      effect_authority_ref TEXT NOT NULL,
      effect_authority_key TEXT NOT NULL,
      event_identity_key TEXT NOT NULL,
      payload TEXT NOT NULL
    )
  `);
  sql.exec(`
    CREATE INDEX IF NOT EXISTS events_truth_lookup
      ON events (scope_key, effect_authority_key, id)
  `);
  sql.exec(`
    CREATE INDEX IF NOT EXISTS events_owner_lookup
      ON events (event_identity_key, id)
  `);
  sql.exec(`
    CREATE TABLE IF NOT EXISTS ledger_sequences (
      name TEXT PRIMARY KEY,
      next_id INTEGER NOT NULL
    )
  `);
};

const nextEventId = (sql: SqlStorage): number => {
  const existing = sql
    .exec("SELECT next_id FROM ledger_sequences WHERE name = ?", "events")
    .toArray()[0] as { readonly next_id?: unknown } | undefined;
  if (existing !== undefined) return Number(existing.next_id);
  const maxRow = sql.exec("SELECT COALESCE(MAX(id), 0) AS max_id FROM events").one() as {
    readonly max_id?: unknown;
  };
  const nextId = Number(maxRow.max_id) + 1;
  sql.exec("INSERT INTO ledger_sequences (name, next_id) VALUES (?, ?)", "events", nextId);
  return nextId;
};

const commitAllocatedEventIds = (sql: SqlStorage, nextId: number): void => {
  sql.exec("UPDATE ledger_sequences SET next_id = ? WHERE name = ?", nextId, "events");
};

export const canonicalLedgerPayload = (
  payload: unknown,
): { readonly encoded: string; readonly payload: unknown } => {
  try {
    const encoded = JSON.stringify(payload);
    if (typeof encoded !== "string") {
      throw new TypeError("ledger event payload must be JSON serializable");
    }
    return { encoded, payload: JSON.parse(encoded) as unknown };
  } catch (cause) {
    throw new JsonStringifyError({ cause });
  }
};

const asEffectError = <E>(
  cause: unknown,
  classify?: (cause: unknown) => E | null,
): SqlError | JsonStringifyError | E => {
  if (cause instanceof JsonStringifyError) return cause;
  const classified = classify?.(cause);
  return classified ?? new SqlError({ cause });
};

interface RuntimeTransitionEventGroup {
  readonly scopeKey: string;
  readonly effectAuthorityKey: string;
  readonly events: LedgerEvent[];
  hasRuntimeEvent: boolean;
}

const groupRuntimeTransitionEventsByTruthIdentityKey = (
  events: ReadonlyArray<LedgerEvent>,
): ReadonlyArray<RuntimeTransitionEventGroup> => {
  const groups = new Map<string, RuntimeTransitionEventGroup>();
  for (const event of events) {
    const columns = eventIdentityColumns(event);
    const key = `${columns.scope_key}\n${columns.effect_authority_key}`;
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, {
        scopeKey: columns.scope_key,
        effectAuthorityKey: columns.effect_authority_key,
        events: [event],
        hasRuntimeEvent: event.factOwnerRef === RUNTIME_FACT_OWNER,
      });
    } else {
      group.events.push(event);
      group.hasRuntimeEvent ||= event.factOwnerRef === RUNTIME_FACT_OWNER;
    }
  }
  return Array.from(groups.values()).filter((group) => group.hasRuntimeEvent);
};

const selectPriorEventsForTruthIdentityKey = (
  sql: SqlStorage,
  group: RuntimeTransitionEventGroup,
): ReadonlyArray<LedgerEvent> =>
  sql
    .exec(
      `
        SELECT *
        FROM events
        WHERE scope_key = ? AND effect_authority_key = ?
        ORDER BY id ASC
      `,
      group.scopeKey,
      group.effectAuthorityKey,
    )
    .toArray()
    .map((row): LedgerEvent => ledgerEventFromRow(row as unknown as LedgerEventSqlRow));

const assertRuntimeLedgerTransitionBatch = (
  sql: SqlStorage,
  events: ReadonlyArray<LedgerEvent>,
): void => {
  for (const group of groupRuntimeTransitionEventsByTruthIdentityKey(events)) {
    assertRuntimeLedgerTransitions({
      history: selectPriorEventsForTruthIdentityKey(sql, group),
      events: group.events,
    });
  }
};

export const commitLedgerTransaction = <A, E = never>(
  storage: DurableObjectState,
  bus: EventBusService,
  owner: { readonly factOwnerRef: FactOwnerRef },
  build: (tx: LedgerTransactionBuilder) => A,
  classifyBuildError?: (cause: unknown) => E | null,
): Effect.Effect<LedgerCommitResult<A>, SqlError | JsonStringifyError | E> =>
  Effect.gen(function* () {
    const sql = storage.storage.sql;
    const committed = yield* Effect.try({
      try: () =>
        storage.storage.transactionSync(() => {
          ensureLedgerSchema(sql);
          const builder = new LedgerCommitBuilderImpl(nextEventId(sql));
          const value = build(builder);
          commitAllocatedEventIds(sql, builder.sequenceNextId());
          const byRef = new Map<string, LedgerEvent>();
          const idOf = (ref: LedgerEventRef): number => {
            const event = byRef.get(ref.key);
            return event === undefined ? builder.id(ref) : event.id;
          };
          const events = builder.recipes.map((recipe): LedgerEvent => {
            assertNoFactOwnerOverride(recipe, "ledger event recipe");
            const truthIdentity = truthIdentityFromCommitSpec(recipe, "ledger event recipe");
            const payload =
              recipe.buildPayload === undefined
                ? recipe.payload
                : recipe.buildPayload({ id: idOf });
            const event: LedgerEvent = {
              id: recipe.id,
              ts: recipe.ts,
              kind: recipe.kind,
              ...eventIdentity(truthIdentity, owner.factOwnerRef),
              payload,
            };
            byRef.set(recipe.ref.key, event);
            return event;
          });
          const encoded = events.map((event) => canonicalLedgerPayload(event.payload));
          const committedEvents = events.map((event, index): LedgerEvent => {
            const committed = { ...event, payload: encoded[index]!.payload };
            byRef.set(builder.recipes[index]!.ref.key, committed);
            return committed;
          });
          assertRuntimeLedgerTransitionBatch(sql, committedEvents);
          for (let index = 0; index < events.length; index++) {
            const event = committedEvents[index]!;
            const identityColumns = eventIdentityColumns(event);
            sql.exec(
              `
                INSERT INTO events (
                  id,
                  ts,
                  kind,
                  scope_ref,
                  scope_key,
                  fact_owner_ref,
                  fact_owner_key,
                  effect_authority_ref,
                  effect_authority_key,
                  event_identity_key,
                  payload
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              `,
              event.id,
              event.ts,
              event.kind,
              identityColumns.scope_ref,
              identityColumns.scope_key,
              identityColumns.fact_owner_ref,
              identityColumns.fact_owner_key,
              identityColumns.effect_authority_ref,
              identityColumns.effect_authority_key,
              identityColumns.event_identity_key,
              encoded[index]!.encoded,
            );
          }
          const context: LedgerCommitContext = {
            events: committedEvents,
            id: idOf,
            event: (ref) => {
              const event = byRef.get(ref.key);
              if (event === undefined) throw new TypeError(`unknown ledger event ref: ${ref.key}`);
              return event;
            },
          };
          for (const effect of builder.sideEffects) effect(context);
          applyRegisteredMaterializedProjectionEvents(sql, committedEvents);
          return {
            value,
            events: committedEvents,
            id: context.id,
            event: context.event,
          };
        }),
      catch: (cause) => asEffectError(cause, classifyBuildError),
    });
    yield* bus.fireMany(committed.events);
    return committed;
  });
