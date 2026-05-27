/**
 * RefResolver — capability-neutral material lookup.
 *
 * Routes and extension carriers store symbolic refs in ledger-visible specs.
 * Concrete endpoint URLs, credential values, and provider handles live in the
 * deploy environment and are resolved at call time. Missing refs are
 * configuration errors and fail fast.
 */

import { Context, Data, Effect, Layer } from "effect";
import type { MaterialKind, MaterialRef } from "./material-ref";
import { materialRefKey } from "./material-ref";

export type ResolvedMaterial = NonNullable<unknown>;

export interface RefResolver {
  readonly material: (ref: MaterialRef) => ResolvedMaterial | null;
}

export class RefResolutionFailed extends Data.TaggedError("agent_os.ref_resolution_failed")<{
  readonly kind: MaterialKind;
  readonly ref: string;
}> {}

export class RefResolverService extends Context.Tag("@agent-os/RefResolver")<
  RefResolverService,
  MaterialResolverService
>() {}

export interface MaterialResolverService {
  readonly material: (ref: MaterialRef) => Effect.Effect<ResolvedMaterial, RefResolutionFailed>;
}

export const RefResolverLive = (resolver: RefResolver): Layer.Layer<RefResolverService> => {
  const material = (ref: MaterialRef): Effect.Effect<ResolvedMaterial, RefResolutionFailed> => {
    const value = resolver.material(ref);
    if (value === null) {
      return Effect.fail(new RefResolutionFailed({ kind: ref.kind, ref: materialRefKey(ref) }));
    }
    return Effect.succeed(value);
  };

  return Layer.succeed(RefResolverService, {
    material,
  });
};

export const resolveStringMaterial = (
  refs: MaterialResolverService,
  ref: MaterialRef,
): Effect.Effect<string, RefResolutionFailed> =>
  Effect.flatMap(refs.material(ref), (value) =>
    typeof value === "string"
      ? Effect.succeed(value)
      : Effect.fail(new RefResolutionFailed({ kind: ref.kind, ref: materialRefKey(ref) })),
  );

export const RefResolverEmpty = RefResolverLive({
  material: () => null,
});
