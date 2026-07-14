import {
  makeProjectionRegistryResult,
  type AnyMaterializedProjectionDefinition,
} from "../../src/projection";
import {
  createInMemoryRuntimeBackend,
  defineResolvedRuntimeInstallGraph,
  type InMemoryRuntimeBackend,
  type InMemoryRuntimeInstallGraphInput,
} from "../../src/in-memory/runtime-backend";
import {
  createInMemoryBackendState,
  installInMemoryBackendStateProjectionRegistry,
  type InMemoryBackendState,
} from "../../src/in-memory/state";

export type TestInMemoryRuntimeOptions = Omit<
  InMemoryRuntimeInstallGraphInput,
  "identity" | "scope"
>;

export const createTestInMemoryBackendState = createInMemoryBackendState;

export const createTestInMemoryRuntimeBackend = (
  input: InMemoryRuntimeInstallGraphInput,
): InMemoryRuntimeBackend => createInMemoryRuntimeBackend(defineResolvedRuntimeInstallGraph(input));

export const installTestProjectionRegistry = (
  state: InMemoryBackendState,
  projections: ReadonlyArray<AnyMaterializedProjectionDefinition>,
): void => {
  installInMemoryBackendStateProjectionRegistry(state, makeProjectionRegistryResult(projections));
};
