import { Effect } from "effect";

export const withImageResourceSettlement = <A, E, R, CE, CR, RE, RR>(
  effect: Effect.Effect<A, E, R>,
  settlement: {
    readonly consume: (value: A) => Effect.Effect<void, CE, CR>;
    readonly release: (error: E) => Effect.Effect<void, RE, RR>;
  },
): Effect.Effect<A, E | CE | RE, R | CR | RR> =>
  Effect.matchEffect(effect, {
    onFailure: (error) =>
      settlement.release(error).pipe(Effect.zipRight(Effect.fail(error))),
    onSuccess: (value) =>
      settlement.consume(value).pipe(Effect.as(value)),
  });
