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
import { payload, stringField } from "./projectionPayload";

export interface CredentialState {
  readonly credentialRef: string;
  readonly provider: string;
  readonly purpose: string;
  readonly status: "active" | "disabled";
}

export interface SkillState {
  readonly skillId: string;
  readonly zipRef: string;
  readonly versionHash: string;
  readonly enabled: boolean;
  readonly status: "installed" | "enabled" | "disabled" | "deleted";
}

export const credentialProjection = defineProjection({
  kind: "tenant.credential",
  version: 1,
  eventKinds: ["tenant.credential.registered", "tenant.credential.disabled"],
  identity: Schema.Struct({ credentialRef: Schema.String }),
  state: Schema.Struct({
    credentialRef: Schema.String,
    provider: Schema.String,
    purpose: Schema.String,
    status: Schema.Literal("active", "disabled"),
  }),
  identityKey: (identity) => identity.credentialRef,
  identify: (event) => {
    const credentialRef = payload(event.payload).credentialRef;
    return typeof credentialRef === "string"
      ? projectionIdentity({ credentialRef })
      : projectionMalformed("credentialRef is required");
  },
  initial: (identity, event): CredentialState => {
    const eventPayload = payload(event.payload);
    return {
      credentialRef: identity.credentialRef,
      provider: stringField(eventPayload, "provider", "unknown"),
      purpose: stringField(eventPayload, "purpose", "tool"),
      status: "active",
    };
  },
  reduce: (state, event) => {
    if (event.kind === "tenant.credential.disabled") {
      return projectionPut({ ...state, status: "disabled" as const });
    }
    const eventPayload = payload(event.payload);
    return projectionPut({
      ...state,
      provider: stringField(eventPayload, "provider", state.provider),
      purpose: stringField(eventPayload, "purpose", state.purpose),
      status: "active" as const,
    });
  },
});

export const skillProjection = defineProjection({
  kind: "tenant.skill",
  version: 1,
  eventKinds: [
    "tenant.skill.installed",
    "tenant.skill.enabled",
    "tenant.skill.disabled",
    "tenant.skill.deleted",
  ],
  identity: Schema.Struct({ skillId: Schema.String }),
  state: Schema.Struct({
    skillId: Schema.String,
    zipRef: Schema.String,
    versionHash: Schema.String,
    enabled: Schema.Boolean,
    status: Schema.Literal("installed", "enabled", "disabled", "deleted"),
  }),
  identityKey: (identity) => identity.skillId,
  identify: (event) => {
    const skillId = payload(event.payload).skillId;
    return typeof skillId === "string"
      ? projectionIdentity({ skillId })
      : projectionMalformed("skillId is required");
  },
  initial: (identity, event): SkillState => {
    const eventPayload = payload(event.payload);
    return {
      skillId: identity.skillId,
      zipRef: stringField(eventPayload, "zipRef", "zip:unknown"),
      versionHash: stringField(eventPayload, "versionHash", "sha256:unknown"),
      enabled: false,
      status: "installed",
    };
  },
  reduce: (state, event) => {
    const eventPayload = payload(event.payload);
    if (event.kind === "tenant.skill.enabled") {
      return projectionPut({ ...state, enabled: true, status: "enabled" as const });
    }
    if (event.kind === "tenant.skill.disabled") {
      return projectionPut({ ...state, enabled: false, status: "disabled" as const });
    }
    if (event.kind === "tenant.skill.deleted") {
      return projectionPut({ ...state, enabled: false, status: "deleted" as const });
    }
    return projectionPut({
      ...state,
      zipRef: stringField(eventPayload, "zipRef", state.zipRef),
      versionHash: stringField(eventPayload, "versionHash", state.versionHash),
      enabled: false,
      status: "installed" as const,
    });
  },
});

export const tenantConfigProjections: ReadonlyArray<AnyMaterializedProjectionDefinition> = [
  credentialProjection,
  skillProjection,
];

export const runTenantConfigLoop = (scope = "vibe-like-tenant") => {
  const backend = createInMemoryRuntimeBackend({ scope, projections: tenantConfigProjections });
  const runtime = ManagedRuntime.make(backend.layer);

  const program = Effect.gen(function* () {
    const ledger = yield* Ledger;
    const projections = yield* MaterializedProjections;
    yield* ledger.log(
      "tenant.credential.registered",
      {
        credentialRef: "credential:weather-api",
        provider: "weather",
        purpose: "tool-call",
      },
      scope,
    );
    yield* ledger.log(
      "tenant.skill.installed",
      {
        skillId: "weather-tool",
        zipRef: "zip:weather-tool-v1",
        versionHash: "sha256:weather-skill-v1",
      },
      scope,
    );
    yield* ledger.log("tenant.skill.enabled", { skillId: "weather-tool" }, scope);
    return {
      credential: yield* projections.get({
        kind: "tenant.credential",
        scope,
        identity: { credentialRef: "credential:weather-api" },
      }),
      skill: yield* projections.get({
        kind: "tenant.skill",
        scope,
        identity: { skillId: "weather-tool" },
      }),
    };
  });

  return runtime.runPromise(program).finally(() => runtime.dispose());
};
