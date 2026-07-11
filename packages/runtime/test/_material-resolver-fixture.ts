import { Effect } from "effect";
import { materialRefKey, type MaterialRef } from "@agent-os/core/material-ref";
import {
  liveResolvedMaterial,
  RefResolutionFailed,
  type MaterialResolutionRequest,
  type RefResolver,
  type ResolvedMaterial,
} from "@agent-os/core/ref-resolver";

export const fixtureMaterialRequest = (materialRef: MaterialRef): MaterialResolutionRequest => ({
  truthIdentity: {
    scopeRef: { kind: "conversation", scopeId: "runtime-test-tenant" },
    effectAuthorityRef: { authorityId: "runtime-test", authorityClass: "test" },
  },
  materialRef,
});

export const fixtureRefResolver = (
  resolve: (ref: MaterialRef) => ResolvedMaterial | null,
  dispose?: (input: { readonly ref: MaterialRef; readonly material: ResolvedMaterial }) => void,
): RefResolver => ({
  material: (request) => {
    const version = "fixture-v1";
    if (request.expectedVersion !== undefined && request.expectedVersion !== version) {
      return Effect.fail(
        new RefResolutionFailed({
          kind: request.materialRef.kind,
          ref: materialRefKey(request.materialRef),
          reason: "material_version_mismatch",
          expectedVersion: request.expectedVersion,
          actualVersion: version,
        }),
      );
    }
    const value = resolve(request.materialRef);
    return value === null
      ? Effect.fail(
          new RefResolutionFailed({
            kind: request.materialRef.kind,
            ref: materialRefKey(request.materialRef),
            reason: "material_missing",
          }),
        )
      : Effect.succeed(
          liveResolvedMaterial({
            ref: request.materialRef,
            version,
            value,
            ...(dispose === undefined
              ? {}
              : {
                  dispose: () =>
                    Effect.sync(() => dispose({ ref: request.materialRef, material: value })),
                }),
          }),
        );
  },
});
