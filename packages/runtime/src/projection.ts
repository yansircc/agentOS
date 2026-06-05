import { Context, Data, Effect, Either, Schema } from "effect";
import { scopeRefKey, type ScopeRef } from "@agent-os/kernel/effect-claim";
import type { SqlError } from "@agent-os/kernel/errors";
import type { LedgerEvent } from "@agent-os/kernel/types";

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

export interface ProjectionReduceContext<Identity> {
  readonly scopeRef: ScopeRef;
  readonly scopeKey: string;
  readonly identity: Identity;
  readonly identityKey: string;
}

export interface MaterializedProjectionDefinition<Identity, State> {
  readonly kind: string;
  readonly version: number;
  readonly eventKinds: ReadonlyArray<string>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly identity: Schema.Schema<Identity, any, never>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly state: Schema.Schema<State, any, never>;
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

export const defineProjection = <Identity, State>(
  spec: MaterializedProjectionDefinition<Identity, State>,
): MaterializedProjectionDefinition<Identity, State> => spec;

export type ProjectionRegistry = ReadonlyMap<string, AnyMaterializedProjectionDefinition>;

export class MaterializedProjectionRegistry extends Context.Tag(
  "@agent-os/MaterializedProjectionRegistry",
)<MaterializedProjectionRegistry, ProjectionRegistry>() {}

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

export interface MaterializedProjectionGetSpec {
  readonly kind: string;
  readonly scope: string;
  readonly identity: unknown;
}

export interface MaterializedProjectionListSpec {
  readonly kind: string;
  readonly scope: string;
  readonly limit?: number;
  readonly afterKey?: string;
}

export class MaterializedProjections extends Context.Tag("@agent-os/MaterializedProjections")<
  MaterializedProjections,
  {
    readonly get: (
      spec: MaterializedProjectionGetSpec,
    ) => Effect.Effect<MaterializedProjectionRow | null, SqlError | UnregisteredProjectionKind>;
    readonly list: (
      spec: MaterializedProjectionListSpec,
    ) => Effect.Effect<
      ReadonlyArray<MaterializedProjectionRow>,
      SqlError | UnregisteredProjectionKind
    >;
    readonly status: (spec: {
      readonly kind: string;
      readonly scope: string;
    }) => Effect.Effect<MaterializedProjectionStatus, SqlError | UnregisteredProjectionKind>;
    readonly rebuild: (spec: {
      readonly kind: string;
      readonly scope: string;
    }) => Effect.Effect<
      MaterializedProjectionRebuildResult,
      | SqlError
      | UnregisteredProjectionKind
      | ProjectionApplicationError
      | ProjectionReducerReturnedThenable
    >;
  }
>() {}

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
  Effect.suspend(() => {
    const result = makeProjectionRegistryResult(projections);
    return result._tag === "success" ? Effect.succeed(result.registry) : Effect.fail(result.error);
  });

export const getProjection = (
  registry: ProjectionRegistry,
  kind: string,
): Effect.Effect<AnyMaterializedProjectionDefinition, UnregisteredProjectionKind> => {
  const projection = registry.get(kind);
  return projection === undefined
    ? Effect.fail(new UnregisteredProjectionKind({ kind }))
    : Effect.succeed(projection);
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
  schema: Schema.Schema<A, unknown, never>,
  value: unknown,
): ProjectionApplyEventResult | { readonly _tag: "decoded"; readonly value: A } => {
  const decoded = Schema.decodeUnknownEither(schema)(value);
  return Either.match(decoded, {
    onLeft: (cause): ProjectionApplyEventResult => ({
      _tag: "failure",
      error: projectionApplyFailure(projection, event, "projection application failed", cause),
    }),
    onRight: (decodedValue) => ({ _tag: "decoded", value: decodedValue }),
  });
};

export const applyProjectionEventResult = (
  projection: AnyMaterializedProjectionDefinition,
  event: LedgerEvent,
  currentFor: ProjectionCurrentLookup,
): ProjectionApplyEventResult => {
  const identifiedEither = Either.try({
    try: () => projection.identify(event),
    catch: (cause) =>
      projectionApplyFailure(projection, event, "projection application failed", cause),
  });
  if (Either.isLeft(identifiedEither)) {
    return { _tag: "failure", error: identifiedEither.left };
  }
  const identified = identifiedEither.right;
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
  const identityKeyEither = Either.try({
    try: () => projection.identityKey(identity),
    catch: (cause) =>
      projectionApplyFailure(projection, event, "projection application failed", cause),
  });
  if (Either.isLeft(identityKeyEither)) {
    return { _tag: "failure", error: identityKeyEither.left };
  }
  const identityKey = identityKeyEither.right;
  if (identityKey.trim().length === 0) {
    return {
      _tag: "failure",
      error: projectionApplyFailure(projection, event, "projection identityKey must be non-empty"),
    };
  }
  const current = currentFor(identityKey);
  const currentStateUnknownEither =
    current === null
      ? Either.try({
          try: () => projection.initial(identity, event),
          catch: (cause) =>
            projectionApplyFailure(projection, event, "projection application failed", cause),
        })
      : Either.right(current.state);
  if (Either.isLeft(currentStateUnknownEither)) {
    return { _tag: "failure", error: currentStateUnknownEither.left };
  }
  const currentStateUnknown = currentStateUnknownEither.right;
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
  const reducedEither = Either.try({
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
  if (Either.isLeft(reducedEither)) {
    return { _tag: "failure", error: reducedEither.left };
  }
  const reduced = reducedEither.right;
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
