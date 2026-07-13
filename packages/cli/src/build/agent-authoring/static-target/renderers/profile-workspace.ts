import { STATIC_TARGET_KIND } from "../model";
import type { StaticCloudflareTarget, StaticTargetWorkspaceRenderInput } from "../model";
import {
  importMaterialResolverPath,
  jsString,
  renderNamedImport,
  renderTypeImport,
  staticTargetModules,
  uniqueLlmMaterialEnvBindings,
} from "../encoding";
import {
  renderCloudflareMaterialResolverFactory,
  renderGeneratedWorkspaceOperations,
  renderProductApiDurableObjectMethods,
  renderProductApiHelpers,
  renderScheduleDurableObjectHelpers,
  renderScheduleDurableObjectMethod,
  renderStaticRuntimeBootstrap,
  renderStaticRuntimeBootstrapImports,
  renderSubmitSpecFromRunInput,
} from "../semantic-bootstrap";

export const renderWorkspaceStaticTarget = (
  normalized: StaticTargetWorkspaceRenderInput,
  target: StaticCloudflareTarget,
  modules: ReturnType<typeof staticTargetModules>,
): string => {
  const bootstrap = normalized.bootstrap;
  const hasSkills = bootstrap.skills.length > 0;
  const hasSchedules = normalized.schedules.length > 0;
  const workspaceToolList = normalized.workspaceOperations.toolNames;
  const workspaceToolArray = `[${workspaceToolList.map(jsString).join(", ")}] as const`;
  const usesMutationTools = normalized.workspaceOperations.usesMutationTools;
  const usesShellTools = normalized.workspaceOperations.usesShellTools;
  const handlerRecord = `{\n${normalized.deployment.manifest.handlers
    .map((handler) => `  ${jsString(handler)}: generatedHandler,`)
    .join("\n")}\n}`;
  const llmEnvBindings = uniqueLlmMaterialEnvBindings(bootstrap.llmRoutes).filter(
    (binding) => binding.kind === "model",
  );
  const generatedLlmEnvFields = llmEnvBindings
    .map((binding) => `  readonly ${binding.envName}?: string;`)
    .join("\n");
  const imports = [
    renderStaticRuntimeBootstrapImports(bootstrap, normalized.deployment.manifest.scope, modules),
    `import generatedMaterialResolverFactory from ${jsString(
      importMaterialResolverPath(target.materialResolver.path),
    )};`,
    `import deploymentProvenance from "./deployment.json";`,
    ...(hasSchedules
      ? [renderNamedImport(["dispatchGeneratedScheduleDelivery"], "./schedules")]
      : []),
    renderNamedImport(
      ["createAgentDurableObject", "createCloudflareSandboxWorkspaceEnvResolver"],
      modules.cloudflareDoRuntime,
    ),
    renderNamedImport(
      [
        "WORKSPACE_OPERATION_HOST_FACT",
        "defineHost",
        "resolveRuntimeInstallGraph",
        "workspaceOperations",
      ],
      modules.runtimeCapability,
    ),
    renderNamedImport(
      ["projectAgentSession", "projectAgentSessions", "projectWorkflowRun", "projectWorkflowRuns"],
      modules.runtimeRunProjector,
    ),
    renderNamedImport(
      ["defineWorkspaceAgentMount", "WORKSPACE_AGENT_PROJECTION"],
      modules.workspaceAgentHost,
    ),
    renderNamedImport(["bindWorkspaceToolsForRuntime"], modules.workspaceBinding),
    renderNamedImport(
      ["workspaceBindingRef", "workspaceProviderResourceId"],
      modules.runtimeProtocol,
    ),
    renderNamedImport(["getSandbox"], modules.cloudflareSandbox),
    renderTypeImport(
      ["InputRequestSettlement", "SubmitResult", "SubmitRunInput"],
      modules.runtimeProtocol,
    ),
    renderTypeImport(
      [
        "AgentSessionListProjection",
        "AgentSessionProjection",
        "WorkflowRunListProjection",
        "WorkflowRunProjection",
      ],
      modules.runtimeRunProjector,
    ),
    renderTypeImport(
      ["AgentSubmitSpec", "CloudflareMaterialResolverFactory", "CloudflareWorkspaceEnvResolver"],
      modules.cloudflareDoRuntime,
    ),
    renderTypeImport(["WorkspaceOperationEnvResolver"], modules.runtimeCapability),
    ...(hasSchedules ? [renderTypeImport(["GeneratedScheduleTriggerInput"], "./schedules")] : []),
    renderTypeImport(
      [
        "WorkspaceAgentDecideInputRequestCommandInput",
        "WorkspaceAgentCustomCommandInput",
        "WorkspaceAgentFileEntry",
        "WorkspaceAgentInspectInputRequestCommandInput",
        "WorkspaceAgentMutationCommandOutput",
        "WorkspaceAgentReadStateCommandInput",
        "WorkspaceAgentReadStateCommandOutput",
        "WorkspaceAgentReadFileCommandInput",
        "WorkspaceAgentReadFileCommandOutput",
        "WorkspaceAgentResumeInputRequestCommandInput",
      ],
      modules.workspaceAgentHost,
    ),
    renderTypeImport(["Sandbox", "SandboxTransport"], modules.cloudflareSandbox),
  ].join("\n");
  return `${imports}

export const targetDeclarations = semanticDeclarations;
export const targetDeployment = deploymentProvenance;

const generatedHandler = () => undefined;

type AgentOSTargetEnv = {
  readonly [binding: string]: unknown;
  readonly SANDBOX_TRANSPORT?: SandboxTransport;
${generatedLlmEnvFields}
};

${renderStaticRuntimeBootstrap(bootstrap, normalized.deployment.manifest.scope)}
${renderCloudflareMaterialResolverFactory()}

${renderGeneratedWorkspaceOperations(workspaceToolArray, usesMutationTools, usesShellTools)}
const generatedWorkspaceScopeKind = ${jsString(normalized.deployment.manifest.scope.kind)};
const generatedWorkspaceBindingRef = workspaceBindingRef(${jsString(
    normalized.workspace.bindingRef,
  )});
const generatedWorkspaceResolverCache = new WeakMap<object, CloudflareWorkspaceEnvResolver>();

const workspaceNamespaceFor = (env: AgentOSTargetEnv): DurableObjectNamespace<Sandbox> =>
  env[${jsString(normalized.workspace.binding)}] as DurableObjectNamespace<Sandbox>;

const generatedWorkspaceRefFor = (scope: string) =>
  workspaceProviderResourceId({
    deploymentNamespace: ${jsString(normalized.deployment.deploymentId)},
    workspaceBindingRef: generatedWorkspaceBindingRef,
    topology: ${JSON.stringify(normalized.workspace.topology)},
    scopeRef: { kind: generatedWorkspaceScopeKind, scopeId: scope },
  });

const generatedWorkspaceResolverFor = (
  env: AgentOSTargetEnv,
): CloudflareWorkspaceEnvResolver => {
  const existing = generatedWorkspaceResolverCache.get(env);
  if (existing !== undefined) return existing;
  const created = createCloudflareSandboxWorkspaceEnvResolver({
    binding: workspaceNamespaceFor(env),
    cwd: ${jsString(normalized.workspace.root)},
    scopePrefix: ${jsString(
      `${normalized.deployment.deploymentId}-${normalized.workspace.bindingRef}`,
    )},
    workspaceRef: ({ scope }) => generatedWorkspaceRefFor(scope),
  });
  generatedWorkspaceResolverCache.set(env, created);
  return created;
};

const generatedWorkspaceLeaseFor = (
  env: AgentOSTargetEnv,
  scope: string,
  runId: string,
) => generatedWorkspaceResolverFor(env).resolve({ scope, runId });

const workspaceSandboxFor = async (
  env: AgentOSTargetEnv,
  scope: string,
): Promise<Sandbox> => {
  const lease = await generatedWorkspaceLeaseFor(env, scope, "workspace-command");
  return getSandbox(workspaceNamespaceFor(env), lease.sandboxId, {
    normalizeId: true,
    sleepAfter: "10m",
    transport: env.SANDBOX_TRANSPORT ?? "rpc",
  });
};

type WorkspacePathResult =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly message: string };

const workspacePathFor = (path: string): WorkspacePathResult => {
  const parts = path
    .split("/")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.some((part) => part === "." || part === "..")) {
    return { ok: false, message: "path escapes workspace" };
  }
  return {
    ok: true,
    path: parts.length === 0 ? ${jsString(normalized.workspace.root)} : ${jsString(
      `${normalized.workspace.root}/`,
    )} + parts.join("/"),
  };
};

const relativeWorkspacePath = (path: string): string =>
  path.startsWith(${jsString(`${normalized.workspace.root}/`)})
    ? path.slice(${normalized.workspace.root.length + 1})
    : path;

type WorkspaceListFile = {
  readonly type?: string;
  readonly relativePath?: string;
  readonly absolutePath?: string;
  readonly size?: number;
  readonly mtimeMs?: number;
  readonly sha256?: string;
};

const workspaceFileKind = (type: string | undefined): WorkspaceAgentFileEntry["kind"] =>
  type === "file" || type === "directory" ? type : "other";

const workspaceFileEntryFor = (value: unknown): WorkspaceAgentFileEntry | null => {
  if (typeof value === "string") {
    return { path: relativeWorkspacePath(value), kind: "file" };
  }
  if (value === null || typeof value !== "object") return null;
  const file = value as WorkspaceListFile;
  const path =
    typeof file.relativePath === "string" && file.relativePath.length > 0
      ? file.relativePath
      : typeof file.absolutePath === "string" && file.absolutePath.length > 0
        ? relativeWorkspacePath(file.absolutePath)
        : "";
  if (path.length === 0) return null;
  return {
    path,
    kind: workspaceFileKind(file.type),
    ...(typeof file.size === "number" ? { size: file.size } : {}),
    ...(typeof file.mtimeMs === "number" ? { mtimeMs: file.mtimeMs } : {}),
    ...(typeof file.sha256 === "string" ? { sha256: file.sha256 } : {}),
  };
};

const generatedWorkspaceOperationEnvFor = (
  env: AgentOSTargetEnv,
): WorkspaceOperationEnvResolver => async (input) => {
  if (input.mode !== "operation") {
    throw Error("workspace binding must be resolved under an authenticated routing scope");
  }
  if (input.runId === undefined || input.runId.length === 0) {
    throw Error("workspace operation is missing runtime-owned run identity");
  }
  const scope = input.event.scopeRef.scopeId;
  if (input.workspaceRef !== generatedWorkspaceRefFor(scope)) {
    throw Error("workspace operation ref does not match authenticated event scope");
  }
  const lease = await generatedWorkspaceLeaseFor(
    env,
    scope,
    input.runId,
  );
  return lease.env;
};

const generatedHostProfileFor = (env: AgentOSTargetEnv) => defineHost({
  target: "cloudflare-do@1",
  provides: [
    "storage.ledger",
    "durability.do",
    WORKSPACE_OPERATION_HOST_FACT,
    "timer.durable",
    "network.outbound",
    "secrets.store",
    "eventLoop.durable",
    "llm.openai",
  ],
  materialize: () => ({
    [WORKSPACE_OPERATION_HOST_FACT]: generatedWorkspaceOperationEnvFor(env),
  }),
});

const generatedCapabilityInstallGraphFor = (env: AgentOSTargetEnv) => {
  const graph = resolveRuntimeInstallGraph(
    generatedHostProfileFor(env),
    [workspaceOperations({ ...generatedWorkspaceOperations, toolNames: [] })],
    { identity: semanticManifest.agentId },
  );
  if (!graph.ok) {
    throw Error(
      graph.diagnostics
        .map((diagnostic) => diagnostic.reason)
        .join("; ") || "capability install graph failed",
    );
  }
  return graph.resolved;
};

const generatedSubmitBindingsFor = async (
  env: AgentOSTargetEnv,
  scope: string,
  event: DynamicCapabilityEventRef = generatedDynamicCapabilityTurnEvent(),
  dynamicCapability: DynamicCapabilityRunInput | undefined = undefined,
): Promise<GeneratedTargetResult<AgentSubmitBindings>> => {
  const preflightDiagnostics = generatedProviderPreflightDiagnosticsFor(
    env,
    generatedMaterialResolverFor(env),
  );
  if (preflightDiagnostics.length > 0) {
    return targetFailure(
      "OpenAI-compatible provider material preflight failed",
      preflightDiagnostics,
    );
  }
  const capabilityGraph = generatedCapabilityInstallGraphFor(env);
  const routes = generatedLlmRoutesFor(env);
  if (!routes.ok) return routes;
  const dynamicBindings = await generatedDynamicSubmitBindingsFor(event, dynamicCapability);
  if (!dynamicBindings.ok) return dynamicBindings;
  const workspaceLease = await generatedWorkspaceLeaseFor(env, scope, "submit-bindings");
  const workspaceBindings = bindWorkspaceToolsForRuntime({
    env: workspaceLease.env,
    authority: "agentos.workspace.capability",
    admit: () => Effect.succeed({ ok: true as const }),
    ...generatedWorkspaceOperations,
  });
  const dynamicCapabilityProjection = dynamicBindings.value.dynamicCapabilityProjection;
  return {
    ok: true,
    value: {
      ...capabilityGraph.bindings,
      ...workspaceBindings,
      ...dynamicBindings.value,
      llmRoutes: routes.value,
      tools: {
        ...(capabilityGraph.bindings.tools ?? {}),
        ...(workspaceBindings.tools ?? {}),
        ...generatedCustomTools,
        ${hasSkills ? "...generatedFrameworkToolsFor(dynamicCapabilityProjection)," : ""}
      },
    },
  };
};

${renderSubmitSpecFromRunInput(hasSkills)}

${renderProductApiHelpers()}
${hasSchedules ? renderScheduleDurableObjectHelpers() : ""}

export const workspaceMount = defineWorkspaceAgentMount({
  driver: { kind: "driver_mount", client: undefined as never },
  projectionSinks: [
    { kind: "projection_sink", name: WORKSPACE_AGENT_PROJECTION.AGENT_INFO },
    { kind: "projection_sink", name: WORKSPACE_AGENT_PROJECTION.STATE },
    { kind: "projection_sink", name: WORKSPACE_AGENT_PROJECTION.FILES },
    { kind: "projection_sink", name: WORKSPACE_AGENT_PROJECTION.RUN_EVENTS },
    { kind: "projection_sink", name: WORKSPACE_AGENT_PROJECTION.INPUT_REQUESTS },
  ],
});

const Base${target.durableObject.className} = createAgentDurableObject<AgentOSTargetEnv>({
  manifest: semanticManifest,
  agentBindings: (env) => ({
    handlers: ${handlerRecord},
    ...generatedCapabilityInstallGraphFor(env).agentBindings,
  }),
  refResolver: generatedMaterialResolverFor,
  llmTransport: () => OpenAiCompatibleLlmTransportLive,
  extensions: (env) => generatedCapabilityInstallGraphFor(env).extensions,
  declaredIntents: (env) => generatedCapabilityInstallGraphFor(env).declaredIntents,
  projections: (env) => generatedCapabilityInstallGraphFor(env).projections,
  graphStatus: (env) => generatedCapabilityInstallGraphFor(env).graphStatus,
  eventHandlers: (context, env) => generatedCapabilityInstallGraphFor(env).handlers(context),
});

export class ${target.durableObject.className} extends Base${target.durableObject.className} {
  private readonly targetEnv: AgentOSTargetEnv;
  private readonly targetScope: string;
  private readonly targetTruthIdentity: LedgerTruthIdentity;

  constructor(ctx: DurableObjectState, env: AgentOSTargetEnv) {
    super(ctx, env);
    const scope = ctx.id.name;
    if (scope === undefined || scope.length === 0) {
      throw Error("authenticated Durable Object routing scope is missing");
    }
    this.targetEnv = env;
    this.targetScope = scope;
    this.targetTruthIdentity = semanticTruthIdentityFor(scope);
  }

  override submit(spec: AgentSubmitSpec): Promise<SubmitResult> {
    return generatedSubmitBindingsFor(
      this.targetEnv,
      this.targetScope,
      generatedDynamicCapabilityTurnEvent(),
      spec.dynamicCapability,
    ).then((bindings) =>
      bindings.ok ? this.submitWithBindings(spec, bindings.value) : rejectTargetFailure(bindings),
    );
  }

  submitRunInput(input: SubmitRunInput): Promise<SubmitResult> {
    return generatedSubmitBindingsFor(
      this.targetEnv,
      this.targetScope,
      generatedDynamicCapabilityTurnEvent(),
      input.dynamicCapability,
    ).then((bindings) =>
      bindings.ok
        ? this.submitWithBindings(
            submitSpecFromRunInput(input, bindings.value.dynamicCapabilityProjection),
            bindings.value,
          )
        : rejectTargetFailure(bindings),
    );
  }

${renderProductApiDurableObjectMethods("this.targetTruthIdentity", "this.targetScope")}
${hasSchedules ? renderScheduleDurableObjectMethod("this.targetTruthIdentity") : ""}

  resumeInputRequest(input: WorkspaceAgentResumeInputRequestCommandInput): Promise<SubmitResult> {
    return generatedSubmitBindingsFor(this.targetEnv, this.targetScope).then((bindings) =>
      bindings.ok
        ? this.resumeInputRequestWithBindings(input, bindings.value)
        : rejectTargetFailure(bindings),
    );
  }

  decideInputRequest(input: WorkspaceAgentDecideInputRequestCommandInput): Promise<SubmitResult> {
    return generatedSubmitBindingsFor(this.targetEnv, this.targetScope).then((bindings) =>
      bindings.ok
        ? this.decideInputRequestWithBindings(input, bindings.value)
        : rejectTargetFailure(bindings),
    );
  }

  inspectInputRequest(
    input: WorkspaceAgentInspectInputRequestCommandInput,
  ): Promise<InputRequestSettlement> {
    return this.inspectInputRequestScoped(input);
  }

  customCommand(input: WorkspaceAgentCustomCommandInput): Promise<unknown> {
    return Effect.runPromise(
      unsafeRunToolByName(
        generatedCustomTools,
        deterministicToolInvocation(input.method, input.input),
      ),
    );
  }

  readWorkspaceState(
    input: WorkspaceAgentReadStateCommandInput = {},
  ): Promise<WorkspaceAgentReadStateCommandOutput> {
    return workspaceSandboxFor(this.targetEnv, this.targetScope)
      .then((sandbox) =>
        sandbox
          .mkdir(${jsString(normalized.workspace.root)}, { recursive: true })
          .then(() =>
            sandbox.listFiles(${jsString(normalized.workspace.root)}, {
              recursive: true,
              includeHidden: input.includeHidden ?? true,
            }),
          ),
      )
      .then((listed) => ({
        workspaceRef: generatedWorkspaceRefFor(this.targetScope),
        files: listed.files
          .map(workspaceFileEntryFor)
          .filter((file): file is WorkspaceAgentFileEntry => file !== null)
          .sort((left, right) => left.path.localeCompare(right.path)),
      }));
  }

  readWorkspaceFile(
    input: WorkspaceAgentReadFileCommandInput,
  ): Promise<WorkspaceAgentReadFileCommandOutput> {
    const path = workspacePathFor(input.path);
    if (!path.ok) return Promise.reject(new TypeError(path.message));
    return workspaceSandboxFor(this.targetEnv, this.targetScope)
      .then((sandbox) =>
        sandbox.readFile(path.path, {
          encoding: input.encoding ?? "utf-8",
        }),
      )
      .then((file) => ({
        path: relativeWorkspacePath(path.path),
        content: file.content,
      }));
  }

  resetWorkspace(): Promise<WorkspaceAgentMutationCommandOutput> {
    return workspaceSandboxFor(this.targetEnv, this.targetScope)
      .then((sandbox) => sandbox.destroy())
      .then(() => workspaceSandboxFor(this.targetEnv, this.targetScope))
      .then((sandbox) =>
        sandbox.mkdir(${jsString(normalized.workspace.root)}, { recursive: true }),
      )
      .then(() => ({ ok: true as const }));
  }

  destroyWorkspace(): Promise<WorkspaceAgentMutationCommandOutput> {
    return workspaceSandboxFor(this.targetEnv, this.targetScope)
      .then((sandbox) => sandbox.destroy())
      .then(() => ({ ok: true as const }));
  }
}
`;
};
