import { Effect } from "effect";

export type ExternalEffectAttemptLookup<AttemptKey = string> =
  | {
      readonly status: "missing";
    }
  | {
      readonly status: "found";
      readonly attemptKey: AttemptKey;
    };

export type ExternalEffectAttemptProjectionStatus =
  | "missing"
  | "running"
  | "settled"
  | "failed"
  | "indeterminate";

export type ExternalEffectKnownAttemptProjectionStatus = Exclude<
  ExternalEffectAttemptProjectionStatus,
  "missing"
>;

export type ExternalEffectAttemptProjection<AttemptKey = string, EvidenceRef = string> =
  | {
      readonly idempotencyKey: string;
      readonly status: "missing";
      readonly evidenceRefs: readonly [];
    }
  | {
      readonly idempotencyKey: string;
      readonly status: ExternalEffectKnownAttemptProjectionStatus;
      readonly attemptKey: AttemptKey;
      readonly evidenceRefs: ReadonlyArray<EvidenceRef>;
    };

export interface ProjectExternalEffectAttemptSpec<Event, Projection, AttemptKey, EvidenceRef> {
  readonly idempotencyKey: string;
  readonly events: ReadonlyArray<Event>;
  readonly projectByIdempotencyKey: (
    events: ReadonlyArray<Event>,
    idempotencyKey: string,
  ) => ExternalEffectAttemptLookup<AttemptKey>;
  readonly projectCurrent: (events: ReadonlyArray<Event>, attemptKey: AttemptKey) => Projection;
  readonly statusFromProjection: (
    projection: Projection,
  ) => ExternalEffectKnownAttemptProjectionStatus;
  readonly evidenceRefsFromProjection: (projection: Projection) => ReadonlyArray<EvidenceRef>;
}

/**
 * Projects a caller-owned external-effect attempt into a UI-neutral status.
 *
 * The caller still owns event history, attempt identity, projection validity,
 * evidence ref shape, and terminal meaning. This helper only joins those
 * caller-owned functions into one repeatable attempt projection.
 */
export const projectExternalEffectAttempt = <Event, Projection, AttemptKey, EvidenceRef>(
  spec: ProjectExternalEffectAttemptSpec<Event, Projection, AttemptKey, EvidenceRef>,
): ExternalEffectAttemptProjection<AttemptKey, EvidenceRef> => {
  const existing = spec.projectByIdempotencyKey(spec.events, spec.idempotencyKey);
  if (existing.status === "missing") {
    return { idempotencyKey: spec.idempotencyKey, status: "missing", evidenceRefs: [] };
  }
  const projection = spec.projectCurrent(spec.events, existing.attemptKey);
  return {
    idempotencyKey: spec.idempotencyKey,
    status: spec.statusFromProjection(projection),
    attemptKey: existing.attemptKey,
    evidenceRefs: spec.evidenceRefsFromProjection(projection),
  };
};

export interface ExternalEffectRequestedState<Spec, Request> {
  readonly activeSpec: Spec;
  readonly request: Request;
}

export interface RunExternalEffectAttemptSpec<Spec, Event, Projection, Request, AttemptKey, E, R> {
  readonly spec: Spec;
  readonly idempotencyKey: string;
  readonly readEvents: () => Effect.Effect<ReadonlyArray<Event>, E, R>;
  readonly projectByIdempotencyKey: (
    events: ReadonlyArray<Event>,
    idempotencyKey: string,
  ) => ExternalEffectAttemptLookup<AttemptKey>;
  readonly projectCurrent: (events: ReadonlyArray<Event>, attemptKey: AttemptKey) => Projection;
  readonly isRunningProjection: (projection: Projection) => boolean;
  readonly activeSpecFromRunningProjection: (spec: Spec, projection: Projection) => Spec;
  readonly requestStateFromRunningProjection: (projection: Projection) => Request;
  readonly request: (spec: Spec) => Effect.Effect<Request, E, R>;
  readonly runRequested: (
    state: ExternalEffectRequestedState<Spec, Request>,
  ) => Effect.Effect<Projection, E, R>;
}

export type DefinedExternalEffectAttempt<Spec, Event, Projection, Request, AttemptKey> = <
  E = never,
  R = never,
>(
  runner: RunExternalEffectAttemptSpec<Spec, Event, Projection, Request, AttemptKey, E, R>,
) => Effect.Effect<Projection, E, R>;

/**
 * Reusable idempotent external-effect attempt runner.
 *
 * This helper owns no durable vocabulary. Callers provide event history,
 * request payloads, projection semantics, attempt identity, carrier claims,
 * witnesses, receipts, and settlement contracts.
 */
export const runExternalEffectAttempt = <Spec, Event, Projection, Request, AttemptKey, E, R>(
  runner: RunExternalEffectAttemptSpec<Spec, Event, Projection, Request, AttemptKey, E, R>,
): Effect.Effect<Projection, E, R> =>
  Effect.gen(function* () {
    const before = yield* runner.readEvents();
    const existing = runner.projectByIdempotencyKey(before, runner.idempotencyKey);

    if (existing.status === "found") {
      const projection = runner.projectCurrent(before, existing.attemptKey);
      if (!runner.isRunningProjection(projection)) {
        return projection;
      }
      const activeSpec = runner.activeSpecFromRunningProjection(runner.spec, projection);
      const request = runner.requestStateFromRunningProjection(projection);
      return yield* runner.runRequested({ activeSpec, request });
    }

    const request = yield* runner.request(runner.spec);
    return yield* runner.runRequested({ activeSpec: runner.spec, request });
  });

/**
 * Defines a typed external-effect attempt runner for one caller-owned algebra.
 *
 * This is only a TypeScript ergonomics helper. It fixes the caller's `Spec`,
 * `Event`, `Projection`, `Request`, and `AttemptKey` types once, then delegates
 * to `runExternalEffectAttempt` so the `E` and `R` channels still come from the
 * supplied effects.
 */
export const defineExternalEffectAttempt =
  <Spec, Event, Projection, Request, AttemptKey = string>(): DefinedExternalEffectAttempt<
    Spec,
    Event,
    Projection,
    Request,
    AttemptKey
  > =>
  (runner) =>
    runExternalEffectAttempt(runner);
