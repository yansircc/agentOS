import { Clock, Effect, Layer } from "effect";
import {
  Ledger,
  recordLedgerPortEvents,
  runtimeStorageOrJsonError,
  type LedgerPreparedCommitBuilder,
  type LedgerPreparedEventRef,
  type LedgerPreparedEventSpec,
} from "../ledger";
import { RUNTIME_FACT_OWNER } from "@agent-os/core/runtime-protocol";
import type { InMemoryBackendState } from "./state";

type PreparedRecipe = LedgerPreparedEventSpec & {
  readonly ref: LedgerPreparedEventRef;
  readonly id: number;
};

class InMemoryPreparedLedgerCommitBuilder implements LedgerPreparedCommitBuilder {
  private readonly refs = new Map<string, LedgerPreparedEventRef>();
  private readonly ids = new Map<string, number>();
  private readonly appended = new Set<string>();
  private nextAnonymousRef = 0;
  readonly recipes: PreparedRecipe[] = [];

  constructor(private nextId: number) {}

  ref(key: string): LedgerPreparedEventRef {
    const existing = this.refs.get(key);
    if (existing !== undefined) return existing;
    const ref = { key };
    this.refs.set(key, ref);
    return ref;
  }

  append(
    refOrRecipe: LedgerPreparedEventRef | LedgerPreparedEventSpec,
    maybeRecipe?: LedgerPreparedEventSpec,
  ): LedgerPreparedEventRef {
    const ref =
      maybeRecipe === undefined
        ? this.ref(`event:${this.nextAnonymousRef++}`)
        : (refOrRecipe as LedgerPreparedEventRef);
    const recipe =
      maybeRecipe === undefined ? (refOrRecipe as LedgerPreparedEventSpec) : maybeRecipe;
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

  id(ref: LedgerPreparedEventRef): number {
    const id = this.ids.get(ref.key);
    if (id === undefined) throw new TypeError(`unknown ledger event ref: ${ref.key}`);
    return id;
  }
}

export const InMemoryLedgerLive = (state: InMemoryBackendState): Layer.Layer<Ledger> =>
  Layer.succeed(Ledger, {
    commit: (events) =>
      Effect.gen(function* () {
        const ts = yield* Clock.currentTimeMillis;
        const committed = yield* state
          .commitProtocolEvents(
            events.map((event) => ({
              ts,
              kind: event.kind,
              scopeRef: event.scopeRef,
              effectAuthorityRef: event.effectAuthorityRef,
              factOwnerRef: RUNTIME_FACT_OWNER,
              payload: event.payload,
            })),
          )
          .pipe(Effect.mapError((cause) => runtimeStorageOrJsonError("ledger_commit", cause)));
        return yield* recordLedgerPortEvents("ledger_commit", committed);
      }).pipe(Effect.withSpan("agentos.in_memory.ledger.commit")),
    commitPrepared: (build) =>
      Effect.gen(function* () {
        const ts = yield* Clock.currentTimeMillis;
        const committed = yield* state
          .commitProtocolPrepared((nextEventId) => {
            const builder = new InMemoryPreparedLedgerCommitBuilder(nextEventId);
            build(builder);
            return builder.recipes.map((recipe) => ({
              ts: recipe.ts ?? ts,
              kind: recipe.kind,
              scopeRef: recipe.scopeRef,
              effectAuthorityRef: recipe.effectAuthorityRef,
              factOwnerRef: RUNTIME_FACT_OWNER,
              payload:
                recipe.buildPayload === undefined
                  ? recipe.payload
                  : recipe.buildPayload({ id: (ref) => builder.id(ref) }),
            }));
          })
          .pipe(Effect.mapError((cause) => runtimeStorageOrJsonError("ledger_commit", cause)));
        return yield* recordLedgerPortEvents("ledger_commit", committed);
      }).pipe(Effect.withSpan("agentos.in_memory.ledger.commit_prepared")),
    events: (identity, opts = {}) =>
      recordLedgerPortEvents("ledger_events", state.snapshot(identity, opts)).pipe(
        Effect.withSpan("agentos.in_memory.ledger.events"),
      ),
    streamSnapshot: (identity, opts = {}) =>
      recordLedgerPortEvents("ledger_stream_snapshot", state.streamSnapshot(identity, opts)).pipe(
        Effect.withSpan("agentos.in_memory.ledger.stream_snapshot"),
      ),
  });
