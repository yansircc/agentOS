type MaybePromise<T> = T | Promise<T>;

/**
 * Declared owner of the source consumed by one projection run.
 *
 * @public
 */
export interface ProjectionSourceRef {
  readonly kind: string;
  readonly ref: string;
  readonly hash?: string;
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

const isNonEmptyString = (value: string): boolean => value.trim().length > 0;

const assertSourceRef = (source: ProjectionSourceRef): void => {
  if (!isNonEmptyString(source.kind)) {
    throw new TypeError("projection source kind must be non-empty");
  }
  if (!isNonEmptyString(source.ref)) {
    throw new TypeError("projection source ref must be non-empty");
  }
  if (source.hash !== undefined && !isNonEmptyString(source.hash)) {
    throw new TypeError("projection source hash must be non-empty when present");
  }
};

/**
 * Defines one projection spec and validates its boot-time identity contract.
 *
 * @public
 */
export const defineProjectionSpec = <Input, Output>(
  spec: ProjectionSpec<Input, Output>,
): ProjectionSpec<Input, Output> => {
  if (!isNonEmptyString(spec.id)) {
    throw new TypeError("projection id must be non-empty");
  }
  if (!Number.isInteger(spec.version) || spec.version < 1) {
    throw new TypeError("projection version must be a positive integer");
  }
  assertSourceRef(spec.source);
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
  ("_tag" in value && (value._tag === "ok" || value._tag === "failure"));

const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  value !== null &&
  (typeof value === "object" || typeof value === "function") &&
  "then" in value &&
  typeof value.then === "function";

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

  try {
    const result: unknown = spec.project(input, context);
    if (isThenable(result)) {
      return projectionFailure(provenance, "projection_returned_thenable");
    }
    if (!isProjectionResult<Output>(result)) {
      return projectionFailure(provenance, "projection_result_invalid");
    }
    return result;
  } catch {
    return projectionFailure(provenance, "projection_threw");
  }
};

const defaultEquals = <Output>(actual: Output, expected: Output): boolean =>
  Object.is(actual, expected);

/**
 * Checks whether a sink already holds the derived projection output.
 *
 * @public
 */
export const checkProjectionSink = async <Input, Output>(
  spec: ProjectionSpec<Input, Output>,
  input: Input,
  sink: ProjectionSink<Output>,
): Promise<ProjectionSinkCheckResult<Output>> => {
  const result = project(spec, input);
  if (result._tag === "failure") {
    return { _tag: "projection_failed", result };
  }

  const current = await sink.read();
  if (current._tag === "found" && (sink.equals ?? defaultEquals)(current.output, result.output)) {
    return { _tag: "current", result, actual: current.output };
  }

  return {
    _tag: "stale",
    result,
    expected: result.output,
    actual: current,
  };
};

/**
 * Writes a sink only when its current output is stale.
 *
 * @public
 */
export const runProjectionSink = async <Input, Output>(
  spec: ProjectionSpec<Input, Output>,
  input: Input,
  sink: ProjectionSink<Output>,
): Promise<ProjectionSinkRunResult<Output>> => {
  const checked = await checkProjectionSink(spec, input, sink);
  if (checked._tag !== "stale") {
    return checked;
  }

  await sink.write(checked.expected);
  return {
    _tag: "updated",
    result: checked.result,
    previous: checked.actual,
  };
};
