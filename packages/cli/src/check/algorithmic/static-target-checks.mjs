import ts from "typescript";

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
    const manifestCompilerSource = read(
      "packages/cli/src/build/agent-authoring/manifest-compiler.ts",
    );
    const deploymentIntentSource = read(
      "packages/cli/src/build/agent-authoring/deployment-intent.ts",
    );
    const entrySources = [
      "packages/cli/src/build/agent-authoring.ts",
      "packages/cli/src/build/build-cli.ts",
      "packages/cli/src/index.ts",
      "packages/cli/src/main.mjs",
    ].map((path) => ({ path, source: read(path) }));
    let legacyConfigPresent = false;
    try {
      read("packages/cli/src/build/agent-authoring/config.ts");
      legacyConfigPresent = true;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      // ENOENT is the positive hard-cut contract.
    }
    failures.push(
      ...staticTargetArchitectureFailures({
        manifestCompilerSource,
        deploymentIntentSource,
        staticTargetSource: source,
        entrySources,
        legacyConfigPresent,
      }),
    );
    const staticRuntimeBootstrapModelSource = sliceBetweenMarkers(
      source,
      "interface StaticRuntimeBootstrapModel",
      "const renderCustomToolImports =",
    );
    const renderStaticRuntimeBootstrapImportsSource = sliceBetweenMarkers(
      source,
      "const renderStaticRuntimeBootstrapImports =",
      "const renderSemanticTruthIdentity =",
    );
    const renderSemanticTruthIdentitySource = sliceBetweenMarkers(
      source,
      "const renderSemanticTruthIdentity =",
      "const renderStaticRuntimeBootstrap =",
    );
    const renderStaticRuntimeBootstrapSource = sliceBetweenMarkers(
      source,
      "const renderStaticRuntimeBootstrap =",
      "const renderSubmitSpecFromRunInput =",
    );
    const renderCloudflareMaterialResolverFactorySource = sliceBetweenMarkers(
      source,
      "const renderCloudflareMaterialResolverFactory =",
      "const renderWorkspaceStaticTarget =",
    );
    const renderWorkspaceStaticTargetSource = sliceBetweenMarkers(
      source,
      "const renderWorkspaceStaticTarget =",
      "const renderChatStaticTarget =",
    );
    const renderChatStaticTargetSource = sliceBetweenMarkers(
      source,
      "const renderChatStaticTarget =",
      "const renderLocalAgentApp =",
    );
    const renderLocalAgentAppSource = sliceBetweenMarkers(
      source,
      "const renderLocalAgentApp =",
      "const renderCloudflareScopeHelper =",
    );
    const renderStaticTargetSource = [
      staticRuntimeBootstrapModelSource,
      renderStaticRuntimeBootstrapImportsSource,
      renderSemanticTruthIdentitySource,
      renderStaticRuntimeBootstrapSource,
      renderCloudflareMaterialResolverFactorySource,
      renderWorkspaceStaticTargetSource,
      renderChatStaticTargetSource,
      renderLocalAgentAppSource,
    ].join("\n");
    const renderWorkspaceSvelteKitRemoteSource = sliceBetweenMarkers(
      source,
      "const renderWorkspaceSvelteKitRemote =",
      "const renderChatSvelteKitRemote =",
    );
    const renderChatSvelteKitRemoteSource = sliceBetweenMarkers(
      source,
      "const renderChatSvelteKitRemote =",
      "const renderWorkspaceBrowserDirectClient =",
    );
    const renderSvelteKitRemoteSource = [
      renderWorkspaceSvelteKitRemoteSource,
      renderChatSvelteKitRemoteSource,
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
      "const generatedProfileClientModuleImports =",
    );
    const renderWorkspaceStaticClientSource = sliceBetweenMarkers(
      source,
      "const renderWorkspaceBrowserDirectClient =",
      "const renderStaticClientTypes =",
    );
    const renderStaticClientSource = renderWorkspaceStaticClientSource;
    for (const [name, targetSource] of [
      ["StaticRuntimeBootstrapModel", staticRuntimeBootstrapModelSource],
      ["renderStaticRuntimeBootstrapImports", renderStaticRuntimeBootstrapImportsSource],
      ["renderSemanticTruthIdentity", renderSemanticTruthIdentitySource],
      ["renderStaticRuntimeBootstrap", renderStaticRuntimeBootstrapSource],
      ["renderCloudflareMaterialResolverFactory", renderCloudflareMaterialResolverFactorySource],
      ["renderWorkspaceStaticTarget", renderWorkspaceStaticTargetSource],
      ["renderChatStaticTarget", renderChatStaticTargetSource],
      ["renderLocalAgentApp", renderLocalAgentAppSource],
    ]) {
      if (targetSource.length === 0) {
        failures.push(
          `${sourcePath}: generated-static-target-linking: missing shared bootstrap surface ${name}`,
        );
      }
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
      "generatedMaterialResolverFactory",
      "CloudflareMaterialResolverFactory",
      "generatedMaterialResolverFor",
      "generatedMaterialResolverFactoryContract.create(env)",
      "refResolver: generatedMaterialResolverFor",
      "defineWorkspaceAgentMount",
      "createCloudflareSandboxWorkspaceEnvResolver",
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
    const sharedBootstrapMarkersBySurface = [
      {
        name: "StaticRuntimeBootstrapModel",
        targetSource: staticRuntimeBootstrapModelSource,
        markers: [
          "interface StaticRuntimeBootstrapModel",
          "const staticRuntimeBootstrapModelFor =",
          "customToolNames: toolNames.filter",
          "manifestTools: input.deployment.manifest.tools",
          "llmRoutes: input.llmRoutes",
          "skills: input.skills",
          "instructionFragments: input.instructionFragments",
          "dynamicResolvers: input.dynamicResolvers",
        ],
      },
      {
        name: "renderStaticRuntimeBootstrapImports",
        targetSource: renderStaticRuntimeBootstrapImportsSource,
        markers: [
          "const renderStaticRuntimeBootstrapImports =",
          'import semanticDeclarations from "./manifest.json";',
          "runDynamicCapabilityResolvers",
          "OpenAiCompatibleLlmTransportLive",
          "preflightOpenAiCompatibleProviderMaterial",
          "manifestTruthIdentity",
          "cloudflareDefaultTruthIdentityFromRoutingScope",
          "deterministicToolInvocation",
          "unsafeRunToolByName",
          "renderCustomToolImports(model)",
        ],
      },
      {
        name: "renderSemanticTruthIdentity",
        targetSource: renderSemanticTruthIdentitySource,
        markers: [
          "const renderSemanticTruthIdentity =",
          'scope.idSource === "submit_scope"',
          "const semanticTruthIdentityFor = (scopeId: string): LedgerTruthIdentity =>",
          'if (scopeId.length === 0) throw Error("authenticated routing scope is missing")',
          "cloudflareDefaultTruthIdentityFromRoutingScope(scopeId",
          "const semanticTruthIdentity = manifestTruthIdentity(semanticManifest);",
          "scopeId !== semanticTruthIdentity.scopeRef.scopeId",
        ],
      },
      {
        name: "renderStaticRuntimeBootstrap",
        targetSource: renderStaticRuntimeBootstrapSource,
        markers: [
          "const renderStaticRuntimeBootstrap =",
          "const semanticManifest =",
          "${renderSemanticTruthIdentity(scope)}",
          "const generatedCustomTools =",
          "renderDynamicCapabilitySupport(model)",
          "renderSkillSupport(model.skills)",
          "renderMaterialValueFunction(model.llmRoutes)",
          "renderGeneratedProviderPreflight(model.llmRoutes)",
          "renderGeneratedLlmRoutesFor(model.llmRoutes)",
        ],
      },
    ];
    for (const { name, targetSource, markers } of sharedBootstrapMarkersBySurface) {
      for (const marker of markers) {
        if (!targetSource.includes(marker)) {
          failures.push(
            `${sourcePath}: generated-static-target-linking: ${name} missing shared semantic marker ${marker}`,
          );
        }
      }
    }

    const staticTargetConsumers = [
      { name: "cloudflare workspace", targetSource: renderWorkspaceStaticTargetSource },
      { name: "cloudflare chat", targetSource: renderChatStaticTargetSource },
      { name: "node local", targetSource: renderLocalAgentAppSource },
    ];
    const requiredBootstrapConsumerMarkers = [
      "const bootstrap = staticRuntimeBootstrapModelFor(normalized, toolNames);",
      "const hasSkills = bootstrap.skills.length > 0;",
      "renderStaticRuntimeBootstrapImports(bootstrap, normalized.deployment.manifest.scope, modules)",
      "${renderStaticRuntimeBootstrap(bootstrap, normalized.deployment.manifest.scope)}",
    ];
    const forbiddenTargetLocalBootstrapMarkers = [
      "const semanticManifest =",
      "const semanticTruthIdentity =",
      "const generatedCustomTools =",
      "const generatedDynamicCapabilityCatalog =",
      "const materialEnvValue =",
      "const requiredStringMaterial =",
    ];
    for (const { name, targetSource } of staticTargetConsumers) {
      for (const marker of requiredBootstrapConsumerMarkers) {
        if (!targetSource.includes(marker)) {
          failures.push(
            `${sourcePath}: generated-static-target-linking: ${name} missing shared bootstrap consumer marker ${marker}`,
          );
        }
      }
      for (const marker of forbiddenTargetLocalBootstrapMarkers) {
        if (targetSource.includes(marker)) {
          failures.push(
            `${sourcePath}: generated-static-target-linking: ${name} duplicates shared bootstrap writer ${marker}`,
          );
        }
      }
    }

    const requiredModuleKinds = [
      '"semantic-json"',
      '"authored-material-resolver"',
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
      "AGENTOS_MATERIAL_RESOLVER",
      "AGENTOS_CREDENTIAL_",
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

    if (!source.includes('".agentos/generated/sveltekit.remote.ts"')) {
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
      if (!source.includes(generatedFile)) {
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
      '"./target"',
      "profile.sandboxImport",
      "profile.sandboxExport",
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
    ];
    for (const marker of requiredWranglerMarkers) {
      if (!renderCloudflareWranglerConfigSource.includes(marker)) {
        failures.push(
          `${sourcePath}: generated-static-target-linking: wrangler config missing ${marker}`,
        );
      }
    }

    for (const marker of [
      'class_name: "Sandbox"',
      'image: "../../Dockerfile"',
      "durable_objects",
      "new_sqlite_classes",
    ]) {
      if (!source.includes(marker)) {
        failures.push(
          `${sourcePath}: generated-static-target-linking: host projection missing wrangler marker ${marker}`,
        );
      }
    }

    const rendererSurfaces = [
      ["renderWorkspaceStaticTarget", renderWorkspaceStaticTargetSource],
      ["renderChatStaticTarget", renderChatStaticTargetSource],
      ["renderLocalAgentApp", renderLocalAgentAppSource],
      ["renderCloudflareScopeHelper", renderCloudflareScopeHelperSource],
      ["renderCloudflareWorkerEntry", renderCloudflareWorkerEntrySource],
      ["renderCloudflareWranglerConfig", renderCloudflareWranglerConfigSource],
      ["renderSvelteKitRemote", renderSvelteKitRemoteSource],
      ["renderStaticClient", renderStaticClientSource],
    ];
    for (const [name, rendererSource] of rendererSurfaces) {
      if (
        /\b(?:ProductPlan|ProductIntent|StaticTargetBinding|DeploymentIntent|LocalHost)\b/u.test(
          rendererSource,
        )
      ) {
        failures.push(
          `${sourcePath}: generated-static-target-linking: ${name} must consume only closed render input`,
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

const parseSource = (path, source) =>
  ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith(".mjs") ? ts.ScriptKind.JS : ts.ScriptKind.TS,
  );

const hasExportModifier = (node) =>
  node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) === true;

const namedInterface = (sourceFile, name) =>
  sourceFile.statements.find(
    (statement) => ts.isInterfaceDeclaration(statement) && statement.name.text === name,
  );

const namedTypeAlias = (sourceFile, name) =>
  sourceFile.statements.find(
    (statement) => ts.isTypeAliasDeclaration(statement) && statement.name.text === name,
  );

const exportedCallable = (sourceFile, name) => {
  for (const statement of sourceFile.statements) {
    if (
      ts.isFunctionDeclaration(statement) &&
      statement.name?.text === name &&
      hasExportModifier(statement)
    ) {
      return statement;
    }
    if (!ts.isVariableStatement(statement) || !hasExportModifier(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name) &&
        declaration.name.text === name &&
        declaration.initializer !== undefined &&
        (ts.isArrowFunction(declaration.initializer) ||
          ts.isFunctionExpression(declaration.initializer))
      ) {
        return declaration.initializer;
      }
    }
  }
  return undefined;
};

const propertyName = (name) =>
  name !== undefined &&
  (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name))
    ? name.text
    : undefined;

const interfaceMemberNames = (declaration) =>
  declaration.members
    .map((member) => (ts.isPropertySignature(member) ? propertyName(member.name) : undefined))
    .filter((name) => name !== undefined);

const normalizedTypeText = (sourceFile, node) =>
  node?.getText(sourceFile).replace(/\s+/gu, "") ?? "";

const callExpressionsNamed = (root, name) => {
  const calls = [];
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === name
    ) {
      calls.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return calls;
};

const propertyAccessPath = (node) => {
  if (ts.isIdentifier(node)) return node.text;
  if (!ts.isPropertyAccessExpression(node)) return undefined;
  const parent = propertyAccessPath(node.expression);
  return parent === undefined ? undefined : `${parent}.${node.name.text}`;
};

const propertyAccessPaths = (root) => {
  const paths = new Set();
  const visit = (node) => {
    if (ts.isPropertyAccessExpression(node)) {
      const path = propertyAccessPath(node);
      if (path !== undefined) paths.add(path);
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return paths;
};

const namedImportNames = (sourceFile, moduleSpecifier) => {
  const names = new Set();
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== moduleSpecifier
    ) {
      continue;
    }
    const bindings = statement.importClause?.namedBindings;
    if (!ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) names.add(element.name.text);
  }
  return names;
};

const callableParameterContract = (sourceFile, callable) =>
  callable.parameters.map((parameter) => ({
    name: ts.isIdentifier(parameter.name) ? parameter.name.text : "",
    type: normalizedTypeText(sourceFile, parameter.type),
  }));

const hasCallWithLeadingArguments = (sourceFile, callable, name, expectedArguments) =>
  callExpressionsNamed(callable.body, name).some((call) =>
    expectedArguments.every(
      (expected, index) => call.arguments[index]?.getText(sourceFile) === expected,
    ),
  );

export const staticTargetArchitectureFailures = ({
  manifestCompilerSource,
  deploymentIntentSource,
  staticTargetSource,
  entrySources = [],
  legacyConfigPresent = false,
}) => {
  const failures = [];
  const manifestPath = "packages/cli/src/build/agent-authoring/manifest-compiler.ts";
  const deploymentPath = "packages/cli/src/build/agent-authoring/deployment-intent.ts";
  const targetPath = "packages/cli/src/build/agent-authoring/static-target.ts";
  const manifestFile = parseSource(manifestPath, manifestCompilerSource);
  const deploymentFile = parseSource(deploymentPath, deploymentIntentSource);
  const targetFile = parseSource(targetPath, staticTargetSource);

  const productPlan = namedInterface(manifestFile, "ProductPlan");
  if (productPlan === undefined || !hasExportModifier(productPlan)) {
    failures.push(`${manifestPath}: ProductPlan must be an exported interface`);
  } else {
    const fields = interfaceMemberNames(productPlan);
    for (const required of [
      "agent",
      "instructions",
      "symbolicRequirements",
      "assets",
      "provenance",
      "productDigest",
    ]) {
      if (!fields.includes(required)) {
        failures.push(`${manifestPath}: ProductPlan is missing product field ${required}`);
      }
    }
    const forbiddenField =
      /(?:scope|authority|target|client|provider|workspace|host|deployment|correlation)/iu;
    for (const field of fields.filter((name) => forbiddenField.test(name))) {
      failures.push(`${manifestPath}: ProductPlan leaks binding field ${field}`);
    }
    const forbiddenType = /\b(?:StaticTargetBinding|DeploymentIntent|LocalHost|AgentOsConfig)\b/u;
    if (forbiddenType.test(productPlan.getText(manifestFile))) {
      failures.push(`${manifestPath}: ProductPlan references a host or deployment type`);
    }
  }

  const compiler = exportedCallable(manifestFile, "compileProductPlan");
  if (compiler === undefined) {
    failures.push(`${manifestPath}: missing exported compileProductPlan`);
  } else if (normalizedTypeText(manifestFile, compiler.type) !== "CompileProductPlanResult") {
    failures.push(`${manifestPath}: compileProductPlan must return CompileProductPlanResult`);
  }

  const bindingAlias = namedTypeAlias(deploymentFile, "StaticTargetBinding");
  if (bindingAlias === undefined || !hasExportModifier(bindingAlias)) {
    failures.push(`${deploymentPath}: StaticTargetBinding must be an exported type alias`);
  } else {
    const members = ts.isUnionTypeNode(bindingAlias.type)
      ? bindingAlias.type.types.map((member) => normalizedTypeText(deploymentFile, member)).sort()
      : [];
    if (members.join("|") !== "DeploymentIntent|LocalHost") {
      failures.push(
        `${deploymentPath}: StaticTargetBinding must be exactly LocalHost | DeploymentIntent`,
      );
    }
  }

  const productImports = namedImportNames(targetFile, "./manifest-compiler");
  if (!productImports.has("ProductPlan")) {
    failures.push(`${targetPath}: binder must import ProductPlan from manifest-compiler`);
  }
  const deploymentImports = namedImportNames(targetFile, "./deployment-intent");
  if (!deploymentImports.has("StaticTargetBinding")) {
    failures.push(`${targetPath}: binder must import StaticTargetBinding from deployment-intent`);
  }

  const binder = exportedCallable(targetFile, "bindStaticTargetPlan");
  if (binder === undefined) {
    failures.push(`${targetPath}: missing exported bindStaticTargetPlan`);
  } else {
    const parameters = callableParameterContract(targetFile, binder);
    const [product, binding] = parameters;
    if (product?.type !== "ProductPlan" || binding?.type !== "StaticTargetBinding") {
      failures.push(
        `${targetPath}: bindStaticTargetPlan must consume ProductPlan + StaticTargetBinding`,
      );
    }
    if (normalizedTypeText(targetFile, binder.type) !== "StaticTargetPlanResult") {
      failures.push(`${targetPath}: bindStaticTargetPlan must return StaticTargetPlanResult`);
    }
    if (
      product?.name !== undefined &&
      binding?.name !== undefined &&
      !hasCallWithLeadingArguments(targetFile, binder, "bindingFactsFor", [
        product.name,
        binding.name,
      ])
    ) {
      failures.push(`${targetPath}: binder must derive binding facts from product + binding`);
    }
    if (
      product?.name !== undefined &&
      !callExpressionsNamed(binder.body, "staticTargetPlanFor").some(
        (call) => call.arguments[0]?.getText(targetFile) === product.name,
      )
    ) {
      failures.push(`${targetPath}: binder must close the ProductPlan into StaticTargetPlan`);
    }
  }

  const plan = namedInterface(targetFile, "StaticTargetPlan");
  if (plan === undefined || !hasExportModifier(plan)) {
    failures.push(`${targetPath}: StaticTargetPlan must be an exported closed plan`);
  } else {
    const fields = interfaceMemberNames(plan);
    for (const required of ["shared", "profile", "host", "client"]) {
      if (!fields.includes(required)) {
        failures.push(`${targetPath}: StaticTargetPlan is missing closed projection ${required}`);
      }
    }
  }

  const renderer = exportedCallable(targetFile, "renderStaticTargetPlan");
  if (renderer === undefined) {
    failures.push(`${targetPath}: missing exported renderStaticTargetPlan`);
  } else {
    const parameters = callableParameterContract(targetFile, renderer);
    if (parameters.length !== 1 || parameters[0]?.type !== "StaticTargetPlan") {
      failures.push(`${targetPath}: renderer must consume only one closed StaticTargetPlan`);
    }
    if (normalizedTypeText(targetFile, renderer.type) !== "StaticTargetLink") {
      failures.push(`${targetPath}: renderStaticTargetPlan must return StaticTargetLink`);
    }
    const planName = parameters[0]?.name ?? "plan";
    const paths = propertyAccessPaths(renderer.body);
    for (const required of [
      `${planName}.host.files`,
      `${planName}.host.moduleGraph`,
      `${planName}.profile.canonicalDeployment`,
      `${planName}.host.canonicalDeployment`,
      `${planName}.client.kind`,
      `${planName}.shared.toolNames`,
      `${planName}.host.mount`,
      `${planName}.profile.mount`,
    ]) {
      if (!paths.has(required)) {
        failures.push(`${targetPath}: closed renderer is missing projection ${required}`);
      }
    }
  }

  const linker = exportedCallable(targetFile, "linkStaticTarget");
  if (linker === undefined) {
    failures.push(`${targetPath}: missing exported linkStaticTarget`);
  } else {
    const parameters = callableParameterContract(targetFile, linker);
    const [product, binding] = parameters;
    if (product?.type !== "ProductPlan" || binding?.type !== "StaticTargetBinding") {
      failures.push(
        `${targetPath}: linkStaticTarget must consume ProductPlan + StaticTargetBinding`,
      );
    }
    if (normalizedTypeText(targetFile, linker.type) !== "StaticTargetLinkResult") {
      failures.push(`${targetPath}: linkStaticTarget must return StaticTargetLinkResult`);
    }
    if (
      product?.name !== undefined &&
      binding?.name !== undefined &&
      !hasCallWithLeadingArguments(targetFile, linker, "bindStaticTargetPlan", [
        product.name,
        binding.name,
      ])
    ) {
      failures.push(`${targetPath}: linkStaticTarget must delegate product binding to the binder`);
    }
    if (callExpressionsNamed(linker.body, "renderStaticTargetPlan").length !== 1) {
      failures.push(`${targetPath}: linkStaticTarget must render exactly one closed plan`);
    }
  }

  const legacyMarkers = [
    "compileAgentTree",
    "linkWorkspaceStaticTarget",
    "decodeAgentOsConfig",
    "normalizeAgentOsConfig",
    "NormalizedAgentOsConfig",
    "AGENTOS_CONFIG_",
    "agentos.config.jsonc",
  ];
  for (const { path, source } of [
    { path: manifestPath, source: manifestCompilerSource },
    { path: deploymentPath, source: deploymentIntentSource },
    { path: targetPath, source: staticTargetSource },
    ...entrySources,
  ]) {
    for (const marker of legacyMarkers) {
      if (source.includes(marker)) {
        failures.push(`${path}: legacy authoring entry remains reachable through ${marker}`);
      }
    }
  }
  if (legacyConfigPresent) {
    failures.push(
      "packages/cli/src/build/agent-authoring/config.ts: legacy authoring grammar must be deleted",
    );
  }

  return failures;
};
