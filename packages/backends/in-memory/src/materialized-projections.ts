import { Effect, Layer } from "effect";
import {
  backendProtocolEventIdentityKey,
  isBackendProtocolEventIdentity,
  type BackendProtocolEventIdentity,
  type BackendProtocolTruthIdentity,
} from "@agent-os/backend-protocol";
import {
  MaterializedProjections,
  UnregisteredProjectionKind,
  runtimeStorageError,
  type RuntimeStorageError,
} from "@agent-os/runtime";
import { inMemoryRuntimeEventIdentity, type InMemoryBackendState } from "./state";

const projectionStorageError = (cause: unknown): RuntimeStorageError | UnregisteredProjectionKind =>
  cause instanceof UnregisteredProjectionKind ? cause : runtimeStorageError("projection", cause);

export const InMemoryMaterializedProjectionsLive = (
  state: InMemoryBackendState,
  identity: BackendProtocolTruthIdentity,
): Layer.Layer<MaterializedProjections> => {
  const eventIdentity = inMemoryRuntimeEventIdentity(identity);
  const eventIdentityKey = backendProtocolEventIdentityKey(eventIdentity);
  const requireRuntimeProjectionIdentity = (
    spec: Pick<BackendProtocolEventIdentity, "scopeRef" | "effectAuthorityRef" | "factOwnerRef">,
  ): Effect.Effect<void, RuntimeStorageError> => {
    const specIdentity = {
      scopeRef: spec.scopeRef,
      effectAuthorityRef: spec.effectAuthorityRef,
      factOwnerRef: spec.factOwnerRef,
    };
    return isBackendProtocolEventIdentity(specIdentity) &&
      backendProtocolEventIdentityKey(specIdentity) === eventIdentityKey
      ? Effect.void
      : Effect.fail(
          runtimeStorageError("projection", "materialized projection identity malformed"),
        );
  };

  return Layer.succeed(MaterializedProjections, {
    get: (spec) =>
      requireRuntimeProjectionIdentity(spec).pipe(
        Effect.andThen(() =>
          state
            .projectionGet({ ...spec, eventIdentity })
            .pipe(Effect.mapError(projectionStorageError)),
        ),
      ),
    list: (spec) =>
      requireRuntimeProjectionIdentity(spec).pipe(
        Effect.andThen(() =>
          state
            .projectionList({ ...spec, eventIdentity })
            .pipe(Effect.mapError(projectionStorageError)),
        ),
      ),
    status: (spec) =>
      requireRuntimeProjectionIdentity(spec).pipe(
        Effect.andThen(() =>
          state
            .projectionStatus({ ...spec, eventIdentity })
            .pipe(Effect.mapError(projectionStorageError)),
        ),
      ),
    rebuild: (spec) =>
      requireRuntimeProjectionIdentity(spec).pipe(
        Effect.andThen(() =>
          state
            .projectionRebuild({ ...spec, eventIdentity })
            .pipe(Effect.mapError(projectionStorageError)),
        ),
      ),
  });
};
