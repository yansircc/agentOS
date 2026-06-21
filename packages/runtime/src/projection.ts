import { Context, Data, Duration, Effect, Result, Schema } from "effect";
import {
  scopeRefKey,
  type AuthorityRef,
  type FactOwnerRef,
  type ScopeRef,
} from "@agent-os/core/effect-claim";
import type { LedgerEvent } from "@agent-os/core/types";
import type { RuntimeStorageError } from "./ledger";

export type ProjectionStatus = "current" | "needs_rebuild";

export interface ProjectionIdentifyOk<Identity> {
  readonly _tag: "identity";
  readonly identity: Identity;
}

export interface ProjectionIdentifySkip {
  readonly _tag: "skip";
}

export interface ProjectionIdentifyMalformed {
  readonly _tag: "malformed";
  readonly reason: string;
}

/**
 * Event-to-projection identity decision made before reduction.
 *
 * @agentosPrimitive primitive.runtime.ProjectionIdentifyResult
 * @agentosInvariant invariant.d10.truth-identity
 * @agentosDocs docs/concepts/materialized-projections.md
 * @public
 */
export type ProjectionIdentifyResult<Identity> =
  | ProjectionIdentifyOk<Identity>
  | ProjectionIdentifySkip
  | ProjectionIdentifyMalformed;

export const projectionIdentity = <Identity>(
  identity: Identity,
): ProjectionIdentifyResult<Identity> => ({ _tag: "identity", identity });

export const projectionSkip = <Identity = never>(): ProjectionIdentifyResult<Identity> => ({
  _tag: "skip",
});

export const projectionMalformed = <Identity = never>(
  reason: string,
): ProjectionIdentifyResult<Identity> => ({
  _tag: "malformed",
  reason,
});

export interface ProjectionPut<State> {
  readonly _tag: "put";
  readonly state: State;
}

export interface ProjectionDelete {
  readonly _tag: "delete";
}

export interface ProjectionKeep {
  readonly _tag: "keep";
}

export interface ProjectionFail {
  readonly _tag: "fail";
  readonly reason: string;
}

/**
 * Synchronous reducer result for one materialized projection row.
 *
 * @agentosPrimitive primitive.runtime.ProjectionReduceResult
 * @agentosInvariant invariant.d10.truth-identity
 * @agentosDocs docs/concepts/materialized-projections.md
 * @public
 */
export type ProjectionReduceResult<State> =
  | ProjectionPut<State>
  | ProjectionDelete
  | ProjectionKeep
  | ProjectionFail;

export const projectionPut = <State>(state: State): ProjectionReduceResult<State> => ({
  _tag: "put",
  state,
});

export const projectionDelete = <State = never>(): ProjectionReduceResult<State> => ({
  _tag: "delete",
});

export const projectionKeep = <State = never>(): ProjectionReduceResult<State> => ({
  _tag: "keep",
});

export const projectionFail = <State = never>(reason: string): ProjectionReduceResult<State> => ({
  _tag: "fail",
  reason,
});

/**
 * Canonical projection reduction context derived from the consumed ledger event.
 *
 * @agentosPrimitive primitive.runtime.ProjectionReduceContext
 * @agentosInvariant invariant.d10.truth-identity
 * @agentosDocs docs/concepts/materialized-projections.md
 * @public
 */
export interface ProjectionReduceContext<Identity> {
  readonly scopeRef: ScopeRef;
  readonly scopeKey: string;
  readonly identity: Identity;
  readonly identityKey: string;
}

/**
 * Pure materialized projection definition over ledger facts.
 *
 * @agentosPrimitive primitive.runtime.MaterializedProjectionDefinition
 * @agentosInvariant invariant.d10.truth-identity
 * @agentosDocs docs/concepts/materialized-projections.md
 * @public
 */
export interface MaterializedProjectionDefinition<Identity, State> {
  readonly kind: string;
  readonly version: number;
  readonly eventKinds: ReadonlyArray<string>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly identity: Schema.Codec<Identity, any, never, never>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly state: Schema.Codec<State, any, never, never>;
  readonly identityKey: (identity: Identity) => string;
  readonly identify: (event: LedgerEvent) => ProjectionIdentifyResult<Identity>;
  readonly initial: (identity: Identity, event: LedgerEvent) => State;
  readonly reduce: (
    state: State,
    event: LedgerEvent,
    ctx: ProjectionReduceContext<Identity>,
  ) => ProjectionReduceResult<State>;
}

export type AnyMaterializedProjectionDefinition = MaterializedProjectionDefinition<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  any
>;

/**
 * Defines one materialized projection without adding a second truth source.
 *
 * @agentosPrimitive primitive.runtime.defineProjection
 * @agentosInvariant invariant.d10.truth-identity
 * @agentosDocs docs/concepts/materialized-projections.md
 * @public
 */
export const defineProjection = <Identity, State>(
  spec: MaterializedProjectionDefinition<Identity, State>,
): MaterializedProjectionDefinition<Identity, State> => spec;

export type ProjectionRegistry = ReadonlyMap<string, AnyMaterializedProjectionDefinition>;

export class MaterializedProjectionRegistry extends Context.Service<
  MaterializedProjectionRegistry,
  ProjectionRegistry
>()("@agent-os/MaterializedProjectionRegistry") {}

export class ProjectionRegistryError extends Data.TaggedError(
  "agent_os.projection_registry_error",
)<{
  readonly reason: string;
  readonly kind?: string;
}> {}

export type ProjectionRegistryBuildResult =
  | {
      readonly _tag: "success";
      readonly registry: ProjectionRegistry;
    }
  | {
      readonly _tag: "failure";
      readonly error: ProjectionRegistryError;
    };

export class UnregisteredProjectionKind extends Data.TaggedError(
  "agent_os.unregistered_projection_kind",
)<{
  readonly kind: string;
}> {}

export class ProjectionApplicationError extends Data.TaggedError(
  "agent_os.projection_application_error",
)<{
  readonly kind: string;
  readonly eventId: number;
  readonly reason: string;
  readonly cause?: unknown;
}> {}

export class ProjectionReducerReturnedThenable extends Data.TaggedError(
  "agent_os.projection_reducer_returned_thenable",
)<{
  readonly kind: string;
  readonly eventId: number;
}> {}

export interface MaterializedProjectionRow<Identity = unknown, State = unknown> {
  readonly kind: string;
  readonly scope: string;
  readonly identityKey: string;
  readonly identity: Identity;
  readonly state: State;
  readonly version: number;
  readonly updatedEventId: number;
  readonly updatedAt: number;
}

export interface MaterializedProjectionStatus {
  readonly kind: string;
  readonly scope: string;
  readonly version: number;
  readonly status: ProjectionStatus;
  readonly lastAppliedEventId: number;
  readonly lastRebuiltEventId: number | null;
  readonly updatedAt: number | null;
}

export interface MaterializedProjectionRebuildResult extends MaterializedProjectionStatus {
  readonly rows: number;
}

export interface MaterializedProjectionEventIdentity {
  readonly scopeRef: ScopeRef;
  readonly effectAuthorityRef: AuthorityRef;
  readonly factOwnerRef: FactOwnerRef;
  readonly scope?: never;
}

export interface MaterializedProjectionGetSpec {
  readonly kind: string;
  readonly scopeRef: ScopeRef;
  readonly effectAuthorityRef: AuthorityRef;
  readonly factOwnerRef: FactOwnerRef;
  readonly identity: unknown;
}

export interface MaterializedProjectionListSpec {
  readonly kind: string;
  readonly scopeRef: ScopeRef;
  readonly effectAuthorityRef: AuthorityRef;
  readonly factOwnerRef: FactOwnerRef;
  readonly limit?: number;
  readonly afterKey?: string;
}

/**
 * Backend-neutral service for projection reads, status, and rebuild.
 *
 * @agentosPrimitive primitive.runtime.MaterializedProjections
 * @agentosInvariant invariant.d10.truth-identity
 * @agentosDocs docs/concepts/materialized-projections.md
 * @public
 */
export class MaterializedProjections extends Context.Service<
  MaterializedProjections,
  {
    readonly get: (
      spec: MaterializedProjectionGetSpec,
    ) => Effect.Effect<
      MaterializedProjectionRow | null,
      RuntimeStorageError | UnregisteredProjectionKind
    >;
    readonly list: (
      spec: MaterializedProjectionListSpec,
    ) => Effect.Effect<
      ReadonlyArray<MaterializedProjectionRow>,
      RuntimeStorageError | UnregisteredProjectionKind
    >;
    readonly status: (
      spec: MaterializedProjectionEventIdentity & { readonly kind: string },
    ) => Effect.Effect<
      MaterializedProjectionStatus,
      RuntimeStorageError | UnregisteredProjectionKind
    >;
    readonly rebuild: (
      spec: MaterializedProjectionEventIdentity & { readonly kind: string },
    ) => Effect.Effect<
      MaterializedProjectionRebuildResult,
      | RuntimeStorageError
      | UnregisteredProjectionKind
      | ProjectionApplicationError
      | ProjectionReducerReturnedThenable
    >;
  }
>()("@agent-os/MaterializedProjections") {}

export interface ProjectionWaitSpec<
  Identity = unknown,
  State = unknown,
> extends MaterializedProjectionGetSpec {
  readonly ready?: (row: MaterializedProjectionRow<Identity, State>) => boolean;
  readonly maxAttempts?: number;
  readonly pollIntervalMs?: number;
}

export class ProjectionWaitTimedOut extends Data.TaggedError("agent_os.projection_wait_timed_out")<{
  readonly projectionKind: string;
  readonly maxAttempts: number;
  readonly reason: "missing" | "not_ready";
  readonly lastObservedEventId?: number;
}> {}

const DEFAULT_PROJECTION_WAIT_MAX_ATTEMPTS = 20;
const DEFAULT_PROJECTION_WAIT_POLL_INTERVAL_MS = 50;

const positiveIntegerOr = (value: number | undefined, fallback: number): number =>
  Number.isInteger(value) && value !== undefined && value > 0 ? value : fallback;

const nonNegativeIntegerOr = (value: number | undefined, fallback: number): number =>
  Number.isInteger(value) && value !== undefined && value >= 0 ? value : fallback;

/**
 * Waits until a ledger-derived projection row exists and satisfies an optional
 * pure readiness predicate.
 *
 * @agentosPrimitive primitive.runtime.waitForProjection
 * @agentosInvariant invariant.d10.truth-identity
 * @agentosDocs docs/concepts/materialized-projections.md
 * @public
 */
export const waitForProjection = <Identity = unknown, State = unknown>(
  spec: ProjectionWaitSpec<Identity, State>,
): Effect.Effect<
  MaterializedProjectionRow<Identity, State>,
  RuntimeStorageError | UnregisteredProjectionKind | ProjectionWaitTimedOut,
  MaterializedProjections
> =>
  Effect.withSpan("agentos.runtime.projection.wait")(
    Effect.gen(function* () {
      const projections = yield* MaterializedProjections;
      const maxAttempts = positiveIntegerOr(spec.maxAttempts, DEFAULT_PROJECTION_WAIT_MAX_ATTEMPTS);
      const pollIntervalMs = nonNegativeIntegerOr(
        spec.pollIntervalMs,
        DEFAULT_PROJECTION_WAIT_POLL_INTERVAL_MS,
      );

      const loop = (
        attempt: number,
      ): Effect.Effect<
        MaterializedProjectionRow<Identity, State>,
        RuntimeStorageError | UnregisteredProjectionKind | ProjectionWaitTimedOut
      > =>
        Effect.gen(function* () {
          const row = (yield* projections.get(spec)) as MaterializedProjectionRow<
            Identity,
            State
          > | null;
          if (row !== null && (spec.ready === undefined || spec.ready(row))) return row;
          if (attempt >= maxAttempts) {
            return yield* new ProjectionWaitTimedOut({
              projectionKind: spec.kind,
              maxAttempts,
              reason: row === null ? "missing" : "not_ready",
              ...(row === null ? {} : { lastObservedEventId: row.updatedEventId }),
            });
          }
          if (pollIntervalMs > 0) {
            yield* Effect.sleep(Duration.millis(pollIntervalMs));
          }
          return yield* loop(attempt + 1);
        });

      return yield* loop(1);
    }),
  );

const projectionRegistrySuccess = (
  registry: ProjectionRegistry,
): ProjectionRegistryBuildResult => ({
  _tag: "success",
  registry,
});

const projectionRegistryFailure = (
  error: ProjectionRegistryError,
): ProjectionRegistryBuildResult => ({
  _tag: "failure",
  error,
});

export const makeProjectionRegistryResult = (
  projections: Iterable<AnyMaterializedProjectionDefinition>,
): ProjectionRegistryBuildResult => {
  const registry = new Map<string, AnyMaterializedProjectionDefinition>();
  for (const projection of projections) {
    if (projection.kind.trim().length === 0) {
      return projectionRegistryFailure(
        new ProjectionRegistryError({ reason: "projection kind is required" }),
      );
    }
    if (!Number.isInteger(projection.version) || projection.version <= 0) {
      return projectionRegistryFailure(
        new ProjectionRegistryError({
          kind: projection.kind,
          reason: "projection version must be a positive integer",
        }),
      );
    }
    if (projection.eventKinds.length === 0) {
      return projectionRegistryFailure(
        new ProjectionRegistryError({
          kind: projection.kind,
          reason: "projection eventKinds must be non-empty",
        }),
      );
    }
    if (new Set(projection.eventKinds).size !== projection.eventKinds.length) {
      return projectionRegistryFailure(
        new ProjectionRegistryError({
          kind: projection.kind,
          reason: "projection eventKinds must not contain duplicates",
        }),
      );
    }
    if (registry.has(projection.kind)) {
      return projectionRegistryFailure(
        new ProjectionRegistryError({
          kind: projection.kind,
          reason: "duplicate projection kind",
        }),
      );
    }
    registry.set(projection.kind, projection);
  }
  return projectionRegistrySuccess(registry);
};

export const makeProjectionRegistry = (
  projections: Iterable<AnyMaterializedProjectionDefinition>,
): Effect.Effect<ProjectionRegistry, ProjectionRegistryError> =>
  Effect.withSpan("agentos.runtime.projection.make_registry")(
    Effect.suspend(() => {
      const result = makeProjectionRegistryResult(projections);
      return result._tag === "success"
        ? Effect.succeed(result.registry)
        : Effect.fail(result.error);
    }),
  );

export const getProjection = (
  registry: ProjectionRegistry,
  kind: string,
): Effect.Effect<AnyMaterializedProjectionDefinition, UnregisteredProjectionKind> => {
  const projection = registry.get(kind);
  return projection === undefined
    ? Effect.fail(new UnregisteredProjectionKind({ kind }))
    : Effect.succeed(projection).pipe(Effect.withSpan("agentos.runtime.projection.get"));
};

const isThenable = (value: unknown): boolean =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { readonly then?: unknown }).then === "function";

export interface ProjectionCurrentRow {
  readonly identity: unknown;
  readonly state: unknown;
}

export type ProjectionCurrentLookup = (identityKey: string) => ProjectionCurrentRow | null;

export type ProjectionApplyResult =
  | {
      readonly _tag: "skip";
    }
  | {
      readonly _tag: "delete";
      readonly identity: unknown;
      readonly identityKey: string;
    }
  | {
      readonly _tag: "put";
      readonly identity: unknown;
      readonly identityKey: string;
      readonly state: unknown;
    };

export type ProjectionApplyEventResult =
  | {
      readonly _tag: "success";
      readonly result: ProjectionApplyResult;
    }
  | {
      readonly _tag: "failure";
      readonly error: ProjectionApplicationError | ProjectionReducerReturnedThenable;
    };

const projectionApplySuccess = (result: ProjectionApplyResult): ProjectionApplyEventResult => ({
  _tag: "success",
  result,
});

const projectionApplyFailure = (
  projection: AnyMaterializedProjectionDefinition,
  event: LedgerEvent,
  reason: string,
  cause?: unknown,
): ProjectionApplicationError =>
  new ProjectionApplicationError({
    kind: projection.kind,
    eventId: event.id,
    reason,
    ...(cause === undefined ? {} : { cause }),
  });

const decodeProjectionValueResult = <A>(
  projection: AnyMaterializedProjectionDefinition,
  event: LedgerEvent,
  schema: Schema.Codec<A, unknown, never, never>,
  value: unknown,
): ProjectionApplyEventResult | { readonly _tag: "decoded"; readonly value: A } => {
  const decoded = Schema.decodeUnknownResult(schema)(value);
  return Result.match(decoded, {
    onFailure: (cause): ProjectionApplyEventResult => ({
      _tag: "failure",
      error: projectionApplyFailure(projection, event, "projection application failed", cause),
    }),
    onSuccess: (decodedValue) => ({ _tag: "decoded", value: decodedValue }),
  });
};

export const applyProjectionEventResult = (
  projection: AnyMaterializedProjectionDefinition,
  event: LedgerEvent,
  currentFor: ProjectionCurrentLookup,
): ProjectionApplyEventResult => {
  const identifiedEither = Result.try({
    try: () => projection.identify(event),
    catch: (cause) =>
      projectionApplyFailure(projection, event, "projection application failed", cause),
  });
  if (Result.isFailure(identifiedEither)) {
    return { _tag: "failure", error: identifiedEither.failure };
  }
  const identified = identifiedEither.success;
  if (isThenable(identified)) {
    return {
      _tag: "failure",
      error: new ProjectionReducerReturnedThenable({ kind: projection.kind, eventId: event.id }),
    };
  }
  if (identified._tag === "skip") return projectionApplySuccess({ _tag: "skip" });
  if (identified._tag === "malformed") {
    return { _tag: "failure", error: projectionApplyFailure(projection, event, identified.reason) };
  }
  const identityResult = decodeProjectionValueResult(
    projection,
    event,
    projection.identity,
    identified.identity,
  );
  if (identityResult._tag !== "decoded") return identityResult;
  const identity = identityResult.value;
  const identityKeyEither = Result.try({
    try: () => projection.identityKey(identity),
    catch: (cause) =>
      projectionApplyFailure(projection, event, "projection application failed", cause),
  });
  if (Result.isFailure(identityKeyEither)) {
    return { _tag: "failure", error: identityKeyEither.failure };
  }
  const identityKey = identityKeyEither.success;
  if (identityKey.trim().length === 0) {
    return {
      _tag: "failure",
      error: projectionApplyFailure(projection, event, "projection identityKey must be non-empty"),
    };
  }
  const current = currentFor(identityKey);
  const currentStateUnknownEither =
    current === null
      ? Result.try({
          try: () => projection.initial(identity, event),
          catch: (cause) =>
            projectionApplyFailure(projection, event, "projection application failed", cause),
        })
      : Result.succeed(current.state);
  if (Result.isFailure(currentStateUnknownEither)) {
    return { _tag: "failure", error: currentStateUnknownEither.failure };
  }
  const currentStateUnknown = currentStateUnknownEither.success;
  if (isThenable(currentStateUnknown)) {
    return {
      _tag: "failure",
      error: new ProjectionReducerReturnedThenable({ kind: projection.kind, eventId: event.id }),
    };
  }
  const currentStateResult = decodeProjectionValueResult(
    projection,
    event,
    projection.state,
    currentStateUnknown,
  );
  if (currentStateResult._tag !== "decoded") return currentStateResult;
  const currentState = currentStateResult.value;
  const reducedEither = Result.try({
    try: () =>
      projection.reduce(currentState, event, {
        scopeRef: event.scopeRef,
        scopeKey: scopeRefKey(event.scopeRef),
        identity,
        identityKey,
      }),
    catch: (cause) =>
      projectionApplyFailure(projection, event, "projection application failed", cause),
  });
  if (Result.isFailure(reducedEither)) {
    return { _tag: "failure", error: reducedEither.failure };
  }
  const reduced = reducedEither.success;
  if (isThenable(reduced)) {
    return {
      _tag: "failure",
      error: new ProjectionReducerReturnedThenable({ kind: projection.kind, eventId: event.id }),
    };
  }
  switch (reduced._tag) {
    case "keep":
      return projectionApplySuccess({ _tag: "skip" });
    case "delete":
      return projectionApplySuccess({ _tag: "delete", identity, identityKey });
    case "fail":
      return { _tag: "failure", error: projectionApplyFailure(projection, event, reduced.reason) };
    case "put": {
      const stateResult = decodeProjectionValueResult(
        projection,
        event,
        projection.state,
        reduced.state,
      );
      if (stateResult._tag !== "decoded") return stateResult;
      return projectionApplySuccess({
        _tag: "put",
        identity,
        identityKey,
        state: stateResult.value,
      });
    }
  }
};

export const applyProjectionEvent = (
  projection: AnyMaterializedProjectionDefinition,
  event: LedgerEvent,
  currentFor: ProjectionCurrentLookup,
): Effect.Effect<
  ProjectionApplyResult,
  ProjectionApplicationError | ProjectionReducerReturnedThenable
> =>
  Effect.suspend(() => {
    const result = applyProjectionEventResult(projection, event, currentFor);
    return result._tag === "success" ? Effect.succeed(result.result) : Effect.fail(result.error);
  });
