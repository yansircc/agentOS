/**
 * RefResolver — capability-neutral endpoint / credential lookup.
 *
 * Routes and extension carriers store symbolic refs in ledger-visible specs.
 * Concrete endpoint URLs and credential values live in deploy env and are
 * resolved at call time. Missing refs are configuration errors and fail fast.
 */

import { Context, Data, Effect, Layer } from "effect";

export interface RefResolver {
  readonly endpoint: (ref: string) => string | null;
  readonly credential: (ref: string) => string | null;
}

export class RefResolutionFailed extends Data.TaggedError(
  "agent_os.ref_resolution_failed",
)<{
  readonly kind: "endpoint" | "credential";
  readonly ref: string;
}> {}

export class RefResolverService extends Context.Tag(
  "@agent-os/RefResolver",
)<
  RefResolverService,
  {
    readonly endpoint: (
      ref: string,
    ) => Effect.Effect<string, RefResolutionFailed>;
    readonly credential: (
      ref: string,
    ) => Effect.Effect<string, RefResolutionFailed>;
  }
>() {}

export const RefResolverLive = (
  resolver: RefResolver,
): Layer.Layer<RefResolverService> =>
  Layer.succeed(RefResolverService, {
    endpoint: (ref) => {
      const value = resolver.endpoint(ref);
      if (value === null) {
        return Effect.fail(new RefResolutionFailed({ kind: "endpoint", ref }));
      }
      return Effect.succeed(value);
    },
    credential: (ref) => {
      const value = resolver.credential(ref);
      if (value === null) {
        return Effect.fail(new RefResolutionFailed({ kind: "credential", ref }));
      }
      return Effect.succeed(value);
    },
  });

export const RefResolverEmpty = RefResolverLive({
  endpoint: () => null,
  credential: () => null,
});
