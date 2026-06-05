import { Effect, Layer } from "effect";
import { SqlError } from "@agent-os/kernel/errors";
import {
  backendProtocolEventIdentityKey,
  type BackendProtocolTruthIdentity,
} from "@agent-os/backend-protocol";
import { MaterializedProjections } from "@agent-os/runtime";
import { inMemoryRuntimeEventIdentity, type InMemoryBackendState } from "./state";

export const InMemoryMaterializedProjectionsLive = (
  state: InMemoryBackendState,
  identity: BackendProtocolTruthIdentity,
): Layer.Layer<MaterializedProjections> => {
  const eventIdentity = inMemoryRuntimeEventIdentity(identity);
  const scopeKey = backendProtocolEventIdentityKey(eventIdentity);
  const requireRuntimeProjectionScope = (scope: string): Effect.Effect<void, SqlError> =>
    scope === scopeKey
      ? Effect.void
      : Effect.fail(new SqlError({ cause: "materialized projection identity malformed" }));

  return Layer.succeed(MaterializedProjections, {
    get: (spec) =>
      requireRuntimeProjectionScope(spec.scope).pipe(
        Effect.andThen(() => state.projectionGet({ ...spec, eventIdentity })),
      ),
    list: (spec) =>
      requireRuntimeProjectionScope(spec.scope).pipe(
        Effect.andThen(() => state.projectionList({ ...spec, eventIdentity })),
      ),
    status: (spec) =>
      requireRuntimeProjectionScope(spec.scope).pipe(
        Effect.andThen(() => state.projectionStatus({ ...spec, eventIdentity })),
      ),
    rebuild: (spec) =>
      requireRuntimeProjectionScope(spec.scope).pipe(
        Effect.andThen(() => state.projectionRebuild({ ...spec, eventIdentity })),
      ),
  });
};
