import { Layer } from "effect";
import { MaterializedProjections } from "@agent-os/runtime";
import type { InMemoryBackendState } from "./state";

export const InMemoryMaterializedProjectionsLive = (
  state: InMemoryBackendState,
): Layer.Layer<MaterializedProjections> =>
  Layer.succeed(MaterializedProjections, {
    get: (spec) => state.projectionGet(spec),
    list: (spec) => state.projectionList(spec),
    status: (spec) => state.projectionStatus(spec),
    rebuild: (spec) => state.projectionRebuild(spec),
  });
