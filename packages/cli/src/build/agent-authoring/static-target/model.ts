import type {
  AgentManifest,
  AgentScopeIdentityPolicy,
  ProviderResourceId,
  WorkspaceBindingRef,
  WorkspaceTopology,
} from "@agent-os/core/runtime-protocol";

export const STATIC_PROFILE_KIND = {
  WORKSPACE: "workspace",
  CHAT: "chat",
} as const;

export type StaticTargetProfileKind =
  (typeof STATIC_PROFILE_KIND)[keyof typeof STATIC_PROFILE_KIND];

export const STATIC_TARGET_KIND = {
  NODE: "node@1",
  CLOUDFLARE_DO: "cloudflare-do@1",
} as const;

export type StaticTargetKind = (typeof STATIC_TARGET_KIND)[keyof typeof STATIC_TARGET_KIND];

export const STATIC_CLIENT_KIND = {
  DIRECT: "direct",
  SVELTE_KIT_REMOTE: "svelte-kit-remote",
} as const;

export type StaticClientKind = (typeof STATIC_CLIENT_KIND)[keyof typeof STATIC_CLIENT_KIND];

export const STATIC_PROVIDER_PROTOCOL = "openai-chat-compatible" as const;

export type StaticDeploymentTargetKind = "node" | "cloudflare-do";
export type StaticTargetBindingKind = "local" | "deployment";

export interface StaticLlmRouteBinding {
  readonly protocol: typeof STATIC_PROVIDER_PROTOCOL;
  readonly route: typeof STATIC_PROVIDER_PROTOCOL;
  readonly endpointRef: string;
  readonly credentialRef: string;
  readonly modelRef: string;
}

export interface StaticCloudflareTarget {
  readonly kind: typeof STATIC_TARGET_KIND.CLOUDFLARE_DO;
  readonly durableObject: {
    readonly className: string;
    readonly binding: string;
  };
  readonly materialResolver: { readonly path: string };
}

export interface StaticNodeTarget {
  readonly kind: typeof STATIC_TARGET_KIND.NODE;
}

export type StaticTarget = StaticNodeTarget | StaticCloudflareTarget;
export type BoundAgentManifest = AgentManifest;

export interface StaticTargetProvenance {
  readonly manifest: Readonly<Record<string, string>>;
  readonly deployment: Readonly<Record<string, string>>;
  readonly exclusions: Readonly<Record<string, string>>;
}

export type StaticTargetGeneratedFilePath =
  | ".agentos/generated/manifest.json"
  | ".agentos/generated/deployment.json"
  | ".agentos/generated/provenance.json"
  | ".agentos/generated/fingerprints.json"
  | ".agentos/generated/skill-resources.json"
  | ".agentos/generated/channels.ts"
  | ".agentos/generated/schedules.ts"
  | ".agentos/generated/target.ts"
  | ".agentos/generated/local.ts"
  | ".agentos/generated/cloudflare-scope.ts"
  | ".agentos/generated/worker.ts"
  | ".agentos/generated/wrangler.jsonc"
  | ".agentos/generated/sveltekit.remote.ts"
  | ".agentos/generated/client.ts"
  | ".agentos/generated/client.d.ts";

export interface StaticTargetGeneratedFile {
  readonly path: StaticTargetGeneratedFilePath;
  readonly text: string;
}

export type StaticTargetModuleImportKind =
  | "target-runtime"
  | "target-scope-helper"
  | "target-worker"
  | "target-config"
  | "capability-runtime"
  | "provider-runtime"
  | "execution-domain-runtime"
  | "workspace-host"
  | "workspace-binding"
  | "channel-runtime"
  | "schedule-runtime"
  | "authored-channel"
  | "authored-material-resolver"
  | "authored-schedule"
  | "authored-dynamic-resolver"
  | "channel-registry"
  | "schedule-registry"
  | "platform-runtime"
  | "workspace-client"
  | "client-core"
  | "client-framework"
  | "client-transport"
  | "effect-runtime"
  | "local-runtime"
  | "semantic-json"
  | "authored-tool";

export interface StaticTargetModuleImport {
  readonly kind: StaticTargetModuleImportKind;
  readonly source: string;
  readonly imports: ReadonlyArray<string>;
}

export interface CanonicalDeploymentIR {
  readonly profile: StaticTargetProfileKind;
  readonly target: StaticTargetKind;
  readonly llmRoute: typeof STATIC_PROVIDER_PROTOCOL;
  readonly client: StaticClientKind;
  readonly workspaceTopology?: WorkspaceTopology;
  readonly toolNames: ReadonlyArray<string>;
}

export interface MountIR {
  readonly driver:
    | {
        readonly kind: "cloudflare-do";
        readonly className: string;
        readonly binding: string;
      }
    | {
        readonly kind: "local-node";
        readonly target: typeof STATIC_TARGET_KIND.NODE;
      };
  readonly projectionSinks: ReadonlyArray<
    | "agent.info"
    | "workspace.state"
    | "workspace.files"
    | "runtime.events"
    | "runtime.input_requests"
  >;
  readonly providerResourceId?: ProviderResourceId;
}

export interface StaticTargetLink {
  readonly files: ReadonlyArray<StaticTargetGeneratedFile>;
  readonly moduleGraph: ReadonlyArray<StaticTargetModuleImport>;
  readonly canonicalDeployment: CanonicalDeploymentIR;
  readonly mount: MountIR;
}

export type StaticTargetLinkIssue =
  | { readonly kind: "unsupported_static_target"; readonly target: StaticDeploymentTargetKind }
  | {
      readonly kind: "unsupported_static_combination";
      readonly profile: StaticTargetProfileKind;
      readonly target: StaticTargetKind;
      readonly client: StaticClientKind;
    }
  | { readonly kind: "unsupported_static_llm_route"; readonly route: string }
  | { readonly kind: "product_digest_mismatch" }
  | { readonly kind: "workspace_binding_required"; readonly host: StaticTargetBindingKind }
  | { readonly kind: "model_provider_unbound"; readonly logicalId: string }
  | { readonly kind: "tool_selection_unknown"; readonly toolId: string }
  | { readonly kind: "invalid_static_package_scope"; readonly scope: string };

export interface StaticTargetLinkOptions {
  readonly packageScope?: string;
}

export type StaticTargetLinkResult =
  | { readonly ok: true; readonly value: StaticTargetLink }
  | { readonly ok: false; readonly issues: ReadonlyArray<StaticTargetLinkIssue> };

export type StaticTargetOrigin = `path:${string}` | `author:${string}#${string}`;

export interface StaticTargetChannel {
  readonly name: string;
  readonly path: string;
  readonly origin: StaticTargetOrigin;
}

export interface StaticTargetSchedule {
  readonly scheduleId: string;
  readonly cron: string;
  readonly path: string;
  readonly origin: StaticTargetOrigin;
}

export interface StaticTargetSkillFile {
  readonly path: string;
  readonly digest: string;
  readonly bytes: number;
  readonly contentBase64: string;
}

export interface StaticTargetSkill {
  readonly name: string;
  readonly description: string;
  readonly path: string;
  readonly digest: string;
  readonly text: string;
  readonly files: ReadonlyArray<StaticTargetSkillFile>;
}

export interface StaticTargetInstructionFragment {
  readonly fragmentId: string;
  readonly path: string;
  readonly digest: string;
  readonly text: string;
  readonly origin: StaticTargetOrigin;
}

export interface StaticTargetDynamicResolver {
  readonly resolverId: string;
  readonly slot: "tools" | "skills" | "instructions";
  readonly path: string;
  readonly outputs: ReadonlyArray<string>;
  readonly origin: StaticTargetOrigin;
}

export interface StaticTargetPlanShared {
  readonly packageScope: string;
  readonly deployment: {
    readonly deploymentId: string;
    readonly codec: string;
    readonly providerStrategy?: string;
  };
  readonly manifest: BoundAgentManifest;
  readonly provenance: StaticTargetProvenance;
  readonly toolNames: ReadonlyArray<string>;
  readonly authoredManifestToolNames: ReadonlyArray<string>;
}

export interface StaticTargetClientProjection {
  readonly kind: StaticClientKind;
}

export interface StaticTargetProfileProjectionBase {
  readonly deployment: Readonly<Record<string, unknown>>;
  readonly canonicalDeployment: {
    readonly profile: StaticTargetProfileKind;
    readonly workspaceTopology?: WorkspaceTopology;
  };
  readonly mount: Pick<MountIR, "projectionSinks" | "providerResourceId">;
}

export interface StaticTargetBoundDeployment {
  readonly deploymentId: string;
  readonly manifest: BoundAgentManifest;
  readonly backend: "node" | "cloudflare-do";
  readonly adapter: StaticTargetKind;
  readonly codec: "agentos-json@1";
  readonly providerStrategy: typeof STATIC_PROVIDER_PROTOCOL;
}

export interface StaticRuntimeBootstrapModel {
  readonly toolNames: ReadonlyArray<string>;
  readonly customToolNames: ReadonlyArray<string>;
  readonly manifestTools: BoundAgentManifest["tools"];
  readonly llmRoutes: Readonly<Record<string, StaticLlmRouteBinding>>;
  readonly skills: ReadonlyArray<StaticTargetSkill>;
  readonly instructionFragments: ReadonlyArray<StaticTargetInstructionFragment>;
  readonly dynamicResolvers: ReadonlyArray<StaticTargetDynamicResolver>;
}

export interface StaticTargetWorkspaceOperations {
  readonly toolNames: ReadonlyArray<string>;
  readonly usesMutationTools: boolean;
  readonly usesShellTools: boolean;
}

export interface StaticTargetRenderInput {
  readonly deployment: StaticTargetBoundDeployment;
  readonly bootstrap: StaticRuntimeBootstrapModel;
  readonly channels: ReadonlyArray<StaticTargetChannel>;
  readonly schedules: ReadonlyArray<StaticTargetSchedule>;
  readonly workspaceOperations: StaticTargetWorkspaceOperations;
}

export interface StaticTargetWorkspace {
  readonly binding: string;
  readonly bindingRef: WorkspaceBindingRef;
  readonly root: string;
  readonly topology: WorkspaceTopology;
  readonly scope: {
    readonly idSource: "manifest";
    readonly scopeRef: { readonly kind: string; readonly scopeId: string };
  };
  readonly providerResourceId: ProviderResourceId;
}

export interface StaticTargetWorkspaceRenderInput extends StaticTargetRenderInput {
  readonly workspace: StaticTargetWorkspace;
}

export type StaticTargetProfileProjection =
  | (StaticTargetProfileProjectionBase & {
      readonly kind: typeof STATIC_PROFILE_KIND.WORKSPACE;
      readonly renderInput: StaticTargetWorkspaceRenderInput;
      readonly nodeWorkspace: StaticTargetWorkspace | null;
    })
  | (StaticTargetProfileProjectionBase & {
      readonly kind: typeof STATIC_PROFILE_KIND.CHAT;
      readonly renderInput: StaticTargetRenderInput;
      readonly nodeWorkspace: null;
    });

export interface StaticTargetHostProjection {
  readonly kind: StaticTargetKind;
  readonly target: StaticTarget;
  readonly deployment: Readonly<Record<string, unknown>>;
  readonly canonicalDeployment: Pick<CanonicalDeploymentIR, "target">;
  readonly mount: Pick<MountIR, "driver">;
}

export interface StaticTargetPlan {
  readonly shared: StaticTargetPlanShared;
  readonly profile: StaticTargetProfileProjection;
  readonly host: StaticTargetHostProjection;
  readonly client: StaticTargetClientProjection;
}

export type StaticTargetPlanResult =
  | { readonly ok: true; readonly value: StaticTargetPlan }
  | { readonly ok: false; readonly issues: ReadonlyArray<StaticTargetLinkIssue> };

export type StaticTargetModules = Readonly<{
  readonly [key: string]: string;
}>;

export type StaticTargetScopePolicy = AgentScopeIdentityPolicy;
