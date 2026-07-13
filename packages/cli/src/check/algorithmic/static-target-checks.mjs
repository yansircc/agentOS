import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const repoRoot = path.resolve(import.meta.dirname, "../../../../..");
const staticTargetRoot = "packages/cli/src/build/agent-authoring/static-target";
const staticTargetPaths = Object.freeze({
  facade: "packages/cli/src/build/agent-authoring/static-target.ts",
  model: `${staticTargetRoot}/model.ts`,
  encoding: `${staticTargetRoot}/encoding.ts`,
  registries: `${staticTargetRoot}/registries.ts`,
  semanticBootstrap: `${staticTargetRoot}/semantic-bootstrap.ts`,
  compiler: `${staticTargetRoot}/compiler.ts`,
  artifacts: `${staticTargetRoot}/artifacts.ts`,
  linker: `${staticTargetRoot}/linker.ts`,
});
const rendererPaths = Object.freeze([
  `${staticTargetRoot}/renderers/profile-workspace.ts`,
  `${staticTargetRoot}/renderers/profile-chat.ts`,
  `${staticTargetRoot}/renderers/host-local.ts`,
  `${staticTargetRoot}/renderers/host-cloudflare.ts`,
  `${staticTargetRoot}/renderers/client-browser.ts`,
  `${staticTargetRoot}/renderers/client-remote-workspace.ts`,
  `${staticTargetRoot}/renderers/client-remote-chat.ts`,
]);
const authoringInputPaths = new Set([
  "packages/cli/src/build/agent-authoring/manifest-compiler.ts",
  "packages/cli/src/build/agent-authoring/deployment-intent.ts",
]);
const rendererForbiddenPaths = new Set([staticTargetPaths.compiler, ...authoringInputPaths]);
const rendererClassifierImports = new Set([
  "DEPLOYMENT_TARGET_KIND",
  "DEPLOYMENT_TRANSPORT",
  "PRODUCT_AGENT_KIND",
  "PROVIDER_PROTOCOL",
  "ProductPlan",
  "StaticTargetBinding",
  "WORKSPACE_TOOL_DEFAULT_DECLARATIONS",
  "WORKSPACE_TOOL_EXPOSURE_PROFILES",
  "isWorkspaceToolName",
  "verifyProductPlanDigest",
]);
const planModelTypes = new Set([
  "StaticTargetPlanShared",
  "StaticTargetClientProjection",
  "StaticTargetProfileProjectionBase",
  "StaticTargetProfileProjection",
  "StaticTargetHostProjection",
  "StaticTargetPlan",
]);
const forbiddenPlanProjectionFields = new Set([
  "files",
  "moduleGraph",
  "clientCandidates",
  "browserDirect",
  "svelteKit",
  "svelteKitRemote",
  "targetText",
  "skillResourceBundle",
]);

const compare = (left, right) => left.localeCompare(right);
const toRepoPath = (absolutePath) =>
  path.relative(repoRoot, absolutePath).split(path.sep).join("/");
const isInsideRepo = (absolutePath) => {
  const relative = path.relative(repoRoot, absolutePath);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
};

let cachedCompilerOptions;
const cliCompilerOptions = () => {
  if (cachedCompilerOptions !== undefined) return cachedCompilerOptions;
  const configPath = path.join(repoRoot, "packages/cli/tsconfig.json");
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, ts.sys);
  if (parsed === undefined || parsed.errors.length > 0) {
    throw new Error("packages/cli/tsconfig.json: cannot resolve static target module graph");
  }
  cachedCompilerOptions = parsed.options;
  return cachedCompilerOptions;
};

const virtualModuleCandidates = (fromFile, specifier) => {
  if (!specifier.startsWith(".")) return [];
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), specifier));
  const withoutJsExtension = /\.(?:c|m)?jsx?$/u.test(base)
    ? base.replace(/\.(?:c|m)?jsx?$/u, "")
    : base;
  return [
    base,
    `${withoutJsExtension}.ts`,
    `${withoutJsExtension}.tsx`,
    `${withoutJsExtension}.mts`,
    `${withoutJsExtension}.cts`,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.mts`,
    `${base}.cts`,
    `${base}.js`,
    `${base}.mjs`,
    `${base}.cjs`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
    `${base}/index.mts`,
    `${base}/index.mjs`,
  ].filter((candidate, index, candidates) => candidates.indexOf(candidate) === index);
};

const importedNames = (node) => {
  if (ts.isImportDeclaration(node)) {
    const names = [];
    if (node.importClause?.name !== undefined) names.push("default");
    const bindings = node.importClause?.namedBindings;
    if (ts.isNamespaceImport(bindings)) names.push("*");
    if (ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        names.push((element.propertyName ?? element.name).text);
      }
    }
    return names;
  }
  if (ts.isExportDeclaration(node)) {
    if (node.exportClause === undefined || ts.isNamespaceExport(node.exportClause)) return ["*"];
    return node.exportClause.elements.map((element) => (element.propertyName ?? element.name).text);
  }
  return ["*"];
};

const staticModuleRecords = (file, source) => {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const records = [];
  const failures = [];
  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      records.push({ specifier: node.moduleSpecifier.text, names: importedNames(node) });
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      records.push({ specifier: node.moduleReference.expression.text, names: ["*"] });
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteralLike(node.argument.literal)
    ) {
      records.push({ specifier: node.argument.literal.text, names: ["*"] });
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      if (node.arguments.length !== 1 || !ts.isStringLiteralLike(node.arguments[0])) {
        failures.push(`${file}: static target module graph contains non-literal dynamic import`);
      } else {
        records.push({ specifier: node.arguments[0].text, names: ["*"] });
      }
    } else if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "require"
    ) {
      failures.push(`${file}: static target module graph forbids require`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  const preprocessed = ts.preProcessFile(source, true, true);
  for (const [references, kind] of [
    [preprocessed.referencedFiles, "path"],
    [preprocessed.typeReferenceDirectives, "types"],
    [preprocessed.libReferenceDirectives, "lib"],
  ]) {
    if (references.length > 0) {
      failures.push(`${file}: static target module graph forbids triple-slash ${kind} reference`);
    }
  }
  return { sourceFile, records, failures };
};

const resolveStaticModule = ({ fromFile, specifier, sources, read }) => {
  for (const candidate of virtualModuleCandidates(fromFile, specifier)) {
    if (sources.has(candidate)) return candidate;
    if (read === undefined) continue;
    try {
      const source = read(candidate);
      sources.set(candidate, source);
      return candidate;
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "EISDIR") throw error;
    }
  }
  if (read === undefined) return undefined;
  const resolved = ts.resolveModuleName(
    specifier,
    path.join(repoRoot, fromFile),
    cliCompilerOptions(),
    ts.sys,
  ).resolvedModule?.resolvedFileName;
  if (resolved === undefined || !isInsideRepo(resolved) || !fs.existsSync(resolved)) {
    return undefined;
  }
  const repoPath = toRepoPath(resolved);
  if (!repoPath.startsWith("packages/cli/src/")) return undefined;
  if (!sources.has(repoPath)) sources.set(repoPath, read(repoPath));
  return repoPath;
};

const staticTargetModuleGraph = ({ moduleSources, read }) => {
  const sources = new Map(Object.entries(moduleSources ?? {}));
  const pending = [...sources.keys()];
  const parsed = new Map();
  const edges = [];
  const failures = [];
  while (pending.length > 0) {
    const file = pending.shift();
    if (file === undefined || parsed.has(file)) continue;
    const source = sources.get(file);
    if (source === undefined) continue;
    const record = staticModuleRecords(file, source);
    parsed.set(file, record);
    if (file === staticTargetPaths.facade || file.startsWith(`${staticTargetRoot}/`)) {
      failures.push(...record.failures);
    }
    for (const imported of record.records) {
      const target = resolveStaticModule({
        fromFile: file,
        specifier: imported.specifier,
        sources,
        read,
      });
      edges.push({ from: file, to: target, ...imported });
      if (target !== undefined && !parsed.has(target)) pending.push(target);
      if (target === undefined && imported.specifier.startsWith(".")) {
        failures.push(`${file}: unresolved relative dependency ${imported.specifier}`);
      }
    }
  }
  return { sources, parsed, edges, failures };
};

const graphAdjacency = (graph) => {
  const adjacency = new Map();
  for (const edge of graph.edges) {
    const current = adjacency.get(edge.from) ?? [];
    current.push(edge);
    adjacency.set(edge.from, current);
  }
  return adjacency;
};

const dependencyClosure = (adjacency, entry) => {
  const visited = new Set();
  const pending = [entry];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || visited.has(current)) continue;
    visited.add(current);
    for (const edge of adjacency.get(current) ?? []) {
      if (edge.to !== undefined) pending.push(edge.to);
    }
  }
  return visited;
};

const propertySignatureName = (node) => {
  if (!ts.isPropertySignature(node)) return undefined;
  if (ts.isIdentifier(node.name) || ts.isStringLiteralLike(node.name)) return node.name.text;
  return undefined;
};

const planModelFailures = (graph) => {
  const parsed = graph.parsed.get(staticTargetPaths.model)?.sourceFile;
  if (parsed === undefined) return [`${staticTargetPaths.model}: plan model is missing`];
  const failures = [];
  for (const statement of parsed.statements) {
    const name =
      (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) &&
      statement.name !== undefined
        ? statement.name.text
        : undefined;
    if (name === undefined || !planModelTypes.has(name)) continue;
    const visit = (node) => {
      const field = propertySignatureName(node);
      if (field !== undefined && forbiddenPlanProjectionFields.has(field)) {
        failures.push(
          `${staticTargetPaths.model}: plan model contains pre-rendered field ${field} in ${name}`,
        );
      }
      ts.forEachChild(node, visit);
    };
    visit(statement);
  }
  return failures;
};

const axisReferenceIn = (root) => {
  let found = false;
  const visit = (node) => {
    if (found) return;
    if (ts.isPropertyAccessExpression(node)) {
      const name = node.name.text;
      if (name === "profile" || name === "host" || name === "client") {
        found = true;
        return;
      }
      if (
        name === "kind" &&
        ((ts.isIdentifier(node.expression) && node.expression.text === "target") ||
          (ts.isPropertyAccessExpression(node.expression) &&
            node.expression.name.text === "target"))
      ) {
        found = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
};

const rendererSecondCompilationFailures = (file, sourceFile) => {
  const failures = [];
  const wideInput =
    /\b(?:ProductIntent|ProductPlan|DeploymentIntent|StaticTargetBinding|StaticTargetPlan|StaticTargetProfileProjection|StaticTargetHostProjection|StaticTargetClientProjection)\b/u;
  const visit = (node) => {
    if (
      ts.isParameter(node) &&
      node.type !== undefined &&
      wideInput.test(node.type.getText(sourceFile))
    ) {
      failures.push(`${file}: renderer performs second compilation through a wide input`);
    }
    const condition = ts.isIfStatement(node)
      ? node.expression
      : ts.isConditionalExpression(node)
        ? node.condition
        : ts.isSwitchStatement(node)
          ? node.expression
          : undefined;
    if (condition !== undefined && axisReferenceIn(condition)) {
      failures.push(`${file}: renderer performs second compilation by reopening an axis`);
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "filter" &&
      /\btoolNames\b/u.test(node.expression.expression.getText(sourceFile))
    ) {
      failures.push(`${file}: renderer performs second compilation by reclassifying tools`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return failures;
};

const staticTargetPhysicalBoundaryFailures = ({ staticTargetModuleSources, read }) => {
  const requiredPaths = [...Object.values(staticTargetPaths), ...rendererPaths];
  const failures = [];
  for (const required of requiredPaths) {
    if (staticTargetModuleSources?.[required] === undefined) {
      failures.push(`${required}: static target role module is missing`);
    }
  }
  if (failures.length > 0) return failures;

  const graph = staticTargetModuleGraph({ moduleSources: staticTargetModuleSources, read });
  failures.push(...graph.failures);
  const adjacency = graphAdjacency(graph);

  const facade = graph.parsed.get(staticTargetPaths.facade)?.sourceFile;
  if (facade !== undefined) {
    for (const statement of facade.statements) {
      if (
        ts.isExportDeclaration(statement) &&
        (statement.exportClause === undefined || ts.isNamespaceExport(statement.exportClause))
      ) {
        failures.push(`${staticTargetPaths.facade}: facade must not use export *`);
      }
    }
  }

  failures.push(...planModelFailures(graph));

  for (const edge of graph.edges) {
    if (
      edge.from.startsWith(`${staticTargetRoot}/`) &&
      edge.from !== staticTargetPaths.compiler &&
      edge.to !== undefined &&
      authoringInputPaths.has(edge.to)
    ) {
      failures.push(`${edge.from}: only the plan compiler may import raw authoring input`);
    }
  }

  const linkerSource = graph.sources.get(staticTargetPaths.linker) ?? "";
  for (const edge of adjacency.get(staticTargetPaths.linker) ?? []) {
    if (
      edge.to === staticTargetPaths.compiler ||
      (edge.to !== undefined && authoringInputPaths.has(edge.to))
    ) {
      failures.push(`${staticTargetPaths.linker}: linker must not consume raw input`);
    }
  }
  if (
    /\b(?:ProductIntent|ProductPlan|DeploymentIntent|StaticTargetBinding)\b/u.test(linkerSource)
  ) {
    failures.push(`${staticTargetPaths.linker}: linker must not consume raw input`);
  }

  const artifactClosure = dependencyClosure(adjacency, staticTargetPaths.artifacts);
  if (
    artifactClosure.has(staticTargetPaths.compiler) ||
    [...authoringInputPaths].some((input) => artifactClosure.has(input))
  ) {
    failures.push(`${staticTargetPaths.artifacts}: artifacts must not import compiler`);
  }

  for (const renderer of rendererPaths) {
    const closure = dependencyClosure(adjacency, renderer);
    const forbidden = [...closure].find((file) => rendererForbiddenPaths.has(file));
    if (forbidden !== undefined) {
      failures.push(`${renderer}: renderer dependency reaches authoring compiler at ${forbidden}`);
    }
    for (const current of closure) {
      for (const edge of adjacency.get(current) ?? []) {
        const classifier = edge.names.find((name) => rendererClassifierImports.has(name));
        const sharedNamespace =
          edge.to === "packages/cli/src/build/agent-authoring/shared.ts" &&
          edge.names.includes("*");
        if (classifier !== undefined || sharedNamespace) {
          failures.push(
            `${renderer}: renderer performs second compilation through classifier ${classifier ?? "namespace"}`,
          );
        }
      }
    }
    const rendererFile = graph.parsed.get(renderer)?.sourceFile;
    if (rendererFile !== undefined) {
      failures.push(...rendererSecondCompilationFailures(renderer, rendererFile));
    }
  }

  return [...new Set(failures)];
};

export const createStaticTargetChecks = ({ read, readJson, failIfAny }) => {
  const sliceBetweenMarkers = (source, startMarker, endMarker) => {
    const start = source.indexOf(startMarker);
    if (start === -1) return "";
    const end = source.indexOf(endMarker, start);
    return end === -1 ? source.slice(start) : source.slice(start, end);
  };

  const checkGeneratedStaticTargetLinking = () => {
    const failures = [];
    const sourcePath = staticTargetPaths.facade;
    const workspaceAgentSourcePath = "packages/core/src/workspace-agent.ts";
    const commandProjectionSourcePath =
      "packages/cli/src/build/agent-authoring/generated-command-projection.ts";
    const staticTargetModuleSources = Object.fromEntries(
      [...Object.values(staticTargetPaths), ...rendererPaths].map((modulePath) => [
        modulePath,
        read(modulePath),
      ]),
    );
    const source = Object.entries(staticTargetModuleSources)
      .sort(([left], [right]) => compare(left, right))
      .map(([, moduleSource]) => moduleSource)
      .join("\n");
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
        staticTargetSource: staticTargetModuleSources[sourcePath],
        staticTargetModuleSources,
        entrySources,
        legacyConfigPresent,
        read,
      }),
    );
    const modelSource = staticTargetModuleSources[staticTargetPaths.model];
    const compilerSource = staticTargetModuleSources[staticTargetPaths.compiler];
    const semanticBootstrapSource = staticTargetModuleSources[staticTargetPaths.semanticBootstrap];
    const staticRuntimeBootstrapModelSource = `${modelSource}\n${compilerSource}`;
    const renderStaticRuntimeBootstrapImportsSource = sliceBetweenMarkers(
      semanticBootstrapSource,
      "const renderStaticRuntimeBootstrapImports =",
      "const renderSemanticTruthIdentity =",
    );
    const renderSemanticTruthIdentitySource = sliceBetweenMarkers(
      semanticBootstrapSource,
      "const renderSemanticTruthIdentity =",
      "const renderStaticRuntimeBootstrap =",
    );
    const renderStaticRuntimeBootstrapSource = sliceBetweenMarkers(
      semanticBootstrapSource,
      "const renderStaticRuntimeBootstrap =",
      "const renderSubmitSpecFromRunInput =",
    );
    const renderCloudflareMaterialResolverFactorySource = semanticBootstrapSource;
    const renderWorkspaceStaticTargetSource =
      staticTargetModuleSources[`${staticTargetRoot}/renderers/profile-workspace.ts`];
    const renderChatStaticTargetSource =
      staticTargetModuleSources[`${staticTargetRoot}/renderers/profile-chat.ts`];
    const renderLocalAgentAppSource =
      staticTargetModuleSources[`${staticTargetRoot}/renderers/host-local.ts`];
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
    const renderWorkspaceSvelteKitRemoteSource =
      staticTargetModuleSources[`${staticTargetRoot}/renderers/client-remote-workspace.ts`];
    const renderChatSvelteKitRemoteSource =
      staticTargetModuleSources[`${staticTargetRoot}/renderers/client-remote-chat.ts`];
    const renderSvelteKitRemoteSource = [
      renderWorkspaceSvelteKitRemoteSource,
      renderChatSvelteKitRemoteSource,
    ].join("\n");
    const hostCloudflareSource =
      staticTargetModuleSources[`${staticTargetRoot}/renderers/host-cloudflare.ts`];
    const renderCloudflareScopeHelperSource = sliceBetweenMarkers(
      hostCloudflareSource,
      "const renderCloudflareScopeHelper =",
      "const renderCloudflareWorkerEntry =",
    );
    const renderCloudflareWorkerEntrySource = sliceBetweenMarkers(
      hostCloudflareSource,
      "const renderCloudflareWorkerEntry =",
      "const renderCloudflareWranglerConfig =",
    );
    const renderCloudflareWranglerConfigSource = hostCloudflareSource;
    const renderWorkspaceStaticClientSource =
      staticTargetModuleSources[`${staticTargetRoot}/renderers/client-browser.ts`];
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
          "const staticRuntimeBootstrapFor =",
          "customToolNames: toolNames.filter",
          "manifestTools: facts.deployment.manifest.tools",
          "llmRoutes: facts.llmRoutes",
          "skills: [...product.assets.skills].sort",
          "instructionFragments: [...product.assets.instructionFragments].sort",
          "dynamicResolvers: [...product.assets.dynamicResolvers].sort",
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
      "const bootstrap = normalized.bootstrap;",
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
  staticTargetModuleSources,
  entrySources = [],
  legacyConfigPresent = false,
  read,
}) => {
  const failures = [];
  const manifestPath = "packages/cli/src/build/agent-authoring/manifest-compiler.ts";
  const deploymentPath = "packages/cli/src/build/agent-authoring/deployment-intent.ts";
  const targetPath = staticTargetPaths.facade;
  const splitSources = staticTargetModuleSources ?? {
    [targetPath]: staticTargetSource,
  };
  const split = staticTargetModuleSources !== undefined;
  const compilerPath = split ? staticTargetPaths.compiler : targetPath;
  const modelPath = split ? staticTargetPaths.model : targetPath;
  const artifactsPath = split ? staticTargetPaths.artifacts : targetPath;
  const linkerPath = split ? staticTargetPaths.linker : targetPath;
  const manifestFile = parseSource(manifestPath, manifestCompilerSource);
  const deploymentFile = parseSource(deploymentPath, deploymentIntentSource);
  const compilerFile = parseSource(compilerPath, splitSources[compilerPath] ?? "");
  const modelFile = parseSource(modelPath, splitSources[modelPath] ?? "");
  const artifactsFile = parseSource(artifactsPath, splitSources[artifactsPath] ?? "");
  const linkerFile = parseSource(linkerPath, splitSources[linkerPath] ?? "");

  if (split) {
    failures.push(
      ...staticTargetPhysicalBoundaryFailures({
        staticTargetModuleSources: splitSources,
        read,
      }),
    );
  }

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

  const productImports = namedImportNames(
    compilerFile,
    split ? "../manifest-compiler" : "./manifest-compiler",
  );
  if (!productImports.has("ProductPlan")) {
    failures.push(`${compilerPath}: binder must import ProductPlan from manifest-compiler`);
  }
  const deploymentImports = namedImportNames(
    compilerFile,
    split ? "../deployment-intent" : "./deployment-intent",
  );
  if (!deploymentImports.has("StaticTargetBinding")) {
    failures.push(`${compilerPath}: binder must import StaticTargetBinding from deployment-intent`);
  }

  const binder = exportedCallable(compilerFile, "bindStaticTargetPlan");
  if (binder === undefined) {
    failures.push(`${compilerPath}: missing exported bindStaticTargetPlan`);
  } else {
    const parameters = callableParameterContract(compilerFile, binder);
    const [product, binding] = parameters;
    if (product?.type !== "ProductPlan" || binding?.type !== "StaticTargetBinding") {
      failures.push(
        `${compilerPath}: bindStaticTargetPlan must consume ProductPlan + StaticTargetBinding`,
      );
    }
    if (normalizedTypeText(compilerFile, binder.type) !== "StaticTargetPlanResult") {
      failures.push(`${compilerPath}: bindStaticTargetPlan must return StaticTargetPlanResult`);
    }
    if (
      product?.name !== undefined &&
      binding?.name !== undefined &&
      !hasCallWithLeadingArguments(compilerFile, binder, "bindingFactsFor", [
        product.name,
        binding.name,
      ])
    ) {
      failures.push(`${compilerPath}: binder must derive binding facts from product + binding`);
    }
    if (
      product?.name !== undefined &&
      !callExpressionsNamed(binder.body, "staticTargetPlanFor").some(
        (call) => call.arguments[0]?.getText(compilerFile) === product.name,
      )
    ) {
      failures.push(`${compilerPath}: binder must close the ProductPlan into StaticTargetPlan`);
    }
  }

  const plan = namedInterface(modelFile, "StaticTargetPlan");
  if (plan === undefined || !hasExportModifier(plan)) {
    failures.push(`${modelPath}: StaticTargetPlan must be an exported closed plan`);
  } else {
    const fields = interfaceMemberNames(plan);
    for (const required of ["shared", "profile", "host", "client"]) {
      if (!fields.includes(required)) {
        failures.push(`${modelPath}: StaticTargetPlan is missing closed projection ${required}`);
      }
    }
  }

  const renderer = exportedCallable(artifactsFile, "renderStaticTargetPlan");
  if (renderer === undefined) {
    failures.push(`${artifactsPath}: missing exported renderStaticTargetPlan`);
  } else {
    const parameters = callableParameterContract(artifactsFile, renderer);
    if (parameters.length !== 1 || parameters[0]?.type !== "StaticTargetPlan") {
      failures.push(`${artifactsPath}: renderer must consume only one closed StaticTargetPlan`);
    }
    if (normalizedTypeText(artifactsFile, renderer.type) !== "StaticTargetLink") {
      failures.push(`${artifactsPath}: renderStaticTargetPlan must return StaticTargetLink`);
    }
    if (!split) {
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
          failures.push(`${artifactsPath}: closed renderer is missing projection ${required}`);
        }
      }
    }
  }

  const linker = exportedCallable(compilerFile, "linkStaticTarget");
  if (linker === undefined) {
    failures.push(`${compilerPath}: missing exported linkStaticTarget`);
  } else {
    const parameters = callableParameterContract(compilerFile, linker);
    const [product, binding] = parameters;
    if (product?.type !== "ProductPlan" || binding?.type !== "StaticTargetBinding") {
      failures.push(
        `${compilerPath}: linkStaticTarget must consume ProductPlan + StaticTargetBinding`,
      );
    }
    if (normalizedTypeText(compilerFile, linker.type) !== "StaticTargetLinkResult") {
      failures.push(`${compilerPath}: linkStaticTarget must return StaticTargetLinkResult`);
    }
    if (
      product?.name !== undefined &&
      binding?.name !== undefined &&
      !hasCallWithLeadingArguments(compilerFile, linker, "bindStaticTargetPlan", [
        product.name,
        binding.name,
      ])
    ) {
      failures.push(
        `${compilerPath}: linkStaticTarget must delegate product binding to the binder`,
      );
    }
    const finalLinkCall = split ? "linkStaticTargetPlan" : "renderStaticTargetPlan";
    if (callExpressionsNamed(linker.body, finalLinkCall).length !== 1) {
      failures.push(`${compilerPath}: linkStaticTarget must link exactly one closed plan`);
    }
  }

  if (split) {
    const closedLinker = exportedCallable(linkerFile, "linkStaticTargetPlan");
    if (closedLinker === undefined) {
      failures.push(`${linkerPath}: missing exported linkStaticTargetPlan`);
    } else {
      const parameters = callableParameterContract(linkerFile, closedLinker);
      if (parameters.length !== 1 || parameters[0]?.type !== "StaticTargetPlanResult") {
        failures.push(`${linkerPath}: linker must consume one closed StaticTargetPlanResult`);
      }
      if (normalizedTypeText(linkerFile, closedLinker.type) !== "StaticTargetLinkResult") {
        failures.push(`${linkerPath}: linker must return StaticTargetLinkResult`);
      }
      if (callExpressionsNamed(closedLinker.body, "renderStaticTargetPlan").length !== 1) {
        failures.push(`${linkerPath}: linker must render exactly one closed plan`);
      }
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
    ...Object.entries(splitSources).map(([path, source]) => ({ path, source })),
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
