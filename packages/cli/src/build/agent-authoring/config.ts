import { authoredValue } from "@agent-os/core/authored-value";
import type { MaterialRef } from "@agent-os/core/material-ref";
import type {
  AgentCapabilityBindingRef,
  AgentExecutionDomainRef,
  AgentManifest,
  AgentScopeKind,
  AgentToolBindingRef,
  ProviderResourceId,
  WorkspaceBindingRef,
  WorkspaceTopology,
} from "@agent-os/core/runtime-protocol";
import {
  WORKSPACE_TOPOLOGY,
  manifestScopeRefResult,
  workspaceBindingRef,
  workspaceProviderResourceId,
  type DeploymentSpec,
  type HandlerKind,
} from "@agent-os/core/runtime-protocol";
import {
  WORKSPACE_OP_FACT_OWNER,
  WORKSPACE_TOOL_DEFAULT_DECLARATIONS,
  type WorkspaceToolDefaultDeclaration,
  type WorkspaceToolName,
} from "@agent-os/runtime";
import { isNonEmptyString, isRecord, type JsonRecord } from "./shared";
import { workspaceManifestMacroOrigin } from "./manifest-compiler";
import type {
  AgentManifestFactKey,
  AgentManifestOrigin,
  AuthoredAgentManifest,
  CompiledAgentChannel,
  CompiledAgentSchedule,
  CompiledAgentSkill,
  CompiledAgentWorkflow,
  CompiledAgentManifest,
  WorkspaceDefaultToolControl,
} from "./manifest-compiler";

export const AGENTOS_CONFIG_PROFILE = {
  WORKSPACE_V1: "workspace@1",
  CHAT_V1: "chat@1",
} as const;

export type AgentOsConfigProfile =
  (typeof AGENTOS_CONFIG_PROFILE)[keyof typeof AGENTOS_CONFIG_PROFILE];

export const AGENTOS_CONFIG_TARGET = {
  CLOUDFLARE_DO_V1: "cloudflare-do@1",
  NODE_V1: "node@1",
} as const;

export type AgentOsConfigTargetKind =
  (typeof AGENTOS_CONFIG_TARGET)[keyof typeof AGENTOS_CONFIG_TARGET];

export const AGENTOS_CONFIG_CLIENT = {
  SVELTE_KIT_REMOTE_V1: "svelte-kit-remote@1",
  BROWSER_DIRECT_V1: "browser-direct@1",
} as const;

export type AgentOsConfigClientKind =
  (typeof AGENTOS_CONFIG_CLIENT)[keyof typeof AGENTOS_CONFIG_CLIENT];

export const AGENTOS_CONFIG_LLM_ROUTE = {
  OPENAI_CHAT_COMPATIBLE: "openai-chat-compatible",
} as const;

export type AgentOsConfigLlmRoute =
  (typeof AGENTOS_CONFIG_LLM_ROUTE)[keyof typeof AGENTOS_CONFIG_LLM_ROUTE];

export interface AgentOsConfigDeployment {
  readonly id: string;
  readonly version?: string;
}

export interface AgentOsConfigCloudflareDoTarget {
  readonly kind: typeof AGENTOS_CONFIG_TARGET.CLOUDFLARE_DO_V1;
  readonly durableObject: {
    readonly className: string;
    readonly binding: string;
  };
}

export interface AgentOsConfigNodeTarget {
  readonly kind: typeof AGENTOS_CONFIG_TARGET.NODE_V1;
}

export type AgentOsConfigTarget = AgentOsConfigCloudflareDoTarget | AgentOsConfigNodeTarget;

export interface AgentOsConfigClient {
  readonly kind: AgentOsConfigClientKind;
}

export interface AgentOsConfigLlmRouteBinding {
  readonly route: AgentOsConfigLlmRoute;
  readonly endpointRef: string;
  readonly credentialRef: string;
  readonly modelRef: string;
}

export interface AgentOsConfigLlm extends AgentOsConfigLlmRouteBinding {
  readonly routes?: Readonly<Record<string, AgentOsConfigLlmRouteBinding>>;
}

export type AgentOsConfigWorkspaceTopology = WorkspaceTopology;

export interface AgentOsConfigWorkspace {
  readonly binding: string;
  readonly root: string;
  readonly topology?: AgentOsConfigWorkspaceTopology;
}

export interface AgentOsConfigBase {
  readonly $schema?: string;
  readonly profile: AgentOsConfigProfile;
  readonly agent: string;
  readonly deployment: AgentOsConfigDeployment;
  readonly target: AgentOsConfigTarget;
  readonly client: AgentOsConfigClient;
  readonly llm: AgentOsConfigLlm;
}

export interface AgentOsWorkspaceConfigV1 extends AgentOsConfigBase {
  readonly profile: typeof AGENTOS_CONFIG_PROFILE.WORKSPACE_V1;
  readonly workspace: AgentOsConfigWorkspace;
}

export interface AgentOsChatConfigV1 extends AgentOsConfigBase {
  readonly profile: typeof AGENTOS_CONFIG_PROFILE.CHAT_V1;
  readonly workspace?: never;
}

export type AgentOsConfigV1 = AgentOsWorkspaceConfigV1 | AgentOsChatConfigV1;

export type AgentOsConfigFactKey = `/${string}`;

export type AgentOsConfigOrigin =
  | `author:agentos.config.jsonc#${AgentOsConfigFactKey}`
  | `macro(${typeof AGENTOS_CONFIG_PROFILE.WORKSPACE_V1})#${AgentOsConfigFactKey}`
  | `macro(${typeof AGENTOS_CONFIG_PROFILE.CHAT_V1})#${AgentOsConfigFactKey}`
  | `derived:${string}`;

export type AgentOsConfigIssue =
  | { readonly kind: "config_not_object"; readonly path: "agentos.config.jsonc" }
  | { readonly kind: "unknown_field"; readonly path: string; readonly field: string }
  | {
      readonly kind: "invalid_config_value";
      readonly path: string;
      readonly field: string;
      readonly reason: string;
    }
  | { readonly kind: "runtime_fact_forbidden"; readonly path: string; readonly field: string }
  | { readonly kind: "function_in_config"; readonly path: string }
  | {
      readonly kind: "workspace_scope_not_manifest_owned";
      readonly path: "agent/agent.json#/scope";
      readonly reason: "scope_not_manifest_owned" | "stable_scope_id_missing";
    }
  | {
      readonly kind: "workspace_submit_scope_requires_cloudflare_routing";
      readonly path: "agent/agent.json#/scope";
      readonly target: AgentOsConfigTargetKind;
    }
  | {
      readonly kind: "workspace_submit_scope_host_path_unsupported";
      readonly path: "agentos.config.jsonc#/client" | "agent/channels" | "agent/schedules";
      readonly hostPath: "svelte-kit-remote" | "channel" | "schedule";
    }
  | {
      readonly kind: "llm_material_env_name_collision";
      readonly path: "agentos.config.jsonc#/llm";
      readonly envName: string;
      readonly refs: readonly [string, string];
    }
  | {
      readonly kind: "workspace_default_tool_shadowed";
      readonly path: string;
      readonly toolId: WorkspaceToolName;
    }
  | {
      readonly kind: "tool_material_ref_unresolved";
      readonly toolId: string;
      readonly materialRef: string;
    }
  | {
      readonly kind: "tool_execution_domain_ref_unresolved";
      readonly toolId: string;
      readonly executionDomain: string;
    }
  | {
      readonly kind: "tool_interaction_ref_unresolved";
      readonly toolId: string;
      readonly interaction: string;
    };

export interface StaticTargetProvenance {
  readonly manifest: Readonly<Record<AgentManifestFactKey, AgentManifestOrigin>>;
  readonly deployment: Readonly<Record<AgentOsConfigFactKey, AgentOsConfigOrigin>>;
  readonly exclusions: Readonly<Record<string, AgentManifestOrigin>>;
}

export type DecodeAgentOsConfigResult =
  | { readonly ok: true; readonly value: AgentOsConfigV1 }
  | { readonly ok: false; readonly issues: ReadonlyArray<AgentOsConfigIssue> };

export interface NormalizedAgentOsConfigBase<M extends AgentManifest = AgentManifest> {
  readonly profile: AgentOsConfigProfile;
  readonly config: AgentOsConfigV1;
  readonly deployment: DeploymentSpec<M>;
  readonly deploymentVersion?: string;
  readonly authoredToolNames: ReadonlyArray<string>;
  readonly channels: ReadonlyArray<CompiledAgentChannel>;
  readonly workflows: ReadonlyArray<CompiledAgentWorkflow>;
  readonly schedules: ReadonlyArray<CompiledAgentSchedule>;
  readonly skills: ReadonlyArray<CompiledAgentSkill>;
  readonly instructionFragments: CompiledAgentManifest["instructionFragments"];
  readonly dynamicResolvers: CompiledAgentManifest["dynamicResolvers"];
  readonly target: AgentOsConfigTarget;
  readonly client: AgentOsConfigClient;
  readonly llm: AgentOsConfigLlmRouteBinding;
  readonly llmRoutes: Readonly<Record<string, AgentOsConfigLlmRouteBinding>>;
  readonly origins: Readonly<Record<AgentOsConfigFactKey, AgentOsConfigOrigin>>;
  readonly provenance: StaticTargetProvenance;
}

export interface NormalizedWorkspaceAgentOsConfig<
  M extends AgentManifest = AgentManifest,
> extends NormalizedAgentOsConfigBase<M> {
  readonly profile: typeof AGENTOS_CONFIG_PROFILE.WORKSPACE_V1;
  readonly config: AgentOsWorkspaceConfigV1;
  readonly workspace: AgentOsConfigWorkspace & {
    readonly topology: AgentOsConfigWorkspaceTopology;
    readonly bindingRef: WorkspaceBindingRef;
  } & (
      | {
          readonly scope: {
            readonly idSource: "manifest";
            readonly scopeRef: { readonly kind: AgentScopeKind; readonly scopeId: string };
          };
          readonly providerResourceId: ProviderResourceId;
        }
      | {
          readonly scope: {
            readonly idSource: "submit_scope";
            readonly kind: AgentScopeKind;
          };
        }
    );
}

export interface NormalizedChatAgentOsConfig<
  M extends AgentManifest = AgentManifest,
> extends NormalizedAgentOsConfigBase<M> {
  readonly profile: typeof AGENTOS_CONFIG_PROFILE.CHAT_V1;
  readonly config: AgentOsChatConfigV1;
}

export type NormalizedAgentOsConfig<M extends AgentManifest = AgentManifest> =
  | NormalizedWorkspaceAgentOsConfig<M>
  | NormalizedChatAgentOsConfig<M>;

export type NormalizeAgentOsConfigResult<M extends AgentManifest = AgentManifest> =
  | { readonly ok: true; readonly value: NormalizedAgentOsConfig<M> }
  | { readonly ok: false; readonly issues: ReadonlyArray<AgentOsConfigIssue> };

const configAuthorOrigin = (factKey: AgentOsConfigFactKey): AgentOsConfigOrigin =>
  `author:agentos.config.jsonc#${factKey}`;

const workspaceMacroOrigin = (factKey: AgentOsConfigFactKey): AgentOsConfigOrigin =>
  `macro(${AGENTOS_CONFIG_PROFILE.WORKSPACE_V1})#${factKey}`;

const chatMacroOrigin = (factKey: AgentOsConfigFactKey): AgentOsConfigOrigin =>
  `macro(${AGENTOS_CONFIG_PROFILE.CHAT_V1})#${factKey}`;

const targetOriginFacts = (
  target: AgentOsConfigTarget,
): Readonly<Record<AgentOsConfigFactKey, AgentOsConfigOrigin>> => ({
  "/target/kind": configAuthorOrigin("/target/kind"),
  ...(target.kind === AGENTOS_CONFIG_TARGET.CLOUDFLARE_DO_V1
    ? {
        "/target/durableObject/className": configAuthorOrigin("/target/durableObject/className"),
        "/target/durableObject/binding": configAuthorOrigin("/target/durableObject/binding"),
      }
    : {}),
});

const targetDeploymentBackend = (target: AgentOsConfigTarget): string =>
  target.kind === AGENTOS_CONFIG_TARGET.NODE_V1 ? "node" : "cloudflare-do";

const targetDeploymentAdapter = (target: AgentOsConfigTarget): AgentOsConfigTargetKind =>
  target.kind;

export type LlmMaterialEnvKind = "endpoint" | "credential" | "model";

export interface LlmMaterialEnvBinding {
  readonly kind: LlmMaterialEnvKind;
  readonly ref: string;
  readonly envName: string;
}

const materialEnvPrefix = (kind: LlmMaterialEnvKind): string =>
  kind === "endpoint"
    ? "AGENTOS_ENDPOINT"
    : kind === "credential"
      ? "AGENTOS_CREDENTIAL"
      : "AGENTOS_MODEL";

const materialEnvSuffix = (ref: string): string =>
  ref
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "REF";

export const materialEnvNameForRef = (kind: LlmMaterialEnvKind, ref: string): string =>
  `${materialEnvPrefix(kind)}_${materialEnvSuffix(ref)}`;

export const llmMaterialEnvBindingsForRefs = (
  refs: ReadonlyArray<{ readonly kind: LlmMaterialEnvKind; readonly ref: string }>,
): ReadonlyArray<LlmMaterialEnvBinding> =>
  refs.map(({ kind, ref }) => ({ kind, ref, envName: materialEnvNameForRef(kind, ref) }));

export const llmMaterialEnvNameCollisionIssues = (
  bindings: ReadonlyArray<LlmMaterialEnvBinding>,
): ReadonlyArray<
  Extract<AgentOsConfigIssue, { readonly kind: "llm_material_env_name_collision" }>
> => {
  const byEnv = new Map<string, string>();
  const issues: Extract<
    AgentOsConfigIssue,
    { readonly kind: "llm_material_env_name_collision" }
  >[] = [];
  for (const binding of bindings) {
    const materialRef = `${binding.kind}:${binding.ref}`;
    const existing = byEnv.get(binding.envName);
    if (existing === undefined) {
      byEnv.set(binding.envName, materialRef);
    } else if (existing !== materialRef) {
      issues.push({
        kind: "llm_material_env_name_collision",
        path: "agentos.config.jsonc#/llm",
        envName: binding.envName,
        refs: [existing, materialRef],
      });
    }
  }
  return issues;
};

export const llmMaterialEnvBindings = (
  llm: AgentOsConfigLlmRouteBinding,
): ReadonlyArray<LlmMaterialEnvBinding> =>
  llmMaterialEnvBindingsForRefs([
    { kind: "endpoint", ref: llm.endpointRef },
    { kind: "credential", ref: llm.credentialRef },
    { kind: "model", ref: llm.modelRef },
  ]);

export const llmMaterialEnvBindingsForRoutes = (
  routes: Readonly<Record<string, AgentOsConfigLlmRouteBinding>>,
): ReadonlyArray<LlmMaterialEnvBinding> =>
  Object.values(routes).flatMap((route) => llmMaterialEnvBindings(route));

const configAllowedFields = new Set([
  "$schema",
  "profile",
  "agent",
  "deployment",
  "target",
  "client",
  "llm",
  "workspace",
]);

const deploymentAllowedFields = new Set(["id", "version"]);
const nodeTargetAllowedFields = new Set(["kind"]);
const cloudflareTargetAllowedFields = new Set(["kind", "durableObject"]);
const durableObjectAllowedFields = new Set(["className", "binding"]);
const clientAllowedFields = new Set(["kind"]);
const llmAllowedFields = new Set(["route", "endpointRef", "credentialRef", "modelRef", "routes"]);
const llmRouteAllowedFields = new Set(["route", "endpointRef", "credentialRef", "modelRef"]);
const workspaceAllowedFields = new Set(["binding", "root", "topology"]);
const topologyAllowedFields = new Set(["kind", "allocator"]);

const configRuntimeFactFields = new Set([
  "continuation",
  "continuationRef",
  "inputRequestRef",
  "snapshot",
  "actualTriggerTime",
  "resumePayload",
  "resolvedMaterial",
  "secret",
  "credential",
  "triggerTime",
]);

const issueInvalidConfigValue = (
  issues: AgentOsConfigIssue[],
  path: string,
  field: string,
  reason: string,
): void => {
  issues.push({ kind: "invalid_config_value", path, field, reason });
};

const assertConfigAllowedFields = (
  issues: AgentOsConfigIssue[],
  path: string,
  value: JsonRecord,
  allowed: ReadonlySet<string>,
): void => {
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) issues.push({ kind: "unknown_field", path, field });
  }
};

const assertNoConfigRuntimeFacts = (
  issues: AgentOsConfigIssue[],
  path: string,
  value: JsonRecord,
): void => {
  const visit = (record: JsonRecord, fieldPrefix: string): void => {
    for (const [field, child] of Object.entries(record)) {
      const fieldPath = fieldPrefix.length === 0 ? field : `${fieldPrefix}.${field}`;
      if (configRuntimeFactFields.has(field)) {
        issues.push({ kind: "runtime_fact_forbidden", path, field: fieldPath });
      }
      if (typeof child === "function") {
        issues.push({ kind: "function_in_config", path: `${path}.${fieldPath}` });
      }
      if (isRecord(child)) visit(child, fieldPath);
      if (Array.isArray(child)) {
        for (let index = 0; index < child.length; index += 1) {
          const item = child[index];
          if (isRecord(item)) visit(item, `${fieldPath}[${index}]`);
          if (typeof item === "function") {
            issues.push({ kind: "function_in_config", path: `${path}.${fieldPath}[${index}]` });
          }
        }
      }
    }
  };
  visit(value, "");
};

const configStringField = (
  issues: AgentOsConfigIssue[],
  path: string,
  field: string,
  value: unknown,
): string | null => {
  if (isNonEmptyString(value)) return value;
  issueInvalidConfigValue(issues, path, field, "non_empty_string_required");
  return null;
};

const configOptionalStringField = (
  issues: AgentOsConfigIssue[],
  path: string,
  field: string,
  value: unknown,
): string | undefined => {
  if (value === undefined) return undefined;
  return configStringField(issues, path, field, value) ?? undefined;
};

const configRequiredRecord = (
  issues: AgentOsConfigIssue[],
  path: string,
  field: string,
  value: unknown,
): JsonRecord | null => {
  if (isRecord(value)) return value;
  issueInvalidConfigValue(issues, path, field, "object_required");
  return null;
};

const decodeDeploymentConfig = (
  issues: AgentOsConfigIssue[],
  value: unknown,
): AgentOsConfigDeployment | null => {
  const record = configRequiredRecord(issues, "agentos.config.jsonc", "/deployment", value);
  if (record === null) return null;
  assertConfigAllowedFields(issues, "/deployment", record, deploymentAllowedFields);
  const id = configStringField(issues, "/deployment", "/deployment/id", record.id);
  const version = configOptionalStringField(
    issues,
    "/deployment",
    "/deployment/version",
    record.version,
  );
  return id === null ? null : { id, ...(version === undefined ? {} : { version }) };
};

const decodeTargetConfig = (
  issues: AgentOsConfigIssue[],
  value: unknown,
): AgentOsConfigTarget | null => {
  const record = configRequiredRecord(issues, "agentos.config.jsonc", "/target", value);
  if (record === null) return null;
  if (record.kind === AGENTOS_CONFIG_TARGET.NODE_V1) {
    assertConfigAllowedFields(issues, "/target", record, nodeTargetAllowedFields);
    return { kind: AGENTOS_CONFIG_TARGET.NODE_V1 };
  }
  if (record.kind !== AGENTOS_CONFIG_TARGET.CLOUDFLARE_DO_V1) {
    assertConfigAllowedFields(issues, "/target", record, nodeTargetAllowedFields);
    issueInvalidConfigValue(issues, "/target", "/target/kind", "target_kind_invalid");
    return null;
  }
  assertConfigAllowedFields(issues, "/target", record, cloudflareTargetAllowedFields);
  const durableObject = configRequiredRecord(
    issues,
    "/target",
    "/target/durableObject",
    record.durableObject,
  );
  if (durableObject === null) return null;
  assertConfigAllowedFields(
    issues,
    "/target/durableObject",
    durableObject,
    durableObjectAllowedFields,
  );
  const className = configStringField(
    issues,
    "/target/durableObject",
    "/target/durableObject/className",
    durableObject.className,
  );
  const binding = configStringField(
    issues,
    "/target/durableObject",
    "/target/durableObject/binding",
    durableObject.binding,
  );
  return className === null || binding === null
    ? null
    : {
        kind: AGENTOS_CONFIG_TARGET.CLOUDFLARE_DO_V1,
        durableObject: { className, binding },
      };
};

const decodeClientConfig = (
  issues: AgentOsConfigIssue[],
  value: unknown,
): AgentOsConfigClient | null => {
  const record = configRequiredRecord(issues, "agentos.config.jsonc", "/client", value);
  if (record === null) return null;
  assertConfigAllowedFields(issues, "/client", record, clientAllowedFields);
  if (
    record.kind !== AGENTOS_CONFIG_CLIENT.SVELTE_KIT_REMOTE_V1 &&
    record.kind !== AGENTOS_CONFIG_CLIENT.BROWSER_DIRECT_V1
  ) {
    issueInvalidConfigValue(issues, "/client", "/client/kind", "client_kind_invalid");
    return null;
  }
  return { kind: record.kind };
};

const decodeLlmRouteConfig = (
  issues: AgentOsConfigIssue[],
  path: string,
  value: unknown,
  options: { readonly checkAllowedFields?: boolean } = {},
): AgentOsConfigLlmRouteBinding | null => {
  const record = configRequiredRecord(issues, "agentos.config.jsonc", path, value);
  if (record === null) return null;
  if (options.checkAllowedFields !== false) {
    assertConfigAllowedFields(issues, path, record, llmRouteAllowedFields);
  }
  if (record.route !== AGENTOS_CONFIG_LLM_ROUTE.OPENAI_CHAT_COMPATIBLE) {
    issueInvalidConfigValue(issues, path, `${path}/route`, "llm_route_invalid");
    return null;
  }
  const endpointRef = configStringField(issues, path, `${path}/endpointRef`, record.endpointRef);
  const credentialRef = configStringField(
    issues,
    path,
    `${path}/credentialRef`,
    record.credentialRef,
  );
  const modelRef = configStringField(issues, path, `${path}/modelRef`, record.modelRef);
  return endpointRef === null || credentialRef === null || modelRef === null
    ? null
    : {
        route: AGENTOS_CONFIG_LLM_ROUTE.OPENAI_CHAT_COMPATIBLE,
        endpointRef,
        credentialRef,
        modelRef,
      };
};

const routeBindingRefPattern = /^[A-Za-z0-9._:-]+$/u;

const decodeLlmRoutesConfig = (
  issues: AgentOsConfigIssue[],
  value: unknown,
): Readonly<Record<string, AgentOsConfigLlmRouteBinding>> | undefined => {
  if (value === undefined) return undefined;
  const record = configRequiredRecord(issues, "/llm", "/llm/routes", value);
  if (record === null) return undefined;
  const routes: Record<string, AgentOsConfigLlmRouteBinding> = {};
  for (const [bindingRef, routeValue] of Object.entries(record).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const routePath = `/llm/routes/${bindingRef}`;
    if (bindingRef === "default") {
      issueInvalidConfigValue(issues, routePath, routePath, "llm_default_route_duplicate");
      continue;
    }
    if (!routeBindingRefPattern.test(bindingRef)) {
      issueInvalidConfigValue(issues, routePath, routePath, "llm_route_binding_ref_invalid");
      continue;
    }
    const route = decodeLlmRouteConfig(issues, routePath, routeValue);
    if (route !== null) routes[bindingRef] = route;
  }
  return routes;
};

const decodeLlmConfig = (issues: AgentOsConfigIssue[], value: unknown): AgentOsConfigLlm | null => {
  const record = configRequiredRecord(issues, "agentos.config.jsonc", "/llm", value);
  if (record === null) return null;
  assertConfigAllowedFields(issues, "/llm", record, llmAllowedFields);
  const defaultRoute = decodeLlmRouteConfig(issues, "/llm", record, {
    checkAllowedFields: false,
  });
  const routes = decodeLlmRoutesConfig(issues, record.routes);
  return defaultRoute === null
    ? null
    : {
        ...defaultRoute,
        ...(routes === undefined ? {} : { routes }),
      };
};

const decodeWorkspaceTopologyConfig = (
  issues: AgentOsConfigIssue[],
  value: unknown,
): AgentOsConfigWorkspaceTopology | null => {
  const record = configRequiredRecord(issues, "/workspace", "/workspace/topology", value);
  if (record === null) return null;
  assertConfigAllowedFields(issues, "/workspace/topology", record, topologyAllowedFields);
  if (record.kind !== WORKSPACE_TOPOLOGY.PER_SCOPE) {
    issueInvalidConfigValue(
      issues,
      "/workspace/topology",
      "/workspace/topology/kind",
      "workspace_topology_kind_invalid",
    );
    return null;
  }
  const allocator = configStringField(
    issues,
    "/workspace/topology",
    "/workspace/topology/allocator",
    record.allocator,
  );
  return allocator === null ? null : { kind: WORKSPACE_TOPOLOGY.PER_SCOPE, allocator };
};

const decodeWorkspaceConfig = (
  issues: AgentOsConfigIssue[],
  value: unknown,
): AgentOsConfigWorkspace | null => {
  const record = configRequiredRecord(issues, "agentos.config.jsonc", "/workspace", value);
  if (record === null) return null;
  assertConfigAllowedFields(issues, "/workspace", record, workspaceAllowedFields);
  const binding = configStringField(issues, "/workspace", "/workspace/binding", record.binding);
  const root = configStringField(issues, "/workspace", "/workspace/root", record.root);
  const topology =
    record.topology === undefined
      ? undefined
      : decodeWorkspaceTopologyConfig(issues, record.topology);
  return binding === null || root === null || topology === null
    ? null
    : { binding, root, ...(topology === undefined ? {} : { topology }) };
};

export const decodeAgentOsConfig = (value: unknown): DecodeAgentOsConfigResult => {
  const issues: AgentOsConfigIssue[] = [];
  if (!isRecord(value))
    return { ok: false, issues: [{ kind: "config_not_object", path: "agentos.config.jsonc" }] };
  assertConfigAllowedFields(issues, "agentos.config.jsonc", value, configAllowedFields);
  assertNoConfigRuntimeFacts(issues, "agentos.config.jsonc", value);

  const schema = configOptionalStringField(
    issues,
    "agentos.config.jsonc",
    "/$schema",
    value.$schema,
  );
  if (
    value.profile !== AGENTOS_CONFIG_PROFILE.WORKSPACE_V1 &&
    value.profile !== AGENTOS_CONFIG_PROFILE.CHAT_V1
  ) {
    issueInvalidConfigValue(issues, "agentos.config.jsonc", "/profile", "profile_invalid");
  }
  const agent = configStringField(issues, "agentos.config.jsonc", "/agent", value.agent);
  const deployment = decodeDeploymentConfig(issues, value.deployment);
  const target = decodeTargetConfig(issues, value.target);
  const client = decodeClientConfig(issues, value.client);
  const llm = decodeLlmConfig(issues, value.llm);
  const workspace =
    value.profile === AGENTOS_CONFIG_PROFILE.WORKSPACE_V1
      ? decodeWorkspaceConfig(issues, value.workspace)
      : null;
  if (
    value.profile === AGENTOS_CONFIG_PROFILE.CHAT_V1 &&
    Object.prototype.hasOwnProperty.call(value, "workspace")
  ) {
    issueInvalidConfigValue(
      issues,
      "agentos.config.jsonc",
      "/workspace",
      "workspace_forbidden_for_chat_profile",
    );
  }
  if (
    issues.length > 0 ||
    agent === null ||
    deployment === null ||
    target === null ||
    client === null ||
    llm === null ||
    (value.profile === AGENTOS_CONFIG_PROFILE.WORKSPACE_V1 && workspace === null)
  ) {
    return { ok: false, issues };
  }
  const base = {
    ...(schema === undefined ? {} : { $schema: schema }),
    agent,
    deployment,
    target,
    client,
    llm,
  };
  if (value.profile === AGENTOS_CONFIG_PROFILE.CHAT_V1) {
    return {
      ok: true,
      value: {
        ...base,
        profile: AGENTOS_CONFIG_PROFILE.CHAT_V1,
      },
    };
  }
  return {
    ok: true,
    value: {
      ...base,
      profile: AGENTOS_CONFIG_PROFILE.WORKSPACE_V1,
      workspace: workspace as AgentOsConfigWorkspace,
    },
  };
};

const defaultWorkspaceTopology = (): AgentOsConfigWorkspaceTopology => ({
  kind: WORKSPACE_TOPOLOGY.PER_SCOPE,
  allocator: "workspace-per-scope-v1",
});

const workspaceMaterialRef = (ref: string): MaterialRef => ({
  kind: "external_resource",
  provider: "agent-os",
  resourceKind: "workspace-env",
  ref,
});

const submitScopeWorkspaceMaterialRef = (input: {
  readonly deploymentNamespace: string;
  readonly workspaceBindingRef: WorkspaceBindingRef;
}): string =>
  [
    "agentos-workspace-material",
    "v1",
    encodeURIComponent(input.deploymentNamespace),
    encodeURIComponent(input.workspaceBindingRef),
    "submit-scope",
  ].join(":");

const workspaceDefaultToolFactKey = (
  toolId: WorkspaceToolName,
  field: keyof AgentToolBindingRef,
): AgentManifestFactKey => `/tools/${toolId}/${field}`;

const workspaceExecutionDomainFactKey = "/executionDomains/workspace/bindingRef" as const;
const workspaceMaterialFactKey = "/materials/workspace" as const;
const workspaceCapabilityFactKey = "/capabilities/workspaceOperations/bindingRef" as const;

const defaultWorkspaceToolEntry = (
  tool: WorkspaceToolDefaultDeclaration,
  control: WorkspaceDefaultToolControl | undefined,
): AgentToolBindingRef => ({
  bindingRef: tool.name,
  executionDomain: tool.executionDomain,
  interaction:
    control?.kind === "override" && control.interaction !== undefined
      ? control.interaction.value
      : tool.interaction,
  materialRefs: tool.materialRefs,
  effects: tool.effects,
  receiptPolicy: tool.receiptPolicy,
});

const addDefaultWorkspaceToolProvenance = (
  provenance: Record<AgentManifestFactKey, AgentManifestOrigin>,
  tool: WorkspaceToolDefaultDeclaration,
  control: WorkspaceDefaultToolControl | undefined,
): void => {
  provenance[workspaceDefaultToolFactKey(tool.name, "bindingRef")] = workspaceManifestMacroOrigin(
    workspaceDefaultToolFactKey(tool.name, "bindingRef"),
  );
  provenance[workspaceDefaultToolFactKey(tool.name, "executionDomain")] =
    workspaceManifestMacroOrigin(workspaceDefaultToolFactKey(tool.name, "executionDomain"));
  provenance[workspaceDefaultToolFactKey(tool.name, "interaction")] =
    control?.kind === "override" && control.interaction !== undefined
      ? control.interaction.origin
      : workspaceManifestMacroOrigin(workspaceDefaultToolFactKey(tool.name, "interaction"));
  provenance[workspaceDefaultToolFactKey(tool.name, "materialRefs")] = workspaceManifestMacroOrigin(
    workspaceDefaultToolFactKey(tool.name, "materialRefs"),
  );
  provenance[workspaceDefaultToolFactKey(tool.name, "effects")] = workspaceManifestMacroOrigin(
    workspaceDefaultToolFactKey(tool.name, "effects"),
  );
  provenance[workspaceDefaultToolFactKey(tool.name, "receiptPolicy")] =
    workspaceManifestMacroOrigin(workspaceDefaultToolFactKey(tool.name, "receiptPolicy"));
};

const applyWorkspaceDefaultTools = <K extends HandlerKind>(
  compiled: CompiledAgentManifest<K>,
): {
  readonly manifest: AuthoredAgentManifest<K>;
  readonly provenance: StaticTargetProvenance["manifest"];
  readonly exclusions: StaticTargetProvenance["exclusions"];
  readonly issues: ReadonlyArray<AgentOsConfigIssue>;
} => {
  const issues: AgentOsConfigIssue[] = [];
  const tools: Record<string, AgentToolBindingRef> = { ...compiled.manifest.tools };
  const capabilities: Record<string, AgentCapabilityBindingRef> = {
    ...compiled.manifest.capabilities,
  };
  const executionDomains: Record<string, AgentExecutionDomainRef> = {
    ...compiled.manifest.executionDomains,
  };
  const provenance: Record<AgentManifestFactKey, AgentManifestOrigin> = {
    ...compiled.provenance,
  };
  const exclusions: Record<string, AgentManifestOrigin> = {};

  if (executionDomains.workspace === undefined) {
    executionDomains.workspace = { bindingRef: "workspace" };
    provenance[workspaceExecutionDomainFactKey] = workspaceManifestMacroOrigin(
      workspaceExecutionDomainFactKey,
    );
  }
  if (capabilities.workspaceOperations === undefined) {
    capabilities.workspaceOperations = { bindingRef: WORKSPACE_OP_FACT_OWNER };
    provenance[workspaceCapabilityFactKey] = workspaceManifestMacroOrigin(
      workspaceCapabilityFactKey,
    );
  }

  for (const defaultTool of WORKSPACE_TOOL_DEFAULT_DECLARATIONS) {
    const control = compiled.workspaceToolControls[defaultTool.name];
    const existing = compiled.manifest.tools?.[defaultTool.name];
    if (control?.kind === "disabled") {
      exclusions[`/tools/${defaultTool.name}`] = control.origin;
      continue;
    }
    if (existing !== undefined) {
      issues.push({
        kind: "workspace_default_tool_shadowed",
        path: compiled.toolFilePaths[defaultTool.name] ?? `agent/tools/${defaultTool.name}.ts`,
        toolId: defaultTool.name,
      });
      continue;
    }
    tools[defaultTool.name] = defaultWorkspaceToolEntry(defaultTool, control);
    addDefaultWorkspaceToolProvenance(provenance, defaultTool, control);
  }
  const manifestWithoutTools = { ...compiled.manifest } as AgentManifest<K>;
  delete (manifestWithoutTools as { tools?: unknown }).tools;
  delete (manifestWithoutTools as { capabilities?: unknown }).capabilities;
  delete (manifestWithoutTools as { executionDomains?: unknown }).executionDomains;
  const sortedTools = Object.fromEntries(
    Object.entries(tools).sort(([left], [right]) => left.localeCompare(right)),
  );
  const sortedCapabilities = Object.fromEntries(
    Object.entries(capabilities).sort(([left], [right]) => left.localeCompare(right)),
  );
  const sortedExecutionDomains = Object.fromEntries(
    Object.entries(executionDomains).sort(([left], [right]) => left.localeCompare(right)),
  );

  return {
    manifest: authoredValue({
      ...manifestWithoutTools,
      ...(Object.keys(sortedCapabilities).length === 0 ? {} : { capabilities: sortedCapabilities }),
      ...(Object.keys(sortedTools).length === 0 ? {} : { tools: sortedTools }),
      ...(Object.keys(sortedExecutionDomains).length === 0
        ? {}
        : { executionDomains: sortedExecutionDomains }),
    }) as AuthoredAgentManifest<K>,
    provenance,
    exclusions,
    issues,
  };
};

const addWorkspaceMaterial = <K extends HandlerKind>(
  manifest: AuthoredAgentManifest<K>,
  provenance: StaticTargetProvenance["manifest"],
  materialRef: string,
): {
  readonly manifest: AuthoredAgentManifest<K>;
  readonly provenance: StaticTargetProvenance["manifest"];
} => {
  if (manifest.materials?.workspace !== undefined) {
    return { manifest, provenance };
  }
  const materials = {
    ...manifest.materials,
    workspace: workspaceMaterialRef(materialRef),
  };
  const sortedMaterials = Object.fromEntries(
    Object.entries(materials).sort(([left], [right]) => left.localeCompare(right)),
  );
  return {
    manifest: authoredValue({
      ...manifest,
      materials: sortedMaterials,
    }) as AuthoredAgentManifest<K>,
    provenance: {
      ...provenance,
      [workspaceMaterialFactKey]: workspaceManifestMacroOrigin(workspaceMaterialFactKey),
    },
  };
};

const validateManifestToolReferences = <K extends HandlerKind>(
  manifest: AuthoredAgentManifest<K>,
): ReadonlyArray<AgentOsConfigIssue> => {
  const issues: AgentOsConfigIssue[] = [];
  for (const [toolId, tool] of Object.entries(manifest.tools ?? {}).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    for (const materialRef of tool.materialRefs ?? []) {
      if (manifest.materials?.[materialRef] === undefined) {
        issues.push({ kind: "tool_material_ref_unresolved", toolId, materialRef });
      }
    }
    if (
      tool.executionDomain !== undefined &&
      manifest.executionDomains?.[tool.executionDomain] === undefined
    ) {
      issues.push({
        kind: "tool_execution_domain_ref_unresolved",
        toolId,
        executionDomain: tool.executionDomain,
      });
    }
    if (tool.interaction !== undefined && manifest.interactions?.[tool.interaction] === undefined) {
      issues.push({
        kind: "tool_interaction_ref_unresolved",
        toolId,
        interaction: tool.interaction,
      });
    }
  }
  return issues;
};

const defaultLlmRoute = (llm: AgentOsConfigLlm): AgentOsConfigLlmRouteBinding => ({
  route: llm.route,
  endpointRef: llm.endpointRef,
  credentialRef: llm.credentialRef,
  modelRef: llm.modelRef,
});

const normalizedLlmRoutes = (
  llm: AgentOsConfigLlm,
): Readonly<Record<string, AgentOsConfigLlmRouteBinding>> => ({
  default: defaultLlmRoute(llm),
  ...(llm.routes ?? {}),
});

const addLlmRouteOrigins = (
  origins: Record<AgentOsConfigFactKey, AgentOsConfigOrigin>,
  llm: AgentOsConfigLlm,
): void => {
  origins["/llm/route"] = configAuthorOrigin("/llm/route");
  origins["/llm/endpointRef"] = configAuthorOrigin("/llm/endpointRef");
  origins["/llm/credentialRef"] = configAuthorOrigin("/llm/credentialRef");
  origins["/llm/modelRef"] = configAuthorOrigin("/llm/modelRef");
  for (const routeBindingRef of Object.keys(llm.routes ?? {}).sort()) {
    origins[`/llm/routes/${routeBindingRef}/route`] = configAuthorOrigin(
      `/llm/routes/${routeBindingRef}/route`,
    );
    origins[`/llm/routes/${routeBindingRef}/endpointRef`] = configAuthorOrigin(
      `/llm/routes/${routeBindingRef}/endpointRef`,
    );
    origins[`/llm/routes/${routeBindingRef}/credentialRef`] = configAuthorOrigin(
      `/llm/routes/${routeBindingRef}/credentialRef`,
    );
    origins[`/llm/routes/${routeBindingRef}/modelRef`] = configAuthorOrigin(
      `/llm/routes/${routeBindingRef}/modelRef`,
    );
  }
};

export const normalizeAgentOsConfig = <K extends HandlerKind = HandlerKind>(
  config: AgentOsConfigV1,
  compiled: CompiledAgentManifest<K>,
): NormalizeAgentOsConfigResult<AuthoredAgentManifest<K>> => {
  const decoded = decodeAgentOsConfig(config);
  if (!decoded.ok) return decoded;
  const value = decoded.value;
  const llmRoutes = normalizedLlmRoutes(value.llm);
  const llmEnvIssues = llmMaterialEnvNameCollisionIssues(
    llmMaterialEnvBindingsForRoutes(llmRoutes),
  );
  if (llmEnvIssues.length > 0) {
    return { ok: false, issues: llmEnvIssues };
  }
  const profileManifest =
    value.profile === AGENTOS_CONFIG_PROFILE.WORKSPACE_V1
      ? applyWorkspaceDefaultTools(compiled)
      : {
          manifest: compiled.manifest,
          provenance: compiled.provenance,
          exclusions: {},
          issues: [],
        };
  if (profileManifest.issues.length > 0) {
    return { ok: false, issues: profileManifest.issues };
  }
  if (value.profile === AGENTOS_CONFIG_PROFILE.CHAT_V1) {
    const scopeRef = manifestScopeRefResult(profileManifest.manifest);
    if (!scopeRef.ok) {
      return {
        ok: false,
        issues: [
          {
            kind: "workspace_scope_not_manifest_owned",
            path: "agent/agent.json#/scope",
            reason: scopeRef.reason,
          },
        ],
      };
    }
    const referenceIssues = validateManifestToolReferences(profileManifest.manifest);
    if (referenceIssues.length > 0) {
      return { ok: false, issues: referenceIssues };
    }
    const origins: Record<AgentOsConfigFactKey, AgentOsConfigOrigin> = {
      "/profile": configAuthorOrigin("/profile"),
      "/agent": configAuthorOrigin("/agent"),
      "/deployment/id": configAuthorOrigin("/deployment/id"),
      ...(value.deployment.version === undefined
        ? {}
        : { "/deployment/version": configAuthorOrigin("/deployment/version") }),
      ...targetOriginFacts(value.target),
      "/client/kind": configAuthorOrigin("/client/kind"),
      "/deployment/backend": `derived:/target/kind`,
      "/deployment/adapter": `derived:/target/kind`,
      "/deployment/codec": chatMacroOrigin("/deployment/codec"),
      "/deployment/providerStrategy": `derived:/llm/route`,
    };
    addLlmRouteOrigins(origins, value.llm);
    return {
      ok: true,
      value: {
        profile: AGENTOS_CONFIG_PROFILE.CHAT_V1,
        config: value,
        deployment: {
          deploymentId: value.deployment.id,
          manifest: profileManifest.manifest,
          backend: targetDeploymentBackend(value.target),
          adapter: targetDeploymentAdapter(value.target),
          codec: "agentos-json@1",
          providerStrategy: value.llm.route,
        },
        ...(value.deployment.version === undefined
          ? {}
          : { deploymentVersion: value.deployment.version }),
        authoredToolNames: Object.keys(compiled.toolFilePaths).sort(),
        channels: compiled.channels,
        workflows: compiled.workflows,
        schedules: compiled.schedules,
        skills: compiled.skills,
        instructionFragments: compiled.instructionFragments,
        dynamicResolvers: compiled.dynamicResolvers,
        target: value.target,
        client: value.client,
        llm: llmRoutes.default,
        llmRoutes,
        origins,
        provenance: {
          manifest: profileManifest.provenance,
          deployment: origins,
          exclusions: profileManifest.exclusions,
        },
      },
    };
  }
  const topology = value.workspace.topology ?? defaultWorkspaceTopology();
  const bindingRef = workspaceBindingRef(value.workspace.binding);
  const scopePolicy = profileManifest.manifest.scope;
  if (scopePolicy.idSource === "extension") {
    return {
      ok: false,
      issues: [
        {
          kind: "workspace_scope_not_manifest_owned",
          path: "agent/agent.json#/scope",
          reason: "scope_not_manifest_owned",
        },
      ],
    };
  }
  if (
    scopePolicy.idSource === "submit_scope" &&
    value.target.kind !== AGENTOS_CONFIG_TARGET.CLOUDFLARE_DO_V1
  ) {
    return {
      ok: false,
      issues: [
        {
          kind: "workspace_submit_scope_requires_cloudflare_routing",
          path: "agent/agent.json#/scope",
          target: value.target.kind,
        },
      ],
    };
  }
  if (scopePolicy.idSource === "submit_scope") {
    const unsupportedHostPaths: AgentOsConfigIssue[] = [
      ...(value.client.kind === AGENTOS_CONFIG_CLIENT.SVELTE_KIT_REMOTE_V1
        ? [
            {
              kind: "workspace_submit_scope_host_path_unsupported" as const,
              path: "agentos.config.jsonc#/client" as const,
              hostPath: "svelte-kit-remote" as const,
            },
          ]
        : []),
      ...(compiled.channels.length > 0
        ? [
            {
              kind: "workspace_submit_scope_host_path_unsupported" as const,
              path: "agent/channels" as const,
              hostPath: "channel" as const,
            },
          ]
        : []),
      ...(compiled.schedules.length > 0
        ? [
            {
              kind: "workspace_submit_scope_host_path_unsupported" as const,
              path: "agent/schedules" as const,
              hostPath: "schedule" as const,
            },
          ]
        : []),
    ];
    if (unsupportedHostPaths.length > 0) return { ok: false, issues: unsupportedHostPaths };
  }
  const manifestScopeRef =
    scopePolicy.idSource === "manifest" ? manifestScopeRefResult(profileManifest.manifest) : null;
  if (manifestScopeRef !== null && !manifestScopeRef.ok) {
    return {
      ok: false,
      issues: [
        {
          kind: "workspace_scope_not_manifest_owned",
          path: "agent/agent.json#/scope",
          reason: manifestScopeRef.reason,
        },
      ],
    };
  }
  const staticWorkspaceIdentity =
    manifestScopeRef !== null && manifestScopeRef.ok
      ? (() => {
          const scopeRef = {
            kind: scopePolicy.kind,
            scopeId: manifestScopeRef.value.scopeId,
          };
          const providerResourceId = workspaceProviderResourceId({
            deploymentNamespace: value.deployment.id,
            workspaceBindingRef: bindingRef,
            topology,
            scopeRef,
          });
          return {
            scope: { idSource: "manifest" as const, scopeRef },
            providerResourceId,
          };
        })()
      : null;
  const workspaceMaterialIdentity =
    staticWorkspaceIdentity?.providerResourceId ??
    submitScopeWorkspaceMaterialRef({
      deploymentNamespace: value.deployment.id,
      workspaceBindingRef: bindingRef,
    });
  const manifestWithWorkspaceMaterial = addWorkspaceMaterial(
    profileManifest.manifest,
    profileManifest.provenance,
    workspaceMaterialIdentity,
  );
  const referenceIssues = validateManifestToolReferences(manifestWithWorkspaceMaterial.manifest);
  if (referenceIssues.length > 0) {
    return { ok: false, issues: referenceIssues };
  }
  const origins: Record<AgentOsConfigFactKey, AgentOsConfigOrigin> = {
    "/profile": configAuthorOrigin("/profile"),
    "/agent": configAuthorOrigin("/agent"),
    "/deployment/id": configAuthorOrigin("/deployment/id"),
    ...(value.deployment.version === undefined
      ? {}
      : { "/deployment/version": configAuthorOrigin("/deployment/version") }),
    ...targetOriginFacts(value.target),
    "/client/kind": configAuthorOrigin("/client/kind"),
    "/workspace/binding": configAuthorOrigin("/workspace/binding"),
    "/workspace/bindingRef": `derived:/workspace/binding`,
    "/workspace/root": configAuthorOrigin("/workspace/root"),
    "/workspace/topology/kind":
      value.workspace.topology === undefined
        ? workspaceMacroOrigin("/workspace/topology/kind")
        : configAuthorOrigin("/workspace/topology/kind"),
    "/workspace/topology/allocator":
      value.workspace.topology === undefined
        ? workspaceMacroOrigin("/workspace/topology/allocator")
        : configAuthorOrigin("/workspace/topology/allocator"),
    "/deployment/backend": `derived:/target/kind`,
    "/deployment/adapter": `derived:/target/kind`,
    "/deployment/codec": workspaceMacroOrigin("/deployment/codec"),
    "/deployment/providerStrategy": `derived:/llm/route`,
    "/workspace/scope/idSource": `derived:agent/agent.json#/scope/idSource`,
    ...(staticWorkspaceIdentity === null
      ? { "/workspace/scope/kind": `derived:agent/agent.json#/scope/kind` as const }
      : {
          "/workspace/providerResourceId":
            `derived:/deployment/id+/workspace/binding+/workspace/topology+/agent/scope` as const,
        }),
  };
  addLlmRouteOrigins(origins, value.llm);
  return {
    ok: true,
    value: {
      profile: AGENTOS_CONFIG_PROFILE.WORKSPACE_V1,
      config: value,
      deployment: {
        deploymentId: value.deployment.id,
        manifest: manifestWithWorkspaceMaterial.manifest,
        backend: targetDeploymentBackend(value.target),
        adapter: targetDeploymentAdapter(value.target),
        codec: "agentos-json@1",
        providerStrategy: value.llm.route,
      },
      ...(value.deployment.version === undefined
        ? {}
        : { deploymentVersion: value.deployment.version }),
      authoredToolNames: Object.keys(compiled.toolFilePaths).sort(),
      channels: compiled.channels,
      workflows: compiled.workflows,
      schedules: compiled.schedules,
      skills: compiled.skills,
      instructionFragments: compiled.instructionFragments,
      dynamicResolvers: compiled.dynamicResolvers,
      target: value.target,
      client: value.client,
      llm: llmRoutes.default,
      llmRoutes,
      workspace: {
        binding: value.workspace.binding,
        bindingRef,
        root: value.workspace.root,
        topology,
        ...(staticWorkspaceIdentity ?? {
          scope: { idSource: "submit_scope" as const, kind: scopePolicy.kind },
        }),
      },
      origins,
      provenance: {
        manifest: manifestWithWorkspaceMaterial.provenance,
        deployment: origins,
        exclusions: profileManifest.exclusions,
      },
    },
  };
};
