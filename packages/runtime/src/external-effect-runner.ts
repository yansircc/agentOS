import { Effect } from "effect";
import type { PreClaim } from "@agent-os/core/effect-claim";
import type { LedgerEvent } from "@agent-os/core/types";

type IdempotencyProjection =
  | {
      readonly status: "missing";
    }
  | {
      readonly status: "found";
      readonly runId: string;
    };

export interface ExternalEffectRequestState<Spec> {
  readonly activeSpec: Spec;
  readonly requestedEventId: number;
  readonly claim: PreClaim;
  readonly events: ReadonlyArray<LedgerEvent>;
}

export interface RunExternalEffectAttemptSpec<Spec, Projection, E, R> {
  readonly spec: Spec;
  readonly idempotencyKey: string;
  readonly readEvents: () => Effect.Effect<ReadonlyArray<LedgerEvent>, E, R>;
  readonly projectByIdempotencyKey: (
    events: ReadonlyArray<LedgerEvent>,
    idempotencyKey: string,
  ) => IdempotencyProjection;
  readonly projectCurrent: (events: ReadonlyArray<LedgerEvent>, runId: string) => Projection;
  readonly isRunningProjection: (projection: Projection) => boolean;
  readonly activeSpecFromRunningProjection: (spec: Spec, projection: Projection) => Spec;
  readonly requestStateFromRunningProjection: (projection: Projection) => {
    readonly requestedEventId: number;
    readonly claim: PreClaim;
  };
  readonly request: (
    spec: Spec,
  ) => Effect.Effect<{ readonly requestedEventId: number; readonly claim: PreClaim }, E, R>;
  readonly runRequested: (
    state: ExternalEffectRequestState<Spec>,
  ) => Effect.Effect<Projection, E, R>;
}

/**
 * Reusable idempotent external-effect attempt runner.
 *
 * This helper owns no durable vocabulary. Callers keep using their carrier,
 * settlement contract, ledger identity, witness, and operationRef owners.
 */
export const runExternalEffectAttempt = <Spec, Projection, E, R>(
  runner: RunExternalEffectAttemptSpec<Spec, Projection, E, R>,
): Effect.Effect<Projection, E, R> =>
  Effect.gen(function* () {
    const before = yield* runner.readEvents();
    const existing = runner.projectByIdempotencyKey(before, runner.idempotencyKey);

    if (existing.status === "found") {
      const projection = runner.projectCurrent(before, existing.runId);
      if (!runner.isRunningProjection(projection)) {
        return projection;
      }
      const activeSpec = runner.activeSpecFromRunningProjection(runner.spec, projection);
      const request = runner.requestStateFromRunningProjection(projection);
      return yield* runner.runRequested({
        activeSpec,
        requestedEventId: request.requestedEventId,
        claim: request.claim,
        events: before,
      });
    }

    const request = yield* runner.request(runner.spec);
    return yield* runner.runRequested({
      activeSpec: runner.spec,
      requestedEventId: request.requestedEventId,
      claim: request.claim,
      events: before,
    });
  });
