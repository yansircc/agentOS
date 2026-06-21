const isNonEmptyString = (value) => typeof value === "string" && value.trim().length > 0;

const sourceRefIssue = (source) => {
  if (!isNonEmptyString(source.kind)) return "projection source kind must be non-empty";
  if (!isNonEmptyString(source.ref)) return "projection source ref must be non-empty";
  if (source.hash !== undefined && !isNonEmptyString(source.hash)) {
    return "projection source hash must be non-empty when present";
  }
  if (source.kind !== "source-set" && source.sources !== undefined) {
    return "projection source children require source-set kind";
  }
  if (
    source.kind === "source-set" &&
    (!Array.isArray(source.sources) || source.sources.length === 0)
  ) {
    return "projection source-set must include at least one source";
  }
  for (const child of source.sources ?? []) {
    const issue = sourceRefIssue(child);
    if (issue !== undefined) return `${source.ref}: ${issue}`;
  }
  return undefined;
};

export const defineProjectionSpec = (spec) => {
  if (!isNonEmptyString(spec.id)) throw new Error("projection id must be non-empty");
  if (!Number.isInteger(spec.version) || spec.version < 1) {
    throw new Error("projection version must be a positive integer");
  }
  const sourceIssue = sourceRefIssue(spec.source);
  if (sourceIssue !== undefined) throw new Error(sourceIssue);
  return spec;
};

const provenanceOf = (spec) => ({
  projection: {
    id: spec.id,
    version: spec.version,
  },
  source: spec.source,
});

const projectionOk = (provenance, output) => ({ _tag: "ok", output, provenance });

const projectionFailure = (provenance, reason, issues) => ({
  _tag: "failure",
  reason,
  provenance,
  ...(issues === undefined ? {} : { issues }),
});

const isThenable = (value) =>
  value !== null &&
  (typeof value === "object" || typeof value === "function") &&
  "then" in value &&
  typeof value.then === "function";

const isProjectionResult = (value) =>
  value !== null &&
  typeof value === "object" &&
  "_tag" in value &&
  (value._tag === "ok" || value._tag === "failure");

const project = (spec, input) => {
  const provenance = provenanceOf(spec);
  const context = {
    provenance,
    ok: (output) => projectionOk(provenance, output),
    failure: (reason, issues) => projectionFailure(provenance, reason, issues),
  };

  try {
    const result = spec.project(input, context);
    if (isThenable(result)) return projectionFailure(provenance, "projection_returned_thenable");
    if (!isProjectionResult(result))
      return projectionFailure(provenance, "projection_result_invalid");
    return result._tag === "ok"
      ? projectionOk(provenance, result.output)
      : projectionFailure(provenance, result.reason, result.issues);
  } catch {
    return projectionFailure(provenance, "projection_threw");
  }
};

const defaultEquals = (actual, expected) => Object.is(actual, expected);

export const checkProjectionSink = async (spec, input, sink) => {
  const result = project(spec, input);
  if (result._tag === "failure") return { _tag: "projection_failed", result };

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

export const runProjectionSink = async (spec, input, sink) => {
  const checked = await checkProjectionSink(spec, input, sink);
  if (checked._tag !== "stale") return checked;
  await sink.write(checked.expected);
  return {
    _tag: "updated",
    result: checked.result,
    previous: checked.actual,
  };
};
