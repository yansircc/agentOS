import { STATIC_TARGET_KIND } from "../model";
import type { StaticCloudflareTarget, StaticTargetRenderInput } from "../model";
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
  renderProductApiDurableObjectMethods,
  renderProductApiHelpers,
  renderScheduleDurableObjectHelpers,
  renderScheduleDurableObjectMethod,
  renderStaticRuntimeBootstrap,
  renderStaticRuntimeBootstrapImports,
  renderSubmitSpecFromRunInput,
} from "../semantic-bootstrap";

export const renderChatStaticTarget = (
  normalized: StaticTargetRenderInput,
  target: StaticCloudflareTarget,
  modules: ReturnType<typeof staticTargetModules>,
): string => {
  const bootstrap = normalized.bootstrap;
  const hasSkills = bootstrap.skills.length > 0;
  const hasSchedules = normalized.schedules.length > 0;
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
    renderNamedImport(["createAgentDurableObject"], modules.cloudflareDoRuntime),
    renderNamedImport(
      ["projectAgentSession", "projectAgentSessions", "projectWorkflowRun", "projectWorkflowRuns"],
      modules.runtimeRunProjector,
    ),
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
      ["AgentSubmitSpec", "CloudflareMaterialResolverFactory"],
      modules.cloudflareDoRuntime,
    ),
    ...(hasSchedules ? [renderTypeImport(["GeneratedScheduleTriggerInput"], "./schedules")] : []),
    renderTypeImport(
      [
        "WorkspaceAgentCustomCommandInput",
        "WorkspaceAgentDecideInputRequestCommandInput",
        "WorkspaceAgentInspectInputRequestCommandInput",
        "WorkspaceAgentResumeInputRequestCommandInput",
      ],
      modules.workspaceAgentHost,
    ),
  ].join("\n");
  return `${imports}

export const targetDeclarations = semanticDeclarations;
export const targetDeployment = deploymentProvenance;

const generatedHandler = () => undefined;

type AgentOSTargetEnv = {
  readonly [binding: string]: unknown;
${generatedLlmEnvFields}
};

${renderStaticRuntimeBootstrap(bootstrap, normalized.deployment.manifest.scope)}
${renderCloudflareMaterialResolverFactory()}

const generatedSubmitBindingsFor = async (
  env: AgentOSTargetEnv,
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
  const routes = generatedLlmRoutesFor(env);
  if (!routes.ok) return routes;
  const dynamicBindings = await generatedDynamicSubmitBindingsFor(event, dynamicCapability);
  if (!dynamicBindings.ok) return dynamicBindings;
  const dynamicCapabilityProjection = dynamicBindings.value.dynamicCapabilityProjection;
  return {
    ok: true,
    value: {
      ...dynamicBindings.value,
      llmRoutes: routes.value,
      tools: ${
        hasSkills
          ? `{
        ...generatedCustomTools,
        ...generatedFrameworkToolsFor(dynamicCapabilityProjection),
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
  refResolver: generatedMaterialResolverFor,
  llmTransport: () => OpenAiCompatibleLlmTransportLive,
});

export class ${target.durableObject.className} extends Base${target.durableObject.className} {
  private readonly targetEnv: AgentOSTargetEnv;

  constructor(ctx: DurableObjectState, env: AgentOSTargetEnv) {
    super(ctx, env);
    this.targetEnv = env;
  }

  override submit(spec: AgentSubmitSpec): Promise<SubmitResult> {
    return generatedSubmitBindingsFor(
      this.targetEnv,
      generatedDynamicCapabilityTurnEvent(),
      spec.dynamicCapability,
    ).then((bindings) =>
      bindings.ok ? this.submitWithBindings(spec, bindings.value) : rejectTargetFailure(bindings),
    );
  }

  submitRunInput(input: SubmitRunInput): Promise<SubmitResult> {
    return generatedSubmitBindingsFor(
      this.targetEnv,
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

${renderProductApiDurableObjectMethods("semanticTruthIdentity")}
${hasSchedules ? renderScheduleDurableObjectMethod("semanticTruthIdentity") : ""}

  resumeInputRequest(input: WorkspaceAgentResumeInputRequestCommandInput): Promise<SubmitResult> {
    return generatedSubmitBindingsFor(this.targetEnv).then((bindings) =>
      bindings.ok
        ? this.resumeInputRequestWithBindings(input, bindings.value)
        : rejectTargetFailure(bindings),
    );
  }

  decideInputRequest(input: WorkspaceAgentDecideInputRequestCommandInput): Promise<SubmitResult> {
    return generatedSubmitBindingsFor(this.targetEnv).then((bindings) =>
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
}
`;
};
