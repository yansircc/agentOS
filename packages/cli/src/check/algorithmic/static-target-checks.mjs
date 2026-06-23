export const createStaticTargetChecks = ({ read, failIfAny }) => {
  const sliceBetweenMarkers = (source, startMarker, endMarker) => {
    const start = source.indexOf(startMarker);
    if (start === -1) return "";
    const end = source.indexOf(endMarker, start);
    return end === -1 ? source.slice(start) : source.slice(start, end);
  };

  const checkGeneratedStaticTargetLinking = () => {
    const failures = [];
    const sourcePath = "packages/cli/src/build/agent-authoring/static-target.ts";
    const workspaceAgentSourcePath = "packages/core/src/workspace-agent.ts";
    const source = read(sourcePath);
    const workspaceAgentSource = read(workspaceAgentSourcePath);
    const renderWorkspaceStaticTargetSource = sliceBetweenMarkers(
      source,
      "const renderWorkspaceStaticTarget =",
      "const renderChatStaticTarget =",
    );
    const renderChatStaticTargetSource = sliceBetweenMarkers(
      source,
      "const renderChatStaticTarget =",
      "const renderStaticTarget =",
    );
    const renderStaticTargetDispatchSource = sliceBetweenMarkers(
      source,
      "const renderStaticTarget =",
      "const renderCloudflareScopeHelper =",
    );
    const renderStaticTargetSource = [
      renderWorkspaceStaticTargetSource,
      renderChatStaticTargetSource,
      renderStaticTargetDispatchSource,
    ].join("\n");
    const linkWorkspaceStaticTargetSource = sliceBetweenMarkers(
      source,
      "export const linkWorkspaceStaticTarget =",
      "const renderAgentOsConfigSchema =",
    );
    const renderWorkspaceSvelteKitRemoteSource = sliceBetweenMarkers(
      source,
      "const renderWorkspaceSvelteKitRemote =",
      "const renderChatSvelteKitRemote =",
    );
    const renderChatSvelteKitRemoteSource = sliceBetweenMarkers(
      source,
      "const renderChatSvelteKitRemote =",
      "const renderSvelteKitRemote =",
    );
    const renderSvelteKitRemoteDispatchSource = sliceBetweenMarkers(
      source,
      "const renderSvelteKitRemote =",
      "const renderWorkspaceStaticClient =",
    );
    const renderSvelteKitRemoteSource = [
      renderWorkspaceSvelteKitRemoteSource,
      renderChatSvelteKitRemoteSource,
      renderSvelteKitRemoteDispatchSource,
    ].join("\n");
    const renderCloudflareScopeHelperSource = sliceBetweenMarkers(
      source,
      "const renderCloudflareScopeHelper =",
      "const renderCloudflareWorkerEntry =",
    );
    const renderCloudflareWorkerEntrySource = sliceBetweenMarkers(
      source,
      "const renderCloudflareWorkerEntry =",
      "const renderCloudflareWranglerConfig =",
    );
    const renderCloudflareWranglerConfigSource = sliceBetweenMarkers(
      source,
      "const renderCloudflareWranglerConfig =",
      "const generatedClientModuleImports =",
    );
    const renderWorkspaceStaticClientSource = sliceBetweenMarkers(
      source,
      "const renderWorkspaceStaticClient =",
      "const renderChatStaticClient =",
    );
    const renderChatStaticClientSource = sliceBetweenMarkers(
      source,
      "const renderChatStaticClient =",
      "const renderStaticClient =",
    );
    const renderStaticClientDispatchSource = sliceBetweenMarkers(
      source,
      "const renderStaticClient =",
      "const renderStaticClientTypes =",
    );
    const renderStaticClientSource = [
      renderWorkspaceStaticClientSource,
      renderChatStaticClientSource,
      renderStaticClientDispatchSource,
    ].join("\n");
    if (renderStaticTargetSource.length === 0) {
      failures.push(`${sourcePath}: generated-static-target-linking: missing renderStaticTarget`);
    }
    if (linkWorkspaceStaticTargetSource.length === 0) {
      failures.push(
        `${sourcePath}: generated-static-target-linking: missing linkWorkspaceStaticTarget`,
      );
    }
    if (renderSvelteKitRemoteSource.length === 0) {
      failures.push(
        `${sourcePath}: generated-static-target-linking: missing renderSvelteKitRemote`,
      );
    }
    if (renderCloudflareScopeHelperSource.length === 0) {
      failures.push(
        `${sourcePath}: generated-static-target-linking: missing renderCloudflareScopeHelper`,
      );
    }
    if (renderCloudflareWorkerEntrySource.length === 0) {
      failures.push(
        `${sourcePath}: generated-static-target-linking: missing renderCloudflareWorkerEntry`,
      );
    }
    if (renderCloudflareWranglerConfigSource.length === 0) {
      failures.push(
        `${sourcePath}: generated-static-target-linking: missing renderCloudflareWranglerConfig`,
      );
    }
    if (renderStaticClientSource.length === 0) {
      failures.push(`${sourcePath}: generated-static-target-linking: missing renderStaticClient`);
    }

    const commandBlock =
      workspaceAgentSource.match(
        /export const WORKSPACE_AGENT_COMMAND = \{([\s\S]*?)\} as const;/u,
      )?.[1] ?? "";
    const workspaceCommandKeys = [...commandBlock.matchAll(/^\s*([A-Z_]+):\s*"([^"]+)"/gmu)].map(
      (match) => match[1],
    );
    if (workspaceCommandKeys.length === 0) {
      failures.push(
        `${workspaceAgentSourcePath}: generated-static-target-linking: missing WORKSPACE_AGENT_COMMAND`,
      );
    }
    const generatedCommandProjection = {
      SUBMIT: {
        method: "submitRunInput",
        parser: "submitInputFromUnknown",
      },
      RESUME_INPUT_REQUEST: {
        method: "resumeInputRequest",
        parser: "resumeInputRequestFromUnknown",
      },
      DECIDE_INPUT_REQUEST: {
        method: "decideInputRequest",
        parser: "decideInputRequestFromUnknown",
      },
      CUSTOM: {
        method: "customCommand",
        parser: "customInputFromUnknown",
      },
      READ_STATE: {
        method: "readWorkspaceState",
        parser: "readStateInputFromUnknown",
      },
      READ_FILE: {
        method: "readWorkspaceFile",
        parser: "readFileInputFromUnknown",
      },
      RESET: {
        method: "resetWorkspace",
        parser: "resetInputFromUnknown",
      },
      DESTROY: {
        method: "destroyWorkspace",
        parser: "destroyInputFromUnknown",
      },
    };
    const commonGeneratedCommandKeys = [
      "SUBMIT",
      "RESUME_INPUT_REQUEST",
      "DECIDE_INPUT_REQUEST",
      "CUSTOM",
    ];
    const workspaceOnlyGeneratedCommandKeys = ["READ_STATE", "READ_FILE", "RESET", "DESTROY"];
    const knownGeneratedCommandKeys = new Set([
      ...commonGeneratedCommandKeys,
      ...workspaceOnlyGeneratedCommandKeys,
    ]);
    for (const commandKey of workspaceCommandKeys) {
      if (!knownGeneratedCommandKeys.has(commandKey)) {
        failures.push(
          `${sourcePath}: generated-static-target-linking: generated target missing profile classification for WORKSPACE_AGENT_COMMAND.${commandKey}`,
        );
      }
    }
    const assertCommandProjection = ({ commandKey, targetSource, remoteSource, profile }) => {
      const projection = generatedCommandProjection[commandKey];
      if (projection === undefined) {
        failures.push(
          `${sourcePath}: generated-static-target-linking: generated target missing projection for WORKSPACE_AGENT_COMMAND.${commandKey}`,
        );
        return;
      }
      if (!targetSource.includes(`${projection.method}(`)) {
        failures.push(
          `${sourcePath}: generated-static-target-linking: ${profile} renderStaticTarget missing ${projection.method} for WORKSPACE_AGENT_COMMAND.${commandKey}`,
        );
      }
      if (!remoteSource.includes(`readonly ${projection.method}:`)) {
        failures.push(
          `${sourcePath}: generated-static-target-linking: ${profile} AgentOSRpc missing ${projection.method} for WORKSPACE_AGENT_COMMAND.${commandKey}`,
        );
      }
      if (!remoteSource.includes(`if (name === WORKSPACE_AGENT_COMMAND.${commandKey})`)) {
        failures.push(
          `${sourcePath}: generated-static-target-linking: ${profile} invokeAgentCommand missing WORKSPACE_AGENT_COMMAND.${commandKey}`,
        );
      }
      if (!remoteSource.includes(projection.parser)) {
        failures.push(
          `${sourcePath}: generated-static-target-linking: ${profile} invokeAgentCommand missing ${projection.parser} for WORKSPACE_AGENT_COMMAND.${commandKey}`,
        );
      }
      if (!remoteSource.includes(`runtime.${projection.method}(`)) {
        failures.push(
          `${sourcePath}: generated-static-target-linking: ${profile} invokeAgentCommand missing runtime.${projection.method} for WORKSPACE_AGENT_COMMAND.${commandKey}`,
        );
      }
    };
    for (const commandKey of commonGeneratedCommandKeys) {
      assertCommandProjection({
        commandKey,
        targetSource: renderWorkspaceStaticTargetSource,
        remoteSource: renderWorkspaceSvelteKitRemoteSource,
        profile: "workspace@1",
      });
      assertCommandProjection({
        commandKey,
        targetSource: renderChatStaticTargetSource,
        remoteSource: renderChatSvelteKitRemoteSource,
        profile: "chat@1",
      });
    }
    for (const commandKey of workspaceOnlyGeneratedCommandKeys) {
      const projection = generatedCommandProjection[commandKey];
      assertCommandProjection({
        commandKey,
        targetSource: renderWorkspaceStaticTargetSource,
        remoteSource: renderWorkspaceSvelteKitRemoteSource,
        profile: "workspace@1",
      });
      if (
        projection !== undefined &&
        (renderChatStaticTargetSource.includes(`${projection.method}(`) ||
          renderChatSvelteKitRemoteSource.includes(`WORKSPACE_AGENT_COMMAND.${commandKey}`) ||
          renderChatSvelteKitRemoteSource.includes(projection.parser))
      ) {
        failures.push(
          `${sourcePath}: generated-static-target-linking: chat@1 must not project WORKSPACE_AGENT_COMMAND.${commandKey}`,
        );
      }
    }

    const requiredStaticWiringMarkers = [
      'import semanticDeclarations from "./manifest.json";',
      'import deploymentProvenance from "./deployment.json";',
      "createAgentDurableObject",
      "installCloudflareWorkspaceOperationProvider",
      "OpenAiCompatibleLlmTransportLive",
      "defineWorkspaceAgentMount",
      "bindWorkspaceToolsForRuntime",
      "makeCloudflareWorkspaceEnv",
      "getSandbox",
      "generatedCustomTools",
      "llmTransport: () => OpenAiCompatibleLlmTransportLive",
      "extensions: (env) => workspaceOperationInstallFor(env).extensions",
      "override submit(spec: AgentSubmitSpec): Promise<SubmitResult>",
      "submitRunInput(input: SubmitRunInput): Promise<SubmitResult>",
      "readWorkspaceFile(",
    ];
    for (const marker of requiredStaticWiringMarkers) {
      if (!renderStaticTargetSource.includes(marker)) {
        failures.push(
          `${sourcePath}: generated-static-target-linking: renderStaticTarget missing static marker ${marker}`,
        );
      }
    }

    const requiredSkillSupportMarkers = [
      'const LOAD_SKILL_TOOL_NAME = "load_skill";',
      "const renderSkillSupport =",
      "const generatedLoadSkillTool = defineProductTool",
      "const generatedSkillsSystemAdvert =",
      "const generatedFrameworkTools =",
      "const renderSubmitSpecFromRunInput =",
      "system: generatedSystemPrompt(input.system)",
    ];
    for (const marker of requiredSkillSupportMarkers) {
      if (!source.includes(marker)) {
        failures.push(
          `${sourcePath}: generated-static-target-linking: generated skills support missing ${marker}`,
        );
      }
    }
    const assertProfileSkillProjection = ({ targetSource, profile }) => {
      for (const marker of [
        "const hasSkills = normalized.skills.length > 0;",
        '...(hasSkills ? ["defineProductTool"] : [])',
        'renderNamedImport(hasSkills ? ["Effect", "Schema"] : ["Effect"], modules.effect)',
        "${renderSkillSupport(normalized.skills)}",
        "${renderSubmitSpecFromRunInput(hasSkills)}",
        "...generatedFrameworkTools",
      ]) {
        if (!targetSource.includes(marker)) {
          failures.push(
            `${sourcePath}: generated-static-target-linking: ${profile} missing generated skills projection marker ${marker}`,
          );
        }
      }
    };
    assertProfileSkillProjection({
      targetSource: renderWorkspaceStaticTargetSource,
      profile: "workspace@1",
    });
    assertProfileSkillProjection({
      targetSource: renderChatStaticTargetSource,
      profile: "chat@1",
    });

    const requiredModuleKinds = [
      '"semantic-json"',
      '"target-runtime"',
      '"target-scope-helper"',
      '"target-worker"',
      '"target-config"',
      '"provider-runtime"',
      '"workspace-host"',
      '"authored-tool"',
      '"workspace-binding"',
      '"execution-domain-runtime"',
      '"platform-runtime"',
      '"client-core"',
      '"client-transport"',
      '"client-framework"',
    ];
    for (const marker of requiredModuleKinds) {
      if (!source.includes(`kind: ${marker}`) && !source.includes(`| ${marker}`)) {
        failures.push(
          `${sourcePath}: generated-static-target-linking: module graph missing ${marker}`,
        );
      }
    }

    const durableObjectConfigSections = [
      renderWorkspaceStaticTargetSource,
      renderChatStaticTargetSource,
    ]
      .map((profileSource) =>
        sliceBetweenMarkers(profileSource, "createAgentDurableObject<", "export class"),
      )
      .filter((section) => section.length > 0);
    if (durableObjectConfigSections.length === 0) {
      failures.push(
        `${sourcePath}: generated-static-target-linking: target must call createAgentDurableObject`,
      );
    }
    for (const forbidden of ["deploymentProvenance", "targetDeployment"]) {
      if (durableObjectConfigSections.some((section) => section.includes(forbidden))) {
        failures.push(
          `${sourcePath}: generated-static-target-linking: runtime wiring must not consume ${forbidden}`,
        );
      }
    }
    for (const forbidden of [
      "makeRuntime({",
      "workspaceExtension(",
      "dynamic import",
      "await import(",
      "import(",
    ]) {
      if (renderStaticTargetSource.includes(forbidden)) {
        failures.push(
          `${sourcePath}: generated-static-target-linking: closed target must not contain ${forbidden}`,
        );
      }
    }

    const requiredRemoteBridgeMarkers = [
      'renderNamedImport(["command", "getRequestEvent", "query"], modules.svelteKitServer)',
      'renderNamedImport(["agentOSRpcClient", "agentOSTruthIdentity"], "./cloudflare-scope")',
      "decodeSseHttpEvents",
      "responseToSseHttpChunks",
      "agentOSRpcClient<AgentOSRpc>(platformEnv)",
      "submitRunInput",
      "readWorkspaceFile",
      "streamEvents",
      "export const invokeAgentCommand = command(",
      "export const runEventStream = query.live(",
    ];
    for (const marker of requiredRemoteBridgeMarkers) {
      if (!renderSvelteKitRemoteSource.includes(marker)) {
        failures.push(
          `${sourcePath}: generated-static-target-linking: renderSvelteKitRemote missing bridge marker ${marker}`,
        );
      }
    }

    const requiredClientBridgeMarkers = [
      'import { invokeAgentCommand, runEventStream } from "./sveltekit.remote";',
      "streamSource: options.streamSource ?? generatedStreamSource",
      "rpcInvoker: options.rpcInvoker ?? generatedRpcInvoker",
      "clientReadable(bridge.client)",
      "selectClientReadable(bridge.client",
    ];
    for (const marker of requiredClientBridgeMarkers) {
      if (!renderStaticClientSource.includes(marker)) {
        failures.push(
          `${sourcePath}: generated-static-target-linking: renderStaticClient missing generated bridge marker ${marker}`,
        );
      }
    }

    if (!linkWorkspaceStaticTargetSource.includes('".agentos/generated/sveltekit.remote.ts"')) {
      failures.push(
        `${sourcePath}: generated-static-target-linking: SvelteKit target must emit sveltekit.remote.ts`,
      );
    }
    for (const generatedFile of [
      '".agentos/generated/cloudflare-scope.ts"',
      '".agentos/generated/worker.ts"',
      '".agentos/generated/wrangler.jsonc"',
    ]) {
      if (!linkWorkspaceStaticTargetSource.includes(generatedFile)) {
        failures.push(
          `${sourcePath}: generated-static-target-linking: target shell must emit ${generatedFile}`,
        );
      }
    }

    const requiredScopeHelperMarkers = [
      "durableObjectRpcClient",
      "manifestTruthIdentity",
      "agentOSTruthIdentity",
      "agentOSScopeId",
      "agentOSDurableObjectBinding",
      "agentOSRpcClient",
    ];
    for (const marker of requiredScopeHelperMarkers) {
      if (!renderCloudflareScopeHelperSource.includes(marker)) {
        failures.push(
          `${sourcePath}: generated-static-target-linking: scope helper missing ${marker}`,
        );
      }
    }

    const requiredWorkerEntryMarkers = [
      "Sandbox",
      '"./target"',
      'normalized.profile === AGENTOS_CONFIG_PROFILE.WORKSPACE_V1 ? ", Sandbox" : ""',
      "satisfies ExportedHandler<AgentOSTargetEnv>",
    ];
    for (const marker of requiredWorkerEntryMarkers) {
      if (!renderCloudflareWorkerEntrySource.includes(marker)) {
        failures.push(
          `${sourcePath}: generated-static-target-linking: worker entry missing ${marker}`,
        );
      }
    }

    const requiredWranglerMarkers = [
      'main: "./worker.ts"',
      'compatibility_flags: ["nodejs_compat"]',
      'class_name: "Sandbox"',
      'image: "../../Dockerfile"',
      "durable_objects",
      "new_sqlite_classes",
    ];
    for (const marker of requiredWranglerMarkers) {
      if (!renderCloudflareWranglerConfigSource.includes(marker)) {
        failures.push(
          `${sourcePath}: generated-static-target-linking: wrangler config missing ${marker}`,
        );
      }
    }

    failIfAny("generated static target linking", failures);
  };

  return {
    sliceBetweenMarkers,
    checkGeneratedStaticTargetLinking,
  };
};
