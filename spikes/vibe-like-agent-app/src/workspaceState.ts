import { Effect, ManagedRuntime, Schema } from "effect";
import { createInMemoryRuntimeBackend } from "@agent-os/backend-in-memory";
import {
  Ledger,
  MaterializedProjections,
  defineProjection,
  projectionIdentity,
  projectionMalformed,
  projectionPut,
  type AnyMaterializedProjectionDefinition,
} from "@agent-os/runtime";
import { payload, recordField, stringField } from "./projectionPayload";

export interface WorkspaceFileState {
  readonly path: string;
  readonly blobRef: string | null;
  readonly digest: string;
  readonly metadata: Readonly<Record<string, string | number | boolean>>;
  readonly deleted: boolean;
}

export interface WorkspaceGitState {
  readonly repoRef: string;
  readonly branch: string;
  readonly statusRef: string;
  readonly diffRef: string;
}

export interface WorkspacePortState {
  readonly port: number;
  readonly status: "open" | "closed" | "probing";
  readonly urlRef: string | null;
  readonly observedAt: number;
}

export interface WorkspaceArtifactState {
  readonly artifactId: string;
  readonly blobRef: string;
  readonly digest: string;
  readonly role: string;
}

export interface WorkspaceUrlState {
  readonly urlRef: string;
  readonly purpose: string;
  readonly status: "pending" | "ready" | "closed";
}

const pathIdentity = (eventPayload: Record<string, unknown>) => {
  const path = eventPayload.path;
  return typeof path === "string"
    ? projectionIdentity({ path })
    : projectionMalformed("path is required");
};

export const workspaceFileProjection = defineProjection({
  kind: "workspace.file",
  version: 1,
  eventKinds: ["workspace.file.written", "workspace.file.deleted"],
  identity: Schema.Struct({ path: Schema.String }),
  state: Schema.Struct({
    path: Schema.String,
    blobRef: Schema.NullOr(Schema.String),
    digest: Schema.String,
    metadata: Schema.Record({
      key: Schema.String,
      value: Schema.Union(Schema.String, Schema.Number, Schema.Boolean),
    }),
    deleted: Schema.Boolean,
  }),
  identityKey: (identity) => identity.path,
  identify: (event) => pathIdentity(payload(event.payload)),
  initial: (identity, event): WorkspaceFileState => {
    const eventPayload = payload(event.payload);
    return {
      path: identity.path,
      blobRef: stringField(eventPayload, "blobRef", ""),
      digest: stringField(eventPayload, "digest", "digest:unknown"),
      metadata: recordField(eventPayload, "metadata"),
      deleted: false,
    };
  },
  reduce: (state, event) => {
    const eventPayload = payload(event.payload);
    if (event.kind === "workspace.file.deleted") {
      return projectionPut({
        ...state,
        blobRef: null,
        digest: stringField(eventPayload, "digest", state.digest),
        deleted: true,
      });
    }
    return projectionPut({
      ...state,
      blobRef: stringField(eventPayload, "blobRef", state.blobRef ?? ""),
      digest: stringField(eventPayload, "digest", state.digest),
      metadata: recordField(eventPayload, "metadata"),
      deleted: false,
    });
  },
});

export const workspaceGitProjection = defineProjection({
  kind: "workspace.git",
  version: 1,
  eventKinds: ["workspace.git.observed"],
  identity: Schema.Struct({ repoRef: Schema.String }),
  state: Schema.Struct({
    repoRef: Schema.String,
    branch: Schema.String,
    statusRef: Schema.String,
    diffRef: Schema.String,
  }),
  identityKey: (identity) => identity.repoRef,
  identify: (event) => {
    const eventPayload = payload(event.payload);
    const repoRef = eventPayload.repoRef;
    return typeof repoRef === "string"
      ? projectionIdentity({ repoRef })
      : projectionMalformed("repoRef is required");
  },
  initial: (identity, event): WorkspaceGitState => {
    const eventPayload = payload(event.payload);
    return {
      repoRef: identity.repoRef,
      branch: stringField(eventPayload, "branch", "main"),
      statusRef: stringField(eventPayload, "statusRef", "status:none"),
      diffRef: stringField(eventPayload, "diffRef", "diff:none"),
    };
  },
  reduce: (state, event) => {
    const eventPayload = payload(event.payload);
    return projectionPut({
      ...state,
      branch: stringField(eventPayload, "branch", state.branch),
      statusRef: stringField(eventPayload, "statusRef", state.statusRef),
      diffRef: stringField(eventPayload, "diffRef", state.diffRef),
    });
  },
});

export const workspacePortProjection = defineProjection({
  kind: "workspace.port",
  version: 1,
  eventKinds: ["workspace.port.probed", "workspace.port.opened", "workspace.port.closed"],
  identity: Schema.Struct({ port: Schema.Number }),
  state: Schema.Struct({
    port: Schema.Number,
    status: Schema.Literal("open", "closed", "probing"),
    urlRef: Schema.NullOr(Schema.String),
    observedAt: Schema.Number,
  }),
  identityKey: (identity) => String(identity.port),
  identify: (event) => {
    const port = payload(event.payload).port;
    return typeof port === "number" && Number.isFinite(port)
      ? projectionIdentity({ port })
      : projectionMalformed("port is required");
  },
  initial: (identity, event): WorkspacePortState => ({
    port: identity.port,
    status: "probing",
    urlRef: null,
    observedAt: event.ts,
  }),
  reduce: (state, event) => {
    const eventPayload = payload(event.payload);
    if (event.kind === "workspace.port.closed") {
      return projectionPut({
        ...state,
        status: "closed" as const,
        urlRef: null,
        observedAt: event.ts,
      });
    }
    if (event.kind === "workspace.port.opened") {
      return projectionPut({
        ...state,
        status: "open" as const,
        urlRef: stringField(eventPayload, "urlRef", state.urlRef ?? ""),
        observedAt: event.ts,
      });
    }
    return projectionPut({ ...state, status: "probing" as const, observedAt: event.ts });
  },
});

export const workspaceArtifactProjection = defineProjection({
  kind: "workspace.artifact",
  version: 1,
  eventKinds: ["workspace.artifact.created"],
  identity: Schema.Struct({ artifactId: Schema.String }),
  state: Schema.Struct({
    artifactId: Schema.String,
    blobRef: Schema.String,
    digest: Schema.String,
    role: Schema.String,
  }),
  identityKey: (identity) => identity.artifactId,
  identify: (event) => {
    const artifactId = payload(event.payload).artifactId;
    return typeof artifactId === "string"
      ? projectionIdentity({ artifactId })
      : projectionMalformed("artifactId is required");
  },
  initial: (identity, event): WorkspaceArtifactState => {
    const eventPayload = payload(event.payload);
    return {
      artifactId: identity.artifactId,
      blobRef: stringField(eventPayload, "blobRef", "blob:unknown"),
      digest: stringField(eventPayload, "digest", "digest:unknown"),
      role: stringField(eventPayload, "role", "artifact"),
    };
  },
  reduce: (state, event) => {
    const eventPayload = payload(event.payload);
    return projectionPut({
      ...state,
      blobRef: stringField(eventPayload, "blobRef", state.blobRef),
      digest: stringField(eventPayload, "digest", state.digest),
      role: stringField(eventPayload, "role", state.role),
    });
  },
});

export const workspaceUrlProjection = defineProjection({
  kind: "workspace.url",
  version: 1,
  eventKinds: ["workspace.url.observed"],
  identity: Schema.Struct({ urlRef: Schema.String }),
  state: Schema.Struct({
    urlRef: Schema.String,
    purpose: Schema.String,
    status: Schema.Literal("pending", "ready", "closed"),
  }),
  identityKey: (identity) => identity.urlRef,
  identify: (event) => {
    const urlRef = payload(event.payload).urlRef;
    return typeof urlRef === "string"
      ? projectionIdentity({ urlRef })
      : projectionMalformed("urlRef is required");
  },
  initial: (identity, event): WorkspaceUrlState => {
    const eventPayload = payload(event.payload);
    return {
      urlRef: identity.urlRef,
      purpose: stringField(eventPayload, "purpose", "preview"),
      status: stringField(eventPayload, "status", "pending") as WorkspaceUrlState["status"],
    };
  },
  reduce: (state, event) => {
    const eventPayload = payload(event.payload);
    return projectionPut({
      ...state,
      purpose: stringField(eventPayload, "purpose", state.purpose),
      status: stringField(eventPayload, "status", state.status) as WorkspaceUrlState["status"],
    });
  },
});

export const workspaceProjections: ReadonlyArray<AnyMaterializedProjectionDefinition> = [
  workspaceFileProjection,
  workspaceGitProjection,
  workspacePortProjection,
  workspaceArtifactProjection,
  workspaceUrlProjection,
];

export const runWorkspaceStateLoop = (scope = "vibe-like-workspace") => {
  const backend = createInMemoryRuntimeBackend({ scope, projections: workspaceProjections });
  const runtime = ManagedRuntime.make(backend.layer);

  const program = Effect.gen(function* () {
    const ledger = yield* Ledger;
    const projections = yield* MaterializedProjections;
    yield* ledger.commit([
      {
        kind: "workspace.file.written",
        payload: {
          path: "src/weather.ts",
          blobRef: "blob:weather-source-v1",
          digest: "sha256:file-v1",
          metadata: { bytes: 128, language: "ts" },
        },
        scope,
      },
      {
        kind: "workspace.git.observed",
        payload: {
          repoRef: "repo:workspace",
          branch: "main",
          statusRef: "git-status:clean",
          diffRef: "git-diff:weather-tool",
        },
        scope,
      },
      { kind: "workspace.port.probed", payload: { port: 8787 }, scope },
      {
        kind: "workspace.url.observed",
        payload: {
          urlRef: "url:preview-8787",
          purpose: "preview",
          status: "ready",
        },
        scope,
      },
      {
        kind: "workspace.port.opened",
        payload: { port: 8787, urlRef: "url:preview-8787" },
        scope,
      },
      {
        kind: "workspace.artifact.created",
        payload: {
          artifactId: "artifact:weather-build",
          blobRef: "blob:weather-build",
          digest: "sha256:artifact-v1",
          role: "build",
        },
        scope,
      },
    ]);

    return {
      file: yield* projections.get({
        kind: "workspace.file",
        scope,
        identity: { path: "src/weather.ts" },
      }),
      git: yield* projections.get({
        kind: "workspace.git",
        scope,
        identity: { repoRef: "repo:workspace" },
      }),
      port: yield* projections.get({ kind: "workspace.port", scope, identity: { port: 8787 } }),
      artifact: yield* projections.get({
        kind: "workspace.artifact",
        scope,
        identity: { artifactId: "artifact:weather-build" },
      }),
      url: yield* projections.get({
        kind: "workspace.url",
        scope,
        identity: { urlRef: "url:preview-8787" },
      }),
    };
  });

  return runtime.runPromise(program).finally(() => runtime.dispose());
};
