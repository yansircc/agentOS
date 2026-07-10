export const createStaticTargetChecks = ({ read, readJson, failIfAny }) => {
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
    const commandProjectionSourcePath =
      "packages/cli/src/build/agent-authoring/generated-command-projection.ts";
    const source = read(sourcePath);
    const workspaceAgentSource = read(workspaceAgentSourcePath);
    const commandProjectionSource = read(commandProjectionSourcePath);
    const surface = readJson("docs/surface.json");
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

    if (!workspaceAgentSource.includes("WORKSPACE_AGENT_COMMAND_DESCRIPTOR")) {
      failures.push(
        `${workspaceAgentSourcePath}: generated-static-target-linking: missing command descriptor source`,
      );
    }
    for (const marker of [
      "satisfies GeneratedCommandProjectionByKey",
      "const commandKeys = Object.keys(",
      'surface === "common"',
      "renderGeneratedCommandRpcType",
      "renderGeneratedCommandCases",
      "renderGeneratedCommandDispatch",
      "renderGeneratedClientTypeMethods",
      "renderGeneratedClientMethods",
    ]) {
      if (!commandProjectionSource.includes(marker)) {
        failures.push(
          `${commandProjectionSourcePath}: generated-static-target-linking: missing algebra marker ${marker}`,
        );
      }
    }
    for (const marker of [
      'renderGeneratedCommandRpcType("workspace")',
      'renderGeneratedCommandCases("workspace")',
      'renderGeneratedCommandRpcType("chat")',
      'renderGeneratedCommandDispatch("chat", "chat")',
      'renderGeneratedClientTypeMethods("chat")',
      'renderGeneratedClientMethods("chat")',
    ]) {
      if (!source.includes(marker)) {
        failures.push(`${sourcePath}: generated-static-target-linking: missing ${marker}`);
      }
    }
    if (renderSvelteKitRemoteSource.includes("if (name === WORKSPACE_AGENT_COMMAND.")) {
      failures.push(
        `${sourcePath}: generated-static-target-linking: remote command cases must come from the typed descriptor algebra`,
      );
    }

    const requiredStaticWiringMarkers = [
      'import semanticDeclarations from "./manifest.json";',
      'import deploymentProvenance from "./deployment.json";',
      "createAgentDurableObject",
      "resolveRuntimeInstallGraph",
      "workspaceOperations",
      "OpenAiCompatibleLlmTransportLive",
      "preflightOpenAiCompatibleProviderMaterial",
      "defineWorkspaceAgentMount",
      "makeCloudflareWorkspaceEnv",
      "getSandbox",
      "generatedCustomTools",
      "llmTransport: () => OpenAiCompatibleLlmTransportLive",
      "generatedCapabilityInstallGraphFor",
      "extensions: (env) => generatedCapabilityInstallGraphFor(env).extensions",
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
      "GENERATED_LOAD_SKILL_TOOL_NAME",
      "const renderSkillSupport =",
      "const renderSkillResourceBundle =",
      'import generatedSkillResourcePayloads from "./skill-resources.json";',
      "const generatedSkillResources =",
      "const generatedLoadSkillTool = defineProductTool",
      'encoding: Schema.optional(Schema.Literals(["utf-8", "base64"]))',
      "const generatedSkillsSystemAdvert =",
      "const generatedFrameworkToolsFor =",
      "const renderSubmitSpecFromRunInput =",
      "generatedSystemPrompt(input.system, dynamicCapabilityProjection)",
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
      '"capability-runtime"',
      '"provider-runtime"',
      '"workspace-host"',
      '"authored-tool"',
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

    const packagesBySlug = new Map((surface.packages ?? []).map((pkg) => [pkg.slug, pkg]));
    const generatedImportAudience = new Set(["default-direct", "generated-only"]);
    const generatedPackageSpecifiers = [
      ...source.matchAll(/publicPackageSpecifier\(scope,\s*"([^"]+)"\)/gu),
    ].map((match) => match[1]);
    if (generatedPackageSpecifiers.length === 0) {
      failures.push(
        `${sourcePath}: generated-static-target-linking: generated package specifier map is empty`,
      );
    }
    for (const specifier of generatedPackageSpecifiers) {
      const [slug, ...subpathParts] = specifier.split("/");
      const pkg = packagesBySlug.get(slug);
      const subpath = subpathParts.length === 0 ? "." : `./${subpathParts.join("/")}`;
      if (pkg === undefined) {
        failures.push(
          `${sourcePath}: generated-static-target-linking: ${specifier} has no docs/surface.json package`,
        );
        continue;
      }
      const entrypoint = (pkg.entrypoints ?? []).find((entry) => entry.subpath === subpath);
      if (entrypoint === undefined) {
        failures.push(
          `${sourcePath}: generated-static-target-linking: ${pkg.name}${subpath === "." ? "" : subpath.slice(1)} is missing docs/surface.json entrypoint metadata`,
        );
        continue;
      }
      if (!entrypoint.audiences.some((audience) => generatedImportAudience.has(audience))) {
        failures.push(
          `${sourcePath}: generated-static-target-linking: generated target must not import ${pkg.name}${subpath === "." ? "" : subpath.slice(1)} with audiences ${entrypoint.audiences.join(", ")}`,
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
      '".agentos/generated/skill-resources.json"',
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
