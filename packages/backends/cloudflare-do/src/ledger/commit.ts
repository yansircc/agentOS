import type { LedgerEvent, LedgerEventIdentity } from "@agent-os/kernel/types";
import { JsonStringifyError, SqlError } from "@agent-os/kernel/errors";
import { Effect } from "effect";
import { applyRegisteredMaterializedProjectionEvents } from "../materialized-projections";
import type { EventBusService } from "./event-bus";

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
  readonly scope: string;
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

export const ensureLedgerSchema = (sql: SqlStorage): void => {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY,
      ts INTEGER NOT NULL,
      kind TEXT NOT NULL,
      scope TEXT NOT NULL,
      payload TEXT NOT NULL
    )
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

const encodePayload = (payload: unknown): string => {
  try {
    const encoded = JSON.stringify(payload);
    if (typeof encoded !== "string") {
      throw new TypeError("ledger event payload must be JSON serializable");
    }
    return encoded;
  } catch (cause) {
    throw new JsonStringifyError({ cause });
  }
};

const transitionIdentityFromScope = (scope: string): LedgerEventIdentity => ({
  scopeRef: { kind: "conversation", scopeId: scope },
  factOwnerRef: "@agent-os/transition-unowned",
  effectAuthorityRef: { authorityClass: "legacy-scope", authorityId: scope },
});

const asEffectError = <E>(
  cause: unknown,
  classify?: (cause: unknown) => E | null,
): SqlError | JsonStringifyError | E => {
  if (cause instanceof JsonStringifyError) return cause;
  const classified = classify?.(cause);
  return classified ?? new SqlError({ cause });
};

export const commitLedgerTransaction = <A, E = never>(
  storage: DurableObjectState,
  bus: EventBusService,
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
            const payload =
              recipe.buildPayload === undefined
                ? recipe.payload
                : recipe.buildPayload({ id: idOf });
            const event: LedgerEvent = {
              id: recipe.id,
              ts: recipe.ts,
              kind: recipe.kind,
              ...transitionIdentityFromScope(recipe.scope),
              payload,
            };
            byRef.set(recipe.ref.key, event);
            return event;
          });
          const encoded = events.map((event) => encodePayload(event.payload));
          for (let index = 0; index < events.length; index++) {
            const event = events[index]!;
            const recipe = builder.recipes[index]!;
            sql.exec(
              "INSERT INTO events (id, ts, kind, scope, payload) VALUES (?, ?, ?, ?, ?)",
              event.id,
              event.ts,
              event.kind,
              recipe.scope,
              encoded[index]!,
            );
          }
          const context: LedgerCommitContext = {
            events,
            id: idOf,
            event: (ref) => {
              const event = byRef.get(ref.key);
              if (event === undefined) throw new TypeError(`unknown ledger event ref: ${ref.key}`);
              return event;
            },
          };
          for (const effect of builder.sideEffects) effect(context);
          applyRegisteredMaterializedProjectionEvents(sql, events);
          return {
            value,
            events,
            id: context.id,
            event: context.event,
          };
        }),
      catch: (cause) => asEffectError(cause, classifyBuildError),
    });
    yield* bus.fireMany(committed.events);
    return committed;
  });
