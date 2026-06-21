import { Data, Effect } from "effect";

export type ImageResourceSettlementPhase = "consume" | "release";

/**
 * Provider-local signal that the image operation result and resource
 * reservation settlement diverged. This package does not write ledger facts;
 * callers that own an image/resource carrier boundary must translate this into
 * that boundary's indeterminate settlement vocabulary.
 */
export class ImageResourceSettlementReconcileRequired extends Data.TaggedError(
  "agent_os.image_resource_settlement_reconcile_required",
)<{
  readonly phase: ImageResourceSettlementPhase;
  readonly cause: unknown;
}> {}

export const withImageResourceSettlement = <A, E, R, CE, CR, RE, RR>(
  effect: Effect.Effect<A, E, R>,
  settlement: {
    readonly consume: (value: A) => Effect.Effect<void, CE, CR>;
    readonly release: (error: E) => Effect.Effect<void, RE, RR>;
  },
): Effect.Effect<A, E | ImageResourceSettlementReconcileRequired, R | CR | RR> =>
  Effect.withSpan("agentos.image_resource_settlement.with_settlement")(
    Effect.matchEffect(effect, {
      onFailure: (error) =>
        settlement.release(error).pipe(
          Effect.mapError(
            (cause) => new ImageResourceSettlementReconcileRequired({ phase: "release", cause }),
          ),
          Effect.andThen(Effect.fail(error)),
        ),
      onSuccess: (value) =>
        settlement.consume(value).pipe(
          Effect.mapError(
            (cause) => new ImageResourceSettlementReconcileRequired({ phase: "consume", cause }),
          ),
          Effect.as(value),
        ),
    }),
  );
