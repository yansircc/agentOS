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
import type { LedgerTruthIdentity } from "./runtime-protocol/ledger";
import type { Live } from "./value-brands";
import { captureLive } from "./live-edge";

export type ResolvedMaterial = NonNullable<unknown>;

export interface MaterialResolutionRequest {
  readonly truthIdentity: LedgerTruthIdentity;
  readonly materialRef: MaterialRef;
  readonly expectedVersion?: string;
}

export interface MaterialResolutionReceipt {
  readonly materialRef: MaterialRef;
  readonly version: string;
}

export interface RefResolver {
  readonly material: (
    request: MaterialResolutionRequest,
  ) => Effect.Effect<LiveResolvedMaterial, RefResolutionFailed>;
}

export interface LiveResolvedMaterial {
  readonly ref: MaterialRef;
  readonly version: string;
  readonly value: Live<ResolvedMaterial>;
  readonly dispose: () => Effect.Effect<void>;
}

export class RefResolutionFailed extends Data.TaggedError("agent_os.ref_resolution_failed")<{
  readonly kind: MaterialKind;
  readonly ref: string;
  readonly reason:
    | "material_missing"
    | "material_unauthorized"
    | "material_version_mismatch"
    | "material_type_mismatch"
    | "resolver_failed";
  readonly expectedVersion?: string;
  readonly actualVersion?: string;
}> {}

export class RefResolverService extends Context.Service<
  RefResolverService,
  ResolvedMaterialService
>()("@agent-os/RefResolver") {}

export interface ResolvedMaterialService {
  readonly material: (
    request: MaterialResolutionRequest,
  ) => Effect.Effect<LiveResolvedMaterial, RefResolutionFailed>;
}

export const liveResolvedMaterial = (input: {
  readonly ref: MaterialRef;
  readonly version: string;
  readonly value: ResolvedMaterial;
  readonly dispose?: () => Effect.Effect<void>;
}): LiveResolvedMaterial => ({
  ref: input.ref,
  version: input.version,
  value: captureLive(input.value),
  dispose: input.dispose ?? (() => Effect.void),
});

export const RefResolverLive = (resolver: RefResolver): Layer.Layer<RefResolverService> => {
  const material = (
    request: MaterialResolutionRequest,
  ): Effect.Effect<LiveResolvedMaterial, RefResolutionFailed> =>
    Effect.withSpan("agentos.kernel.ref_resolver.material")(
      Effect.try({
        try: () => resolver.material(request),
        catch: () =>
          new RefResolutionFailed({
            kind: request.materialRef.kind,
            ref: materialRefKey(request.materialRef),
            reason: "resolver_failed",
            ...(request.expectedVersion === undefined
              ? {}
              : { expectedVersion: request.expectedVersion }),
          }),
      }).pipe(Effect.flatten),
    );

  return Layer.succeed(RefResolverService, {
    material,
  });
};

export const withResolvedMaterial = <A, E, R>(
  refs: ResolvedMaterialService,
  request: MaterialResolutionRequest,
  use: (value: Live<ResolvedMaterial>) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | RefResolutionFailed, R> =>
  Effect.withSpan("agentos.kernel.ref_resolver.with_resolved_material")(
    Effect.acquireUseRelease(
      refs.material(request),
      (handle) => use(handle.value),
      (handle) => handle.dispose(),
    ),
  );

export const RefResolverNone: RefResolver = {
  material: (request) =>
    Effect.fail(
      new RefResolutionFailed({
        kind: request.materialRef.kind,
        ref: materialRefKey(request.materialRef),
        reason: "material_missing",
        ...(request.expectedVersion === undefined
          ? {}
          : { expectedVersion: request.expectedVersion }),
      }),
    ),
};

export const RefResolverEmpty = RefResolverLive(RefResolverNone);
