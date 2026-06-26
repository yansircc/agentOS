import type { ProviderResourceId } from "@agent-os/core/runtime-protocol";
import type { HandlerKind } from "@agent-os/core/runtime-protocol";
import { WORKSPACE_TOOL_EXPOSURE_PROFILES, type WorkspaceToolName } from "@agent-os/runtime";
import {
  digestText,
  GENERATED_LOAD_SKILL_TOOL_NAME,
  GENERATED_READ_SKILL_FILE_TOOL_NAME,
  isWorkspaceToolName,
} from "./shared";
import type {
  AuthoredAgentManifest,
  CompiledAgentChannel,
  CompiledAgentSchedule,
  CompiledAgentSkill,
} from "./manifest-compiler";
import {
  AGENTOS_CONFIG_CLIENT,
  AGENTOS_CONFIG_LLM_ROUTE,
  AGENTOS_CONFIG_PROFILE,
  AGENTOS_CONFIG_TARGET,
  llmMaterialEnvBindings,
  type AgentOsConfigCloudflareDoTarget,
  type AgentOsConfigClientKind,
  type AgentOsConfigLlmRoute,
  type AgentOsConfigProfile,
  type AgentOsConfigTarget,
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
  | "authored-schedule"
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
  readonly profile: AgentOsConfigProfile;
  readonly target: AgentOsConfigTargetKind;
  readonly llmRoute: typeof AGENTOS_CONFIG_LLM_ROUTE.OPENAI_CHAT_COMPATIBLE;
  readonly client: AgentOsConfigClientKind;
  readonly workspaceTopology?: AgentOsConfigWorkspaceTopology;
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
        readonly target: typeof AGENTOS_CONFIG_TARGET.NODE_V1;
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

const importChannelPath = (path: string): string => `../../${path.replace(/\.ts$/u, "")}`;

const importSchedulePath = (path: string): string => `../../${path.replace(/\.ts$/u, "")}`;

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

const cloudflareTargetFor = (target: AgentOsConfigTarget): AgentOsConfigCloudflareDoTarget => {
  if (target.kind === AGENTOS_CONFIG_TARGET.CLOUDFLARE_DO_V1) return target;
  throw new TypeError(`cloudflare target renderer received ${target.kind}`);
};

const staticTargetModules = (scope: string) => ({
  runtimeCapability: publicPackageSpecifier(scope, "runtime/capability"),
  cloudflareDoRuntime: publicPackageSpecifier(scope, "runtime/cloudflare"),
  localRuntime: publicPackageSpecifier(scope, "runtime/local"),
  openAiCompatibleTransport: publicPackageSpecifier(
    scope,
    "runtime/llm-effect-ai/openai-compatible",
  ),
  workspaceAgentHost: publicPackageSpecifier(scope, "runtime/workspace-agent"),
  workspaceAgentClient: publicPackageSpecifier(scope, "client/workspace-agent"),
  workspaceBinding: publicPackageSpecifier(scope, "runtime/workspace-binding"),
  workspaceEnvCloudflare: publicPackageSpecifier(scope, "runtime/cloudflare"),
  runtimeChannel: publicPackageSpecifier(scope, "runtime/channel"),
  runtimeSchedule: publicPackageSpecifier(scope, "runtime/schedule"),
  runtimeRunProjector: publicPackageSpecifier(scope, "runtime/run-projector"),
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

const sortedChannels = (
  channels: ReadonlyArray<CompiledAgentChannel>,
): ReadonlyArray<CompiledAgentChannel> =>
  [...channels].sort((left, right) => left.name.localeCompare(right.name));

const sortedSchedules = (
  schedules: ReadonlyArray<CompiledAgentSchedule>,
): ReadonlyArray<CompiledAgentSchedule> =>
  [...schedules].sort((left, right) => left.scheduleId.localeCompare(right.scheduleId));

const generatedChannelImports = (
  channels: ReadonlyArray<CompiledAgentChannel>,
): ReadonlyArray<StaticTargetModuleImport> =>
  sortedChannels(channels).map((channel, index) => ({
    kind: "authored-channel",
    source: importChannelPath(channel.path),
    imports: [`default as channel_${index}`],
  }));

const generatedScheduleImports = (
  schedules: ReadonlyArray<CompiledAgentSchedule>,
): ReadonlyArray<StaticTargetModuleImport> =>
  sortedSchedules(schedules).map((schedule, index) => ({
    kind: "authored-schedule",
    source: importSchedulePath(schedule.path),
    imports: [`default as schedule_${index}`],
  }));

const renderChannelRegistry = (
  channels: ReadonlyArray<CompiledAgentChannel>,
  modules: ReturnType<typeof staticTargetModules>,
): string => {
  const ordered = sortedChannels(channels);
  const channelImports = ordered
    .map((channel, index) => `import channel_${index} from ${jsString(importChannelPath(channel.path))};`)
    .join("\n");
  const entries =
    ordered.length === 0
      ? "[]"
      : `[\n${ordered
          .map(
            (channel, index) =>
              `  { name: ${jsString(channel.name)}, path: ${jsString(
                channel.path,
              )}, channel: channel_${index} as DefinedChannel },`,
          )
          .join("\n")}\n]`;
  return `${channelImports}
${renderNamedImport(["createChannelContext"], modules.runtimeChannel)}
${renderTypeImport(
  ["ChannelMethod", "ChannelRequest", "ChannelRoute", "ChannelRuntime", "DefinedChannel"],
  modules.runtimeChannel,
)}

type GeneratedChannelDefinition = {
  readonly name: string;
  readonly path: string;
  readonly channel: DefinedChannel;
};

type GeneratedChannelRoute = ChannelRoute & {
  readonly channelName: string;
  readonly mountPath: string;
  readonly channel: DefinedChannel;
};

export const generatedChannels = ${entries} as const satisfies ReadonlyArray<GeneratedChannelDefinition>;

const mountedChannelPath = (channelName: string, routePath: string): string =>
  routePath === "/" ? \`/channels/\${channelName}\` : \`/channels/\${channelName}\${routePath}\`;

const generatedRoutes = generatedChannels.flatMap((entry): ReadonlyArray<GeneratedChannelRoute> =>
  entry.channel.routes.map((route) => ({
    ...route,
    channelName: entry.name,
    mountPath: mountedChannelPath(entry.name, route.path),
    channel: entry.channel,
  })),
);

const routeSegments = (path: string): ReadonlyArray<string> =>
  path
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);

const isRouteParamSegment = (segment: string): boolean => segment.startsWith(":");

const routePatternsConflict = (left: string, right: string): boolean => {
  const leftSegments = routeSegments(left);
  const rightSegments = routeSegments(right);
  if (leftSegments.length !== rightSegments.length) return false;
  return leftSegments.every((leftSegment, index) => {
    const rightSegment = rightSegments[index] ?? "";
    return leftSegment === rightSegment || isRouteParamSegment(leftSegment) || isRouteParamSegment(rightSegment);
  });
};

const assertNoGeneratedChannelRouteConflicts = (routes: ReadonlyArray<GeneratedChannelRoute>): void => {
  for (let leftIndex = 0; leftIndex < routes.length; leftIndex += 1) {
    const left = routes[leftIndex];
    if (left === undefined) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < routes.length; rightIndex += 1) {
      const right = routes[rightIndex];
      if (right === undefined || left.method !== right.method) continue;
      if (!routePatternsConflict(left.mountPath, right.mountPath)) continue;
      throw new Error(
        \`generated channel route conflict: \${left.method} \${left.mountPath} conflicts with \${right.mountPath}\`,
      );
    }
  }
};

assertNoGeneratedChannelRouteConflicts(generatedRoutes);

export const generatedChannelNames = generatedChannels.map((entry) => entry.name);
export const generatedChannelRoutes = generatedRoutes;

const matchGeneratedChannelPath = (
  pattern: string,
  pathname: string,
): Readonly<Record<string, string>> | null => {
  const patternSegments = routeSegments(pattern);
  const pathSegments = routeSegments(pathname);
  if (patternSegments.length !== pathSegments.length) return null;
  const params: Record<string, string> = {};
  for (let index = 0; index < patternSegments.length; index += 1) {
    const patternSegment = patternSegments[index] ?? "";
    const pathSegment = pathSegments[index] ?? "";
    if (patternSegment.startsWith(":")) {
      const paramName = patternSegment.slice(1);
      if (paramName.length === 0) return null;
      params[paramName] = decodeURIComponent(pathSegment);
      continue;
    }
    if (patternSegment !== pathSegment) return null;
  }
  return params;
};

export const dispatchGeneratedChannelRequest = async (
  request: Request,
  runtime: ChannelRuntime,
): Promise<Response | null> => {
  const url = new URL(request.url);
  const method = request.method.toUpperCase() as ChannelMethod;
  for (const route of generatedChannelRoutes) {
    if (route.method !== method) continue;
    const params = matchGeneratedChannelPath(route.mountPath, url.pathname);
    if (params === null) continue;
    const channelRequest: ChannelRequest = {
      method: route.method,
      path: url.pathname,
      params,
      request,
      url,
    };
    const principal = await route.channel.verify(channelRequest);
    const context = createChannelContext(runtime, principal);
    return route.handler(channelRequest, context);
  }
  return null;
};
`;
};

const renderScheduleRegistry = (
  schedules: ReadonlyArray<CompiledAgentSchedule>,
  modules: ReturnType<typeof staticTargetModules>,
): string => {
  const ordered = sortedSchedules(schedules);
  const scheduleImports = ordered
    .map(
      (schedule, index) =>
        `import schedule_${index} from ${jsString(importSchedulePath(schedule.path))};`,
    )
    .join("\n");
  const entries =
    ordered.length === 0
      ? "[]"
      : `[\n${ordered
          .map(
            (schedule, index) =>
              `  { scheduleId: ${jsString(schedule.scheduleId)}, path: ${jsString(
                schedule.path,
              )}, cron: ${jsString(schedule.cron)}, schedule: schedule_${index} as DefinedSchedule },`,
          )
          .join("\n")}\n]`;
  return `${scheduleImports}
${renderNamedImport(["createScheduleContext", "scheduleFireId"], modules.runtimeSchedule)}
${renderTypeImport(
  ["DefinedSchedule", "SchedulePrincipal", "ScheduleRuntime"],
  modules.runtimeSchedule,
)}

type GeneratedScheduleDefinition = {
  readonly scheduleId: string;
  readonly path: string;
  readonly cron: string;
  readonly schedule: DefinedSchedule;
};

export type GeneratedScheduleTriggerInput = {
  readonly scheduleId: string;
  readonly scheduledAt: string | number | Date;
  readonly appPrincipal: SchedulePrincipal;
};

export type GeneratedScheduleDispatchInput = GeneratedScheduleTriggerInput & {
  readonly runtime: ScheduleRuntime;
};

export const generatedSchedules = ${entries} as const satisfies ReadonlyArray<GeneratedScheduleDefinition>;
export const generatedScheduleIds = generatedSchedules.map((entry) => entry.scheduleId);
export const generatedScheduleRegistry = new Map(
  generatedSchedules.map((entry) => [entry.scheduleId, entry]),
);

export const dispatchGeneratedSchedule = async (
  input: GeneratedScheduleDispatchInput,
): Promise<unknown> => {
  const entry = generatedScheduleRegistry.get(input.scheduleId);
  if (entry === undefined) {
    throw new Error(\`unknown generated schedule: \${input.scheduleId}\`);
  }
  const fireId = scheduleFireId({
    appPrincipal: input.appPrincipal,
    scheduleId: entry.scheduleId,
    scheduledAt: input.scheduledAt,
  });
  const context = createScheduleContext(input.runtime, {
    appPrincipal: input.appPrincipal,
    fireId,
    scheduledAt: input.scheduledAt,
  });
  return entry.schedule.handler(context);
};
`;
};

const renderSkillCatalog = (skills: ReadonlyArray<CompiledAgentSkill>): string => {
  const entries = sortedSkills(skills).map(
    (skill) =>
      `  ${JSON.stringify(
        stableJsonValue({
          description: skill.description,
          digest: skill.digest,
          files: skill.files.map((file) => ({
            bytes: file.bytes,
            digest: file.digest,
            path: file.path,
            text: file.text,
          })),
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
  readonly description: string;
  readonly path: string;
  readonly digest: string;
  readonly text: string;
  readonly files: ReadonlyArray<{
    readonly path: string;
    readonly digest: string;
    readonly bytes: number;
    readonly text: string;
  }>;
};

type GeneratedSkillFile = GeneratedSkill["files"][number];

type LoadedGeneratedSkill = Omit<GeneratedSkill, "files"> & {
  readonly files: ReadonlyArray<Omit<GeneratedSkillFile, "text">>;
};

const generatedSkillCatalog = ${renderSkillCatalog(skills)} satisfies ReadonlyArray<GeneratedSkill>;
const generatedSkillNames = generatedSkillCatalog.map((skill) => skill.name);
const generatedSkillByName = Object.fromEntries(
  generatedSkillCatalog.map((skill) => [skill.name, skill]),
) as Readonly<Record<(typeof generatedSkillNames)[number], GeneratedSkill>>;
const generatedSkillFilePathCatalog = generatedSkillCatalog.flatMap((skill) =>
  skill.files.map((file) => ({ name: skill.name, path: file.path })),
);
const generatedSkillsSystemAdvert = [
  "Available agent skills are not loaded by default.",
  ...generatedSkillCatalog.map((skill) => \`- \${skill.name}: \${skill.description}\`),
  "Do not assume a skill's full instructions until ${GENERATED_LOAD_SKILL_TOOL_NAME} returns it.",
].join("\\n");

const generatedSystemPrompt = (system: string | undefined): string =>
  system === undefined || system.length === 0
    ? generatedSkillsSystemAdvert
    : \`\${system}\\n\\n\${generatedSkillsSystemAdvert}\`;

const generatedLoadedSkill = (skill: GeneratedSkill): LoadedGeneratedSkill => ({
  name: skill.name,
  description: skill.description,
  path: skill.path,
  digest: skill.digest,
  text: skill.text,
  files: skill.files.map((file) => ({
    path: file.path,
    digest: file.digest,
    bytes: file.bytes,
  })),
});

const generatedLoadSkillTool = defineProductTool({
  name: ${jsString(GENERATED_LOAD_SKILL_TOOL_NAME)},
  description: "Load the full text of a CLI-authored agent skill by name.",
  args: Schema.Struct({ name: ${renderSkillNameSchema(skills)} }),
  authority: "agentos.generated.skills",
  authorityId: "agentos.generated.skills.load_skill",
  admit: () => Effect.succeed({ ok: true as const }),
  execute: ({ name }) => Effect.succeed(generatedLoadedSkill(generatedSkillByName[name])),
});

const generatedReadSkillFileTool = defineProductTool({
  name: ${jsString(GENERATED_READ_SKILL_FILE_TOOL_NAME)},
  description: "Read one declared supporting file from a CLI-authored agent skill package.",
  args: Schema.Struct({
    name: ${renderSkillNameSchema(skills)},
    path: Schema.String,
  }),
  authority: "agentos.generated.skills",
  authorityId: "agentos.generated.skills.read_skill_file",
  admit: ({ name, path }) =>
    Effect.succeed({
      ok: generatedSkillFilePathCatalog.some((file) => file.name === name && file.path === path),
    } as const),
  execute: ({ name, path }) => {
    const file = generatedSkillByName[name].files.find((candidate) => candidate.path === path);
    if (file === undefined) {
      return Effect.fail(Error(\`unknown skill file \${name}/\${path}\`));
    }
    return Effect.succeed({
      name,
      path: file.path,
      digest: file.digest,
      text: file.text,
    });
  },
});

const generatedFrameworkTools = {
  ${jsString(GENERATED_LOAD_SKILL_TOOL_NAME)}: generatedLoadSkillTool,
  ${jsString(GENERATED_READ_SKILL_FILE_TOOL_NAME)}: generatedReadSkillFileTool,
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

const renderProductApiHelpers = (): string => `export interface AgentSessionSubmitTurnInput extends SubmitRunInput {
  readonly sessionRef: string;
  readonly turnRef: string;
  readonly idempotencyKey?: string;
}

export interface AgentWorkflowRunInput extends SubmitRunInput {
  readonly workflowId: string;
  readonly workflowRunId: string;
  readonly idempotencyKey?: string;
  readonly inputDigest?: string;
}

export interface AgentWorkflowRunRef {
  readonly workflowId: string;
  readonly workflowRunId: string;
}

const submitRunInputFields = (input: SubmitRunInput): SubmitRunInput => ({
  intent: input.intent,
  context: input.context,
  ...(input.system === undefined ? {} : { system: input.system }),
  ...(input.budget === undefined ? {} : { budget: input.budget }),
  ...(input.outputSchema === undefined ? {} : { outputSchema: input.outputSchema }),
  ...(input.traceContext === undefined ? {} : { traceContext: input.traceContext }),
  ...(input.materials === undefined ? {} : { materials: input.materials }),
  ...(input.toolContext === undefined ? {} : { toolContext: input.toolContext }),
  ...(input.toolPolicy === undefined ? {} : { toolPolicy: input.toolPolicy }),
  ...(input.decisionInterrupts === undefined ? {} : { decisionInterrupts: input.decisionInterrupts }),
  ...(input.resume === undefined ? {} : { resume: input.resume }),
});

const submitRunInputFromWorkflowRun = (
  input: AgentWorkflowRunInput,
): SubmitRunInput => submitRunInputFields(input);

const submitRunInputFromSessionTurn = (
  input: AgentSessionSubmitTurnInput,
): SubmitRunInput => submitRunInputFields(input);`;

const renderProductApiDurableObjectMethods = (): string => `
  submitSessionTurn(input: AgentSessionSubmitTurnInput): Promise<SubmitResult> {
    const bindings = generatedSubmitBindingsFor(this.targetEnv);
    return bindings.ok
      ? this.submitWithBindingsAndProductLink(
          submitSpecFromRunInput(submitRunInputFromSessionTurn(input)),
          bindings.value,
          {
            kind: "session_turn",
            sessionRef: input.sessionRef,
            turnRef: input.turnRef,
            ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
          },
        )
      : rejectTargetFailure(bindings);
  }

  inspectSession(input: { readonly sessionRef: string }): Promise<AgentSessionProjection> {
    return this.events(semanticTruthIdentity).then((events) =>
      projectAgentSession(events, input.sessionRef),
    );
  }

  listSessions(): Promise<AgentSessionListProjection> {
    return this.events(semanticTruthIdentity).then((events) => projectAgentSessions(events));
  }

  runWorkflow(input: AgentWorkflowRunInput): Promise<SubmitResult> {
    const bindings = generatedSubmitBindingsFor(this.targetEnv);
    return bindings.ok
      ? this.submitWithBindingsAndProductLink(
          submitSpecFromRunInput(submitRunInputFromWorkflowRun(input)),
          bindings.value,
          {
            kind: "workflow_run",
            workflowId: input.workflowId,
            workflowRunId: input.workflowRunId,
            ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
            ...(input.inputDigest === undefined ? {} : { inputDigest: input.inputDigest }),
          },
        )
      : rejectTargetFailure(bindings);
  }

  inspectWorkflowRun(input: AgentWorkflowRunRef): Promise<WorkflowRunProjection | null> {
    return this.events(semanticTruthIdentity).then((events) =>
      projectWorkflowRun(events, input.workflowId, input.workflowRunId),
    );
  }

  listWorkflowRuns(input: { readonly workflowId: string }): Promise<WorkflowRunListProjection> {
    return this.events(semanticTruthIdentity).then((events) =>
      projectWorkflowRuns(events, input.workflowId),
    );
  }`;

const renderScheduleDurableObjectHelpers = (): string => `
const generatedScheduleRuntimeFor = (target: {
  readonly submitSessionTurn: (input: AgentSessionSubmitTurnInput) => Promise<SubmitResult>;
  readonly runWorkflow: (input: AgentWorkflowRunInput) => Promise<SubmitResult>;
}) =>
  Object.freeze({
    sessions: Object.freeze({
      submitTurn: (input: AgentSessionSubmitTurnInput) => target.submitSessionTurn(input),
    }),
    workflows: Object.freeze({
      run: (input: AgentWorkflowRunInput) => target.runWorkflow(input),
    }),
  });`;

const renderScheduleDurableObjectMethod = (): string => `
  dispatchSchedule(input: GeneratedScheduleTriggerInput): Promise<unknown> {
    return dispatchGeneratedSchedule({
      ...input,
      runtime: generatedScheduleRuntimeFor(this),
    });
  }
`;

const renderGeneratedWorkspaceOperations = (
  workspaceToolArray: string,
  usesMutationTools: boolean,
  usesShellTools: boolean,
): string => `const generatedWorkspaceToolNames = ${workspaceToolArray};

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

const generatedWorkspaceOperations = {
  toolNames: generatedWorkspaceToolNames,
  mutationPolicy: ${usesMutationTools ? '"receipt-backed"' : '"disabled"'},
  shellPolicy: ${usesShellTools ? '"receipt-backed"' : '"disabled"'},
  toolInteractions: generatedWorkspaceToolInteractions,
} as const;`;

const renderWorkspaceStaticTarget = (
  normalized: NormalizedWorkspaceAgentOsConfig<AuthoredAgentManifest>,
  toolNames: ReadonlyArray<string>,
  modules: ReturnType<typeof staticTargetModules>,
): string => {
  const target = cloudflareTargetFor(normalized.target);
  const hasSkills = normalized.skills.length > 0;
  const hasSchedules = normalized.schedules.length > 0;
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
    ...(hasSchedules ? [renderNamedImport(["dispatchGeneratedSchedule"], "./schedules")] : []),
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
    renderNamedImport(
      ["OpenAiCompatibleLlmTransportLive", "preflightOpenAiCompatibleProviderMaterial"],
      modules.openAiCompatibleTransport,
    ),
    renderNamedImport(["manifestTruthIdentity"], modules.runtimeProtocol),
    renderNamedImport(
      ["projectAgentSession", "projectAgentSessions", "projectWorkflowRun", "projectWorkflowRuns"],
      modules.runtimeRunProjector,
    ),
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
    renderTypeImport(
      [
        "AgentSessionListProjection",
        "AgentSessionProjection",
        "WorkflowRunListProjection",
        "WorkflowRunProjection",
      ],
      modules.runtimeRunProjector,
    ),
    renderTypeImport(["AgentSubmitSpec"], modules.cloudflareDoRuntime),
    ...(hasSchedules ? [renderTypeImport(["GeneratedScheduleTriggerInput"], "./schedules")] : []),
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
const semanticTruthIdentity = manifestTruthIdentity(semanticManifest);
const generatedHandler = () => undefined;

type AgentOSTargetEnv = {
  readonly [binding: string]: unknown;
  readonly SANDBOX_TRANSPORT?: SandboxTransport;
${generatedLlmEnvFields}
};

type GeneratedTargetFailure = {
  readonly ok: false;
  readonly message: string;
  readonly diagnostics?: ReturnType<typeof preflightOpenAiCompatibleProviderMaterial>;
};

type GeneratedTargetResult<Value> =
  | { readonly ok: true; readonly value: Value }
  | GeneratedTargetFailure;

const targetFailure = (
  message: string,
  diagnostics?: ReturnType<typeof preflightOpenAiCompatibleProviderMaterial>,
): GeneratedTargetFailure => ({
  ok: false,
  message,
  ...(diagnostics === undefined || diagnostics.length === 0 ? {} : { diagnostics }),
});

const rejectTargetFailure = (failure: GeneratedTargetFailure): Promise<never> => {
  const error = Error(failure.message) as Error & {
    diagnostics?: ReturnType<typeof preflightOpenAiCompatibleProviderMaterial>;
  };
  if (failure.diagnostics !== undefined) error.diagnostics = failure.diagnostics;
  return Promise.reject(error);
};

${renderGeneratedWorkspaceOperations(workspaceToolArray, usesMutationTools, usesShellTools)}
const generatedCustomTools = ${customToolRecord} satisfies Readonly<Record<string, Tool>>;
${renderSkillSupport(normalized.skills)}
const generatedWorkspaceSandboxId = ${jsString(normalized.workspace.cloudflareSandboxId)};

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
    [workspaceOperations(generatedWorkspaceOperations)],
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

const generatedProviderPreflightDiagnosticsFor = (
  env: AgentOSTargetEnv,
): ReturnType<typeof preflightOpenAiCompatibleProviderMaterial> => {
  const modelValue = materialValue(env, { kind: "model", ref: ${jsString(normalized.llm.modelRef)} });
  return preflightOpenAiCompatibleProviderMaterial({
    route: {
      kind: "openai-chat-compatible",
      endpointRef: ${jsString(normalized.llm.endpointRef)},
      credentialRef: ${jsString(normalized.llm.credentialRef)},
      modelId: typeof modelValue === "string" ? modelValue : "",
    },
    refResolver: { material: (ref) => materialValue(env, ref) },
    routeBindingRef: "default",
    modelMaterial: {
      ref: ${jsString(normalized.llm.modelRef)},
      value: modelValue,
    },
  });
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
  const preflightDiagnostics = generatedProviderPreflightDiagnosticsFor(env);
  if (preflightDiagnostics.length > 0) {
    return targetFailure(
      "OpenAI-compatible provider material preflight failed",
      preflightDiagnostics,
    );
  }
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

export class ${target.durableObject.className} extends Base${target.durableObject.className} {
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

${renderProductApiDurableObjectMethods()}
${hasSchedules ? renderScheduleDurableObjectMethod() : ""}

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
  const target = cloudflareTargetFor(normalized.target);
  const hasSkills = normalized.skills.length > 0;
  const hasSchedules = normalized.schedules.length > 0;
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
    ...(hasSchedules ? [renderNamedImport(["dispatchGeneratedSchedule"], "./schedules")] : []),
    renderNamedImport(["createAgentDurableObject"], modules.cloudflareDoRuntime),
    renderNamedImport(
      ["OpenAiCompatibleLlmTransportLive", "preflightOpenAiCompatibleProviderMaterial"],
      modules.openAiCompatibleTransport,
    ),
    renderNamedImport(["manifestTruthIdentity"], modules.runtimeProtocol),
    renderNamedImport(
      ["projectAgentSession", "projectAgentSessions", "projectWorkflowRun", "projectWorkflowRuns"],
      modules.runtimeRunProjector,
    ),
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
    renderTypeImport(
      [
        "AgentSessionListProjection",
        "AgentSessionProjection",
        "WorkflowRunListProjection",
        "WorkflowRunProjection",
      ],
      modules.runtimeRunProjector,
    ),
    renderTypeImport(["AgentSubmitSpec"], modules.cloudflareDoRuntime),
    ...(hasSchedules ? [renderTypeImport(["GeneratedScheduleTriggerInput"], "./schedules")] : []),
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
const semanticTruthIdentity = manifestTruthIdentity(semanticManifest);
const generatedHandler = () => undefined;

type AgentOSTargetEnv = {
  readonly [binding: string]: unknown;
${generatedLlmEnvFields}
};

type GeneratedTargetFailure = {
  readonly ok: false;
  readonly message: string;
  readonly diagnostics?: ReturnType<typeof preflightOpenAiCompatibleProviderMaterial>;
};

type GeneratedTargetResult<Value> =
  | { readonly ok: true; readonly value: Value }
  | GeneratedTargetFailure;

const targetFailure = (
  message: string,
  diagnostics?: ReturnType<typeof preflightOpenAiCompatibleProviderMaterial>,
): GeneratedTargetFailure => ({
  ok: false,
  message,
  ...(diagnostics === undefined || diagnostics.length === 0 ? {} : { diagnostics }),
});

const rejectTargetFailure = (failure: GeneratedTargetFailure): Promise<never> => {
  const error = Error(failure.message) as Error & {
    diagnostics?: ReturnType<typeof preflightOpenAiCompatibleProviderMaterial>;
  };
  if (failure.diagnostics !== undefined) error.diagnostics = failure.diagnostics;
  return Promise.reject(error);
};

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

const generatedProviderPreflightDiagnosticsFor = (
  env: AgentOSTargetEnv,
): ReturnType<typeof preflightOpenAiCompatibleProviderMaterial> => {
  const modelValue = materialValue(env, { kind: "model", ref: ${jsString(normalized.llm.modelRef)} });
  return preflightOpenAiCompatibleProviderMaterial({
    route: {
      kind: "openai-chat-compatible",
      endpointRef: ${jsString(normalized.llm.endpointRef)},
      credentialRef: ${jsString(normalized.llm.credentialRef)},
      modelId: typeof modelValue === "string" ? modelValue : "",
    },
    refResolver: { material: (ref) => materialValue(env, ref) },
    routeBindingRef: "default",
    modelMaterial: {
      ref: ${jsString(normalized.llm.modelRef)},
      value: modelValue,
    },
  });
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
  const preflightDiagnostics = generatedProviderPreflightDiagnosticsFor(env);
  if (preflightDiagnostics.length > 0) {
    return targetFailure(
      "OpenAI-compatible provider material preflight failed",
      preflightDiagnostics,
    );
  }
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

${renderProductApiHelpers()}
${hasSchedules ? renderScheduleDurableObjectHelpers() : ""}

const Base${target.durableObject.className} = createAgentDurableObject<AgentOSTargetEnv>({
  manifest: semanticManifest,
  agentBindings: {
    handlers: ${handlerRecord},
  },
  refResolver: (env) => ({
    material: (ref) => materialValue(env, ref),
  }),
  llmTransport: () => OpenAiCompatibleLlmTransportLive,
});

export class ${target.durableObject.className} extends Base${target.durableObject.className} {
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

${renderProductApiDurableObjectMethods()}
${hasSchedules ? renderScheduleDurableObjectMethod() : ""}

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

const renderLocalAgentApp = (
  normalized: NormalizedWorkspaceAgentOsConfig<AuthoredAgentManifest>,
  toolNames: ReadonlyArray<string>,
  modules: ReturnType<typeof staticTargetModules>,
): string => {
  if (normalized.target.kind !== AGENTOS_CONFIG_TARGET.NODE_V1) {
    throw new TypeError(`local agent app renderer received ${normalized.target.kind}`);
  }
  const hasChannels = normalized.channels.length > 0;
  const hasSchedules = normalized.schedules.length > 0;
  const authoredToolNames = new Set(normalized.authoredToolNames);
  const workspaceToolList = toolNames.filter(
    (toolName): toolName is WorkspaceToolName =>
      isWorkspaceToolName(toolName) && !authoredToolNames.has(toolName),
  );
  const workspaceToolArray = `[${workspaceToolList.map(jsString).join(", ")}] as const`;
  const usesMutationTools = workspaceToolList.some((toolName) =>
    workspaceMutationToolNames.has(toolName),
  );
  const usesShellTools = workspaceToolList.some((toolName) =>
    workspaceShellToolNames.has(toolName),
  );
  const llmEnvByKind = Object.fromEntries(
    llmMaterialEnvBindings(normalized.llm).map((binding) => [binding.kind, binding.envName]),
  ) as Record<LlmMaterialEnvKind, string>;
  const imports = [
    `import semanticDeclarations from "./manifest.json";`,
    ...(hasChannels ? [renderNamedImport(["dispatchGeneratedChannelRequest"], "./channels")] : []),
    ...(hasChannels ? [renderTypeImport(["ChannelRuntime"], modules.runtimeChannel)] : []),
    ...(hasSchedules
      ? [renderNamedImport(["dispatchGeneratedSchedule", "generatedScheduleIds"], "./schedules")]
      : []),
    ...(hasSchedules ? [renderTypeImport(["GeneratedScheduleTriggerInput"], "./schedules")] : []),
    renderNamedImport(["lowerLocalAgentRuntime"], modules.localRuntime),
    renderNamedImport(
      ["OpenAiCompatibleLlmTransportLive", "preflightOpenAiCompatibleProviderMaterial"],
      modules.openAiCompatibleTransport,
    ),
    renderNamedImport(
      ["projectAgentSession", "projectAgentSessions", "projectWorkflowRun", "projectWorkflowRuns"],
      modules.runtimeRunProjector,
    ),
    renderTypeImport(["AgentManifest", "SubmitResult", "SubmitRunInput"], modules.runtimeProtocol),
    renderTypeImport(
      [
        "AgentSessionListProjection",
        "AgentSessionProjection",
        "WorkflowRunListProjection",
        "WorkflowRunProjection",
      ],
      modules.runtimeRunProjector,
    ),
    renderTypeImport(["CreateLocalAgentRuntimeOptions", "LocalAgentRuntime"], modules.localRuntime),
  ].join("\n");
  return `${imports}

const semanticManifest = semanticDeclarations as AgentManifest;

type AgentOSTargetEnv = Readonly<Record<string, string | undefined>>;

${renderGeneratedWorkspaceOperations(workspaceToolArray, usesMutationTools, usesShellTools)}

const cleanEnv = (source: AgentOSTargetEnv): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
};

const generatedTargetEnvFor = (
  options: Pick<CreateLocalAgentAppOptions, "env" | "inheritEnv">,
): AgentOSTargetEnv => ({
  ...(options.inheritEnv === true ? cleanEnv(process.env) : {}),
  ...(options.env === undefined ? {} : cleanEnv(options.env)),
});

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

const generatedLocalLlmFor = (
  env: AgentOSTargetEnv,
): NonNullable<CreateLocalAgentRuntimeOptions["llm"]> => {
  const modelValue = materialValue(env, { kind: "model", ref: ${jsString(normalized.llm.modelRef)} });
  return {
    kind: "transport",
    transport: OpenAiCompatibleLlmTransportLive,
    route: {
      kind: "openai-chat-compatible",
      endpointRef: ${jsString(normalized.llm.endpointRef)},
      credentialRef: ${jsString(normalized.llm.credentialRef)},
      modelId: typeof modelValue === "string" ? modelValue : "",
    },
    refResolver: {
      material: (ref) => materialValue(env, ref),
    },
    preflight: preflightOpenAiCompatibleProviderMaterial,
  };
};

${renderProductApiHelpers()}

export interface LocalAgentApp {
  readonly runtime: LocalAgentRuntime;
  readonly sessions: {
    readonly submitTurn: (input: AgentSessionSubmitTurnInput) => Promise<SubmitResult>;
    readonly inspect: (sessionRef: string) => AgentSessionProjection;
    readonly list: () => AgentSessionListProjection;
  };
  readonly workflows: {
    readonly run: (input: AgentWorkflowRunInput) => Promise<SubmitResult>;
    readonly inspectRun: (
      workflowId: string,
      workflowRunId: string,
    ) => WorkflowRunProjection | null;
    readonly listRuns: (workflowId: string) => WorkflowRunListProjection;
  };
  ${
    hasSchedules
      ? `readonly schedules: {
    readonly ids: ReadonlyArray<string>;
    readonly dispatch: (input: GeneratedScheduleTriggerInput) => Promise<unknown>;
  };`
      : ""
  }
}

${
  hasChannels
    ? `export const handleLocalAgentChannelRequest = (
  request: Request,
  runtime: ChannelRuntime,
): Promise<Response | null> => dispatchGeneratedChannelRequest(request, runtime);`
    : ""
}

export interface CreateLocalAgentAppOptions {
  readonly cwd?: string;
  readonly env?: CreateLocalAgentRuntimeOptions["env"];
  readonly inheritEnv?: CreateLocalAgentRuntimeOptions["inheritEnv"];
  readonly llm?: CreateLocalAgentRuntimeOptions["llm"];
}

export const createLocalAgentApp = async (
  options: CreateLocalAgentAppOptions = {},
): Promise<LocalAgentApp> => {
  const targetEnv = generatedTargetEnvFor(options);
  const lowered = await lowerLocalAgentRuntime({
    target: "node@1",
    identity: semanticManifest.agentId,
    cwd: options.cwd ?? process.cwd(),
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.inheritEnv === undefined ? {} : { inheritEnv: options.inheritEnv }),
    llm: options.llm ?? generatedLocalLlmFor(targetEnv),
    workspaceOperations: generatedWorkspaceOperations,
  });
  const sessions = {
    submitTurn: (input: AgentSessionSubmitTurnInput) =>
      lowered.submitWithProductLink(submitRunInputFromSessionTurn(input), {
        kind: "session_turn",
        sessionRef: input.sessionRef,
        turnRef: input.turnRef,
        ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
      }),
    inspect: (sessionRef: string) => projectAgentSession(lowered.runtime.events(), sessionRef),
    list: () => projectAgentSessions(lowered.runtime.events()),
  };
  const workflows = {
    run: (input: AgentWorkflowRunInput) =>
      lowered.submitWithProductLink(submitRunInputFromWorkflowRun(input), {
        kind: "workflow_run",
        workflowId: input.workflowId,
        workflowRunId: input.workflowRunId,
        ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
        ...(input.inputDigest === undefined ? {} : { inputDigest: input.inputDigest }),
      }),
    inspectRun: (workflowId: string, workflowRunId: string) =>
      projectWorkflowRun(lowered.runtime.events(), workflowId, workflowRunId),
    listRuns: (workflowId: string) => projectWorkflowRuns(lowered.runtime.events(), workflowId),
  };
  return {
    runtime: lowered.runtime,
    sessions,
    workflows,
    ${
      hasSchedules
        ? `schedules: {
      ids: generatedScheduleIds,
      dispatch: (input: GeneratedScheduleTriggerInput) =>
        dispatchGeneratedSchedule({
          ...input,
          runtime: { sessions, workflows },
        }),
    },`
        : ""
    }
  };
};
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
): string => {
  const target = cloudflareTargetFor(normalized.target);
  return `${renderNamedImport(["durableObjectRpcClient"], `${modules.cloudflareDoRuntime}/do-rpc`)}
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
export const agentOSDurableObjectBinding = ${jsString(target.durableObject.binding)};

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
};

const renderCloudflareWorkerEntry = (
  normalized: NormalizedAgentOsConfig<AuthoredAgentManifest>,
  modules: ReturnType<typeof staticTargetModules>,
): string => {
  const target = cloudflareTargetFor(normalized.target);
  const hasChannels = normalized.channels.length > 0;
  return `${normalized.profile === AGENTOS_CONFIG_PROFILE.WORKSPACE_V1 ? `${renderNamedImport(["Sandbox"], modules.cloudflareSandbox)}\n` : ""}${renderNamedImport([target.durableObject.className], "./target")}
${hasChannels ? `${renderNamedImport(["dispatchGeneratedChannelRequest"], "./channels")}\n${renderNamedImport(["agentOSRpcClient"], "./cloudflare-scope")}\n${renderTypeImport(["AgentRuntimeClient"], modules.cloudflareDoRuntime)}\n${renderTypeImport(["ChannelRuntime"], modules.runtimeChannel)}\n` : ""}${renderTypeImport(["AgentOSTargetEnv"], "./cloudflare-scope")}

export { ${target.durableObject.className}${normalized.profile === AGENTOS_CONFIG_PROFILE.WORKSPACE_V1 ? ", Sandbox" : ""} };

${
  hasChannels
    ? `type AgentOSChannelRpc = Pick<AgentRuntimeClient, "events" | "streamEvents"> & {
  readonly submitRunInput: ChannelRuntime["submit"];
  readonly dispatchToScope: ChannelRuntime["dispatch"];
};

const generatedChannelRuntimeFor = (env: AgentOSTargetEnv): ChannelRuntime => {
  const runtime = agentOSRpcClient<AgentOSChannelRpc>(env);
  return Object.freeze({
    submit: (input) => runtime.submitRunInput(input),
    dispatch: (spec) => runtime.dispatchToScope(spec),
  });
};
`
    : ""
}

export default {
  async fetch(request: Request, env: AgentOSTargetEnv): Promise<Response> {
    ${
      hasChannels
        ? `const channelResponse = await dispatchGeneratedChannelRequest(request, generatedChannelRuntimeFor(env));
    if (channelResponse !== null) return channelResponse;`
        : ""
    }
    return new Response("agentOS Cloudflare target", { status: 404 });
  },
} satisfies ExportedHandler<AgentOSTargetEnv>;
`;
};

const renderCloudflareWranglerConfig = (
  normalized: NormalizedAgentOsConfig<AuthoredAgentManifest>,
): string => {
  const target = cloudflareTargetFor(normalized.target);
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
        }
      : {
          durable_objects: {
            bindings: [
              {
                class_name: target.durableObject.className,
                name: target.durableObject.binding,
              },
            ],
          },
          migrations: [
            {
              tag: "v1",
              new_sqlite_classes: [target.durableObject.className],
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
            "WorkspaceAgentProductClient",
            "WorkspaceAgentProductCommandMap",
            "WorkspaceAgentProductProjectionTypes",
            "WorkspaceAgentProductCommandOutputByName",
            "WORKSPACE_AGENT_PRODUCT_COMMAND",
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
${renderNamedImport(["WORKSPACE_AGENT_PRODUCT_COMMAND"], modules.workspaceAgentClient)}
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
    "AgentSessionListProjection",
    "AgentSessionProjection",
    "WorkflowRunListProjection",
    "WorkflowRunProjection",
  ],
  modules.runtimeRunProjector,
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
${renderTypeImport(
  [
    "WorkspaceAgentSessionSubmitTurnInput",
    "WorkspaceAgentWorkflowRunInput",
    "WorkspaceAgentWorkflowRunRef",
    "WorkspaceAgentWorkflowRunsInput",
  ],
  modules.workspaceAgentClient,
)}
${renderTypeImport(["AgentOSTargetEnv"], "./cloudflare-scope")}

type AgentOSRpc = Pick<AgentRuntimeClient, "events" | "streamEvents"> & {
  readonly submitRunInput: (input: SubmitRunInput) => Promise<SubmitResult>;
  readonly submitSessionTurn: (input: WorkspaceAgentSessionSubmitTurnInput) => Promise<SubmitResult>;
  readonly inspectSession: (
    input: { readonly sessionRef: string },
  ) => Promise<AgentSessionProjection>;
  readonly listSessions: () => Promise<AgentSessionListProjection>;
  readonly runWorkflow: (input: WorkspaceAgentWorkflowRunInput) => Promise<SubmitResult>;
  readonly inspectWorkflowRun: (
    input: WorkspaceAgentWorkflowRunRef,
  ) => Promise<WorkflowRunProjection | null>;
  readonly listWorkflowRuns: (
    input: WorkspaceAgentWorkflowRunsInput,
  ) => Promise<WorkflowRunListProjection>;
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

const productSubmitInputFromUnknown = (
  value: unknown,
  label: string,
): GeneratedResult<AgentOSSubmitRunInput> => {
  if (!isRecord(value)) return fail(400, \`invalid \${label} command input\`);
  if (typeof value.intent !== "string" || !isRecord(value.context)) {
    return fail(400, \`invalid \${label} submit run input\`);
  }
  return { ok: true, value: value as unknown as AgentOSSubmitRunInput };
};

const sessionTurnInputFromUnknown = (
  value: unknown,
): GeneratedResult<WorkspaceAgentSessionSubmitTurnInput> => {
  const submitInput = productSubmitInputFromUnknown(value, "submitSessionTurn");
  if (!submitInput.ok) return submitInput;
  if (!isRecord(value)) return fail(400, "invalid submitSessionTurn command input");
  if (typeof value.sessionRef !== "string" || typeof value.turnRef !== "string") {
    return fail(400, "invalid session turn identity");
  }
  return { ok: true, value: value as unknown as WorkspaceAgentSessionSubmitTurnInput };
};

const sessionInspectInputFromUnknown = (
  value: unknown,
): GeneratedResult<{ readonly sessionRef: string }> => {
  if (!isRecord(value) || typeof value.sessionRef !== "string") {
    return fail(400, "invalid inspectSession command input");
  }
  return { ok: true, value: { sessionRef: value.sessionRef } };
};

const workflowRunInputFromUnknown = (
  value: unknown,
): GeneratedResult<WorkspaceAgentWorkflowRunInput> => {
  const submitInput = productSubmitInputFromUnknown(value, "runWorkflow");
  if (!submitInput.ok) return submitInput;
  if (!isRecord(value)) return fail(400, "invalid runWorkflow command input");
  if (typeof value.workflowId !== "string" || typeof value.workflowRunId !== "string") {
    return fail(400, "invalid workflow run identity");
  }
  if (value.idempotencyKey !== undefined && typeof value.idempotencyKey !== "string") {
    return fail(400, "invalid workflow run idempotencyKey");
  }
  if (value.inputDigest !== undefined && typeof value.inputDigest !== "string") {
    return fail(400, "invalid workflow run inputDigest");
  }
  return { ok: true, value: value as unknown as WorkspaceAgentWorkflowRunInput };
};

const workflowRunRefFromUnknown = (
  value: unknown,
): GeneratedResult<WorkspaceAgentWorkflowRunRef> => {
  if (!isRecord(value)) return fail(400, "invalid inspectWorkflowRun command input");
  if (typeof value.workflowId !== "string" || typeof value.workflowRunId !== "string") {
    return fail(400, "invalid workflow run identity");
  }
  return {
    ok: true,
    value: { workflowId: value.workflowId, workflowRunId: value.workflowRunId },
  };
};

const workflowRunsInputFromUnknown = (
  value: unknown,
): GeneratedResult<WorkspaceAgentWorkflowRunsInput> => {
  if (!isRecord(value) || typeof value.workflowId !== "string") {
    return fail(400, "invalid listWorkflowRuns command input");
  }
  return { ok: true, value: { workflowId: value.workflowId } };
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
  if (name === WORKSPACE_AGENT_PRODUCT_COMMAND.SUBMIT_SESSION_TURN) {
    const sessionInput = sessionTurnInputFromUnknown(input);
    return sessionInput.ok ? runtime.submitSessionTurn(sessionInput.value) : rejectFailure(sessionInput);
  }
  if (name === WORKSPACE_AGENT_PRODUCT_COMMAND.INSPECT_SESSION) {
    const sessionInput = sessionInspectInputFromUnknown(input);
    return sessionInput.ok ? runtime.inspectSession(sessionInput.value) : rejectFailure(sessionInput);
  }
  if (name === WORKSPACE_AGENT_PRODUCT_COMMAND.LIST_SESSIONS) {
    return runtime.listSessions();
  }
  if (name === WORKSPACE_AGENT_PRODUCT_COMMAND.RUN_WORKFLOW) {
    const workflowInput = workflowRunInputFromUnknown(input);
    return workflowInput.ok ? runtime.runWorkflow(workflowInput.value) : rejectFailure(workflowInput);
  }
  if (name === WORKSPACE_AGENT_PRODUCT_COMMAND.INSPECT_WORKFLOW_RUN) {
    const workflowInput = workflowRunRefFromUnknown(input);
    return workflowInput.ok
      ? runtime.inspectWorkflowRun(workflowInput.value)
      : rejectFailure(workflowInput);
  }
  if (name === WORKSPACE_AGENT_PRODUCT_COMMAND.LIST_WORKFLOW_RUNS) {
    const workflowInput = workflowRunsInputFromUnknown(input);
    return workflowInput.ok
      ? runtime.listWorkflowRuns(workflowInput.value)
      : rejectFailure(workflowInput);
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
  [
    "AgentSessionListProjection",
    "AgentSessionProjection",
    "WorkflowRunListProjection",
    "WorkflowRunProjection",
  ],
  modules.runtimeRunProjector,
)}
${renderTypeImport(
  [
    "CreateWorkspaceAgentClientOptions",
    "WorkspaceAgentClientBridge",
    "WorkspaceAgentProductCommandMap",
    "WorkspaceAgentProductProjectionTypes",
  ],
  modules.workspaceAgentClient,
)}

export interface GeneratedAgentClientProductProjections extends WorkspaceAgentProductProjectionTypes {
  readonly session: AgentSessionProjection;
  readonly sessionList: AgentSessionListProjection;
  readonly workflowRun: WorkflowRunProjection;
  readonly workflowRunList: WorkflowRunListProjection;
}

export type GeneratedAgentClientOptions =
  CreateWorkspaceAgentClientOptions<WorkspaceAgentProductCommandMap<GeneratedAgentClientProductProjections>>;
export type GeneratedAgentClient = WorkspaceAgentClientBridge<GeneratedAgentClientProductProjections>;

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
    "AgentSessionListProjection",
    "AgentSessionProjection",
    "WorkflowRunListProjection",
    "WorkflowRunProjection",
  ],
  modules.runtimeRunProjector,
)}
${renderTypeImport(
  [
    "CreateWorkspaceAgentClientOptions",
    "WorkspaceAgentClientBridge",
    "WorkspaceAgentProductClient",
    "WorkspaceAgentProductCommandMap",
    "WorkspaceAgentProductProjectionTypes",
  ],
  modules.workspaceAgentClient,
)}
${renderTypeImport(["Readable"], modules.svelteStore)}

export interface GeneratedAgentClientProductProjections extends WorkspaceAgentProductProjectionTypes {
  readonly session: AgentSessionProjection;
  readonly sessionList: AgentSessionListProjection;
  readonly workflowRun: WorkflowRunProjection;
  readonly workflowRunList: WorkflowRunListProjection;
}

export type GeneratedAgentClientOptions =
  CreateWorkspaceAgentClientOptions<WorkspaceAgentProductCommandMap<GeneratedAgentClientProductProjections>>;

export interface GeneratedAgentClient
  extends WorkspaceAgentClientBridge<GeneratedAgentClientProductProjections> {
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

const generatedRpcInvoker = ((name, input) =>
  invokeAgentCommand({ name, input })) as WorkspaceAgentProductClient<
  GeneratedAgentClientProductProjections
>["invoke"];

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
  if (normalized.llm.route !== AGENTOS_CONFIG_LLM_ROUTE.OPENAI_CHAT_COMPATIBLE) {
    return {
      ok: false,
      issues: [{ kind: "unsupported_static_llm_route", route: normalized.llm.route }],
    };
  }
  const toolNames = Object.keys(normalized.deployment.manifest.tools ?? {}).sort();
  const hasChannels = normalized.channels.length > 0;
  const hasSchedules = normalized.schedules.length > 0;
  if (normalized.target.kind === AGENTOS_CONFIG_TARGET.NODE_V1) {
    if (normalized.profile !== AGENTOS_CONFIG_PROFILE.WORKSPACE_V1) {
      return {
        ok: false,
        issues: [{ kind: "unsupported_static_target", target: normalized.target.kind }],
      };
    }
    const deploymentJson = {
      deploymentId: normalized.deployment.deploymentId,
      backend: normalized.deployment.backend,
      adapter: normalized.deployment.adapter,
      codec: normalized.deployment.codec,
      ...(normalized.deployment.providerStrategy === undefined
        ? {}
        : { providerStrategy: normalized.deployment.providerStrategy }),
      workspace: {
        binding: normalized.workspace.binding,
        bindingRef: normalized.workspace.bindingRef,
        root: normalized.workspace.root,
        topology: normalized.workspace.topology,
        providerResourceId: normalized.workspace.providerResourceId,
      },
    };
    const moduleGraph: ReadonlyArray<StaticTargetModuleImport> = [
      { kind: "semantic-json", source: "./manifest.json", imports: ["default as declarations"] },
      { kind: "semantic-json", source: "./deployment.json", imports: ["default as deployment"] },
      {
        kind: "local-runtime",
        source: modules.localRuntime,
        imports: ["lowerLocalAgentRuntime"],
      },
      ...(hasChannels
        ? [
            {
              kind: "channel-runtime" as const,
              source: modules.runtimeChannel,
              imports: ["DefinedChannel"],
            },
            ...generatedChannelImports(normalized.channels),
            {
              kind: "channel-registry" as const,
              source: "./channels",
              imports: ["dispatchGeneratedChannelRequest", "generatedChannels"],
            },
          ]
        : []),
      ...(hasSchedules
        ? [
            {
              kind: "schedule-runtime" as const,
              source: modules.runtimeSchedule,
              imports: ["DefinedSchedule"],
            },
            ...generatedScheduleImports(normalized.schedules),
            {
              kind: "schedule-registry" as const,
              source: "./schedules",
              imports: ["dispatchGeneratedSchedule", "generatedSchedules"],
            },
          ]
        : []),
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
          ...(hasChannels
            ? [
                generatedPath(
                  ".agentos/generated/channels.ts",
                  renderChannelRegistry(normalized.channels, modules),
                ),
              ]
            : []),
          ...(hasSchedules
            ? [
                generatedPath(
                  ".agentos/generated/schedules.ts",
                  renderScheduleRegistry(normalized.schedules, modules),
                ),
              ]
            : []),
          generatedPath(
            ".agentos/generated/local.ts",
            renderLocalAgentApp(
              normalized as NormalizedWorkspaceAgentOsConfig<AuthoredAgentManifest>,
              toolNames,
              modules,
            ),
          ),
        ],
        moduleGraph,
        canonicalDeployment: {
          profile: normalized.profile,
          target: normalized.target.kind,
          llmRoute: normalized.llm.route,
          client: normalized.client.kind,
          workspaceTopology: normalized.workspace.topology,
          toolNames,
        },
        mount: {
          driver: {
            kind: "local-node",
            target: AGENTOS_CONFIG_TARGET.NODE_V1,
          },
          projectionSinks: [
            "agent.info",
            "workspace.state",
            "workspace.files",
            "runtime.events",
            "runtime.input_requests",
          ],
          providerResourceId: normalized.workspace.providerResourceId,
        },
      },
    };
  }
  const target = cloudflareTargetFor(normalized.target);
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
    ...(hasChannels
      ? [
          {
            kind: "channel-runtime" as const,
            source: modules.runtimeChannel,
            imports: ["DefinedChannel"],
          },
          ...generatedChannelImports(normalized.channels),
          {
            kind: "channel-registry" as const,
            source: "./channels",
            imports: ["dispatchGeneratedChannelRequest", "generatedChannels"],
          },
        ]
      : []),
    ...(hasSchedules
      ? [
          {
            kind: "schedule-runtime" as const,
            source: modules.runtimeSchedule,
            imports: ["DefinedSchedule"],
          },
          ...generatedScheduleImports(normalized.schedules),
          {
            kind: "schedule-registry" as const,
            source: "./schedules",
            imports: ["dispatchGeneratedSchedule", "generatedSchedules"],
          },
        ]
      : []),
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
          ? [target.durableObject.className, "Sandbox"]
          : [target.durableObject.className],
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
        ...(hasChannels
          ? [
              generatedPath(
                ".agentos/generated/channels.ts",
                renderChannelRegistry(normalized.channels, modules),
              ),
            ]
          : []),
        ...(hasSchedules
          ? [
              generatedPath(
                ".agentos/generated/schedules.ts",
                renderScheduleRegistry(normalized.schedules, modules),
              ),
            ]
          : []),
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
          className: target.durableObject.className,
          binding: target.durableObject.binding,
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
