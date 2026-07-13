import { GENERATED_LOAD_SKILL_TOOL_NAME, GENERATED_READ_SKILL_FILE_TOOL_NAME } from "../shared";
import type {
  StaticRuntimeBootstrapModel,
  StaticTargetDynamicResolver,
  StaticTargetScopePolicy,
  StaticTargetSkill,
} from "./model";
import {
  importDynamicResolverPath,
  importToolPath,
  jsString,
  renderGeneratedLlmRoutesFor,
  renderGeneratedProviderPreflight,
  renderMaterialValueFunction,
  renderNamedImport,
  renderTypeImport,
  stableJsonValue,
  staticTargetModules,
} from "./encoding";
import { renderInstructionFragments, renderSkillCatalog } from "./registries";

export const renderCustomToolImports = (model: StaticRuntimeBootstrapModel): string =>
  model.customToolNames
    .map((toolName, index) => `import tool_${index} from ${jsString(importToolPath(toolName))};`)
    .join("\n");

export const renderCustomToolRecord = (model: StaticRuntimeBootstrapModel): string =>
  model.customToolNames.length === 0
    ? "{}"
    : `{\n${model.customToolNames
        .map((toolName, index) => `  ${jsString(toolName)}: tool_${index},`)
        .join("\n")}\n}`;

export const renderDynamicCapabilityCatalog = (model: StaticRuntimeBootstrapModel): string => {
  const manifestTools = model.manifestTools ?? {};
  const dynamicToolNames = [
    ...model.toolNames,
    ...(model.skills.length > 0
      ? [GENERATED_LOAD_SKILL_TOOL_NAME, GENERATED_READ_SKILL_FILE_TOOL_NAME]
      : []),
  ];
  return JSON.stringify(
    stableJsonValue({
      instructions: model.instructionFragments.map((fragment) => ({
        digest: fragment.digest,
        id: fragment.fragmentId,
      })),
      skills: model.skills.map((skill) => ({
        digest: skill.digest,
        id: skill.name,
      })),
      tools: [...new Set(dynamicToolNames)].sort().map((toolName) => ({
        id: toolName,
        ...(manifestTools[toolName]?.bindingRef === undefined
          ? {}
          : { bindingRef: manifestTools[toolName]?.bindingRef }),
      })),
    }),
    null,
    2,
  );
};

export const renderDynamicResolverImportStatements = (
  resolvers: ReadonlyArray<StaticTargetDynamicResolver>,
): string =>
  resolvers
    .map(
      (resolver, index) =>
        `import dynamicResolver_${index} from ${jsString(importDynamicResolverPath(resolver.path))};`,
    )
    .join("\n");

export const renderDynamicCapabilitySupport = (model: StaticRuntimeBootstrapModel): string => {
  const resolvers = model.dynamicResolvers;
  const resolverEntries =
    resolvers.length === 0
      ? "[]"
      : `[\n${resolvers
          .map(
            (resolver, index) => `  {
    resolverId: ${jsString(resolver.resolverId)},
    slot: ${jsString(resolver.slot)},
    resolve: dynamicResolver_${index},
  },`,
          )
          .join("\n")}\n]`;
  return `${renderDynamicResolverImportStatements(resolvers)}

const generatedDynamicCapabilityCatalog = ${renderDynamicCapabilityCatalog(model)} satisfies DynamicCapabilityCompiledCatalog;

const generatedInstructionFragments = ${renderInstructionFragments(
    model.instructionFragments,
  )} satisfies ReadonlyArray<SubmitInstructionFragment>;

const generatedDynamicCapabilityResolvers = ${resolverEntries} satisfies ReadonlyArray<DynamicCapabilityResolverDefinition>;

const generatedDynamicCapabilityTurnEvent = (
  refs: { readonly sessionRef?: string; readonly turnRef?: string } = {},
): DynamicCapabilityEventRef => ({
  name: DYNAMIC_CAPABILITY_EVENT.TURN_STARTED,
  ...(refs.sessionRef === undefined ? {} : { sessionRef: refs.sessionRef }),
  ...(refs.turnRef === undefined ? {} : { turnRef: refs.turnRef }),
});

const generatedDynamicSubmitBindingsFor = async (
  event: DynamicCapabilityEventRef,
  input: DynamicCapabilityRunInput | undefined = undefined,
): Promise<GeneratedTargetResult<Pick<AgentSubmitBindings, "dynamicCapabilityProjection" | "instructionFragments">>> => {
  const projection = await runDynamicCapabilityResolvers({
    event,
    catalog: generatedDynamicCapabilityCatalog,
    resolvers: generatedDynamicCapabilityResolvers,
    ...(input === undefined ? {} : { input }),
    materials: semanticManifest.materials ?? {},
  });
  if (!projection.ok) {
    return targetFailure(\`dynamic capability resolver failed: \${JSON.stringify(projection.issues)}\`);
  }
  return {
    ok: true,
    value: {
      dynamicCapabilityProjection: projection.projection,
      instructionFragments: generatedInstructionFragments,
    },
  };
};`;
};

export const renderSkillSupport = (skills: ReadonlyArray<StaticTargetSkill>): string => {
  if (skills.length === 0) return "";
  return `
import generatedSkillResourcePayloads from "./skill-resources.json";

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
    readonly resourceRef: string;
  }>;
};

type GeneratedSkillFile = GeneratedSkill["files"][number];

type LoadedGeneratedSkill = Omit<GeneratedSkill, "files"> & {
  readonly files: ReadonlyArray<Omit<GeneratedSkillFile, "text">>;
};

const generatedSkillCatalog = ${renderSkillCatalog(skills)} satisfies ReadonlyArray<GeneratedSkill>;
const generatedSkillResources = generatedSkillResourcePayloads as Readonly<Record<string, string>>;
const generatedSkillNames = generatedSkillCatalog.map((skill) => skill.name);
const generatedSkillByName = Object.fromEntries(
  generatedSkillCatalog.map((skill) => [skill.name, skill]),
) as Readonly<Record<string, GeneratedSkill>>;
const generatedSkillFilePathCatalog = generatedSkillCatalog.flatMap((skill) =>
  skill.files.map((file) => ({ name: skill.name, path: file.path })),
);
const generatedVisibleSkillCatalogFor = (
  projection: DynamicCapabilityProjection | undefined,
): ReadonlyArray<GeneratedSkill> => {
  if (projection === undefined) return generatedSkillCatalog;
  const visible = new Set(
    projection.skills.filter((skill) => skill.visible).map((skill) => skill.id),
  );
  return generatedSkillCatalog.filter((skill) => visible.has(skill.name));
};

const generatedSkillsSystemAdvert = (
  projection: DynamicCapabilityProjection | undefined,
): string => [
  "Available agent skills are not loaded by default.",
  ...generatedVisibleSkillCatalogFor(projection).map((skill) => \`- \${skill.name}: \${skill.description}\`),
  "Do not assume a skill's full instructions until ${GENERATED_LOAD_SKILL_TOOL_NAME} returns it.",
].join("\\n");

const generatedSystemPrompt = (
  system: string | undefined,
  projection: DynamicCapabilityProjection | undefined,
): string =>
  system === undefined || system.length === 0
    ? generatedSkillsSystemAdvert(projection)
    : \`\${system}\\n\\n\${generatedSkillsSystemAdvert(projection)}\`;

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

const generatedFrameworkToolsFor = (
  projection: DynamicCapabilityProjection | undefined,
): Readonly<Record<string, Tool>> => {
  const visibleSkillNames = new Set(
    generatedVisibleSkillCatalogFor(projection).map((skill) => skill.name),
  );
  if (visibleSkillNames.size === 0) return {};
  const visibleSkill = (name: string): GeneratedSkill | null => {
    if (!visibleSkillNames.has(name)) return null;
    return generatedSkillByName[name] ?? null;
  };
  const generatedLoadSkillTool = defineProductTool({
  name: ${jsString(GENERATED_LOAD_SKILL_TOOL_NAME)},
  description: "Load the full text of a CLI-authored agent skill by name.",
  args: Schema.Struct({ name: Schema.String }),
  authority: "agentos.generated.skills",
  authorityId: "agentos.generated.skills.load_skill",
  admit: ({ name }) => Effect.succeed({ ok: visibleSkillNames.has(name) } as const),
  execute: ({ name }) => {
    const skill = visibleSkill(name);
    if (skill === null) return Effect.fail(Error(\`unknown skill \${name}\`));
    return Effect.succeed(generatedLoadedSkill(skill));
  },
  });

  const generatedReadSkillFileTool = defineProductTool({
  name: ${jsString(GENERATED_READ_SKILL_FILE_TOOL_NAME)},
  description: "Read one declared supporting file from a CLI-authored agent skill package.",
  args: Schema.Struct({
    name: Schema.String,
    path: Schema.String,
    encoding: Schema.optional(Schema.Literals(["utf-8", "base64"])),
  }),
  authority: "agentos.generated.skills",
  authorityId: "agentos.generated.skills.read_skill_file",
  admit: ({ name, path }) =>
    Effect.succeed({
      ok:
        visibleSkillNames.has(name) &&
        generatedSkillFilePathCatalog.some((file) => file.name === name && file.path === path),
    } as const),
  execute: ({ name, path, encoding = "utf-8" }) => {
    const skill = visibleSkill(name);
    const file = skill?.files.find((candidate) => candidate.path === path);
    if (skill === null || file === undefined) {
      return Effect.fail(Error(\`unknown skill file \${name}/\${path}\`));
    }
    const contentBase64 = generatedSkillResources[file.resourceRef];
    if (contentBase64 === undefined) {
      return Effect.fail(Error(\`missing skill resource \${file.resourceRef}\`));
    }
    if (encoding === "base64") {
      return Effect.succeed({
        name,
        path: file.path,
        digest: file.digest,
        bytes: file.bytes,
        encoding,
        content: contentBase64,
      });
    }
    return Effect.try({
      try: () =>
        new TextDecoder("utf-8", { fatal: true }).decode(
          Uint8Array.from(atob(contentBase64), (character) => character.charCodeAt(0)),
        ),
      catch: () => Error(\`skill resource is not valid utf-8: \${name}/\${path}\`),
    }).pipe(
      Effect.map((content) => ({
        name,
        path: file.path,
        digest: file.digest,
        bytes: file.bytes,
        encoding,
        content,
      })),
    );
  },
  });

  return {
    ${jsString(GENERATED_LOAD_SKILL_TOOL_NAME)}: generatedLoadSkillTool,
    ${jsString(GENERATED_READ_SKILL_FILE_TOOL_NAME)}: generatedReadSkillFileTool,
  } satisfies Readonly<Record<string, Tool>>;
};
`;
};

export const renderStaticRuntimeBootstrapImports = (
  model: StaticRuntimeBootstrapModel,
  scope: StaticTargetScopePolicy,
  modules: ReturnType<typeof staticTargetModules>,
): string =>
  [
    `import semanticDeclarations from "./manifest.json";`,
    renderNamedImport(["runDynamicCapabilityResolvers"], modules.runtimeCapability),
    renderNamedImport(
      ["OpenAiCompatibleLlmTransportLive", "preflightOpenAiCompatibleProviderMaterial"],
      modules.openAiCompatibleTransport,
    ),
    renderNamedImport(
      ["DYNAMIC_CAPABILITY_EVENT", "manifestTruthIdentity"],
      modules.runtimeProtocol,
    ),
    renderNamedImport(
      [
        "deterministicToolInvocation",
        ...(model.skills.length > 0 ? ["defineProductTool"] : []),
        "unsafeRunToolByName",
      ],
      modules.coreTools,
    ),
    renderNamedImport(model.skills.length > 0 ? ["Effect", "Schema"] : ["Effect"], modules.effect),
    renderTypeImport(
      [
        "AgentManifest",
        "AgentSubmitBindings",
        "DynamicCapabilityCompiledCatalog",
        "DynamicCapabilityEventRef",
        "DynamicCapabilityProjection",
        "DynamicCapabilityRunInput",
        "LedgerTruthIdentity",
        "SubmitInstructionFragment",
      ],
      modules.runtimeProtocol,
    ),
    renderTypeImport(["DynamicCapabilityResolverDefinition"], modules.runtimeCapability),
    renderTypeImport(["Tool"], modules.coreTools),
    renderTypeImport(["RefResolver"], modules.coreRefResolver),
    ...(scope.idSource === "submit_scope"
      ? [
          renderNamedImport(
            ["cloudflareDefaultTruthIdentityFromRoutingScope"],
            modules.cloudflareDoRuntime,
          ),
        ]
      : []),
    renderCustomToolImports(model),
  ]
    .filter((statement) => statement.length > 0)
    .join("\n");

export const renderSemanticTruthIdentity = (scope: StaticTargetScopePolicy): string =>
  scope.idSource === "submit_scope"
    ? `const semanticTruthIdentityFor = (scopeId: string): LedgerTruthIdentity => {
  if (scopeId.length === 0) throw Error("authenticated routing scope is missing");
  return cloudflareDefaultTruthIdentityFromRoutingScope(scopeId, ${jsString(scope.kind)});
};`
    : `const semanticTruthIdentity = manifestTruthIdentity(semanticManifest);
const semanticTruthIdentityFor = (scopeId: string): LedgerTruthIdentity => {
  if (scopeId !== semanticTruthIdentity.scopeRef.scopeId) {
    throw Error("authenticated routing scope does not match manifest scope");
  }
  return semanticTruthIdentity;
};`;

export const renderStaticRuntimeBootstrap = (
  model: StaticRuntimeBootstrapModel,
  scope: StaticTargetScopePolicy,
): string => `
const semanticManifest = semanticDeclarations as AgentManifest;
${renderSemanticTruthIdentity(scope)}

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

const generatedCustomTools = ${renderCustomToolRecord(model)} satisfies Readonly<Record<string, Tool>>;
${renderDynamicCapabilitySupport(model)}
${renderSkillSupport(model.skills)}

const materialEnvValue = (env: AgentOSTargetEnv, name: string): string | null => {
  const value = env[name];
  return typeof value === "string" && value.length > 0 ? value : null;
};

${renderMaterialValueFunction(model.llmRoutes)}
${renderGeneratedProviderPreflight(model.llmRoutes)}

const requiredStringMaterial = (
  kind: string,
  ref: string,
  value: NonNullable<unknown> | null,
): GeneratedTargetResult<string> => {
  if (typeof value === "string" && value.length > 0) return { ok: true, value };
  return targetFailure(\`missing \${kind} material: \${ref}\`);
};

${renderGeneratedLlmRoutesFor(model.llmRoutes)}
`;

export const renderSubmitSpecFromRunInput = (
  hasSkills: boolean,
): string => `const submitSpecFromRunInput = (
  input: SubmitRunInput,
  dynamicCapabilityProjection: DynamicCapabilityProjection | undefined,
): AgentSubmitSpec => ({
  input,
  intent: input.intent,
  context: input.context,
  ${hasSkills ? "system: generatedSystemPrompt(input.system, dynamicCapabilityProjection)," : "...(input.system === undefined ? {} : { system: input.system }),"}
  ...(input.budget === undefined ? {} : { budget: input.budget }),
  ...(input.outputSchema === undefined ? {} : { outputSchema: input.outputSchema }),
  ...(input.traceContext === undefined ? {} : { traceContext: input.traceContext }),
  ...(input.dynamicCapability === undefined ? {} : { dynamicCapability: input.dynamicCapability }),
  ...(input.materials === undefined ? {} : { materials: input.materials }),
  ...(input.toolContext === undefined ? {} : { toolContext: input.toolContext }),
  ...(input.toolPolicy === undefined ? {} : { toolPolicy: input.toolPolicy }),
  ...(input.decisionInterrupts === undefined ? {} : { decisionInterrupts: input.decisionInterrupts }),
  ...(input.resume === undefined ? {} : { resume: input.resume }),
});`;

export const renderProductApiHelpers =
  (): string => `export interface AgentSessionSubmitTurnInput extends SubmitRunInput {
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
  ...(input.dynamicCapability === undefined ? {} : { dynamicCapability: input.dynamicCapability }),
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

export const renderProductApiDurableObjectMethods = (
  truthIdentity: string,
  bindingsScope?: string,
): string => `
  submitSessionTurn(input: AgentSessionSubmitTurnInput): Promise<SubmitResult> {
    return generatedSubmitBindingsFor(
      this.targetEnv,
      ${bindingsScope === undefined ? "" : `${bindingsScope},`}
      generatedDynamicCapabilityTurnEvent({
        sessionRef: input.sessionRef,
        turnRef: input.turnRef,
      }),
      input.dynamicCapability,
    ).then((bindings) =>
      bindings.ok
        ? this.submitWithBindingsAndProductLink(
            submitSpecFromRunInput(
              submitRunInputFromSessionTurn(input),
              bindings.value.dynamicCapabilityProjection,
            ),
            bindings.value,
            {
              kind: "session_turn",
              sessionRef: input.sessionRef,
              turnRef: input.turnRef,
              ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
            },
          )
        : rejectTargetFailure(bindings),
    );
  }

  inspectSession(input: { readonly sessionRef: string }): Promise<AgentSessionProjection> {
    return this.events(${truthIdentity}).then((events) =>
      projectAgentSession(events, input.sessionRef),
    );
  }

  listSessions(): Promise<AgentSessionListProjection> {
    return this.events(${truthIdentity}).then((events) => projectAgentSessions(events));
  }

  runWorkflow(input: AgentWorkflowRunInput): Promise<SubmitResult> {
    return generatedSubmitBindingsFor(
      this.targetEnv,
      ${bindingsScope === undefined ? "" : `${bindingsScope},`}
      generatedDynamicCapabilityTurnEvent(),
      input.dynamicCapability,
    ).then((bindings) =>
      bindings.ok
        ? this.submitWithBindingsAndProductLink(
            submitSpecFromRunInput(
              submitRunInputFromWorkflowRun(input),
              bindings.value.dynamicCapabilityProjection,
            ),
            bindings.value,
            {
              kind: "workflow_run",
              workflowId: input.workflowId,
              workflowRunId: input.workflowRunId,
              ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
              ...(input.inputDigest === undefined ? {} : { inputDigest: input.inputDigest }),
            },
          )
        : rejectTargetFailure(bindings),
    );
  }

  inspectWorkflowRun(input: AgentWorkflowRunRef): Promise<WorkflowRunProjection | null> {
    return this.events(${truthIdentity}).then((events) =>
      projectWorkflowRun(events, input.workflowId, input.workflowRunId),
    );
  }

  listWorkflowRuns(input: { readonly workflowId: string }): Promise<WorkflowRunListProjection> {
    return this.events(${truthIdentity}).then((events) =>
      projectWorkflowRuns(events, input.workflowId),
    );
  }`;

export const renderScheduleDurableObjectHelpers = (): string => `
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

export const renderScheduleDurableObjectMethod = (truthIdentity: string): string => `
  dispatchSchedule(input: GeneratedScheduleTriggerInput): Promise<unknown> {
    return this.events(${truthIdentity}).then((history) =>
      dispatchGeneratedScheduleDelivery({
        ...input,
        history,
        identity: ${truthIdentity},
        runtime: generatedScheduleRuntimeFor(this),
      }).then((result) => this.commitScheduleFireDispatchFullWithDelivery(result)),
    );
  }
`;

export const renderGeneratedWorkspaceOperations = (
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

export const renderCloudflareMaterialResolverFactory = (): string => `
const generatedMaterialResolverFactoryContract =
  generatedMaterialResolverFactory satisfies CloudflareMaterialResolverFactory;
const generatedMaterialResolverCache = new WeakMap<object, RefResolver>();

const generatedMaterialResolverFor = (env: AgentOSTargetEnv): RefResolver => {
  const existing = generatedMaterialResolverCache.get(env);
  if (existing !== undefined) return existing;
  const created = generatedMaterialResolverFactoryContract.create(env);
  generatedMaterialResolverCache.set(env, created);
  return created;
};`;
