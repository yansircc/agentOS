import { Effect } from "effect";

export type ExternalEffectAttemptLookup<AttemptKey = string> =
  | {
      readonly status: "missing";
    }
  | {
      readonly status: "found";
      readonly attemptKey: AttemptKey;
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
