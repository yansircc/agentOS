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
import type { Live } from "./value-brands";
import { captureLive } from "./live-edge";

export type ResolvedMaterial = NonNullable<unknown>;

export interface RefResolverDisposeInput {
  readonly ref: MaterialRef;
  readonly material: ResolvedMaterial;
}

export interface RefResolver {
  readonly material: (ref: MaterialRef) => ResolvedMaterial | null;
  readonly dispose?: (input: RefResolverDisposeInput) => void;
}

export interface LiveResolvedMaterial {
  readonly ref: MaterialRef;
  readonly value: Live<ResolvedMaterial>;
  readonly dispose: () => Effect.Effect<void>;
}

export class RefResolutionFailed extends Data.TaggedError("agent_os.ref_resolution_failed")<{
  readonly kind: MaterialKind;
  readonly ref: string;
  readonly reason: "material_missing" | "material_type_mismatch" | "resolver_threw";
}> {}

export class RefResolverService extends Context.Service<
  RefResolverService,
  ResolvedMaterialService
>()("@agent-os/RefResolver") {}

export interface ResolvedMaterialService {
  readonly material: (ref: MaterialRef) => Effect.Effect<LiveResolvedMaterial, RefResolutionFailed>;
}

const liveResolvedMaterialFromResolver = (
  resolver: RefResolver,
  ref: MaterialRef,
): Effect.Effect<LiveResolvedMaterial, RefResolutionFailed> =>
  Effect.gen(function* () {
    const value = yield* Effect.try({
      try: () => resolver.material(ref),
      catch: () =>
        new RefResolutionFailed({
          kind: ref.kind,
          ref: materialRefKey(ref),
          reason: "resolver_threw",
        }),
    });
    if (value === null) {
      return yield* Effect.fail(
        new RefResolutionFailed({
          kind: ref.kind,
          ref: materialRefKey(ref),
          reason: "material_missing",
        }),
      );
    }
    return {
      ref,
      value: captureLive(value),
      dispose: () =>
        Effect.sync(() => {
          resolver.dispose?.({ ref, material: value });
        }),
    };
  });

export const RefResolverLive = (resolver: RefResolver): Layer.Layer<RefResolverService> => {
  const material = (ref: MaterialRef): Effect.Effect<LiveResolvedMaterial, RefResolutionFailed> =>
    liveResolvedMaterialFromResolver(resolver, ref);

  return Layer.succeed(RefResolverService, {
    material,
  });
};

export const withResolvedMaterial = <A, E, R>(
  refs: ResolvedMaterialService,
  ref: MaterialRef,
  use: (value: Live<ResolvedMaterial>) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | RefResolutionFailed, R> =>
  Effect.acquireUseRelease(
    refs.material(ref),
    (handle) => use(handle.value),
    (handle) => handle.dispose(),
  );

export const RefResolverEmpty = RefResolverLive({
  material: () => null,
});
