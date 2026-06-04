import { Effect, ManagedRuntime, Schema } from "effect";
import { createInMemoryRuntimeBackend } from "@agent-os/backend-in-memory";
import {
  Ledger,
  MaterializedProjections,
  defineProjection,
  projectionIdentity,
  projectionMalformed,
  projectionPut,
} from "@agent-os/runtime";
import { payload, stringField } from "./projectionPayload";

export interface DeployAppState {
  readonly appId: string;
  readonly status: "requested" | "deployed" | "readback_ok" | "readback_failed";
  readonly bundleRef: string;
  readonly workerRef: string | null;
  readonly version: string | null;
  readonly digest: string;
  readonly readbackDigest: string | null;
}

export const deployAppProjection = defineProjection({
  kind: "deploy.app",
  version: 1,
  eventKinds: ["deploy.requested", "deploy.completed", "deploy.readback"],
  identity: Schema.Struct({ appId: Schema.String }),
  state: Schema.Struct({
    appId: Schema.String,
    status: Schema.Literal("requested", "deployed", "readback_ok", "readback_failed"),
    bundleRef: Schema.String,
    workerRef: Schema.NullOr(Schema.String),
    version: Schema.NullOr(Schema.String),
    digest: Schema.String,
    readbackDigest: Schema.NullOr(Schema.String),
  }),
  identityKey: (identity) => identity.appId,
  identify: (event) => {
    const appId = payload(event.payload).appId;
    return typeof appId === "string"
      ? projectionIdentity({ appId })
      : projectionMalformed("appId is required");
  },
  initial: (identity, event): DeployAppState => {
    const eventPayload = payload(event.payload);
    return {
      appId: identity.appId,
      status: "requested",
      bundleRef: stringField(eventPayload, "bundleRef", "bundle:unknown"),
      workerRef: null,
      version: null,
      digest: stringField(eventPayload, "digest", "sha256:unknown"),
      readbackDigest: null,
    };
  },
  reduce: (state, event) => {
    const eventPayload = payload(event.payload);
    if (event.kind === "deploy.completed") {
      return projectionPut({
        ...state,
        status: "deployed" as const,
        workerRef: stringField(eventPayload, "workerRef", state.workerRef ?? ""),
        version: stringField(eventPayload, "version", state.version ?? ""),
        digest: stringField(eventPayload, "digest", state.digest),
      });
    }
    if (event.kind === "deploy.readback") {
      const readbackDigest = stringField(eventPayload, "readbackDigest", "");
      return projectionPut({
        ...state,
        status:
          readbackDigest.length > 0 && readbackDigest === state.digest
            ? ("readback_ok" as const)
            : ("readback_failed" as const),
        readbackDigest,
      });
    }
    return projectionPut({
      ...state,
      status: "requested" as const,
      bundleRef: stringField(eventPayload, "bundleRef", state.bundleRef),
      digest: stringField(eventPayload, "digest", state.digest),
    });
  },
});

export const runDeployPathLoop = (scope = "vibe-like-deploy") => {
  const backend = createInMemoryRuntimeBackend({ scope, projections: [deployAppProjection] });
  const runtime = ManagedRuntime.make(backend.layer);

  const program = Effect.gen(function* () {
    const ledger = yield* Ledger;
    const projections = yield* MaterializedProjections;
    yield* ledger.commit([
      {
        kind: "deploy.requested",
        payload: {
          appId: "weather-agent",
          bundleRef: "bundle:weather-agent-v1",
          digest: "sha256:worker-v1",
        },
        scope,
      },
      {
        kind: "deploy.completed",
        payload: {
          appId: "weather-agent",
          workerRef: "worker:weather-agent",
          version: "v1",
          digest: "sha256:worker-v1",
        },
        scope,
      },
      {
        kind: "deploy.readback",
        payload: {
          appId: "weather-agent",
          readbackDigest: "sha256:worker-v1",
        },
        scope,
      },
    ]);
    return yield* projections.get({
      kind: "deploy.app",
      scope,
      identity: { appId: "weather-agent" },
    });
  });

  return runtime.runPromise(program).finally(() => runtime.dispose());
};
