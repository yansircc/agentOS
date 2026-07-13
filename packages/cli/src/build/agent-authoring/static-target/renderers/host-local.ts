import type { StaticTargetRenderInput } from "../model";
import { jsString, renderNamedImport, renderTypeImport, staticTargetModules } from "../encoding";
import {
  renderGeneratedWorkspaceOperations,
  renderProductApiHelpers,
  renderStaticRuntimeBootstrap,
  renderStaticRuntimeBootstrapImports,
} from "../semantic-bootstrap";

export const renderLocalAgentApp = (
  normalized: StaticTargetRenderInput,
  modules: ReturnType<typeof staticTargetModules>,
): string => {
  const bootstrap = normalized.bootstrap;
  const hasChannels = normalized.channels.length > 0;
  const hasSkills = bootstrap.skills.length > 0;
  const hasSchedules = normalized.schedules.length > 0;
  const workspaceToolList = normalized.workspaceOperations.toolNames;
  const workspaceToolArray = `[${workspaceToolList.map(jsString).join(", ")}] as const`;
  const usesMutationTools = normalized.workspaceOperations.usesMutationTools;
  const usesShellTools = normalized.workspaceOperations.usesShellTools;
  const imports = [
    renderStaticRuntimeBootstrapImports(bootstrap, normalized.deployment.manifest.scope, modules),
    ...(hasChannels ? [renderNamedImport(["dispatchGeneratedChannelRequest"], "./channels")] : []),
    ...(hasChannels ? [renderTypeImport(["ChannelRuntime"], modules.runtimeChannel)] : []),
    ...(hasSchedules
      ? [
          renderNamedImport(
            [
              "dispatchGeneratedScheduleDelivery",
              "generatedScheduleDefinitions",
              "generatedScheduleIds",
            ],
            "./schedules",
          ),
        ]
      : []),
    ...(hasSchedules ? [renderTypeImport(["GeneratedScheduleTriggerInput"], "./schedules")] : []),
    renderNamedImport(["lowerLocalAgentRuntime"], modules.localRuntime),
    renderNamedImport(["createAgentSession"], modules.productShellClient),
    renderTypeImport(["AgentSession"], modules.productShellClient),
    renderNamedImport(["projectInputRequestSettlement"], modules.runtimeRunProjector),
    ...(hasSchedules
      ? [renderNamedImport(["projectScheduleFireHistory"], modules.runtimeSchedule)]
      : []),
    renderNamedImport(
      [
        "projectAgentSession",
        "projectAgentSessions",
        "projectRunInspection",
        "projectWorkflowRun",
        "projectWorkflowRuns",
      ],
      modules.runtimeRunProjector,
    ),
    renderTypeImport(
      ["InputRequestSettlement", "SubmitResult", "SubmitRunInput"],
      modules.runtimeProtocol,
    ),
    ...(hasSchedules
      ? [
          renderTypeImport(
            [
              "ScheduleDefinitionProjection",
              "ScheduleFireHistoryProjection",
              "ScheduleFireProjection",
            ],
            modules.runtimeSchedule,
          ),
        ]
      : []),
    renderTypeImport(
      [
        "AgentSessionListProjection",
        "AgentSessionProjection",
        "RunInspection",
        "WorkflowRunListProjection",
        "WorkflowRunProjection",
      ],
      modules.runtimeRunProjector,
    ),
    renderTypeImport(
      ["CreateLocalAgentRuntimeOptions", "LocalAgentRuntime", "LocalAgentSubmitInput"],
      modules.localRuntime,
    ),
    renderTypeImport(
      ["WorkspaceAgentCustomCommandInput", "WorkspaceAgentInspectInputRequestCommandInput"],
      modules.workspaceAgentHost,
    ),
  ].join("\n");
  return `${imports}

type AgentOSTargetEnv = Readonly<Record<string, string | undefined>>;

${renderStaticRuntimeBootstrap(bootstrap, normalized.deployment.manifest.scope)}

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

const generatedLocalLlmFor = (
  env: AgentOSTargetEnv,
  materialResolver: RefResolver | undefined,
): GeneratedTargetResult<NonNullable<CreateLocalAgentRuntimeOptions["llm"]>> => {
  if (materialResolver === undefined) {
    return targetFailure("generated provider runtime requires a host materialResolver");
  }
  const preflightDiagnostics = generatedProviderPreflightDiagnosticsFor(env, materialResolver);
  if (preflightDiagnostics.length > 0) {
    return targetFailure(
      "OpenAI-compatible provider material preflight failed",
      preflightDiagnostics,
    );
  }
  const routes = generatedLlmRoutesFor(env);
  if (!routes.ok) return routes;
  return {
    ok: true,
    value: {
      kind: "transport",
      transport: OpenAiCompatibleLlmTransportLive,
      route: routes.value.default,
      preflight: preflightOpenAiCompatibleProviderMaterial,
    },
  };
};

${renderProductApiHelpers()}

const generatedLocalSubmitInputFromRunInput = async (
  input: SubmitRunInput,
  event: DynamicCapabilityEventRef = generatedDynamicCapabilityTurnEvent(),
): Promise<LocalAgentSubmitInput> => {
  const dynamicBindings = await generatedDynamicSubmitBindingsFor(event, input.dynamicCapability);
  if (!dynamicBindings.ok) return rejectTargetFailure(dynamicBindings);
  const dynamicCapabilityProjection = dynamicBindings.value.dynamicCapabilityProjection;
  return {
    ...input,
    ...(input.context === undefined ? {} : { context: input.context }),
    ...(input.system === undefined && !${hasSkills} ? {} : {
      system: ${hasSkills ? "generatedSystemPrompt(input.system, dynamicCapabilityProjection)" : "input.system"},
    }),
    dynamicCapabilityProjection,
    instructionFragments: dynamicBindings.value.instructionFragments,
    tools: ${
      hasSkills
        ? `{
      ...generatedCustomTools,
      ...generatedFrameworkToolsFor(dynamicCapabilityProjection),
    }`
        : "generatedCustomTools"
    },
  };
};

export interface LocalAgentAppRuntime extends LocalAgentRuntime {
  readonly inspectRun: (runId: number | string) => RunInspection;
  readonly inspectInputRequest: (
    input: WorkspaceAgentInspectInputRequestCommandInput,
  ) => InputRequestSettlement;
}

export interface LocalAgentApp {
  readonly runtime: LocalAgentAppRuntime;
  readonly session: AgentSession;
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
    hasChannels
      ? `readonly channels: {
    readonly handle: (request: Request) => Promise<Response | null>;
  };`
      : ""
  }
  readonly customCommand: (input: WorkspaceAgentCustomCommandInput) => Promise<unknown>;
  ${
    hasSchedules
      ? `readonly schedules: {
    readonly ids: ReadonlyArray<string>;
    readonly list: () => ReadonlyArray<ScheduleDefinitionProjection>;
    readonly trigger: (input: GeneratedScheduleTriggerInput) => Promise<ScheduleFireProjection>;
    readonly history: (input?: { readonly scheduleId?: string }) => ScheduleFireHistoryProjection;
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
  readonly materialResolver?: RefResolver;
}

export const createLocalAgentApp = async (
  options: CreateLocalAgentAppOptions = {},
): Promise<LocalAgentApp> => {
  const targetEnv = generatedTargetEnvFor(options);
  const generatedLlm =
    options.llm === undefined
      ? generatedLocalLlmFor(targetEnv, options.materialResolver)
      : { ok: true as const, value: options.llm };
  if (!generatedLlm.ok) return rejectTargetFailure(generatedLlm);
  const lowered = await lowerLocalAgentRuntime({
    target: "node@1",
    identity: semanticManifest.agentId,
    truthIdentity: semanticTruthIdentity,
    cwd: options.cwd ?? process.cwd(),
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.inheritEnv === undefined ? {} : { inheritEnv: options.inheritEnv }),
    ...(options.materialResolver === undefined
      ? {}
      : { materialResolver: options.materialResolver }),
    llm: generatedLlm.value,
    workspaceOperations: generatedWorkspaceOperations,
  });
  const sessions = {
    submitTurn: (input: AgentSessionSubmitTurnInput) =>
      generatedLocalSubmitInputFromRunInput(
        submitRunInputFromSessionTurn(input),
        generatedDynamicCapabilityTurnEvent({
          sessionRef: input.sessionRef,
          turnRef: input.turnRef,
        }),
      ).then((submitInput) =>
        lowered.submitWithProductLink(submitInput, {
          kind: "session_turn",
          sessionRef: input.sessionRef,
          turnRef: input.turnRef,
          ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
        }),
      ),
    inspect: (sessionRef: string) => projectAgentSession(lowered.runtime.events(), sessionRef),
    list: () => projectAgentSessions(lowered.runtime.events()),
  };
  const session = createAgentSession({ submitTurn: sessions.submitTurn });
  const workflows = {
    run: (input: AgentWorkflowRunInput) =>
      generatedLocalSubmitInputFromRunInput(submitRunInputFromWorkflowRun(input)).then(
        (submitInput) =>
          lowered.submitWithProductLink(submitInput, {
            kind: "workflow_run",
            workflowId: input.workflowId,
            workflowRunId: input.workflowRunId,
            ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
            ...(input.inputDigest === undefined ? {} : { inputDigest: input.inputDigest }),
          }),
      ),
    inspectRun: (workflowId: string, workflowRunId: string) =>
      projectWorkflowRun(lowered.runtime.events(), workflowId, workflowRunId),
    listRuns: (workflowId: string) => projectWorkflowRuns(lowered.runtime.events(), workflowId),
  };
  const runtime: LocalAgentAppRuntime = {
    ...lowered.runtime,
    inspectRun: (runId) =>
      projectRunInspection(lowered.runtime.events(), runId, lowered.runtime.diagnostics()),
    inspectInputRequest: (input) => projectInputRequestSettlement(lowered.runtime.events(), input.ref),
  };
  ${
    hasChannels
      ? `const channelRuntime: ChannelRuntime = {
    submit: (input) => lowered.runtime.submit(input),
    dispatch: async () => {
      throw new Error("local node channel dispatch is unavailable");
    },
  };
  const channels = {
    handle: (request: Request) => handleLocalAgentChannelRequest(request, channelRuntime),
  };`
      : ""
  }
  const customCommand = (input: WorkspaceAgentCustomCommandInput): Promise<unknown> =>
    Effect.runPromise(
      unsafeRunToolByName(
        generatedCustomTools,
        deterministicToolInvocation(input.method, input.input),
      ),
    );
  ${
    hasSchedules
      ? `const scheduleHistory = (
    input: { readonly scheduleId?: string } = {},
  ): ScheduleFireHistoryProjection => projectScheduleFireHistory(lowered.runtime.events(), input);
  const triggerSchedule = async (
    input: GeneratedScheduleTriggerInput,
  ): Promise<ScheduleFireProjection> => {
    const result = await dispatchGeneratedScheduleDelivery({
      ...input,
      history: lowered.runtime.events(),
      identity: semanticTruthIdentity,
      runtime: { sessions, workflows },
    });
    if (result.kind === "attempt") {
      await lowered.commitScheduleFireDispatchWithDelivery(result);
    }
    const projected = scheduleHistory({ scheduleId: input.scheduleId }).fires.find(
      (fire) => fire.fireId === result.fireId,
    );
    if (projected === undefined) {
      throw new Error(\`schedule fire projection missing after commit: \${result.fireId}\`);
    }
    return projected;
  };`
      : ""
  }
  return {
    runtime,
    session,
    sessions,
    workflows,
    ${hasChannels ? "channels,\n    " : ""}customCommand,
    ${
      hasSchedules
        ? `schedules: {
      ids: generatedScheduleIds,
      list: () => generatedScheduleDefinitions,
      trigger: triggerSchedule,
      history: scheduleHistory,
    },`
        : ""
    }
  };
};
`;
};
