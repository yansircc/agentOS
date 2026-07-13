import { digestText } from "../shared";
import {
  STATIC_CLIENT_KIND,
  STATIC_PROFILE_KIND,
  STATIC_PROVIDER_PROTOCOL,
  STATIC_TARGET_KIND,
  type StaticCloudflareTarget,
  type StaticTargetGeneratedFile,
  type StaticTargetLink,
  type StaticTargetModuleImport,
  type StaticTargetPlan,
  type StaticTargetProfileProjection,
} from "./model";
import {
  generatedChannelImports,
  generatedDynamicResolverImports,
  generatedPath,
  generatedScheduleImports,
  generatedToolImports,
  importMaterialResolverPath,
  renderNamedImport,
  stableJson,
  staticTargetModules,
} from "./encoding";
import {
  renderChannelRegistry,
  renderScheduleRegistry,
  renderSkillResourceBundle,
} from "./registries";
import { renderWorkspaceStaticTarget } from "./renderers/profile-workspace";
import { renderChatStaticTarget } from "./renderers/profile-chat";
import { renderLocalAgentApp } from "./renderers/host-local";
import {
  renderCloudflareScopeHelper,
  renderCloudflareWorkerEntry,
  renderCloudflareWranglerConfig,
} from "./renderers/host-cloudflare";
import {
  generatedChatClientModuleImports,
  generatedSvelteKitClientModuleImports,
  generatedWorkspaceClientModuleImports,
  renderWorkspaceSvelteKitRemote,
} from "./renderers/client-remote-workspace";
import { renderChatSvelteKitRemote } from "./renderers/client-remote-chat";
import {
  renderChatBrowserDirectClient,
  renderChatSvelteKitClient,
  renderStaticClientTypes,
  renderWorkspaceBrowserDirectClient,
  renderWorkspaceSvelteKitClient,
} from "./renderers/client-browser";

interface SharedArtifactProjection {
  readonly moduleInventory: {
    readonly semanticCore: ReadonlyArray<StaticTargetModuleImport>;
    readonly skillResources: ReadonlyArray<StaticTargetModuleImport>;
    readonly authoredTools: ReadonlyArray<StaticTargetModuleImport>;
    readonly dynamicResolvers: ReadonlyArray<StaticTargetModuleImport>;
    readonly channels: ReadonlyArray<StaticTargetModuleImport>;
    readonly schedules: ReadonlyArray<StaticTargetModuleImport>;
  };
  readonly files: {
    readonly manifest: StaticTargetGeneratedFile;
    readonly provenance: StaticTargetGeneratedFile;
    readonly skillResources?: StaticTargetGeneratedFile;
    readonly channels?: StaticTargetGeneratedFile;
    readonly schedules?: StaticTargetGeneratedFile;
  };
  readonly skillResourceBundle: string;
}

interface ClientArtifactProjection {
  readonly moduleImports: ReadonlyArray<StaticTargetModuleImport>;
  readonly files: ReadonlyArray<StaticTargetGeneratedFile>;
}

const sharedArtifactProjectionFor = (
  plan: StaticTargetPlan,
  modules: ReturnType<typeof staticTargetModules>,
): SharedArtifactProjection => {
  const input = plan.profile.renderInput;
  const skills = input.bootstrap.skills;
  const skillResourceBundle = renderSkillResourceBundle(skills);
  const semanticCore: ReadonlyArray<StaticTargetModuleImport> = [
    { kind: "semantic-json", source: "./manifest.json", imports: ["default as declarations"] },
    { kind: "semantic-json", source: "./deployment.json", imports: ["default as deployment"] },
  ];
  const skillResources: ReadonlyArray<StaticTargetModuleImport> =
    skills.length === 0
      ? []
      : [
          {
            kind: "semantic-json",
            source: "./skill-resources.json",
            imports: ["default as skillResourcePayloads"],
          },
        ];
  const channels: ReadonlyArray<StaticTargetModuleImport> =
    input.channels.length === 0
      ? []
      : [
          {
            kind: "channel-runtime",
            source: modules.runtimeChannel,
            imports: ["DefinedChannel"],
          },
          ...generatedChannelImports(input.channels),
          {
            kind: "channel-registry",
            source: "./channels",
            imports: ["dispatchGeneratedChannelRequest", "generatedChannels"],
          },
        ];
  const schedules: ReadonlyArray<StaticTargetModuleImport> =
    input.schedules.length === 0
      ? []
      : [
          {
            kind: "schedule-runtime",
            source: modules.runtimeSchedule,
            imports: ["DefinedSchedule"],
          },
          ...generatedScheduleImports(input.schedules),
          {
            kind: "schedule-registry",
            source: "./schedules",
            imports: [
              "dispatchGeneratedSchedule",
              "dispatchGeneratedScheduleDelivery",
              "generatedScheduleDefinitions",
              "generatedSchedules",
            ],
          },
        ];
  return {
    skillResourceBundle,
    moduleInventory: {
      semanticCore,
      skillResources,
      authoredTools: generatedToolImports(plan.shared.authoredManifestToolNames),
      dynamicResolvers: generatedDynamicResolverImports(input.bootstrap.dynamicResolvers),
      channels,
      schedules,
    },
    files: {
      manifest: generatedPath(".agentos/generated/manifest.json", stableJson(plan.shared.manifest)),
      provenance: generatedPath(
        ".agentos/generated/provenance.json",
        stableJson(plan.shared.provenance),
      ),
      ...(skills.length === 0
        ? {}
        : {
            skillResources: generatedPath(
              ".agentos/generated/skill-resources.json",
              skillResourceBundle,
            ),
          }),
      ...(input.channels.length === 0
        ? {}
        : {
            channels: generatedPath(
              ".agentos/generated/channels.ts",
              renderChannelRegistry(input.channels, modules),
            ),
          }),
      ...(input.schedules.length === 0
        ? {}
        : {
            schedules: generatedPath(
              ".agentos/generated/schedules.ts",
              renderScheduleRegistry(input.schedules, modules),
            ),
          }),
    },
  };
};

const sharedGeneratedFilesFor = (
  plan: StaticTargetPlan,
  shared: SharedArtifactProjection,
  moduleGraph: ReadonlyArray<StaticTargetModuleImport>,
): ReadonlyArray<StaticTargetGeneratedFile> => [
  shared.files.manifest,
  generatedPath(".agentos/generated/deployment.json", stableJson(plan.host.deployment)),
  shared.files.provenance,
  ...(shared.files.skillResources === undefined ? [] : [shared.files.skillResources]),
  generatedPath(
    ".agentos/generated/fingerprints.json",
    stableJson({
      deployment: digestText(stableJson(plan.host.deployment)),
      manifest: digestText(stableJson(plan.shared.manifest)),
      ...(shared.files.skillResources === undefined
        ? {}
        : { skillResources: digestText(shared.skillResourceBundle) }),
      targetModuleGraph: digestText(stableJson(moduleGraph)),
    }),
  ),
  ...(shared.files.channels === undefined ? [] : [shared.files.channels]),
  ...(shared.files.schedules === undefined ? [] : [shared.files.schedules]),
];

const baseClientModuleImportsFor = (
  profile: StaticTargetProfileProjection,
  modules: ReturnType<typeof staticTargetModules>,
): ReadonlyArray<StaticTargetModuleImport> =>
  profile.kind === STATIC_PROFILE_KIND.WORKSPACE
    ? generatedWorkspaceClientModuleImports(modules)
    : generatedChatClientModuleImports(modules);

const clientArtifactProjectionFor = (
  plan: StaticTargetPlan,
  modules: ReturnType<typeof staticTargetModules>,
): ClientArtifactProjection => {
  const baseModuleImports = baseClientModuleImportsFor(plan.profile, modules);
  if (plan.client.kind === STATIC_CLIENT_KIND.DIRECT) {
    const browserDirect =
      plan.profile.kind === STATIC_PROFILE_KIND.WORKSPACE
        ? renderWorkspaceBrowserDirectClient(modules)
        : renderChatBrowserDirectClient(modules);
    return {
      moduleImports: baseModuleImports,
      files: [
        generatedPath(".agentos/generated/client.ts", browserDirect),
        generatedPath(".agentos/generated/client.d.ts", renderStaticClientTypes()),
      ],
    };
  }
  const svelteKitRemote =
    plan.profile.kind === STATIC_PROFILE_KIND.WORKSPACE
      ? renderWorkspaceSvelteKitRemote(modules)
      : renderChatSvelteKitRemote(modules);
  const svelteKitClient =
    plan.profile.kind === STATIC_PROFILE_KIND.WORKSPACE
      ? renderWorkspaceSvelteKitClient(modules)
      : renderChatSvelteKitClient(modules);
  return {
    moduleImports: [...baseModuleImports, ...generatedSvelteKitClientModuleImports(modules)],
    files: [
      generatedPath(".agentos/generated/sveltekit.remote.ts", svelteKitRemote),
      generatedPath(".agentos/generated/client.ts", svelteKitClient),
      generatedPath(".agentos/generated/client.d.ts", renderStaticClientTypes()),
    ],
  };
};

const cloudflareProfileModuleImports = (
  profile: StaticTargetProfileProjection,
  modules: ReturnType<typeof staticTargetModules>,
): {
  readonly capability: ReadonlyArray<StaticTargetModuleImport>;
  readonly workspaceHost: ReadonlyArray<StaticTargetModuleImport>;
  readonly executionDomain: ReadonlyArray<StaticTargetModuleImport>;
  readonly worker: ReadonlyArray<string>;
} =>
  profile.kind === STATIC_PROFILE_KIND.WORKSPACE
    ? {
        capability: [
          {
            kind: "capability-runtime",
            source: modules.runtimeCapability,
            imports: [
              "WORKSPACE_OPERATION_HOST_FACT",
              "defineHost",
              "resolveRuntimeInstallGraph",
              "runDynamicCapabilityResolvers",
              "workspaceOperations",
            ],
          },
        ],
        workspaceHost: [
          {
            kind: "workspace-host",
            source: modules.workspaceAgentHost,
            imports: ["defineWorkspaceAgentMount", "WORKSPACE_AGENT_PROJECTION"],
          },
        ],
        executionDomain: [
          {
            kind: "execution-domain-runtime",
            source: modules.workspaceEnvCloudflare,
            imports: ["createCloudflareSandboxWorkspaceEnvResolver"],
          },
          {
            kind: "workspace-binding",
            source: modules.workspaceBinding,
            imports: ["bindWorkspaceToolsForRuntime"],
          },
          {
            kind: "platform-runtime",
            source: modules.cloudflareSandbox,
            imports: ["getSandbox", "Sandbox", "SandboxTransport"],
          },
        ],
        worker: ["Sandbox"],
      }
    : {
        capability: [
          {
            kind: "capability-runtime",
            source: modules.runtimeCapability,
            imports: ["runDynamicCapabilityResolvers"],
          },
        ],
        workspaceHost: [
          {
            kind: "workspace-host",
            source: modules.workspaceAgentHost,
            imports: ["WORKSPACE_AGENT_COMMAND"],
          },
        ],
        executionDomain: [],
        worker: [],
      };

const renderNodeStaticTargetPlan = (
  plan: StaticTargetPlan,
  shared: SharedArtifactProjection,
  modules: ReturnType<typeof staticTargetModules>,
): StaticTargetLink => {
  const inventory = shared.moduleInventory;
  const moduleGraph: ReadonlyArray<StaticTargetModuleImport> = [
    ...inventory.semanticCore,
    ...inventory.skillResources,
    { kind: "local-runtime", source: modules.localRuntime, imports: ["lowerLocalAgentRuntime"] },
    {
      kind: "workspace-client",
      source: modules.productShellClient,
      imports: ["AgentSession", "createAgentSession"],
    },
    {
      kind: "capability-runtime",
      source: modules.runtimeCapability,
      imports: ["runDynamicCapabilityResolvers"],
    },
    {
      kind: "workspace-host",
      source: modules.workspaceAgentHost,
      imports: ["WorkspaceAgentCustomCommandInput"],
    },
    {
      kind: "target-runtime",
      source: modules.runtimeRunProjector,
      imports: [
        "projectAgentSession",
        "projectAgentSessions",
        "projectRunInspection",
        "projectWorkflowRun",
        "projectWorkflowRuns",
      ],
    },
    ...inventory.authoredTools,
    ...inventory.dynamicResolvers,
    ...inventory.channels,
    ...inventory.schedules,
  ];
  return {
    files: [
      ...sharedGeneratedFilesFor(plan, shared, moduleGraph),
      generatedPath(
        ".agentos/generated/local.ts",
        renderLocalAgentApp(plan.profile.renderInput, modules),
      ),
    ],
    moduleGraph,
    canonicalDeployment: {
      ...plan.profile.canonicalDeployment,
      ...plan.host.canonicalDeployment,
      llmRoute: STATIC_PROVIDER_PROTOCOL,
      client: plan.client.kind,
      toolNames: plan.shared.toolNames,
    },
    mount: { ...plan.host.mount, ...plan.profile.mount },
  };
};

const renderCloudflareStaticTargetPlan = (
  plan: StaticTargetPlan,
  shared: SharedArtifactProjection,
  modules: ReturnType<typeof staticTargetModules>,
): StaticTargetLink => {
  const target = plan.host.target as StaticCloudflareTarget;
  const client = clientArtifactProjectionFor(plan, modules);
  const profileImports = cloudflareProfileModuleImports(plan.profile, modules);
  const selected =
    plan.profile.kind === STATIC_PROFILE_KIND.WORKSPACE
      ? {
          targetText: renderWorkspaceStaticTarget(plan.profile.renderInput, target, modules),
          workerProfile: {
            sandboxImport: `${renderNamedImport(["Sandbox"], modules.cloudflareSandbox)}\n`,
            sandboxExport: ", Sandbox",
          },
          wranglerProfile: {
            vars: { SANDBOX_TRANSPORT: "rpc" },
            containers: [
              {
                class_name: "Sandbox",
                image: "../../Dockerfile",
                instance_type: "lite",
                max_instances: 2,
              },
            ],
            durable_objects: {
              bindings: [
                { class_name: "Sandbox", name: plan.profile.renderInput.workspace.binding },
                {
                  class_name: target.durableObject.className,
                  name: target.durableObject.binding,
                },
              ],
            },
            migrations: [
              {
                tag: "v1",
                new_sqlite_classes: ["Sandbox", target.durableObject.className],
              },
            ],
          },
        }
      : {
          targetText: renderChatStaticTarget(plan.profile.renderInput, target, modules),
          workerProfile: { sandboxImport: "", sandboxExport: "" },
          wranglerProfile: {
            durable_objects: {
              bindings: [
                {
                  class_name: target.durableObject.className,
                  name: target.durableObject.binding,
                },
              ],
            },
            migrations: [{ tag: "v1", new_sqlite_classes: [target.durableObject.className] }],
          },
        };
  const inventory = shared.moduleInventory;
  const moduleGraph: ReadonlyArray<StaticTargetModuleImport> = [
    ...inventory.semanticCore,
    {
      kind: "authored-material-resolver",
      source: importMaterialResolverPath(target.materialResolver.path),
      imports: ["default as generatedMaterialResolverFactory"],
    },
    ...inventory.skillResources,
    {
      kind: "target-runtime",
      source: modules.cloudflareDoRuntime,
      imports: ["createAgentDurableObject"],
    },
    ...inventory.channels,
    ...inventory.schedules,
    ...profileImports.capability,
    {
      kind: "provider-runtime",
      source: modules.openAiCompatibleTransport,
      imports: ["OpenAiCompatibleLlmTransportLive"],
    },
    ...profileImports.workspaceHost,
    ...inventory.authoredTools,
    ...inventory.dynamicResolvers,
    ...profileImports.executionDomain,
    { kind: "effect-runtime", source: modules.effect, imports: ["Effect"] },
    {
      kind: "target-scope-helper",
      source: "./cloudflare-scope",
      imports: ["agentOSRpcClient", "AgentOSTargetEnv"],
    },
    {
      kind: "target-worker",
      source: "./worker",
      imports: [target.durableObject.className, ...profileImports.worker],
    },
    { kind: "target-config", source: "./wrangler.jsonc", imports: [] },
    ...client.moduleImports,
  ];
  return {
    files: [
      ...sharedGeneratedFilesFor(plan, shared, moduleGraph),
      generatedPath(".agentos/generated/target.ts", selected.targetText),
      generatedPath(
        ".agentos/generated/cloudflare-scope.ts",
        renderCloudflareScopeHelper(plan.profile.renderInput, target, modules),
      ),
      generatedPath(
        ".agentos/generated/worker.ts",
        renderCloudflareWorkerEntry(
          plan.profile.renderInput,
          target,
          modules,
          selected.workerProfile,
        ),
      ),
      generatedPath(
        ".agentos/generated/wrangler.jsonc",
        renderCloudflareWranglerConfig(plan.profile.renderInput, selected.wranglerProfile),
      ),
      ...client.files,
    ],
    moduleGraph,
    canonicalDeployment: {
      ...plan.profile.canonicalDeployment,
      ...plan.host.canonicalDeployment,
      llmRoute: STATIC_PROVIDER_PROTOCOL,
      client: plan.client.kind,
      toolNames: plan.shared.toolNames,
    },
    mount: { ...plan.host.mount, ...plan.profile.mount },
  };
};

export const renderStaticTargetPlan = (plan: StaticTargetPlan): StaticTargetLink => {
  const modules = staticTargetModules(plan.shared.packageScope);
  const shared = sharedArtifactProjectionFor(plan, modules);
  return plan.host.kind === STATIC_TARGET_KIND.NODE
    ? renderNodeStaticTargetPlan(plan, shared, modules)
    : renderCloudflareStaticTargetPlan(plan, shared, modules);
};
