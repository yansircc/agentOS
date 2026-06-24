import type { ProviderResourceId } from "@agent-os/core/runtime-protocol";
import type { HandlerKind } from "@agent-os/core/runtime-protocol";
import { WORKSPACE_TOOL_EXPOSURE_PROFILES, type WorkspaceToolName } from "@agent-os/runtime";
import { digestText, GENERATED_LOAD_SKILL_TOOL_NAME, isWorkspaceToolName } from "./shared";
import type { AuthoredAgentManifest, CompiledAgentSkill } from "./manifest-compiler";
import {
  AGENTOS_CONFIG_CLIENT,
  AGENTOS_CONFIG_LLM_ROUTE,
  AGENTOS_CONFIG_PROFILE,
  AGENTOS_CONFIG_TARGET,
  llmMaterialEnvBindings,
  type AgentOsConfigClientKind,
  type AgentOsConfigLlmRoute,
  type AgentOsConfigProfile,
  type AgentOsConfigTargetKind,
  type AgentOsConfigWorkspaceTopology,
  type LlmMaterialEnvKind,
  type NormalizedAgentOsConfig,
  type NormalizedChatAgentOsConfig,
  type NormalizedWorkspaceAgentOsConfig,
} from "./config";

export type StaticTargetGeneratedFilePath =
  | ".agentos/generated/manifest.json"
  | ".agentos/generated/deployment.json"
  | ".agentos/generated/provenance.json"
  | ".agentos/generated/fingerprints.json"
  | ".agentos/generated/target.ts"
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
  | "platform-runtime"
  | "workspace-client"
  | "client-core"
  | "client-framework"
  | "client-transport"
  | "effect-runtime"
  | "semantic-json"
  | "authored-tool";

export interface StaticTargetModuleImport {
  readonly kind: StaticTargetModuleImportKind;
  readonly source: string;
  readonly imports: ReadonlyArray<string>;
}

export interface CanonicalDeploymentIR {
  readonly profile: AgentOsConfigProfile;
  readonly target: typeof AGENTOS_CONFIG_TARGET.CLOUDFLARE_DO_V1;
  readonly llmRoute: typeof AGENTOS_CONFIG_LLM_ROUTE.OPENAI_CHAT_COMPATIBLE;
  readonly client: AgentOsConfigClientKind;
  readonly workspaceTopology?: AgentOsConfigWorkspaceTopology;
  readonly toolNames: ReadonlyArray<string>;
}

export interface MountIR {
  readonly driver: {
    readonly kind: "cloudflare-do";
    readonly className: string;
    readonly binding: string;
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
  | {
      readonly kind: "unsupported_static_target";
      readonly target: AgentOsConfigTargetKind;
    }
  | {
      readonly kind: "unsupported_static_llm_route";
      readonly route: AgentOsConfigLlmRoute;
    }
  | {
      readonly kind: "invalid_static_package_scope";
      readonly scope: string;
    };

export interface StaticTargetLinkOptions {
  readonly packageScope?: string;
}

export type StaticTargetLinkResult =
  | { readonly ok: true; readonly value: StaticTargetLink }
  | { readonly ok: false; readonly issues: ReadonlyArray<StaticTargetLinkIssue> };

const generatedPath = <Path extends StaticTargetGeneratedFilePath>(path: Path, text: string) => ({
  path,
  text,
});

const stableJsonValue = (value: unknown): unknown => {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(stableJsonValue);
  const record = value as Readonly<Record<string, unknown>>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) sorted[key] = stableJsonValue(record[key]);
  return sorted;
};

const stableJson = (value: unknown): string =>
  `${JSON.stringify(stableJsonValue(value), null, 2)}\n`;

const jsString = (value: string): string => JSON.stringify(value);

const importToolPath = (toolName: string): string => `../../agent/tools/${toolName}`;

const workspaceMutationToolNames = new Set<WorkspaceToolName>(
  WORKSPACE_TOOL_EXPOSURE_PROFILES.mutation,
);
const workspaceShellToolNames = new Set<WorkspaceToolName>(WORKSPACE_TOOL_EXPOSURE_PROFILES.shell);

const SOURCE_PACKAGE_SCOPE = "@agent-os";
const INJECTED_PUBLIC_PACKAGE_SCOPE = "__AGENTOS_PUBLIC_PACKAGE_SCOPE__";
const packageScopePattern = /^@[a-z0-9][a-z0-9._-]*$/u;
const DEFAULT_STATIC_TARGET_PACKAGE_SCOPE = packageScopePattern.test(INJECTED_PUBLIC_PACKAGE_SCOPE)
  ? INJECTED_PUBLIC_PACKAGE_SCOPE
  : SOURCE_PACKAGE_SCOPE;

const publicPackageSpecifier = (scope: string, name: string): string => `${scope}/${name}`;

const staticTargetModules = (scope: string) => ({
  runtimeCapability: publicPackageSpecifier(scope, "runtime/capability"),
  cloudflareDoRuntime: publicPackageSpecifier(scope, "runtime/cloudflare"),
  openAiCompatibleTransport: publicPackageSpecifier(
    scope,
    "runtime/llm-effect-ai/openai-compatible",
  ),
  workspaceAgentHost: publicPackageSpecifier(scope, "runtime/workspace-agent"),
  workspaceAgentClient: publicPackageSpecifier(scope, "client/workspace-agent"),
  workspaceBinding: publicPackageSpecifier(scope, "runtime/workspace-binding"),
  workspaceEnvCloudflare: publicPackageSpecifier(scope, "runtime/cloudflare"),
  clientCore: publicPackageSpecifier(scope, "client"),
  clientSvelte: publicPackageSpecifier(scope, "client/svelte"),
  runtimeProtocol: publicPackageSpecifier(scope, "core/runtime-protocol"),
  coreTools: publicPackageSpecifier(scope, "core/tools"),
  sseHttp: publicPackageSpecifier(scope, "runtime/sse-http"),
  cloudflareSandbox: "@cloudflare/sandbox",
  svelteKitServer: "$app/server",
  svelteKitKit: "@sveltejs/kit",
  effect: "effect",
  svelteStore: "svelte/store",
});

const renderNamedImport = (names: ReadonlyArray<string>, source: string): string =>
  `import { ${names.join(", ")} } ${"from"} ${jsString(source)};`;

const renderTypeImport = (names: ReadonlyArray<string>, source: string): string =>
  `import type { ${names.join(", ")} } ${"from"} ${jsString(source)};`;

const generatedToolImports = (
  toolNames: ReadonlyArray<string>,
): ReadonlyArray<StaticTargetModuleImport> =>
  toolNames.map((toolName, index) => ({
    kind: "authored-tool",
    source: importToolPath(toolName),
    imports: [`default as tool_${index}`],
  }));

const sortedSkills = (
  skills: ReadonlyArray<CompiledAgentSkill>,
): ReadonlyArray<CompiledAgentSkill> =>
  [...skills].sort((left, right) => left.name.localeCompare(right.name));

const renderSkillCatalog = (skills: ReadonlyArray<CompiledAgentSkill>): string => {
  const entries = sortedSkills(skills).map(
    (skill) =>
      `  ${JSON.stringify(
        stableJsonValue({
          digest: skill.digest,
          name: skill.name,
          path: skill.path,
          text: skill.text,
        }),
      )}`,
  );
  return entries.length === 0 ? "[]" : `[\n${entries.join(",\n")}\n]`;
};

const renderSkillNameSchema = (skills: ReadonlyArray<CompiledAgentSkill>): string =>
  `Schema.Literals(${JSON.stringify(sortedSkills(skills).map((skill) => skill.name))})`;

const renderSkillSupport = (skills: ReadonlyArray<CompiledAgentSkill>): string => {
  if (skills.length === 0) return "";
  return `
type GeneratedSkill = {
  readonly name: string;
  readonly path: string;
  readonly digest: string;
  readonly text: string;
};

const generatedSkillCatalog = ${renderSkillCatalog(skills)} satisfies ReadonlyArray<GeneratedSkill>;
const generatedSkillNames = generatedSkillCatalog.map((skill) => skill.name);
const generatedSkillByName = Object.fromEntries(
  generatedSkillCatalog.map((skill) => [skill.name, skill]),
) as Readonly<Record<(typeof generatedSkillNames)[number], GeneratedSkill>>;
const generatedSkillsSystemAdvert = [
  "Available agent skills are not loaded by default.",
  ...generatedSkillCatalog.map(
    (skill) =>
      \`- \${skill.name}: call ${GENERATED_LOAD_SKILL_TOOL_NAME} with {"name":\${JSON.stringify(skill.name)}} to load \${skill.path} (\${skill.digest}).\`,
  ),
  "Do not assume a skill's full instructions until ${GENERATED_LOAD_SKILL_TOOL_NAME} returns it.",
].join("\\n");

const generatedSystemPrompt = (system: string | undefined): string =>
  system === undefined || system.length === 0
    ? generatedSkillsSystemAdvert
    : \`\${system}\\n\\n\${generatedSkillsSystemAdvert}\`;

const generatedLoadSkillTool = defineProductTool({
  name: ${jsString(GENERATED_LOAD_SKILL_TOOL_NAME)},
  description: "Load the full text of a CLI-authored agent skill by name.",
  args: Schema.Struct({ name: ${renderSkillNameSchema(skills)} }),
  authority: "agentos.generated.skills",
  authorityId: "agentos.generated.skills.load_skill",
  admit: () => Effect.succeed({ ok: true as const }),
  execute: ({ name }) => Effect.succeed(generatedSkillByName[name]),
});
const generatedFrameworkTools = {
  ${jsString(GENERATED_LOAD_SKILL_TOOL_NAME)}: generatedLoadSkillTool,
} satisfies Readonly<Record<string, Tool>>;
`;
};

const renderSubmitSpecFromRunInput = (
  hasSkills: boolean,
): string => `const submitSpecFromRunInput = (input: SubmitRunInput): AgentSubmitSpec => ({
  input,
  intent: input.intent,
  context: input.context,
  ${hasSkills ? "system: generatedSystemPrompt(input.system)," : "...(input.system === undefined ? {} : { system: input.system }),"}
  ...(input.budget === undefined ? {} : { budget: input.budget }),
  ...(input.outputSchema === undefined ? {} : { outputSchema: input.outputSchema }),
  ...(input.traceContext === undefined ? {} : { traceContext: input.traceContext }),
  ...(input.materials === undefined ? {} : { materials: input.materials }),
  ...(input.toolContext === undefined ? {} : { toolContext: input.toolContext }),
  ...(input.toolPolicy === undefined ? {} : { toolPolicy: input.toolPolicy }),
  ...(input.decisionInterrupts === undefined ? {} : { decisionInterrupts: input.decisionInterrupts }),
  ...(input.resume === undefined ? {} : { resume: input.resume }),
});`;

const renderWorkspaceStaticTarget = (
  normalized: NormalizedWorkspaceAgentOsConfig<AuthoredAgentManifest>,
  toolNames: ReadonlyArray<string>,
  modules: ReturnType<typeof staticTargetModules>,
): string => {
  const hasSkills = normalized.skills.length > 0;
  const authoredToolNames = new Set(normalized.authoredToolNames);
  const workspaceToolList = toolNames.filter(
    (toolName): toolName is WorkspaceToolName =>
      isWorkspaceToolName(toolName) && !authoredToolNames.has(toolName),
  );
  const customToolNames = toolNames.filter((toolName) => authoredToolNames.has(toolName));
  const toolImports = customToolNames
    .map((toolName, index) => `import tool_${index} from ${jsString(importToolPath(toolName))};`)
    .join("\n");
  const customToolRecord =
    customToolNames.length === 0
      ? "{}"
      : `{\n${customToolNames
          .map((toolName, index) => `  ${jsString(toolName)}: tool_${index},`)
          .join("\n")}\n}`;
  const workspaceToolArray = `[${workspaceToolList.map(jsString).join(", ")}] as const`;
  const usesMutationTools = workspaceToolList.some((toolName) =>
    workspaceMutationToolNames.has(toolName),
  );
  const usesShellTools = workspaceToolList.some((toolName) =>
    workspaceShellToolNames.has(toolName),
  );
  const handlerRecord = `{\n${normalized.deployment.manifest.handlers
    .map((handler) => `  ${jsString(handler)}: generatedHandler,`)
    .join("\n")}\n}`;
  const llmEnvByKind = Object.fromEntries(
    llmMaterialEnvBindings(normalized.llm).map((binding) => [binding.kind, binding.envName]),
  ) as Readonly<Record<LlmMaterialEnvKind, string>>;
  const generatedLlmEnvFields = Object.values(llmEnvByKind)
    .map((envName) => `  readonly ${envName}?: string;`)
    .join("\n");
  const imports = [
    `import semanticDeclarations from "./manifest.json";`,
    `import deploymentProvenance from "./deployment.json";`,
    renderNamedImport(["createAgentDurableObject"], modules.cloudflareDoRuntime),
    renderNamedImport(
      [
        "WORKSPACE_OPERATION_HOST_FACT",
        "defineHost",
        "resolveRuntimeInstallGraph",
        "workspaceOperations",
      ],
      modules.runtimeCapability,
    ),
    renderNamedImport(["OpenAiCompatibleLlmTransportLive"], modules.openAiCompatibleTransport),
    renderNamedImport(
      ["defineWorkspaceAgentMount", "WORKSPACE_AGENT_PROJECTION"],
      modules.workspaceAgentHost,
    ),
    renderNamedImport(["makeCloudflareWorkspaceEnv"], modules.workspaceEnvCloudflare),
    renderNamedImport(["getSandbox"], modules.cloudflareSandbox),
    renderNamedImport(
      [
        "deterministicToolInvocation",
        ...(hasSkills ? ["defineProductTool"] : []),
        "unsafeRunToolByName",
      ],
      modules.coreTools,
    ),
    renderNamedImport(hasSkills ? ["Effect", "Schema"] : ["Effect"], modules.effect),
    renderTypeImport(
      ["AgentManifest", "AgentSubmitBindings", "SubmitResult", "SubmitRunInput"],
      modules.runtimeProtocol,
    ),
    renderTypeImport(["AgentSubmitSpec"], modules.cloudflareDoRuntime),
    renderTypeImport(
      [
        "WorkspaceAgentDecideInputRequestCommandInput",
        "WorkspaceAgentCustomCommandInput",
        "WorkspaceAgentFileEntry",
        "WorkspaceAgentMutationCommandOutput",
        "WorkspaceAgentReadStateCommandInput",
        "WorkspaceAgentReadStateCommandOutput",
        "WorkspaceAgentReadFileCommandInput",
        "WorkspaceAgentReadFileCommandOutput",
        "WorkspaceAgentResumeInputRequestCommandInput",
      ],
      modules.workspaceAgentHost,
    ),
    renderTypeImport(["Tool"], modules.coreTools),
    renderTypeImport(["Sandbox", "SandboxTransport"], modules.cloudflareSandbox),
    ...(toolImports.length === 0 ? [] : [toolImports]),
  ].join("\n");
  return `${imports}

export const targetDeclarations = semanticDeclarations;
export const targetDeployment = deploymentProvenance;

const semanticManifest = semanticDeclarations as AgentManifest;
const generatedHandler = () => undefined;

type AgentOSTargetEnv = {
  readonly [binding: string]: unknown;
  readonly SANDBOX_TRANSPORT?: SandboxTransport;
${generatedLlmEnvFields}
};

type GeneratedTargetFailure = {
  readonly ok: false;
  readonly message: string;
};

type GeneratedTargetResult<Value> =
  | { readonly ok: true; readonly value: Value }
  | GeneratedTargetFailure;

const targetFailure = (message: string): GeneratedTargetFailure => ({ ok: false, message });

const rejectTargetFailure = (failure: GeneratedTargetFailure): Promise<never> =>
  Promise.reject(Error(failure.message));

const generatedWorkspaceToolNames = ${workspaceToolArray};
const generatedCustomTools = ${customToolRecord} satisfies Readonly<Record<string, Tool>>;
${renderSkillSupport(normalized.skills)}
const generatedWorkspaceSandboxId = ${jsString(normalized.workspace.cloudflareSandboxId)};

const generatedWorkspaceToolInteractionFor = (
  name: (typeof generatedWorkspaceToolNames)[number],
): "never" | "approval" => {
  const interaction = semanticManifest.tools?.[name]?.interaction;
  if (interaction === "never" || interaction === "approval") return interaction;
  throw Error(\`invalid workspace tool interaction for \${name}: \${String(interaction)}\`);
};

const generatedWorkspaceToolInteractions = Object.fromEntries(
  generatedWorkspaceToolNames.map((name) => [name, generatedWorkspaceToolInteractionFor(name)]),
) as Readonly<Partial<Record<(typeof generatedWorkspaceToolNames)[number], "never" | "approval">>>;

const workspaceNamespaceFor = (env: AgentOSTargetEnv): DurableObjectNamespace<Sandbox> =>
  env[${jsString(normalized.workspace.binding)}] as DurableObjectNamespace<Sandbox>;

const workspaceSandboxFor = (env: AgentOSTargetEnv): Sandbox =>
  getSandbox(workspaceNamespaceFor(env), generatedWorkspaceSandboxId, {
    normalizeId: true,
    sleepAfter: "10m",
    transport: env.SANDBOX_TRANSPORT ?? "rpc",
  });

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

const workspaceEnvFor = (env: AgentOSTargetEnv) =>
  makeCloudflareWorkspaceEnv({
    client: workspaceSandboxFor(env),
    cwd: ${jsString(normalized.workspace.root)},
    workspaceRef: ${jsString(normalized.workspace.providerResourceId)},
  });

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
    [WORKSPACE_OPERATION_HOST_FACT]: () => workspaceEnvFor(env),
  }),
});

const generatedCapabilityInstallGraphFor = (env: AgentOSTargetEnv) => {
  const graph = resolveRuntimeInstallGraph(
    generatedHostProfileFor(env),
    [
      workspaceOperations({
        toolNames: generatedWorkspaceToolNames,
        mutationPolicy: ${usesMutationTools ? '"receipt-backed"' : '"disabled"'},
        shellPolicy: ${usesShellTools ? '"receipt-backed"' : '"disabled"'},
        toolInteractions: generatedWorkspaceToolInteractions,
      }),
    ],
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

const materialEnvValue = (env: AgentOSTargetEnv, name: string): string | null => {
  const value = env[name];
  return typeof value === "string" && value.length > 0 ? value : null;
};

const materialValue = (
  env: AgentOSTargetEnv,
  ref: { readonly kind: string; readonly ref: string },
): NonNullable<unknown> | null => {
  if (ref.kind === "endpoint" && ref.ref === ${jsString(normalized.llm.endpointRef)}) {
    return materialEnvValue(env, ${jsString(llmEnvByKind.endpoint)});
  }
  if (ref.kind === "credential" && ref.ref === ${jsString(normalized.llm.credentialRef)}) {
    return materialEnvValue(env, ${jsString(llmEnvByKind.credential)});
  }
  if (ref.kind === "model" && ref.ref === ${jsString(normalized.llm.modelRef)}) {
    return materialEnvValue(env, ${jsString(llmEnvByKind.model)});
  }
  return null;
};

const requiredStringMaterial = (
  kind: string,
  ref: string,
  value: NonNullable<unknown> | null,
): GeneratedTargetResult<string> => {
  if (typeof value === "string" && value.length > 0) return { ok: true, value };
  return targetFailure(\`missing \${kind} material: \${ref}\`);
};

const generatedLlmRouteFor = (env: AgentOSTargetEnv): GeneratedTargetResult<NonNullable<AgentSubmitBindings["llmRoutes"]>["default"]> => {
  const modelId = requiredStringMaterial(
    "model",
    ${jsString(normalized.llm.modelRef)},
    materialValue(env, { kind: "model", ref: ${jsString(normalized.llm.modelRef)} }),
  );
  if (!modelId.ok) return modelId;
  return {
    ok: true,
    value: {
      kind: "openai-chat-compatible",
      endpointRef: ${jsString(normalized.llm.endpointRef)},
      credentialRef: ${jsString(normalized.llm.credentialRef)},
      modelId: modelId.value,
    },
  };
};

const generatedSubmitBindingsFor = (env: AgentOSTargetEnv): GeneratedTargetResult<AgentSubmitBindings> => {
  const capabilityGraph = generatedCapabilityInstallGraphFor(env);
  const route = generatedLlmRouteFor(env);
  if (!route.ok) return route;
  return {
    ok: true,
    value: {
      ...capabilityGraph.bindings,
      llmRoutes: {
        default: route.value,
      },
      tools: {
        ...(capabilityGraph.bindings.tools ?? {}),
        ...generatedCustomTools,
        ${hasSkills ? "...generatedFrameworkTools," : ""}
      },
    },
  };
};

${renderSubmitSpecFromRunInput(hasSkills)}

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

const Base${normalized.target.durableObject.className} = createAgentDurableObject<AgentOSTargetEnv>({
  manifest: semanticManifest,
  agentBindings: (env) => ({
    handlers: ${handlerRecord},
    ...generatedCapabilityInstallGraphFor(env).agentBindings,
  }),
  refResolver: (env) => ({
    material: (ref) => materialValue(env, ref),
  }),
  llmTransport: () => OpenAiCompatibleLlmTransportLive,
  extensions: (env) => generatedCapabilityInstallGraphFor(env).extensions,
  declaredIntents: (env) => generatedCapabilityInstallGraphFor(env).declaredIntents,
  projections: (env) => generatedCapabilityInstallGraphFor(env).projections,
  graphStatus: (env) => generatedCapabilityInstallGraphFor(env).graphStatus,
  eventHandlers: (context, env) => generatedCapabilityInstallGraphFor(env).handlers(context),
});

export class ${normalized.target.durableObject.className} extends Base${normalized.target.durableObject.className} {
  private readonly targetEnv: AgentOSTargetEnv;

  constructor(ctx: DurableObjectState, env: AgentOSTargetEnv) {
    super(ctx, env);
    this.targetEnv = env;
  }

  override submit(spec: AgentSubmitSpec): Promise<SubmitResult> {
    const bindings = generatedSubmitBindingsFor(this.targetEnv);
    return bindings.ok
      ? this.submitWithBindings(spec, bindings.value)
      : rejectTargetFailure(bindings);
  }

  submitRunInput(input: SubmitRunInput): Promise<SubmitResult> {
    const bindings = generatedSubmitBindingsFor(this.targetEnv);
    return bindings.ok
      ? this.submitWithBindings(submitSpecFromRunInput(input), bindings.value)
      : rejectTargetFailure(bindings);
  }

  resumeInputRequest(input: WorkspaceAgentResumeInputRequestCommandInput): Promise<SubmitResult> {
    const bindings = generatedSubmitBindingsFor(this.targetEnv);
    return bindings.ok
      ? this.resumeInputRequestWithBindings(input, bindings.value)
      : rejectTargetFailure(bindings);
  }

  decideInputRequest(input: WorkspaceAgentDecideInputRequestCommandInput): Promise<SubmitResult> {
    const bindings = generatedSubmitBindingsFor(this.targetEnv);
    return bindings.ok
      ? this.decideInputRequestWithBindings(input, bindings.value)
      : rejectTargetFailure(bindings);
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
    const sandbox = workspaceSandboxFor(this.targetEnv);
    return sandbox
      .mkdir(${jsString(normalized.workspace.root)}, { recursive: true })
      .then(() =>
        sandbox.listFiles(${jsString(normalized.workspace.root)}, {
          recursive: true,
          includeHidden: input.includeHidden ?? true,
        }),
      )
      .then((listed) => ({
        workspaceRef: ${jsString(normalized.workspace.providerResourceId)},
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
    return workspaceSandboxFor(this.targetEnv)
      .readFile(path.path, {
        encoding: input.encoding ?? "utf-8",
      })
      .then((file) => ({
        path: relativeWorkspacePath(path.path),
        content: file.content,
      }));
  }

  resetWorkspace(): Promise<WorkspaceAgentMutationCommandOutput> {
    return workspaceSandboxFor(this.targetEnv)
      .destroy()
      .then(() =>
        workspaceSandboxFor(this.targetEnv).mkdir(${jsString(normalized.workspace.root)}, {
          recursive: true,
        }),
      )
      .then(() => ({ ok: true as const }));
  }

  destroyWorkspace(): Promise<WorkspaceAgentMutationCommandOutput> {
    return workspaceSandboxFor(this.targetEnv)
      .destroy()
      .then(() => ({ ok: true as const }));
  }
}
`;
};

const renderChatStaticTarget = (
  normalized: NormalizedChatAgentOsConfig<AuthoredAgentManifest>,
  toolNames: ReadonlyArray<string>,
  modules: ReturnType<typeof staticTargetModules>,
): string => {
  const hasSkills = normalized.skills.length > 0;
  const authoredToolNames = new Set(normalized.authoredToolNames);
  const customToolNames = toolNames.filter((toolName) => authoredToolNames.has(toolName));
  const toolImports = customToolNames
    .map((toolName, index) => `import tool_${index} from ${jsString(importToolPath(toolName))};`)
    .join("\n");
  const customToolRecord =
    customToolNames.length === 0
      ? "{}"
      : `{\n${customToolNames
          .map((toolName, index) => `  ${jsString(toolName)}: tool_${index},`)
          .join("\n")}\n}`;
  const handlerRecord = `{\n${normalized.deployment.manifest.handlers
    .map((handler) => `  ${jsString(handler)}: generatedHandler,`)
    .join("\n")}\n}`;
  const llmEnvByKind = Object.fromEntries(
    llmMaterialEnvBindings(normalized.llm).map((binding) => [binding.kind, binding.envName]),
  ) as Readonly<Record<LlmMaterialEnvKind, string>>;
  const generatedLlmEnvFields = Object.values(llmEnvByKind)
    .map((envName) => `  readonly ${envName}?: string;`)
    .join("\n");
  const imports = [
    `import semanticDeclarations from "./manifest.json";`,
    `import deploymentProvenance from "./deployment.json";`,
    renderNamedImport(["createAgentDurableObject"], modules.cloudflareDoRuntime),
    renderNamedImport(["OpenAiCompatibleLlmTransportLive"], modules.openAiCompatibleTransport),
    renderNamedImport(
      [
        "deterministicToolInvocation",
        ...(hasSkills ? ["defineProductTool"] : []),
        "unsafeRunToolByName",
      ],
      modules.coreTools,
    ),
    renderNamedImport(hasSkills ? ["Effect", "Schema"] : ["Effect"], modules.effect),
    renderTypeImport(
      ["AgentManifest", "AgentSubmitBindings", "SubmitResult", "SubmitRunInput"],
      modules.runtimeProtocol,
    ),
    renderTypeImport(["AgentSubmitSpec"], modules.cloudflareDoRuntime),
    renderTypeImport(
      [
        "WorkspaceAgentCustomCommandInput",
        "WorkspaceAgentDecideInputRequestCommandInput",
        "WorkspaceAgentResumeInputRequestCommandInput",
      ],
      modules.workspaceAgentHost,
    ),
    renderTypeImport(["Tool"], modules.coreTools),
    ...(toolImports.length === 0 ? [] : [toolImports]),
  ].join("\n");
  return `${imports}

export const targetDeclarations = semanticDeclarations;
export const targetDeployment = deploymentProvenance;

const semanticManifest = semanticDeclarations as AgentManifest;
const generatedHandler = () => undefined;

type AgentOSTargetEnv = {
  readonly [binding: string]: unknown;
${generatedLlmEnvFields}
};

type GeneratedTargetFailure = {
  readonly ok: false;
  readonly message: string;
};

type GeneratedTargetResult<Value> =
  | { readonly ok: true; readonly value: Value }
  | GeneratedTargetFailure;

const targetFailure = (message: string): GeneratedTargetFailure => ({ ok: false, message });

const rejectTargetFailure = (failure: GeneratedTargetFailure): Promise<never> =>
  Promise.reject(Error(failure.message));

const generatedCustomTools = ${customToolRecord} satisfies Readonly<Record<string, Tool>>;
${renderSkillSupport(normalized.skills)}

const materialEnvValue = (env: AgentOSTargetEnv, name: string): string | null => {
  const value = env[name];
  return typeof value === "string" && value.length > 0 ? value : null;
};

const materialValue = (
  env: AgentOSTargetEnv,
  ref: { readonly kind: string; readonly ref: string },
): NonNullable<unknown> | null => {
  if (ref.kind === "endpoint" && ref.ref === ${jsString(normalized.llm.endpointRef)}) {
    return materialEnvValue(env, ${jsString(llmEnvByKind.endpoint)});
  }
  if (ref.kind === "credential" && ref.ref === ${jsString(normalized.llm.credentialRef)}) {
    return materialEnvValue(env, ${jsString(llmEnvByKind.credential)});
  }
  if (ref.kind === "model" && ref.ref === ${jsString(normalized.llm.modelRef)}) {
    return materialEnvValue(env, ${jsString(llmEnvByKind.model)});
  }
  return null;
};

const requiredStringMaterial = (
  kind: string,
  ref: string,
  value: NonNullable<unknown> | null,
): GeneratedTargetResult<string> => {
  if (typeof value === "string" && value.length > 0) return { ok: true, value };
  return targetFailure(\`missing \${kind} material: \${ref}\`);
};

const generatedLlmRouteFor = (env: AgentOSTargetEnv): GeneratedTargetResult<NonNullable<AgentSubmitBindings["llmRoutes"]>["default"]> => {
  const modelId = requiredStringMaterial(
    "model",
    ${jsString(normalized.llm.modelRef)},
    materialValue(env, { kind: "model", ref: ${jsString(normalized.llm.modelRef)} }),
  );
  if (!modelId.ok) return modelId;
  return {
    ok: true,
    value: {
      kind: "openai-chat-compatible",
      endpointRef: ${jsString(normalized.llm.endpointRef)},
      credentialRef: ${jsString(normalized.llm.credentialRef)},
      modelId: modelId.value,
    },
  };
};

const generatedSubmitBindingsFor = (env: AgentOSTargetEnv): GeneratedTargetResult<AgentSubmitBindings> => {
  const route = generatedLlmRouteFor(env);
  if (!route.ok) return route;
  return {
    ok: true,
    value: {
      llmRoutes: {
        default: route.value,
      },
      tools: ${
        hasSkills
          ? `{
        ...generatedCustomTools,
        ...generatedFrameworkTools,
      }`
          : "generatedCustomTools"
      },
    },
  };
};

${renderSubmitSpecFromRunInput(hasSkills)}

const Base${normalized.target.durableObject.className} = createAgentDurableObject<AgentOSTargetEnv>({
  manifest: semanticManifest,
  agentBindings: {
    handlers: ${handlerRecord},
  },
  refResolver: (env) => ({
    material: (ref) => materialValue(env, ref),
  }),
  llmTransport: () => OpenAiCompatibleLlmTransportLive,
});

export class ${normalized.target.durableObject.className} extends Base${normalized.target.durableObject.className} {
  private readonly targetEnv: AgentOSTargetEnv;

  constructor(ctx: DurableObjectState, env: AgentOSTargetEnv) {
    super(ctx, env);
    this.targetEnv = env;
  }

  override submit(spec: AgentSubmitSpec): Promise<SubmitResult> {
    const bindings = generatedSubmitBindingsFor(this.targetEnv);
    return bindings.ok
      ? this.submitWithBindings(spec, bindings.value)
      : rejectTargetFailure(bindings);
  }

  submitRunInput(input: SubmitRunInput): Promise<SubmitResult> {
    const bindings = generatedSubmitBindingsFor(this.targetEnv);
    return bindings.ok
      ? this.submitWithBindings(submitSpecFromRunInput(input), bindings.value)
      : rejectTargetFailure(bindings);
  }

  resumeInputRequest(input: WorkspaceAgentResumeInputRequestCommandInput): Promise<SubmitResult> {
    const bindings = generatedSubmitBindingsFor(this.targetEnv);
    return bindings.ok
      ? this.resumeInputRequestWithBindings(input, bindings.value)
      : rejectTargetFailure(bindings);
  }

  decideInputRequest(input: WorkspaceAgentDecideInputRequestCommandInput): Promise<SubmitResult> {
    const bindings = generatedSubmitBindingsFor(this.targetEnv);
    return bindings.ok
      ? this.decideInputRequestWithBindings(input, bindings.value)
      : rejectTargetFailure(bindings);
  }

  customCommand(input: WorkspaceAgentCustomCommandInput): Promise<unknown> {
    return Effect.runPromise(
      unsafeRunToolByName(
        generatedCustomTools,
        deterministicToolInvocation(input.method, input.input),
      ),
    );
  }
}
`;
};

const renderStaticTarget = (
  normalized: NormalizedAgentOsConfig<AuthoredAgentManifest>,
  toolNames: ReadonlyArray<string>,
  modules: ReturnType<typeof staticTargetModules>,
): string =>
  normalized.profile === AGENTOS_CONFIG_PROFILE.WORKSPACE_V1
    ? renderWorkspaceStaticTarget(normalized, toolNames, modules)
    : renderChatStaticTarget(normalized, toolNames, modules);

const renderCloudflareScopeHelper = (
  normalized: NormalizedAgentOsConfig<AuthoredAgentManifest>,
  modules: ReturnType<typeof staticTargetModules>,
): string => `${renderNamedImport(["durableObjectRpcClient"], `${modules.cloudflareDoRuntime}/do-rpc`)}
${renderNamedImport(["manifestTruthIdentity"], modules.runtimeProtocol)}
${renderTypeImport(["AgentRuntimeClient"], modules.cloudflareDoRuntime)}
${renderTypeImport(["DurableObjectRpcClient"], `${modules.cloudflareDoRuntime}/do-rpc`)}
${renderTypeImport(["AgentManifest"], modules.runtimeProtocol)}
import manifest from "./manifest.json";

export type AgentOSTargetEnv = {
  readonly [binding: string]: unknown;
};

export const agentOSTruthIdentity = manifestTruthIdentity(manifest as AgentManifest);
export const agentOSScopeId = agentOSTruthIdentity.scopeRef.scopeId;
export const agentOSDurableObjectBinding = ${jsString(normalized.target.durableObject.binding)};

export const agentOSDurableObjectNamespace = (
  env: AgentOSTargetEnv,
): DurableObjectNamespace =>
  env[agentOSDurableObjectBinding] as DurableObjectNamespace;

export const agentOSRpcClient = <
  Rpc extends Pick<AgentRuntimeClient, "events" | "streamEvents"> = AgentRuntimeClient,
>(
  env: AgentOSTargetEnv,
  scopeId: string = agentOSScopeId,
): DurableObjectRpcClient<Rpc> => durableObjectRpcClient<Rpc>(agentOSDurableObjectNamespace(env), scopeId);
`;

const renderCloudflareWorkerEntry = (
  normalized: NormalizedAgentOsConfig<AuthoredAgentManifest>,
  modules: ReturnType<typeof staticTargetModules>,
): string => `${normalized.profile === AGENTOS_CONFIG_PROFILE.WORKSPACE_V1 ? `${renderNamedImport(["Sandbox"], modules.cloudflareSandbox)}\n` : ""}${renderNamedImport([normalized.target.durableObject.className], "./target")}
${renderTypeImport(["AgentOSTargetEnv"], "./cloudflare-scope")}

export { ${normalized.target.durableObject.className}${normalized.profile === AGENTOS_CONFIG_PROFILE.WORKSPACE_V1 ? ", Sandbox" : ""} };

export default {
  fetch(): Response {
    return new Response("agentOS Cloudflare target", { status: 404 });
  },
} satisfies ExportedHandler<AgentOSTargetEnv>;
`;

const renderCloudflareWranglerConfig = (
  normalized: NormalizedAgentOsConfig<AuthoredAgentManifest>,
): string => {
  const workspaceConfig =
    normalized.profile === AGENTOS_CONFIG_PROFILE.WORKSPACE_V1
      ? {
          vars: {
            SANDBOX_TRANSPORT: "rpc",
          },
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
              {
                class_name: "Sandbox",
                name: normalized.workspace.binding,
              },
              {
                class_name: normalized.target.durableObject.className,
                name: normalized.target.durableObject.binding,
              },
            ],
          },
          migrations: [
            {
              tag: "v1",
              new_sqlite_classes: ["Sandbox", normalized.target.durableObject.className],
            },
          ],
        }
      : {
          durable_objects: {
            bindings: [
              {
                class_name: normalized.target.durableObject.className,
                name: normalized.target.durableObject.binding,
              },
            ],
          },
          migrations: [
            {
              tag: "v1",
              new_sqlite_classes: [normalized.target.durableObject.className],
            },
          ],
        };
  return stableJson({
    $schema: "node_modules/wrangler/config-schema.json",
    name: normalized.deployment.deploymentId,
    main: "./worker.ts",
    compatibility_date: "2026-04-15",
    compatibility_flags: ["nodejs_compat"],
    ...workspaceConfig,
  });
};

const generatedClientModuleImports = (
  normalized: NormalizedAgentOsConfig<AuthoredAgentManifest>,
  modules: ReturnType<typeof staticTargetModules>,
): ReadonlyArray<StaticTargetModuleImport> => [
  {
    kind: "workspace-client",
    source: modules.workspaceAgentClient,
    imports:
      normalized.profile === AGENTOS_CONFIG_PROFILE.WORKSPACE_V1
        ? [
            "createWorkspaceAgentClientBridge",
            "CreateWorkspaceAgentClientOptions",
            "WorkspaceAgentClientBridge",
          ]
        : [
            "WORKSPACE_AGENT_COMMAND",
            "createWorkspaceAgentClient",
            "CreateWorkspaceAgentClientOptions",
            "WorkspaceAgentClient",
            "WorkspaceAgentCommandOutputByName",
          ],
  },
  ...(normalized.client.kind === AGENTOS_CONFIG_CLIENT.SVELTE_KIT_REMOTE_V1
    ? [
        {
          kind: "client-transport" as const,
          source: "./sveltekit.remote",
          imports: ["invokeAgentCommand", "runEventStream"],
        },
        {
          kind: "client-transport" as const,
          source: modules.svelteKitServer,
          imports: ["command", "getRequestEvent", "query"],
        },
        {
          kind: "client-transport" as const,
          source: modules.sseHttp,
          imports: ["decodeSseHttpEvents", "responseToSseHttpChunks"],
        },
        {
          kind: "client-core" as const,
          source: modules.clientCore,
          imports: ["AgentClientSnapshot"],
        },
        {
          kind: "client-framework" as const,
          source: modules.clientSvelte,
          imports: ["clientReadable", "selectClientReadable"],
        },
        {
          kind: "client-framework" as const,
          source: modules.svelteStore,
          imports: ["Readable"],
        },
      ]
    : []),
];

const renderWorkspaceSvelteKitRemote = (
  normalized: NormalizedWorkspaceAgentOsConfig<AuthoredAgentManifest>,
  modules: ReturnType<typeof staticTargetModules>,
): string => `${renderNamedImport(["command", "getRequestEvent", "query"], modules.svelteKitServer)}
${renderNamedImport(["decodeSseHttpEvents", "responseToSseHttpChunks"], modules.sseHttp)}
${renderNamedImport(["Result", "Schema"], modules.effect)}
${renderNamedImport(["WORKSPACE_AGENT_COMMAND"], modules.workspaceAgentHost)}
${renderNamedImport(
  ["decodeRuntimeLedgerEvent", "isInputRequestRef", "parseInputRequestResumePayload"],
  modules.runtimeProtocol,
)}
${renderNamedImport(["agentOSRpcClient", "agentOSTruthIdentity"], "./cloudflare-scope")}
${renderTypeImport(["AgentRuntimeClient"], modules.cloudflareDoRuntime)}
${renderTypeImport(["SseHttpEvent"], modules.sseHttp)}
${renderTypeImport(
  ["RuntimeLedgerEvent", "SubmitResult", "SubmitRunInput"],
  modules.runtimeProtocol,
)}
${renderTypeImport(
  [
    "WorkspaceAgentCustomCommandInput",
    "WorkspaceAgentDestroyCommandInput",
    "WorkspaceAgentCommandOutputByName",
    "WorkspaceAgentDecideInputRequestCommandInput",
    "WorkspaceAgentReadFileCommandInput",
    "WorkspaceAgentResumeInputRequestCommandInput",
    "WorkspaceAgentReadStateCommandInput",
    "WorkspaceAgentResetCommandInput",
  ],
  modules.workspaceAgentHost,
)}
${renderTypeImport(["AgentOSTargetEnv"], "./cloudflare-scope")}

type AgentOSRpc = Pick<AgentRuntimeClient, "events" | "streamEvents"> & {
  readonly submitRunInput: (input: SubmitRunInput) => Promise<SubmitResult>;
  readonly resumeInputRequest: (
    input: WorkspaceAgentResumeInputRequestCommandInput,
  ) => Promise<SubmitResult>;
  readonly decideInputRequest: (
    input: WorkspaceAgentDecideInputRequestCommandInput,
  ) => Promise<SubmitResult>;
  readonly customCommand: (
    input: WorkspaceAgentCustomCommandInput,
  ) => Promise<WorkspaceAgentCommandOutputByName[typeof WORKSPACE_AGENT_COMMAND.CUSTOM]>;
  readonly readWorkspaceFile: (
    input: WorkspaceAgentReadFileCommandInput,
  ) => Promise<WorkspaceAgentCommandOutputByName[typeof WORKSPACE_AGENT_COMMAND.READ_FILE]>;
  readonly readWorkspaceState: (
    input?: WorkspaceAgentReadStateCommandInput,
  ) => Promise<WorkspaceAgentCommandOutputByName[typeof WORKSPACE_AGENT_COMMAND.READ_STATE]>;
  readonly resetWorkspace: (
    input?: WorkspaceAgentResetCommandInput,
  ) => Promise<WorkspaceAgentCommandOutputByName[typeof WORKSPACE_AGENT_COMMAND.RESET]>;
  readonly destroyWorkspace: (
    input?: WorkspaceAgentDestroyCommandInput,
  ) => Promise<WorkspaceAgentCommandOutputByName[typeof WORKSPACE_AGENT_COMMAND.DESTROY]>;
};

const optionalAfterIdInput = Schema.toStandardSchemaV1(
  Schema.Struct({ afterId: Schema.optional(Schema.Number) }),
);
const commandInput = Schema.toStandardSchemaV1(
  Schema.Struct({
    name: Schema.String,
    input: Schema.Unknown,
  }),
);

type GeneratedFailure = {
  readonly ok: false;
  readonly status: number;
  readonly message: string;
};

type GeneratedResult<Value> =
  | { readonly ok: true; readonly value: Value }
  | GeneratedFailure;

const fail = (status: number, message: string): GeneratedFailure => ({
  ok: false,
  status,
  message,
});

const rejectFailure = (failure: GeneratedFailure): Promise<never> =>
  Promise.reject(
    Object.assign(Error(failure.message), {
      status: failure.status,
      body: { message: failure.message },
    }),
  );

const env = (): GeneratedResult<AgentOSTargetEnv> => {
  const platformEnv = getRequestEvent().platform?.env;
  if (platformEnv === undefined) return fail(500, "Cloudflare platform env missing");
  return { ok: true, value: platformEnv as AgentOSTargetEnv };
};

const agentOS = (platformEnv: AgentOSTargetEnv) =>
  agentOSRpcClient<AgentOSRpc>(platformEnv);

type AgentOSRemote = ReturnType<typeof agentOS>;
type AgentOSSubmitRunInput = Parameters<AgentOSRemote["submitRunInput"]>[0];

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const submitInputFromUnknown = (
  value: unknown,
): GeneratedResult<{ readonly input: AgentOSSubmitRunInput }> => {
  if (!isRecord(value) || !isRecord(value.input)) return fail(400, "invalid submit command input");
  if (typeof value.input.intent !== "string" || !isRecord(value.input.context)) {
    return fail(400, "invalid submit run input");
  }
  return { ok: true, value: { input: value.input as unknown as AgentOSSubmitRunInput } };
};

const resumeInputRequestFromUnknown = (
  value: unknown,
): GeneratedResult<WorkspaceAgentResumeInputRequestCommandInput> => {
  if (!isRecord(value)) return fail(400, "invalid resumeInputRequest command input");
  if (!isInputRequestRef(value.ref)) return fail(400, "invalid resumeInputRequest ref");
  const ref = value.ref;
  if (typeof value.decidedBy !== "string" || value.decidedBy.length === 0) {
    return fail(400, "invalid resumeInputRequest decidedBy");
  }
  if (!isRecord(value.answer) || typeof value.answer.decisionRef !== "string") {
    return fail(400, "invalid resumeInputRequest answer");
  }
  const parsed = parseInputRequestResumePayload(ref.requestKind, value.answer.resume);
  if (!parsed.ok) return fail(400, parsed.reason);
  return {
    ok: true,
    value: {
      ref,
      decidedBy: value.decidedBy,
      answer: {
        decisionRef: value.answer.decisionRef,
        resume: parsed.resume,
      },
    },
  };
};

const decideInputRequestFromUnknown = (
  value: unknown,
): GeneratedResult<WorkspaceAgentDecideInputRequestCommandInput> => {
  if (!isRecord(value)) return fail(400, "invalid decideInputRequest command input");
  if (!isInputRequestRef(value.ref)) return fail(400, "invalid decideInputRequest ref");
  if (!isRecord(value.decision) || typeof value.decision.kind !== "string") {
    return fail(400, "invalid decideInputRequest decision");
  }
  const ref = value.ref;
  const decision = value.decision;
  if (decision.kind === "approved") {
    if (typeof decision.decidedBy !== "string" || decision.decidedBy.length === 0) {
      return fail(400, "invalid decideInputRequest decidedBy");
    }
    if (!isRecord(decision.answer) || typeof decision.answer.decisionRef !== "string") {
      return fail(400, "invalid decideInputRequest answer");
    }
    const parsed = parseInputRequestResumePayload(ref.requestKind, decision.answer.resume);
    if (!parsed.ok) return fail(400, parsed.reason);
    return {
      ok: true,
      value: {
        ref,
        decision: {
          kind: "approved",
          decidedBy: decision.decidedBy,
          answer: {
            decisionRef: decision.answer.decisionRef,
            resume: parsed.resume,
          },
        },
      },
    };
  }
  if (decision.kind === "rejected") {
    if (typeof decision.decisionRef !== "string" || decision.decisionRef.length === 0) {
      return fail(400, "invalid decideInputRequest decisionRef");
    }
    if (typeof decision.decidedBy !== "string" || decision.decidedBy.length === 0) {
      return fail(400, "invalid decideInputRequest decidedBy");
    }
    return {
      ok: true,
      value: {
        ref,
        decision: {
          kind: "rejected",
          decisionRef: decision.decisionRef,
          decidedBy: decision.decidedBy,
          ...(typeof decision.reason === "string" ? { reason: decision.reason } : {}),
        },
      },
    };
  }
  if (decision.kind === "cancelled" || decision.kind === "expired") {
    if (typeof decision.closeRef !== "string" || decision.closeRef.length === 0) {
      return fail(400, "invalid decideInputRequest closeRef");
    }
    return {
      ok: true,
      value: {
        ref,
        decision: {
          kind: decision.kind,
          closeRef: decision.closeRef,
          ...(typeof decision.reason === "string" ? { reason: decision.reason } : {}),
        },
      },
    };
  }
  return fail(400, "unsupported decideInputRequest decision");
};

const customInputFromUnknown = (
  value: unknown,
): GeneratedResult<WorkspaceAgentCustomCommandInput> => {
  if (!isRecord(value) || typeof value.method !== "string" || value.method.length === 0) {
    return fail(400, "invalid custom command input");
  }
  return { ok: true, value: { method: value.method, input: value.input } };
};

const readStateInputFromUnknown = (
  value: unknown,
): GeneratedResult<WorkspaceAgentReadStateCommandInput> => {
  if (value === undefined) return { ok: true, value: {} };
  if (!isRecord(value)) return fail(400, "invalid readState command input");
  if (value.includeHidden !== undefined && typeof value.includeHidden !== "boolean") {
    return fail(400, "invalid readState includeHidden");
  }
  return {
    ok: true,
    value:
      value.includeHidden === undefined
        ? {}
        : { includeHidden: value.includeHidden },
  };
};

const readFileInputFromUnknown = (
  value: unknown,
): GeneratedResult<WorkspaceAgentReadFileCommandInput> => {
  if (!isRecord(value) || typeof value.path !== "string") {
    return fail(400, "invalid readFile command input");
  }
  if (value.encoding !== undefined && value.encoding !== "utf-8") {
    return fail(400, "unsupported readFile encoding");
  }
  return {
    ok: true,
    value: {
      path: value.path,
      ...(value.encoding === undefined ? {} : { encoding: value.encoding }),
    },
  };
};

const resetInputFromUnknown = (value: unknown): GeneratedResult<WorkspaceAgentResetCommandInput> => {
  if (value === undefined) return { ok: true, value: {} };
  if (!isRecord(value)) return fail(400, "invalid reset command input");
  return { ok: true, value: typeof value.reason === "string" ? { reason: value.reason } : {} };
};

const destroyInputFromUnknown = (
  value: unknown,
): GeneratedResult<WorkspaceAgentDestroyCommandInput> => {
  if (value === undefined) return { ok: true, value: {} };
  if (!isRecord(value)) return fail(400, "invalid destroy command input");
  return { ok: true, value: typeof value.reason === "string" ? { reason: value.reason } : {} };
};

const runtimeEventFromLedger = (
  event: Parameters<typeof decodeRuntimeLedgerEvent>[0],
): RuntimeLedgerEvent | null => {
  const decoded = decodeRuntimeLedgerEvent(event);
  return decoded._tag === "runtime" ? decoded.event : null;
};

const jsonValueFromString = (data: string): GeneratedResult<unknown> =>
  Result.match(
    Result.try({
      try: () => JSON.parse(data) as unknown,
      catch: () => "invalid ledger stream event: malformed JSON",
    }),
    {
      onFailure: (message) => fail(502, message),
      onSuccess: (value) => ({ ok: true, value }),
    },
  );

const ledgerEventFromSse = (
  event: SseHttpEvent,
): GeneratedResult<Parameters<typeof decodeRuntimeLedgerEvent>[0] | null> => {
  if (event.event !== "ledger") return { ok: true, value: null };
  if (event.data.trim().length === 0) {
    return fail(502, "invalid ledger stream event: empty data");
  }
  const parsed = jsonValueFromString(event.data);
  return parsed.ok
    ? { ok: true, value: parsed.value as Parameters<typeof decodeRuntimeLedgerEvent>[0] }
    : parsed;
};

const emptyRuntimeEvents = (): AsyncIterable<RuntimeLedgerEvent> => ({
  [Symbol.asyncIterator]() {
    return {
      next: () => Promise.resolve({ done: true as const, value: undefined }),
    };
  },
});

const runtimeEventsFromSse = (response: Response): AsyncIterable<RuntimeLedgerEvent> => {
  if (response.body === null) return emptyRuntimeEvents();
  const source = decodeSseHttpEvents(responseToSseHttpChunks(response));
  return {
    [Symbol.asyncIterator]() {
      const iterator = source[Symbol.asyncIterator]();
      const next = (): Promise<IteratorResult<RuntimeLedgerEvent>> =>
        iterator.next().then((result) => {
          if (result.done === true) return { done: true, value: undefined };
          const ledgerEvent = ledgerEventFromSse(result.value);
          if (!ledgerEvent.ok) return rejectFailure(ledgerEvent);
          if (ledgerEvent.value === null) return next();
          const runtimeEvent = runtimeEventFromLedger(ledgerEvent.value);
          return runtimeEvent === null ? next() : { done: false, value: runtimeEvent };
        });
      return {
        next,
        return: () =>
          iterator.return === undefined
            ? Promise.resolve({ done: true, value: undefined })
            : iterator.return(undefined).then(() => ({ done: true, value: undefined })),
      };
    },
  };
};

export const invokeAgentCommand = command(commandInput, ({ name, input }): Promise<unknown> => {
  const platformEnv = env();
  if (!platformEnv.ok) return rejectFailure(platformEnv);
  const runtime = agentOS(platformEnv.value);
  if (name === WORKSPACE_AGENT_COMMAND.SUBMIT) {
    const submitInput = submitInputFromUnknown(input);
    return submitInput.ok
      ? runtime.submitRunInput(submitInput.value.input)
      : rejectFailure(submitInput);
  }
  if (name === WORKSPACE_AGENT_COMMAND.RESUME_INPUT_REQUEST) {
    const resumeInput = resumeInputRequestFromUnknown(input);
    return resumeInput.ok
      ? runtime.resumeInputRequest(resumeInput.value)
      : rejectFailure(resumeInput);
  }
  if (name === WORKSPACE_AGENT_COMMAND.DECIDE_INPUT_REQUEST) {
    const decideInput = decideInputRequestFromUnknown(input);
    return decideInput.ok
      ? runtime.decideInputRequest(decideInput.value)
      : rejectFailure(decideInput);
  }
  if (name === WORKSPACE_AGENT_COMMAND.CUSTOM) {
    const customInput = customInputFromUnknown(input);
    return customInput.ok ? runtime.customCommand(customInput.value) : rejectFailure(customInput);
  }
  if (name === WORKSPACE_AGENT_COMMAND.READ_STATE) {
    const readStateInput = readStateInputFromUnknown(input);
    return readStateInput.ok
      ? runtime.readWorkspaceState(readStateInput.value)
      : rejectFailure(readStateInput);
  }
  if (name === WORKSPACE_AGENT_COMMAND.READ_FILE) {
    const readFileInput = readFileInputFromUnknown(input);
    return readFileInput.ok
      ? runtime.readWorkspaceFile(readFileInput.value)
      : rejectFailure(readFileInput);
  }
  if (name === WORKSPACE_AGENT_COMMAND.RESET) {
    const resetInput = resetInputFromUnknown(input);
    return resetInput.ok ? runtime.resetWorkspace(resetInput.value) : rejectFailure(resetInput);
  }
  if (name === WORKSPACE_AGENT_COMMAND.DESTROY) {
    const destroyInput = destroyInputFromUnknown(input);
    return destroyInput.ok
      ? runtime.destroyWorkspace(destroyInput.value)
      : rejectFailure(destroyInput);
  }
  return rejectFailure(fail(501, \`unsupported generated workspace command \${name}\`));
});

export const runEventStream = query.live(optionalAfterIdInput, (input) => {
  const afterId = input.afterId ?? 0;
  const platformEnv = env();
  if (!platformEnv.ok) return rejectFailure(platformEnv);
  return agentOS(platformEnv.value)
    .streamEvents(agentOSTruthIdentity, afterId > 0 ? { afterId } : {})
    .then(runtimeEventsFromSse);
});
`;

const renderChatSvelteKitRemote = (
  normalized: NormalizedChatAgentOsConfig<AuthoredAgentManifest>,
  modules: ReturnType<typeof staticTargetModules>,
): string => `${renderNamedImport(["command", "getRequestEvent", "query"], modules.svelteKitServer)}
${renderNamedImport(["decodeSseHttpEvents", "responseToSseHttpChunks"], modules.sseHttp)}
${renderNamedImport(["Result", "Schema"], modules.effect)}
${renderNamedImport(["WORKSPACE_AGENT_COMMAND"], modules.workspaceAgentHost)}
${renderNamedImport(
  ["decodeRuntimeLedgerEvent", "isInputRequestRef", "parseInputRequestResumePayload"],
  modules.runtimeProtocol,
)}
${renderNamedImport(["agentOSRpcClient", "agentOSTruthIdentity"], "./cloudflare-scope")}
${renderTypeImport(["AgentRuntimeClient"], modules.cloudflareDoRuntime)}
${renderTypeImport(["SseHttpEvent"], modules.sseHttp)}
${renderTypeImport(
  ["RuntimeLedgerEvent", "SubmitResult", "SubmitRunInput"],
  modules.runtimeProtocol,
)}
${renderTypeImport(
  [
    "WorkspaceAgentCommandOutputByName",
    "WorkspaceAgentCustomCommandInput",
    "WorkspaceAgentDecideInputRequestCommandInput",
    "WorkspaceAgentResumeInputRequestCommandInput",
  ],
  modules.workspaceAgentHost,
)}
${renderTypeImport(["AgentOSTargetEnv"], "./cloudflare-scope")}

type AgentOSRpc = Pick<AgentRuntimeClient, "events" | "streamEvents"> & {
  readonly submitRunInput: (input: SubmitRunInput) => Promise<SubmitResult>;
  readonly resumeInputRequest: (
    input: WorkspaceAgentResumeInputRequestCommandInput,
  ) => Promise<SubmitResult>;
  readonly decideInputRequest: (
    input: WorkspaceAgentDecideInputRequestCommandInput,
  ) => Promise<SubmitResult>;
  readonly customCommand: (
    input: WorkspaceAgentCustomCommandInput,
  ) => Promise<WorkspaceAgentCommandOutputByName[typeof WORKSPACE_AGENT_COMMAND.CUSTOM]>;
};

const optionalAfterIdInput = Schema.toStandardSchemaV1(
  Schema.Struct({ afterId: Schema.optional(Schema.Number) }),
);
const commandInput = Schema.toStandardSchemaV1(
  Schema.Struct({
    name: Schema.String,
    input: Schema.Unknown,
  }),
);

type GeneratedFailure = {
  readonly ok: false;
  readonly status: number;
  readonly message: string;
};

type GeneratedResult<Value> =
  | { readonly ok: true; readonly value: Value }
  | GeneratedFailure;

const fail = (status: number, message: string): GeneratedFailure => ({
  ok: false,
  status,
  message,
});

const rejectFailure = (failure: GeneratedFailure): Promise<never> =>
  Promise.reject(
    Object.assign(Error(failure.message), {
      status: failure.status,
      body: { message: failure.message },
    }),
  );

const env = (): GeneratedResult<AgentOSTargetEnv> => {
  const platformEnv = getRequestEvent().platform?.env;
  if (platformEnv === undefined) return fail(500, "Cloudflare platform env missing");
  return { ok: true, value: platformEnv as AgentOSTargetEnv };
};

const agentOS = (platformEnv: AgentOSTargetEnv) =>
  agentOSRpcClient<AgentOSRpc>(platformEnv);

type AgentOSRemote = ReturnType<typeof agentOS>;
type AgentOSSubmitRunInput = Parameters<AgentOSRemote["submitRunInput"]>[0];

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const submitInputFromUnknown = (
  value: unknown,
): GeneratedResult<{ readonly input: AgentOSSubmitRunInput }> => {
  if (!isRecord(value) || !isRecord(value.input)) return fail(400, "invalid submit command input");
  if (typeof value.input.intent !== "string" || !isRecord(value.input.context)) {
    return fail(400, "invalid submit run input");
  }
  return { ok: true, value: { input: value.input as unknown as AgentOSSubmitRunInput } };
};

const resumeInputRequestFromUnknown = (
  value: unknown,
): GeneratedResult<WorkspaceAgentResumeInputRequestCommandInput> => {
  if (!isRecord(value)) return fail(400, "invalid resumeInputRequest command input");
  if (!isInputRequestRef(value.ref)) return fail(400, "invalid resumeInputRequest ref");
  const ref = value.ref;
  if (typeof value.decidedBy !== "string" || value.decidedBy.length === 0) {
    return fail(400, "invalid resumeInputRequest decidedBy");
  }
  if (!isRecord(value.answer) || typeof value.answer.decisionRef !== "string") {
    return fail(400, "invalid resumeInputRequest answer");
  }
  const parsed = parseInputRequestResumePayload(ref.requestKind, value.answer.resume);
  if (!parsed.ok) return fail(400, parsed.reason);
  return {
    ok: true,
    value: {
      ref,
      decidedBy: value.decidedBy,
      answer: {
        decisionRef: value.answer.decisionRef,
        resume: parsed.resume,
      },
    },
  };
};

const decideInputRequestFromUnknown = (
  value: unknown,
): GeneratedResult<WorkspaceAgentDecideInputRequestCommandInput> => {
  if (!isRecord(value)) return fail(400, "invalid decideInputRequest command input");
  if (!isInputRequestRef(value.ref)) return fail(400, "invalid decideInputRequest ref");
  if (!isRecord(value.decision) || typeof value.decision.kind !== "string") {
    return fail(400, "invalid decideInputRequest decision");
  }
  const ref = value.ref;
  const decision = value.decision;
  if (decision.kind === "approved") {
    if (typeof decision.decidedBy !== "string" || decision.decidedBy.length === 0) {
      return fail(400, "invalid decideInputRequest decidedBy");
    }
    if (!isRecord(decision.answer) || typeof decision.answer.decisionRef !== "string") {
      return fail(400, "invalid decideInputRequest answer");
    }
    const parsed = parseInputRequestResumePayload(ref.requestKind, decision.answer.resume);
    if (!parsed.ok) return fail(400, parsed.reason);
    return {
      ok: true,
      value: {
        ref,
        decision: {
          kind: "approved",
          decidedBy: decision.decidedBy,
          answer: {
            decisionRef: decision.answer.decisionRef,
            resume: parsed.resume,
          },
        },
      },
    };
  }
  if (decision.kind === "rejected") {
    if (typeof decision.decisionRef !== "string" || decision.decisionRef.length === 0) {
      return fail(400, "invalid decideInputRequest decisionRef");
    }
    if (typeof decision.decidedBy !== "string" || decision.decidedBy.length === 0) {
      return fail(400, "invalid decideInputRequest decidedBy");
    }
    return {
      ok: true,
      value: {
        ref,
        decision: {
          kind: "rejected",
          decisionRef: decision.decisionRef,
          decidedBy: decision.decidedBy,
          ...(typeof decision.reason === "string" ? { reason: decision.reason } : {}),
        },
      },
    };
  }
  if (decision.kind === "cancelled" || decision.kind === "expired") {
    if (typeof decision.closeRef !== "string" || decision.closeRef.length === 0) {
      return fail(400, "invalid decideInputRequest closeRef");
    }
    return {
      ok: true,
      value: {
        ref,
        decision: {
          kind: decision.kind,
          closeRef: decision.closeRef,
          ...(typeof decision.reason === "string" ? { reason: decision.reason } : {}),
        },
      },
    };
  }
  return fail(400, "unsupported decideInputRequest decision");
};

const customInputFromUnknown = (
  value: unknown,
): GeneratedResult<WorkspaceAgentCustomCommandInput> => {
  if (!isRecord(value) || typeof value.method !== "string" || value.method.length === 0) {
    return fail(400, "invalid custom command input");
  }
  return { ok: true, value: { method: value.method, input: value.input } };
};

const runtimeEventFromLedger = (
  event: Parameters<typeof decodeRuntimeLedgerEvent>[0],
): RuntimeLedgerEvent | null => {
  const decoded = decodeRuntimeLedgerEvent(event);
  return decoded._tag === "runtime" ? decoded.event : null;
};

const jsonValueFromString = (data: string): GeneratedResult<unknown> =>
  Result.match(
    Result.try({
      try: () => JSON.parse(data) as unknown,
      catch: () => "invalid ledger stream event: malformed JSON",
    }),
    {
      onFailure: (message) => fail(502, message),
      onSuccess: (value) => ({ ok: true, value }),
    },
  );

const ledgerEventFromSse = (
  event: SseHttpEvent,
): GeneratedResult<Parameters<typeof decodeRuntimeLedgerEvent>[0] | null> => {
  if (event.event !== "ledger") return { ok: true, value: null };
  if (event.data.trim().length === 0) {
    return fail(502, "invalid ledger stream event: empty data");
  }
  const parsed = jsonValueFromString(event.data);
  return parsed.ok
    ? { ok: true, value: parsed.value as Parameters<typeof decodeRuntimeLedgerEvent>[0] }
    : parsed;
};

const emptyRuntimeEvents = (): AsyncIterable<RuntimeLedgerEvent> => ({
  [Symbol.asyncIterator]() {
    return {
      next: () => Promise.resolve({ done: true as const, value: undefined }),
    };
  },
});

const runtimeEventsFromSse = (response: Response): AsyncIterable<RuntimeLedgerEvent> => {
  if (response.body === null) return emptyRuntimeEvents();
  const source = decodeSseHttpEvents(responseToSseHttpChunks(response));
  return {
    [Symbol.asyncIterator]() {
      const iterator = source[Symbol.asyncIterator]();
      const next = (): Promise<IteratorResult<RuntimeLedgerEvent>> =>
        iterator.next().then((result) => {
          if (result.done === true) return { done: true, value: undefined };
          const ledgerEvent = ledgerEventFromSse(result.value);
          if (!ledgerEvent.ok) return rejectFailure(ledgerEvent);
          if (ledgerEvent.value === null) return next();
          const runtimeEvent = runtimeEventFromLedger(ledgerEvent.value);
          return runtimeEvent === null ? next() : { done: false, value: runtimeEvent };
        });
      return {
        next,
        return: () =>
          iterator.return === undefined
            ? Promise.resolve({ done: true, value: undefined })
            : iterator.return(undefined).then(() => ({ done: true, value: undefined })),
      };
    },
  };
};

export const invokeAgentCommand = command(commandInput, ({ name, input }): Promise<unknown> => {
  const platformEnv = env();
  if (!platformEnv.ok) return rejectFailure(platformEnv);
  const runtime = agentOS(platformEnv.value);
  if (name === WORKSPACE_AGENT_COMMAND.SUBMIT) {
    const submitInput = submitInputFromUnknown(input);
    return submitInput.ok
      ? runtime.submitRunInput(submitInput.value.input)
      : rejectFailure(submitInput);
  }
  if (name === WORKSPACE_AGENT_COMMAND.RESUME_INPUT_REQUEST) {
    const resumeInput = resumeInputRequestFromUnknown(input);
    return resumeInput.ok
      ? runtime.resumeInputRequest(resumeInput.value)
      : rejectFailure(resumeInput);
  }
  if (name === WORKSPACE_AGENT_COMMAND.DECIDE_INPUT_REQUEST) {
    const decideInput = decideInputRequestFromUnknown(input);
    return decideInput.ok
      ? runtime.decideInputRequest(decideInput.value)
      : rejectFailure(decideInput);
  }
  if (name === WORKSPACE_AGENT_COMMAND.CUSTOM) {
    const customInput = customInputFromUnknown(input);
    return customInput.ok ? runtime.customCommand(customInput.value) : rejectFailure(customInput);
  }
  return rejectFailure(fail(501, \`unsupported generated chat command \${name}\`));
});

export const runEventStream = query.live(optionalAfterIdInput, (input) => {
  const afterId = input.afterId ?? 0;
  const platformEnv = env();
  if (!platformEnv.ok) return rejectFailure(platformEnv);
  return agentOS(platformEnv.value)
    .streamEvents(agentOSTruthIdentity, afterId > 0 ? { afterId } : {})
    .then(runtimeEventsFromSse);
});
`;

const renderSvelteKitRemote = (
  normalized: NormalizedAgentOsConfig<AuthoredAgentManifest>,
  modules: ReturnType<typeof staticTargetModules>,
): string =>
  normalized.profile === AGENTOS_CONFIG_PROFILE.WORKSPACE_V1
    ? renderWorkspaceSvelteKitRemote(normalized, modules)
    : renderChatSvelteKitRemote(normalized, modules);

const renderWorkspaceStaticClient = (
  normalized: NormalizedWorkspaceAgentOsConfig<AuthoredAgentManifest>,
  modules: ReturnType<typeof staticTargetModules>,
): string => {
  if (normalized.client.kind === AGENTOS_CONFIG_CLIENT.BROWSER_DIRECT_V1) {
    return `${renderNamedImport(["createWorkspaceAgentClientBridge"], modules.workspaceAgentClient)}
${renderTypeImport(
  ["CreateWorkspaceAgentClientOptions", "WorkspaceAgentClientBridge"],
  modules.workspaceAgentClient,
)}

export type GeneratedAgentClientOptions = CreateWorkspaceAgentClientOptions;
export type GeneratedAgentClient = WorkspaceAgentClientBridge;

export const createAgentOSClient = (
  options: GeneratedAgentClientOptions = {},
): GeneratedAgentClient => createWorkspaceAgentClientBridge(options);
`;
  }

  return `${renderNamedImport(["createWorkspaceAgentClientBridge"], modules.workspaceAgentClient)}
import { invokeAgentCommand, runEventStream } from "./sveltekit.remote";
${renderNamedImport(["clientReadable", "selectClientReadable"], modules.clientSvelte)}
${renderTypeImport(["AgentClientSnapshot"], modules.clientCore)}
${renderTypeImport(
  [
    "CreateWorkspaceAgentClientOptions",
    "WorkspaceAgentClient",
    "WorkspaceAgentClientBridge",
    "WorkspaceAgentCommandOutputByName",
  ],
  modules.workspaceAgentClient,
)}
${renderTypeImport(["Readable"], modules.svelteStore)}

export type GeneratedAgentClientOptions = CreateWorkspaceAgentClientOptions;

export interface GeneratedAgentClient extends WorkspaceAgentClientBridge {
  readonly snapshot: Readable<AgentClientSnapshot>;
  readonly events: Readable<AgentClientSnapshot["events"]>;
  readonly connection: Readable<AgentClientSnapshot["connection"]>;
  readonly run: Readable<AgentClientSnapshot["run"]>;
  readonly inputRequests: Readable<AgentClientSnapshot["run"]["inputRequests"]>;
}

const generatedStreamSource: NonNullable<GeneratedAgentClientOptions["streamSource"]> = {
  open: (cursor) =>
    runEventStream({
      ...(cursor.afterEventId === undefined ? {} : { afterId: cursor.afterEventId }),
    }),
};

const generatedRpcInvoker: WorkspaceAgentClient["invoke"] = (name, input) =>
  invokeAgentCommand({ name, input }) as Promise<WorkspaceAgentCommandOutputByName[typeof name]>;

export const createAgentOSClient = (
  options: GeneratedAgentClientOptions = {},
): GeneratedAgentClient => {
  const bridge = createWorkspaceAgentClientBridge({
    ...options,
    streamSource: options.streamSource ?? generatedStreamSource,
    rpcInvoker: options.rpcInvoker ?? generatedRpcInvoker,
  });
  return {
    ...bridge,
    snapshot: clientReadable(bridge.client),
    events: selectClientReadable(bridge.client, (snapshot) => snapshot.events),
    connection: selectClientReadable(bridge.client, (snapshot) => snapshot.connection),
    run: selectClientReadable(bridge.client, (snapshot) => snapshot.run),
    inputRequests: selectClientReadable(bridge.client, (snapshot) => snapshot.run.inputRequests),
  };
};
`;
};

const renderChatStaticClient = (
  normalized: NormalizedChatAgentOsConfig<AuthoredAgentManifest>,
  modules: ReturnType<typeof staticTargetModules>,
): string => {
  const commonImports = `${renderNamedImport(
    ["WORKSPACE_AGENT_COMMAND", "createWorkspaceAgentClient"],
    modules.workspaceAgentClient,
  )}
${renderTypeImport(["SubmitRunInput"], modules.runtimeProtocol)}
${renderTypeImport(["AgentClientCommandOptions", "AgentClientSnapshot"], modules.clientCore)}
${renderTypeImport(
  [
    "CreateWorkspaceAgentClientOptions",
    "WorkspaceAgentClient",
    "WorkspaceAgentCommandOutputByName",
    "WorkspaceAgentCustomCommandInput",
    "WorkspaceAgentDecideInputRequestCommandInput",
    "WorkspaceAgentResumeInputRequestCommandInput",
  ],
  modules.workspaceAgentClient,
)}`;
  const commonTypes = `
export type GeneratedAgentClientOptions = CreateWorkspaceAgentClientOptions;

export interface GeneratedAgentClient {
  readonly client: WorkspaceAgentClient;
  submit(
    input: SubmitRunInput,
    options?: AgentClientCommandOptions,
  ): Promise<WorkspaceAgentCommandOutputByName[typeof WORKSPACE_AGENT_COMMAND.SUBMIT]>;
  resumeInputRequest(
    input: WorkspaceAgentResumeInputRequestCommandInput,
    options?: AgentClientCommandOptions,
  ): Promise<
    WorkspaceAgentCommandOutputByName[typeof WORKSPACE_AGENT_COMMAND.RESUME_INPUT_REQUEST]
  >;
  decideInputRequest(
    input: WorkspaceAgentDecideInputRequestCommandInput,
    options?: AgentClientCommandOptions,
  ): Promise<
    WorkspaceAgentCommandOutputByName[typeof WORKSPACE_AGENT_COMMAND.DECIDE_INPUT_REQUEST]
  >;
  custom(
    input: WorkspaceAgentCustomCommandInput,
    options?: AgentClientCommandOptions,
  ): Promise<WorkspaceAgentCommandOutputByName[typeof WORKSPACE_AGENT_COMMAND.CUSTOM]>;
`;
  const commonMethods = `
    client,
    submit(input, commandOptions) {
      return client.invoke(WORKSPACE_AGENT_COMMAND.SUBMIT, { input }, commandOptions);
    },
    resumeInputRequest(input, commandOptions) {
      return client.invoke(WORKSPACE_AGENT_COMMAND.RESUME_INPUT_REQUEST, input, commandOptions);
    },
    decideInputRequest(input, commandOptions) {
      return client.invoke(WORKSPACE_AGENT_COMMAND.DECIDE_INPUT_REQUEST, input, commandOptions);
    },
    custom(input, commandOptions) {
      return client.invoke(WORKSPACE_AGENT_COMMAND.CUSTOM, input, commandOptions);
    },`;
  if (normalized.client.kind === AGENTOS_CONFIG_CLIENT.BROWSER_DIRECT_V1) {
    return `${commonImports}
${commonTypes}
}

export const createAgentOSClient = (
  options: GeneratedAgentClientOptions = {},
): GeneratedAgentClient => {
  const client = createWorkspaceAgentClient(options);
  return {${commonMethods}
  };
};
`;
  }

  return `${commonImports}
import { invokeAgentCommand, runEventStream } from "./sveltekit.remote";
${renderNamedImport(["clientReadable", "selectClientReadable"], modules.clientSvelte)}
${renderTypeImport(["Readable"], modules.svelteStore)}
${commonTypes}
  readonly snapshot: Readable<AgentClientSnapshot>;
  readonly events: Readable<AgentClientSnapshot["events"]>;
  readonly connection: Readable<AgentClientSnapshot["connection"]>;
  readonly run: Readable<AgentClientSnapshot["run"]>;
  readonly inputRequests: Readable<AgentClientSnapshot["run"]["inputRequests"]>;
}

const generatedStreamSource: NonNullable<GeneratedAgentClientOptions["streamSource"]> = {
  open: (cursor) =>
    runEventStream({
      ...(cursor.afterEventId === undefined ? {} : { afterId: cursor.afterEventId }),
    }),
};

const generatedRpcInvoker: WorkspaceAgentClient["invoke"] = (name, input) =>
  invokeAgentCommand({ name, input }) as Promise<WorkspaceAgentCommandOutputByName[typeof name]>;

export const createAgentOSClient = (
  options: GeneratedAgentClientOptions = {},
): GeneratedAgentClient => {
  const client = createWorkspaceAgentClient({
    ...options,
    streamSource: options.streamSource ?? generatedStreamSource,
    rpcInvoker: options.rpcInvoker ?? generatedRpcInvoker,
  });
  return {${commonMethods}
    snapshot: clientReadable(client),
    events: selectClientReadable(client, (snapshot) => snapshot.events),
    connection: selectClientReadable(client, (snapshot) => snapshot.connection),
    run: selectClientReadable(client, (snapshot) => snapshot.run),
    inputRequests: selectClientReadable(client, (snapshot) => snapshot.run.inputRequests),
  };
};
`;
};

const renderStaticClient = (
  normalized: NormalizedAgentOsConfig<AuthoredAgentManifest>,
  modules: ReturnType<typeof staticTargetModules>,
): string =>
  normalized.profile === AGENTOS_CONFIG_PROFILE.WORKSPACE_V1
    ? renderWorkspaceStaticClient(normalized, modules)
    : renderChatStaticClient(normalized, modules);

const renderStaticClientTypes = (): string => `export type {
  GeneratedAgentClient,
  GeneratedAgentClientOptions,
} from "./client";

export { createAgentOSClient } from "./client";
`;

/**
 * Link normalized workspace authoring intent to a closed-target residual
 * program. Implementation wiring is static imports and factory composition;
 * manifest and deployment JSON remain semantic/provenance data only.
 *
 * @agentosPrimitive primitive.agent-authoring.linkWorkspaceStaticTarget
 * @agentosInvariant invariant.docs.agent-projection
 * @agentosInvariant invariant.algebra.single-code-source
 * @agentosDocs docs/guides/build-natural-language-workspace-agent.md
 */
export const linkWorkspaceStaticTarget = <K extends HandlerKind = HandlerKind>(
  normalized: NormalizedAgentOsConfig<AuthoredAgentManifest<K>>,
  options: StaticTargetLinkOptions = {},
): StaticTargetLinkResult => {
  const packageScope = options.packageScope ?? DEFAULT_STATIC_TARGET_PACKAGE_SCOPE;
  if (!packageScopePattern.test(packageScope)) {
    return {
      ok: false,
      issues: [{ kind: "invalid_static_package_scope", scope: packageScope }],
    };
  }
  const modules = staticTargetModules(packageScope);
  if (normalized.target.kind !== AGENTOS_CONFIG_TARGET.CLOUDFLARE_DO_V1) {
    return {
      ok: false,
      issues: [{ kind: "unsupported_static_target", target: normalized.target.kind }],
    };
  }
  if (normalized.llm.route !== AGENTOS_CONFIG_LLM_ROUTE.OPENAI_CHAT_COMPATIBLE) {
    return {
      ok: false,
      issues: [{ kind: "unsupported_static_llm_route", route: normalized.llm.route }],
    };
  }
  const toolNames = Object.keys(normalized.deployment.manifest.tools ?? {}).sort();
  const authoredToolNames = new Set(normalized.authoredToolNames);
  const authoredManifestToolNames = toolNames.filter((toolName) => authoredToolNames.has(toolName));
  const deploymentJson = {
    deploymentId: normalized.deployment.deploymentId,
    backend: normalized.deployment.backend,
    adapter: normalized.deployment.adapter,
    codec: normalized.deployment.codec,
    ...(normalized.deployment.providerStrategy === undefined
      ? {}
      : { providerStrategy: normalized.deployment.providerStrategy }),
    ...(normalized.profile === AGENTOS_CONFIG_PROFILE.WORKSPACE_V1
      ? {
          workspace: {
            binding: normalized.workspace.binding,
            bindingRef: normalized.workspace.bindingRef,
            root: normalized.workspace.root,
            topology: normalized.workspace.topology,
            providerResourceId: normalized.workspace.providerResourceId,
            cloudflareSandboxId: normalized.workspace.cloudflareSandboxId,
          },
        }
      : {}),
  };
  const moduleGraph: ReadonlyArray<StaticTargetModuleImport> = [
    { kind: "semantic-json", source: "./manifest.json", imports: ["default as declarations"] },
    { kind: "semantic-json", source: "./deployment.json", imports: ["default as deployment"] },
    {
      kind: "target-runtime",
      source: modules.cloudflareDoRuntime,
      imports: ["createAgentDurableObject"],
    },
    ...(normalized.profile === AGENTOS_CONFIG_PROFILE.WORKSPACE_V1
      ? [
          {
            kind: "capability-runtime" as const,
            source: modules.runtimeCapability,
            imports: [
              "WORKSPACE_OPERATION_HOST_FACT",
              "defineHost",
              "resolveRuntimeInstallGraph",
              "workspaceOperations",
            ],
          },
        ]
      : []),
    {
      kind: "provider-runtime",
      source: modules.openAiCompatibleTransport,
      imports: ["OpenAiCompatibleLlmTransportLive"],
    },
    {
      kind: "workspace-host",
      source: modules.workspaceAgentHost,
      imports:
        normalized.profile === AGENTOS_CONFIG_PROFILE.WORKSPACE_V1
          ? ["defineWorkspaceAgentMount", "WORKSPACE_AGENT_PROJECTION"]
          : ["WORKSPACE_AGENT_COMMAND"],
    },
    ...generatedToolImports(authoredManifestToolNames),
    ...(normalized.profile === AGENTOS_CONFIG_PROFILE.WORKSPACE_V1
      ? [
          {
            kind: "execution-domain-runtime" as const,
            source: modules.workspaceEnvCloudflare,
            imports: ["makeCloudflareWorkspaceEnv"],
          },
          {
            kind: "platform-runtime" as const,
            source: modules.cloudflareSandbox,
            imports: ["getSandbox", "Sandbox", "SandboxTransport"],
          },
        ]
      : []),
    {
      kind: "effect-runtime",
      source: modules.effect,
      imports: ["Effect"],
    },
    {
      kind: "target-scope-helper",
      source: "./cloudflare-scope",
      imports: ["agentOSRpcClient", "AgentOSTargetEnv"],
    },
    {
      kind: "target-worker",
      source: "./worker",
      imports:
        normalized.profile === AGENTOS_CONFIG_PROFILE.WORKSPACE_V1
          ? [normalized.target.durableObject.className, "Sandbox"]
          : [normalized.target.durableObject.className],
    },
    {
      kind: "target-config",
      source: "./wrangler.jsonc",
      imports: [],
    },
    ...generatedClientModuleImports(
      normalized as NormalizedAgentOsConfig<AuthoredAgentManifest>,
      modules,
    ),
  ];
  return {
    ok: true,
    value: {
      files: [
        generatedPath(
          ".agentos/generated/manifest.json",
          stableJson(normalized.deployment.manifest),
        ),
        generatedPath(".agentos/generated/deployment.json", stableJson(deploymentJson)),
        generatedPath(".agentos/generated/provenance.json", stableJson(normalized.provenance)),
        generatedPath(
          ".agentos/generated/fingerprints.json",
          stableJson({
            deployment: digestText(stableJson(deploymentJson)),
            manifest: digestText(stableJson(normalized.deployment.manifest)),
            targetModuleGraph: digestText(stableJson(moduleGraph)),
          }),
        ),
        generatedPath(
          ".agentos/generated/target.ts",
          renderStaticTarget(
            normalized as NormalizedAgentOsConfig<AuthoredAgentManifest>,
            toolNames,
            modules,
          ),
        ),
        generatedPath(
          ".agentos/generated/cloudflare-scope.ts",
          renderCloudflareScopeHelper(
            normalized as NormalizedAgentOsConfig<AuthoredAgentManifest>,
            modules,
          ),
        ),
        generatedPath(
          ".agentos/generated/worker.ts",
          renderCloudflareWorkerEntry(
            normalized as NormalizedAgentOsConfig<AuthoredAgentManifest>,
            modules,
          ),
        ),
        generatedPath(
          ".agentos/generated/wrangler.jsonc",
          renderCloudflareWranglerConfig(
            normalized as NormalizedAgentOsConfig<AuthoredAgentManifest>,
          ),
        ),
        ...(normalized.client.kind === AGENTOS_CONFIG_CLIENT.SVELTE_KIT_REMOTE_V1
          ? [
              generatedPath(
                ".agentos/generated/sveltekit.remote.ts",
                renderSvelteKitRemote(
                  normalized as NormalizedAgentOsConfig<AuthoredAgentManifest>,
                  modules,
                ),
              ),
            ]
          : []),
        generatedPath(
          ".agentos/generated/client.ts",
          renderStaticClient(normalized as NormalizedAgentOsConfig<AuthoredAgentManifest>, modules),
        ),
        generatedPath(".agentos/generated/client.d.ts", renderStaticClientTypes()),
      ],
      moduleGraph,
      canonicalDeployment: {
        profile: normalized.profile,
        target: normalized.target.kind,
        llmRoute: normalized.llm.route,
        client: normalized.client.kind,
        ...(normalized.profile === AGENTOS_CONFIG_PROFILE.WORKSPACE_V1
          ? { workspaceTopology: normalized.workspace.topology }
          : {}),
        toolNames,
      },
      mount: {
        driver: {
          kind: "cloudflare-do",
          className: normalized.target.durableObject.className,
          binding: normalized.target.durableObject.binding,
        },
        projectionSinks:
          normalized.profile === AGENTOS_CONFIG_PROFILE.WORKSPACE_V1
            ? [
                "agent.info",
                "workspace.state",
                "workspace.files",
                "runtime.events",
                "runtime.input_requests",
              ]
            : ["agent.info", "runtime.events", "runtime.input_requests"],
        ...(normalized.profile === AGENTOS_CONFIG_PROFILE.WORKSPACE_V1
          ? { providerResourceId: normalized.workspace.providerResourceId }
          : {}),
      },
    },
  };
};
