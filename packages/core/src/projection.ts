import { Data, Result } from "effect";

type MaybePromise<T> = T | PromiseLike<T>;

/**
 * Declared owner of the source consumed by one projection run.
 *
 * @public
 */
export interface ProjectionSourceRef {
  readonly kind: string;
  readonly ref: string;
  readonly hash?: string;
  readonly sources?: ReadonlyArray<ProjectionSourceRef>;
}

/**
 * Provenance carried by every projection result.
 *
 * @public
 */
export interface ProjectionProvenance {
  readonly projection: {
    readonly id: string;
    readonly version: number;
  };
  readonly source: ProjectionSourceRef;
}

/**
 * Structured projection failure detail.
 *
 * @public
 */
export interface ProjectionIssue {
  readonly path?: string;
  readonly message: string;
}

/**
 * Successful source-to-view derivation.
 *
 * @public
 */
export interface ProjectionOk<Output> {
  readonly _tag: "ok";
  readonly output: Output;
  readonly provenance: ProjectionProvenance;
}

/**
 * Explicit fail-closed projection result.
 *
 * @public
 */
export interface ProjectionFailure {
  readonly _tag: "failure";
  readonly reason: string;
  readonly provenance: ProjectionProvenance;
  readonly issues?: ReadonlyArray<ProjectionIssue>;
}

/**
 * Result of one projection run.
 *
 * @public
 */
export type ProjectionResult<Output> = ProjectionOk<Output> | ProjectionFailure;

/**
 * Context passed to a pure projection function.
 *
 * @public
 */
export interface ProjectionContext {
  readonly provenance: ProjectionProvenance;
  readonly ok: <Output>(output: Output) => ProjectionResult<Output>;
  readonly failure: <Output = never>(
    reason: string,
    issues?: ReadonlyArray<ProjectionIssue>,
  ) => ProjectionResult<Output>;
}

/**
 * Pure source-to-view projection definition.
 *
 * @public
 */
export interface ProjectionSpec<Input, Output> {
  readonly id: string;
  readonly version: number;
  readonly source: ProjectionSourceRef;
  readonly project: (input: Input, context: ProjectionContext) => ProjectionResult<Output>;
}

/**
 * Alias for a pure source-to-view projection definition.
 *
 * @public
 */
export type ProjectionDefinition<Input, Output> = ProjectionSpec<Input, Output>;

/**
 * Current sink contents before a projection write.
 *
 * @public
 */
export type ProjectionSinkReadResult<Output> =
  | {
      readonly _tag: "missing";
    }
  | {
      readonly _tag: "found";
      readonly output: Output;
    };

/**
 * Sink around a projection. Side effects live here, not inside ProjectionSpec.project.
 *
 * @public
 */
export interface ProjectionSink<Output> {
  readonly id: string;
  readonly read: () => MaybePromise<ProjectionSinkReadResult<Output>>;
  readonly write: (output: Output) => MaybePromise<void>;
  readonly equals?: (actual: Output, expected: Output) => boolean;
}

/**
 * Read-only sink check result.
 *
 * @public
 */
export type ProjectionSinkCheckResult<Output> =
  | {
      readonly _tag: "projection_failed";
      readonly result: ProjectionFailure;
    }
  | {
      readonly _tag: "current";
      readonly result: ProjectionOk<Output>;
      readonly actual: Output;
    }
  | {
      readonly _tag: "stale";
      readonly result: ProjectionOk<Output>;
      readonly expected: Output;
      readonly actual: ProjectionSinkReadResult<Output>;
    };

/**
 * Sink write result.
 *
 * @public
 */
export type ProjectionSinkRunResult<Output> =
  | Exclude<ProjectionSinkCheckResult<Output>, { readonly _tag: "stale" }>
  | {
      readonly _tag: "updated";
      readonly result: ProjectionOk<Output>;
      readonly previous: ProjectionSinkReadResult<Output>;
    };

/**
 * Invalid projection declaration.
 *
 * @public
 */
export class ProjectionDefinitionError extends Data.TaggedError(
  "agent_os.projection_definition_error",
)<{
  readonly message: string;
}> {}

/**
 * Projection result unwrapped through a fail-fast public DTO facade.
 *
 * @public
 */
export class ProjectionRunFailed extends Data.TaggedError("agent_os.projection_run_failed")<{
  readonly message: string;
  readonly projectionId: string;
  readonly reason: string;
}> {}

/**
 * Projection sink read/write failure.
 *
 * @public
 */
export class ProjectionSinkFailure extends Data.TaggedError("agent_os.projection_sink_failure")<{
  readonly sinkId: string;
  readonly operation: "read" | "write";
  readonly cause: unknown;
}> {}

const isNonEmptyString = (value: string): boolean => value.trim().length > 0;

const sourceRefIssue = (source: ProjectionSourceRef): string | undefined => {
  if (!isNonEmptyString(source.kind)) {
    return "projection source kind must be non-empty";
  }
  if (!isNonEmptyString(source.ref)) {
    return "projection source ref must be non-empty";
  }
  if (source.hash !== undefined && !isNonEmptyString(source.hash)) {
    return "projection source hash must be non-empty when present";
  }
  if (source.kind !== "source-set" && source.sources !== undefined) {
    return "projection source children require source-set kind";
  }
  if (
    source.kind === "source-set" &&
    (source.sources === undefined || source.sources.length === 0)
  ) {
    return "projection source-set must include at least one source";
  }
  for (const child of source.sources ?? []) {
    const issue = sourceRefIssue(child);
    if (issue !== undefined) {
      return `${source.ref}: ${issue}`;
    }
  }
  return undefined;
};

const failDefinition = (message: string): never =>
  Result.getOrThrowWith(Result.fail(new ProjectionDefinitionError({ message })), (error) => error);

/**
 * Defines one projection spec and validates its boot-time identity contract.
 *
 * @public
 */
export const defineProjectionSpec = <Input, Output>(
  spec: ProjectionSpec<Input, Output>,
): ProjectionSpec<Input, Output> => {
  if (!isNonEmptyString(spec.id)) {
    return failDefinition("projection id must be non-empty");
  }
  if (!Number.isInteger(spec.version) || spec.version < 1) {
    return failDefinition("projection version must be a positive integer");
  }
  const sourceIssue = sourceRefIssue(spec.source);
  if (sourceIssue !== undefined) {
    return failDefinition(sourceIssue);
  }
  return spec;
};

const provenanceOf = <Input, Output>(
  spec: ProjectionSpec<Input, Output>,
): ProjectionProvenance => ({
  projection: {
    id: spec.id,
    version: spec.version,
  },
  source: spec.source,
});

/**
 * Builds a successful projection result.
 *
 * @public
 */
export const projectionOk = <Output>(
  provenance: ProjectionProvenance,
  output: Output,
): ProjectionResult<Output> => ({
  _tag: "ok",
  output,
  provenance,
});

/**
 * Builds an explicit projection failure.
 *
 * @public
 */
export const projectionFailure = <Output = never>(
  provenance: ProjectionProvenance,
  reason: string,
  issues?: ReadonlyArray<ProjectionIssue>,
): ProjectionResult<Output> => ({
  _tag: "failure",
  reason,
  provenance,
  ...(issues === undefined ? {} : { issues }),
});

/**
 * Namespace-style constructors for projection results.
 *
 * @public
 */
export const ProjectionResult = {
  ok: projectionOk,
  failure: projectionFailure,
} as const;

const isProjectionResult = <Output>(value: unknown): value is ProjectionResult<Output> =>
  value !== null &&
  typeof value === "object" &&
  "_tag" in value &&
  (value._tag === "ok" || value._tag === "failure");

const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  value !== null &&
  (typeof value === "object" || typeof value === "function") &&
  "then" in value &&
  typeof value.then === "function";

const normalizeProjectionResult = <Output>(
  result: ProjectionResult<Output>,
  provenance: ProjectionProvenance,
): ProjectionResult<Output> =>
  result._tag === "ok"
    ? projectionOk(provenance, result.output)
    : projectionFailure(provenance, result.reason, result.issues);

/**
 * Runs a pure projection and returns an explicit result.
 *
 * @public
 */
export const project = <Input, Output>(
  spec: ProjectionSpec<Input, Output>,
  input: Input,
): ProjectionResult<Output> => {
  const provenance = provenanceOf(spec);
  const context: ProjectionContext = {
    provenance,
    ok: (output) => projectionOk(provenance, output),
    failure: (reason, issues) => projectionFailure(provenance, reason, issues),
  };

  const attempted = Result.try({
    try: () => spec.project(input, context),
    catch: () => "projection_threw" as const,
  });
  if (Result.isFailure(attempted)) {
    return projectionFailure(provenance, "projection_threw");
  }
  const result: unknown = attempted.success;
  if (isThenable(result)) {
    return projectionFailure(provenance, "projection_returned_thenable");
  }
  if (!isProjectionResult<Output>(result)) {
    return projectionFailure(provenance, "projection_result_invalid");
  }
  return normalizeProjectionResult(result, provenance);
};

const defaultEquals = <Output>(actual: Output, expected: Output): boolean =>
  Object.is(actual, expected);

const resolvedPromise = <Output>(value: Output): Promise<Output> =>
  new Promise((resolve) => resolve(value));

const maybePromise = <Output>(
  operation: "read" | "write",
  sinkId: string,
  evaluate: () => MaybePromise<Output>,
): Promise<Output> =>
  new Promise((resolve, reject) => {
    const evaluated = Result.try({
      try: evaluate,
      catch: (cause) => new ProjectionSinkFailure({ sinkId, operation, cause }),
    });
    if (Result.isFailure(evaluated)) {
      reject(evaluated.failure);
      return;
    }
    const value = evaluated.success;
    if (isThenable(value)) {
      value.then(resolve, (cause) =>
        reject(new ProjectionSinkFailure({ sinkId, operation, cause })),
      );
      return;
    }
    resolve(value);
  });

/**
 * Checks whether a sink already holds the derived projection output.
 *
 * @public
 */
export const checkProjectionSink = <Input, Output>(
  spec: ProjectionSpec<Input, Output>,
  input: Input,
  sink: ProjectionSink<Output>,
): Promise<ProjectionSinkCheckResult<Output>> => {
  const result = project(spec, input);
  if (result._tag === "failure") {
    return resolvedPromise({ _tag: "projection_failed", result });
  }

  return maybePromise("read", sink.id, sink.read).then((current) => {
    if (current._tag === "found" && (sink.equals ?? defaultEquals)(current.output, result.output)) {
      return { _tag: "current", result, actual: current.output };
    }

    return {
      _tag: "stale",
      result,
      expected: result.output,
      actual: current,
    };
  });
};

/**
 * Writes a sink only when its current output is stale.
 *
 * @public
 */
export const runProjectionSink = <Input, Output>(
  spec: ProjectionSpec<Input, Output>,
  input: Input,
  sink: ProjectionSink<Output>,
): Promise<ProjectionSinkRunResult<Output>> =>
  checkProjectionSink(spec, input, sink).then((checked) => {
    if (checked._tag !== "stale") {
      return checked;
    }

    return maybePromise("write", sink.id, () => sink.write(checked.expected)).then(() => ({
      _tag: "updated",
      result: checked.result,
      previous: checked.actual,
    }));
  });

/**
 * Unwraps a projection result through a fail-fast DTO facade.
 *
 * @public
 */
export const projectionOutputOrFail = <Output>(result: ProjectionResult<Output>): Output => {
  if (result._tag === "ok") return result.output;
  return Result.getOrThrowWith(
    Result.fail(
      new ProjectionRunFailed({
        message: result.reason,
        projectionId: result.provenance.projection.id,
        reason: result.reason,
      }),
    ),
    (error) => error,
  );
};
