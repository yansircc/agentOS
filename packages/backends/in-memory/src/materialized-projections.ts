import { Effect, Layer } from "effect";
import {
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
import type { InMemoryBackendState } from "./state";

const projectionStorageError = (cause: unknown): RuntimeStorageError | UnregisteredProjectionKind =>
  cause instanceof UnregisteredProjectionKind ? cause : runtimeStorageError("projection", cause);

export const InMemoryMaterializedProjectionsLive = (
  state: InMemoryBackendState,
  _identity: BackendProtocolTruthIdentity,
): Layer.Layer<MaterializedProjections> => {
  const projectionIdentity = (
    spec: Pick<BackendProtocolEventIdentity, "scopeRef" | "effectAuthorityRef" | "factOwnerRef">,
  ): Effect.Effect<BackendProtocolEventIdentity, RuntimeStorageError> => {
    const specIdentity = {
      scopeRef: spec.scopeRef,
      effectAuthorityRef: spec.effectAuthorityRef,
      factOwnerRef: spec.factOwnerRef,
    };
    return isBackendProtocolEventIdentity(specIdentity)
      ? Effect.succeed(specIdentity)
      : Effect.fail(
          runtimeStorageError("projection", "materialized projection identity malformed"),
        );
  };

  return Layer.succeed(MaterializedProjections, {
    get: (spec) =>
      projectionIdentity(spec).pipe(
        Effect.andThen((eventIdentity) =>
          state
            .projectionGet({ ...spec, eventIdentity })
            .pipe(Effect.mapError(projectionStorageError)),
        ),
        Effect.withSpan("agentos.in_memory.projection.get"),
      ),
    list: (spec) =>
      projectionIdentity(spec).pipe(
        Effect.andThen((eventIdentity) =>
          state
            .projectionList({ ...spec, eventIdentity })
            .pipe(Effect.mapError(projectionStorageError)),
        ),
        Effect.withSpan("agentos.in_memory.projection.list"),
      ),
    status: (spec) =>
      projectionIdentity(spec).pipe(
        Effect.andThen((eventIdentity) =>
          state
            .projectionStatus({ ...spec, eventIdentity })
            .pipe(Effect.mapError(projectionStorageError)),
        ),
        Effect.withSpan("agentos.in_memory.projection.status"),
      ),
    rebuild: (spec) =>
      projectionIdentity(spec).pipe(
        Effect.andThen((eventIdentity) =>
          state
            .projectionRebuild({ ...spec, eventIdentity })
            .pipe(Effect.mapError(projectionStorageError)),
        ),
        Effect.withSpan("agentos.in_memory.projection.rebuild"),
      ),
  });
};
