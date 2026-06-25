import ts from "typescript";

const runtimeSurfaceClassValues = [
  "stable-contract",
  "first-party-host-substrate",
  "generated-target-wiring",
  "app-owned-integration-recipe",
];
const runtimeSurfaceClasses = new Set(runtimeSurfaceClassValues);
const runtimeSubstrateClasses = new Set(["stable-contract", "first-party-host-substrate"]);
const runtimeFirstPartyHostPrefixes = ["./cloudflare", "./in-memory", "./local", "./node"];
const runtimeExtensionCategoryTokens = {
  channel: ["channel", "slack", "discord", "teams", "telegram", "email", "webhook", "sms"],
  sandbox: ["sandbox", "e2b", "container", "browser", "vm"],
  database: [
    "database",
    "db",
    "postgres",
    "postgresql",
    "mysql",
    "sqlite",
    "d1",
    "sql",
    "neon",
    "prisma",
    "drizzle",
  ],
  provider: ["provider", "llm", "ai", "openai", "anthropic", "gemini", "mistral", "cohere"],
  observability: [
    "observability",
    "telemetry",
    "otlp",
    "trace",
    "tracing",
    "metrics",
    "sentry",
    "langfuse",
    "log",
    "logging",
  ],
};

const isPlainRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const runtimeSurfaceLabel = (subpath) =>
  `@agent-os/runtime${subpath === "." ? "" : subpath.slice(1)}`;

const runtimeExportSubpaths = (runtimePackageJson) =>
  isPlainRecord(runtimePackageJson?.exports)
    ? Object.keys(runtimePackageJson.exports)
        .filter((subpath) => subpath !== "./package.json")
        .sort((left, right) => left.localeCompare(right))
    : [];

const publicApiSections = ["Public exports", "Experimental exports", "Deprecated exports"];

const markdownSectionBody = (source, heading) => {
  const start = source.indexOf(`## ${heading}`);
  if (start === -1) return "";
  const bodyStart = start + heading.length + 3;
  const rest = source.slice(bodyStart);
  const next = rest.search(/^## /mu);
  return next === -1 ? rest : rest.slice(0, next);
};

const runtimeApiSymbolsForSubpath = (source, subpath) =>
  new Set(
    publicApiSections
      .flatMap((section) => [
        ...markdownSectionBody(source, section).matchAll(/`([^`:]+):([^`]+)`/gu),
      ])
      .filter((match) => match[1] === subpath)
      .map((match) => match[2]),
  );

const exportedDeclarationNames = (statement) => {
  if (ts.isExportAssignment(statement)) {
    return [statement.isExportEquals === true ? "export=" : "default"];
  }
  if (
    statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) !== true
  ) {
    return [];
  }
  if (statement.modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)) {
    return ["default"];
  }
  if (
    ts.isInterfaceDeclaration(statement) ||
    ts.isTypeAliasDeclaration(statement) ||
    ts.isClassDeclaration(statement) ||
    ts.isFunctionDeclaration(statement) ||
    ts.isEnumDeclaration(statement)
  ) {
    return statement.name === undefined ? [] : [statement.name.text];
  }
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations
      .map((declaration) =>
        ts.isIdentifier(declaration.name) ? declaration.name.text : undefined,
      )
      .filter((name) => name !== undefined);
  }
  return [];
};

const explicitPublicBarrelSymbols = ({ source, file }) => {
  const findings = [];
  const names = new Set();
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

  for (const statement of sourceFile.statements) {
    if (ts.isExportDeclaration(statement)) {
      if (statement.exportClause === undefined || ts.isNamespaceExport(statement.exportClause)) {
        const { line, character } = sourceFile.getLineAndCharacterOfPosition(
          statement.getStart(sourceFile),
        );
        findings.push(
          `${file}:${line + 1}:${character + 1}: runtime cloudflare public barrel must use explicit named exports; export-star syntax is forbidden`,
        );
        continue;
      }

      for (const element of statement.exportClause.elements) {
        names.add(element.name.text);
      }
      continue;
    }

    for (const name of exportedDeclarationNames(statement)) names.add(name);
  }

  return { findings, names };
};

const cloudflarePublicBarrelFindings = ({
  runtimeApiMarkdown,
  cloudflarePublicBarrelSource,
  cloudflarePublicBarrelPath,
}) => {
  if (typeof runtimeApiMarkdown !== "string" || typeof cloudflarePublicBarrelSource !== "string") {
    return [];
  }

  const docsSymbols = runtimeApiSymbolsForSubpath(runtimeApiMarkdown, "./cloudflare");
  const barrel = explicitPublicBarrelSymbols({
    source: cloudflarePublicBarrelSource,
    file: cloudflarePublicBarrelPath,
  });
  const findings = [...barrel.findings];

  for (const symbol of [...barrel.names].sort((left, right) => left.localeCompare(right))) {
    if (!docsSymbols.has(symbol)) {
      findings.push(
        `${cloudflarePublicBarrelPath}: exports ./cloudflare:${symbol}, but docs/api/runtime.md does not declare it`,
      );
    }
  }
  for (const symbol of [...docsSymbols].sort((left, right) => left.localeCompare(right))) {
    if (!barrel.names.has(symbol)) {
      findings.push(
        `docs/api/runtime.md: declares ./cloudflare:${symbol}, but ${cloudflarePublicBarrelPath} does not export it`,
      );
    }
  }

  return findings;
};

const isFirstPartyRuntimeHostSubpath = (subpath) =>
  runtimeFirstPartyHostPrefixes.some(
    (prefix) => subpath === prefix || subpath.startsWith(`${prefix}/`),
  );

const runtimeExtensionCategoriesForSubpath = (subpath) => {
  if (subpath === ".") return [];
  const tokens = new Set(
    subpath
      .toLowerCase()
      .split(/[^a-z0-9]+/u)
      .filter(Boolean),
  );
  return Object.entries(runtimeExtensionCategoryTokens)
    .filter(([, categoryTokens]) => categoryTokens.some((token) => tokens.has(token)))
    .map(([category]) => category);
};

export const runtimePublicSurfaceFindings = ({
  surfacePackage,
  runtimePackageJson,
  runtimeApiMarkdown,
  cloudflarePublicBarrelSource,
  cloudflarePublicBarrelPath = "packages/runtime/src/cloudflare/index.ts",
}) => {
  const findings = [];
  if (!isPlainRecord(surfacePackage)) {
    return ["docs/surface.json: @agent-os/runtime package is missing"];
  }
  if (!isPlainRecord(runtimePackageJson?.exports)) {
    return ["packages/runtime/package.json: exports must be an object"];
  }

  const exportSubpaths = runtimeExportSubpaths(runtimePackageJson);
  const exportSubpathSet = new Set(exportSubpaths);
  const entrypoints = Array.isArray(surfacePackage.entrypoints) ? surfacePackage.entrypoints : [];
  const entrypointsBySubpath = new Map();
  for (const entrypoint of entrypoints) {
    if (!isPlainRecord(entrypoint) || typeof entrypoint.subpath !== "string") continue;
    entrypointsBySubpath.set(entrypoint.subpath, entrypoint);
  }

  for (const subpath of exportSubpaths) {
    if (!entrypointsBySubpath.has(subpath)) {
      findings.push(
        `${runtimeSurfaceLabel(subpath)}: runtime package export is missing docs/surface.json entrypoint`,
      );
    }
  }

  for (const entrypoint of entrypoints) {
    if (!isPlainRecord(entrypoint)) {
      findings.push("@agent-os/runtime: docs/surface.json runtime entrypoint must be an object");
      continue;
    }
    const subpath = entrypoint.subpath;
    if (typeof subpath !== "string") {
      findings.push("@agent-os/runtime: docs/surface.json runtime entrypoint missing subpath");
      continue;
    }
    const label = runtimeSurfaceLabel(subpath);
    if (!exportSubpathSet.has(subpath)) {
      findings.push(`${label}: docs/surface.json entrypoint has no package.json export`);
    }

    const surfaceClass = entrypoint.surfaceClass;
    if (typeof surfaceClass !== "string" || !runtimeSurfaceClasses.has(surfaceClass)) {
      findings.push(
        `${label}: runtime surfaceClass must be one of ${runtimeSurfaceClassValues.join(", ")}`,
      );
      continue;
    }
    if (surfaceClass === "app-owned-integration-recipe") {
      findings.push(
        `${label}: runtime public export cannot be classified app-owned-integration-recipe; keep app-owned integrations in blueprint recipes`,
      );
    }
    if (surfaceClass === "first-party-host-substrate" && !isFirstPartyRuntimeHostSubpath(subpath)) {
      findings.push(
        `${label}: first-party-host-substrate is only valid for ${runtimeFirstPartyHostPrefixes.join(", ")} runtime subpaths`,
      );
    }
    if (
      surfaceClass === "generated-target-wiring" &&
      !entrypoint.audiences?.includes("generated-only")
    ) {
      findings.push(`${label}: generated-target-wiring requires generated-only audience`);
    }

    const extensionCategories = runtimeExtensionCategoriesForSubpath(subpath);
    if (extensionCategories.length > 0 && !runtimeSubstrateClasses.has(surfaceClass)) {
      findings.push(
        `${label}: ${extensionCategories.join("/")} integration-shaped runtime export must be classified as stable substrate, not ${surfaceClass}`,
      );
    }
  }

  findings.push(
    ...cloudflarePublicBarrelFindings({
      runtimeApiMarkdown,
      cloudflarePublicBarrelSource,
      cloudflarePublicBarrelPath,
    }),
  );

  return findings.sort((left, right) => left.localeCompare(right));
};

const blueprintRecipeSchemaVersion = 1;
const blueprintRecipeKinds = ["channel", "sandbox", "database", "provider", "observability"];
const blueprintRecipeKindSet = new Set(blueprintRecipeKinds);
const blueprintRecipeActions = ["agentos add", "agentos update"];
const blueprintRecipePrimaryFiles = new Set([
  "agentos.config.jsonc",
  "agent/agent.json",
  "package.json",
]);
const blueprintRecipeGuidePath = "blueprints/UPGRADE.md";
const blueprintRecipeIdPattern =
  /^(channel|sandbox|database|provider|observability)\.[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const blueprintPrimaryFileMarkerPattern = /<!--\s*agentos:primary-file\s+path="([^"]+)"\s*-->/gu;
const blueprintUpgradeMarkerPattern = /<!--\s*agentos:blueprint-upgrade\s+id="([^"]+)"\s*-->/gu;
const blueprintForbiddenTokens = [
  "target--node",
  "createLocalWorkspaceEnv",
  "createLocalAgentRuntime",
  "packages/runtime",
  "@agent-os/runtime/",
  "@yansirplus/runtime/",
  ".dev.vars",
];

const blueprintRecipeLabel = (source) => source.file ?? "blueprint recipe";

const parseBlueprintRecipe = (source, findings) => {
  const label = blueprintRecipeLabel(source);
  const match = /^---json\n([\s\S]*?)\n---\n?([\s\S]*)$/u.exec(source.content);
  if (match === null) {
    findings.push(
      `${label}: blueprint recipe must start with JSON frontmatter delimited by ---json and ---`,
    );
    return undefined;
  }
  let frontmatter;
  try {
    frontmatter = JSON.parse(match[1]);
  } catch (error) {
    findings.push(`${label}: JSON frontmatter is invalid: ${error.message}`);
    return undefined;
  }
  if (!isPlainRecord(frontmatter)) {
    findings.push(`${label}: JSON frontmatter must be an object`);
    return undefined;
  }
  return { file: source.file, frontmatter, body: match[2] };
};

const collectMarkerValues = (content, pattern) => {
  const values = [];
  for (const match of content.matchAll(pattern)) values.push(match[1]);
  return values;
};

const requiredBlueprintActionSet = new Set(blueprintRecipeActions);

const validateBlueprintRecipe = (recipe, findings) => {
  const { file, frontmatter, body } = recipe;
  const id = frontmatter.id;
  const kind = frontmatter.kind;
  const title = frontmatter.title;
  const summary = frontmatter.summary;
  const primaryFile = frontmatter.primaryFile;
  const appliesTo = frontmatter.appliesTo;
  const upgradeGuide = frontmatter.upgradeGuide;
  const label = file;

  if (frontmatter.schemaVersion !== blueprintRecipeSchemaVersion) {
    findings.push(`${label}: schemaVersion must be ${blueprintRecipeSchemaVersion}`);
  }
  if (typeof id !== "string" || !blueprintRecipeIdPattern.test(id)) {
    findings.push(`${label}: id must be <kind>.<slug> for ${blueprintRecipeKinds.join(", ")}`);
  }
  if (typeof kind !== "string" || !blueprintRecipeKindSet.has(kind)) {
    findings.push(`${label}: kind must be one of ${blueprintRecipeKinds.join(", ")}`);
  }
  if (typeof id === "string" && typeof kind === "string" && id.split(".")[0] !== kind) {
    findings.push(`${label}: id prefix must match kind`);
  }
  if (typeof title !== "string" || title.trim().length === 0) {
    findings.push(`${label}: title must be a non-empty string`);
  }
  if (typeof summary !== "string" || summary.trim().length === 0) {
    findings.push(`${label}: summary must be a non-empty string`);
  }
  if (typeof primaryFile !== "string" || !blueprintRecipePrimaryFiles.has(primaryFile)) {
    findings.push(
      `${label}: primaryFile must be one of ${[...blueprintRecipePrimaryFiles].join(", ")}`,
    );
  }
  if (
    !Array.isArray(appliesTo) ||
    appliesTo.length !== requiredBlueprintActionSet.size ||
    new Set(appliesTo).size !== requiredBlueprintActionSet.size ||
    appliesTo.some((action) => !requiredBlueprintActionSet.has(action))
  ) {
    findings.push(`${label}: appliesTo must be exactly ${blueprintRecipeActions.join(", ")}`);
  }
  if (upgradeGuide !== blueprintRecipeGuidePath) {
    findings.push(`${label}: upgradeGuide must be ${blueprintRecipeGuidePath}`);
  }
  if (typeof id === "string" && blueprintRecipeIdPattern.test(id)) {
    const [idKind, slug] = id.split(".");
    const expectedPath = `blueprints/recipes/${idKind}/${slug}.md`;
    if (file !== expectedPath) findings.push(`${label}: recipe path must be ${expectedPath}`);
  }

  if (typeof title === "string" && !body.includes(`# ${title}`)) {
    findings.push(`${label}: body must contain # ${title}`);
  }
  for (const heading of ["## Boundary", "## Steps", "## Upgrade Guide"]) {
    if (!body.includes(heading)) findings.push(`${label}: body must contain ${heading}`);
  }

  const primaryMarkers = collectMarkerValues(body, blueprintPrimaryFileMarkerPattern);
  if (primaryMarkers.length !== 1) {
    findings.push(`${label}: body must contain exactly one agentos:primary-file marker`);
  } else if (primaryMarkers[0] !== primaryFile) {
    findings.push(`${label}: primary-file marker must match frontmatter.primaryFile`);
  }

  for (const token of blueprintForbiddenTokens) {
    if (body.includes(token))
      findings.push(`${label}: blueprint recipe must not reference ${token}`);
  }
};

export const blueprintRecipeFindingsForSources = ({ recipeSources, upgradeGuideContent }) => {
  const findings = [];
  if (!Array.isArray(recipeSources) || recipeSources.length === 0) {
    findings.push("blueprints/recipes: at least one blueprint recipe is required");
    return findings;
  }
  if (typeof upgradeGuideContent !== "string") {
    findings.push(`${blueprintRecipeGuidePath}: upgrade guide is missing`);
    return findings;
  }

  const recipes = [];
  for (const source of recipeSources) {
    if (
      !isPlainRecord(source) ||
      typeof source.file !== "string" ||
      typeof source.content !== "string"
    ) {
      findings.push("blueprint recipe source must include file and content");
      continue;
    }
    const recipe = parseBlueprintRecipe(source, findings);
    if (recipe !== undefined) recipes.push(recipe);
  }

  /** @type {Set<string>} */
  const recipeIds = new Set();
  for (const recipe of recipes) {
    validateBlueprintRecipe(recipe, findings);
    const id = recipe.frontmatter.id;
    if (typeof id !== "string") continue;
    if (recipeIds.has(id)) findings.push(`${recipe.file}: duplicate blueprint recipe id ${id}`);
    recipeIds.add(id);
  }

  const guideIds = collectMarkerValues(upgradeGuideContent, blueprintUpgradeMarkerPattern);
  const guideIdCounts = new Map();
  for (const id of guideIds) guideIdCounts.set(id, (guideIdCounts.get(id) ?? 0) + 1);
  for (const [id, count] of guideIdCounts) {
    if (count !== 1) findings.push(`${blueprintRecipeGuidePath}: duplicate upgrade marker ${id}`);
    if (!recipeIds.has(id))
      findings.push(`${blueprintRecipeGuidePath}: unknown upgrade marker ${id}`);
  }
  for (const id of recipeIds) {
    if (!guideIdCounts.has(id)) {
      findings.push(`${blueprintRecipeGuidePath}: missing upgrade marker ${id}`);
    }
  }

  return findings.sort((left, right) => left.localeCompare(right));
};

export const createConvergenceSmokeChecks = ({
  fs,
  os,
  path,
  execFileSync,
  repoRoot,
  read,
  readJson,
  walk,
  isRecord,
  failIfAny,
  manifestNames,
  checkPublicApi,
  checkClientBoundaries,
  clientSectionBody,
  checkGeneratedStaticTargetLinking,
  checkSpikeHygiene,
  moduleBucketRegistry,
  workspacePackagePatterns,
  workspacePackageRecords,
  consumerFacingSpecifierFailures,
  packageUnitPublicSpecifiers,
  packageUnitPublicSpecifierForSource,
  packageUnitRecords,
  packageUnitSourceNames,
  packageUnitsRegistry,
  distributionRootsRegistry,
  selectedSourceSpecifiersForProfileUnit,
  runProfileTypecheck,
  obsoletePublicPackageFailures,
  packageUnitOptionalPeerFindings,
  specifierMatchesPackage,
  projectionFoldBoundaryFailures,
}) => {
  const checkConvergenceBoundary = () => {
    checkClientBoundaries();
    checkGeneratedStaticTargetLinking();
    checkBlueprintRecipes();
    checkSpikeHygiene();
    console.log("convergence boundary passed");
  };

  const checkBlueprintRecipes = () => {
    const recipeRoot = "blueprints/recipes";
    const recipeFiles = walk(recipeRoot).filter((file) => file.endsWith(".md"));
    const upgradeGuidePath = path.join(repoRoot, blueprintRecipeGuidePath);
    const failures = blueprintRecipeFindingsForSources({
      recipeSources: recipeFiles.map((file) => ({ file, content: read(file) })),
      upgradeGuideContent: fs.existsSync(upgradeGuidePath)
        ? read(blueprintRecipeGuidePath)
        : undefined,
    });
    failIfAny("blueprint recipes", failures);
    console.log(`blueprint recipes covered ${recipeFiles.length} recipe(s)`);
  };

  const publicExportNames = (apiSource) =>
    new Set([
      ...manifestNames(path.join(repoRoot, apiSource), "Public exports"),
      ...manifestNames(path.join(repoRoot, apiSource), "Experimental exports"),
      ...manifestNames(path.join(repoRoot, apiSource), "Deprecated exports"),
    ]);

  const publicSurfaceSweepManifest = () =>
    readJson("packages/cli/src/check/sources/public-surface-sweep.source.json");

  const packagePublicSymbols = (pkg) => {
    if (typeof pkg.apiSource !== "string") return new Set();
    return publicExportNames(pkg.apiSource);
  };

  const packageExportsSymbol = (exports, symbolName) =>
    [...exports].some((entry) => String(entry).endsWith(`:${symbolName}`));

  const checkConvergencePublicSurface = () => {
    checkPublicApi();
    checkClientBoundaries();

    const manifest = publicSurfaceSweepManifest();
    const failures = [];
    if (manifest.schemaVersion !== 1) {
      failures.push("public surface sweep manifest schemaVersion must be 1");
    }
    if (manifest.deprecatedExports?.policy !== "forbidden") {
      failures.push("deprecatedExports policy must be forbidden");
    }

    const surfacePackages = readJson("docs/surface.json").packages ?? [];
    const surfaceByName = new Map(surfacePackages.map((pkg) => [pkg.name, pkg]));
    failures.push(
      ...runtimePublicSurfaceFindings({
        surfacePackage: surfaceByName.get("@agent-os/runtime"),
        runtimePackageJson: readJson("packages/runtime/package.json"),
        runtimeApiMarkdown: read("docs/api/runtime.md"),
        cloudflarePublicBarrelSource: read("packages/runtime/src/cloudflare/index.ts"),
      }),
    );
    const retiredPackages = new Set(manifest.retiredPackages ?? []);
    for (const record of workspacePackageRecords()) {
      if (retiredPackages.has(record.name)) {
        failures.push(`${record.name}: retired package remains in workspace`);
      }
    }
    for (const pkg of surfacePackages) {
      if (retiredPackages.has(pkg.name)) {
        failures.push(`${pkg.name}: retired package remains in docs/surface.json`);
      }
    }

    let deprecatedSectionCount = 0;
    for (const pkg of surfacePackages) {
      if (!isRecord(pkg) || typeof pkg.apiSource !== "string") continue;
      const source = read(pkg.apiSource);
      const body = clientSectionBody(source, "Deprecated exports").trim();
      if (body.length > 0) {
        deprecatedSectionCount += 1;
        if (body !== "None.") failures.push(`${pkg.apiSource}: deprecated exports must be None.`);
      }
    }

    const moduleBucketIds = new Set(moduleBucketRegistry().buckets.map((bucket) => bucket.id));
    for (const retained of manifest.retainedProjectionVocabulary ?? []) {
      if (!isRecord(retained)) {
        failures.push("retainedProjectionVocabulary entries must be objects");
        continue;
      }
      if (
        typeof retained.moduleBucket !== "string" ||
        !moduleBucketIds.has(retained.moduleBucket)
      ) {
        failures.push(
          `${retained.export}: retained projection vocabulary has invalid moduleBucket`,
        );
      }
      if (typeof retained.reason !== "string" || retained.reason.length === 0) {
        failures.push(`${retained.export}: retained projection vocabulary requires reason`);
      }
      const [packageName, symbolName] =
        typeof retained.export === "string" ? retained.export.split(":") : [];
      const pkg = surfaceByName.get(packageName);
      if (pkg === undefined || symbolName === undefined) {
        failures.push(
          `${retained.export}: retained projection vocabulary must name package:symbol`,
        );
        continue;
      }
      if (!packageExportsSymbol(packagePublicSymbols(pkg), symbolName)) {
        failures.push(
          `${retained.export}: retained projection vocabulary is not publicly exported`,
        );
      }
    }
    failures.push(...consumerFacingSpecifierFailures());

    failIfAny("convergence public surface", failures);
    console.log(
      `convergence public surface covered ${surfacePackages.length} package surfaces and ${deprecatedSectionCount} deprecated-export sections`,
    );
  };

  const checkDocsSiteBuild = () => {
    const contentRoot = path.join(repoRoot, "tooling/docs-site/src/content/docs");
    const distRoot = path.join(repoRoot, "tooling/docs-site/dist");
    const pages = walk("tooling/docs-site/src/content/docs").filter((file) => file.endsWith(".md"));
    const failures = [];
    if (pages.length === 0) failures.push("docs-site projected content is empty");
    for (const file of pages) {
      const contentRel = path
        .relative(contentRoot, path.join(repoRoot, file))
        .split(path.sep)
        .join("/");
      const route =
        contentRel === "index.md" ? "index.html" : contentRel.replace(/\.md$/u, "/index.html");
      if (!fs.existsSync(path.join(distRoot, route)))
        failures.push(`${file} did not build tooling/docs-site/dist/${route}`);
    }
    const builtPages = walk("tooling/docs-site/dist").filter((file) => file.endsWith(".html"));
    if (builtPages.length <= 1)
      failures.push(`docs-site build emitted ${builtPages.length} HTML page(s)`);
    failIfAny("docs site build", failures);
  };

  const checkCliSurface = () => {
    const failures = [];
    const rootPackage = readJson("package.json");
    const workspacePatterns = workspacePackagePatterns();
    const records = workspacePackageRecords();
    const packageNames = new Set(records.map((record) => record.name));
    const surfacePackages = readJson("docs/surface.json").packages ?? [];
    const surfaceByName = new Map(surfacePackages.map((pkg) => [pkg.name, pkg]));
    const sourceAliases = readJson("tsconfig.source-paths.json").compilerOptions?.paths ?? {};
    const oldPackageNames = ["@agent-os/agentos-cli", "@agent-os/ops-api", "@agent-os/ops-htmx"];
    const oldPackagePaths = [
      "tooling/agentos-cli/package.json",
      "tooling/ops-api/package.json",
      "tooling/ops-htmx/package.json",
    ];

    if (!workspacePatterns.includes("packages/cli")) {
      failures.push("pnpm-workspace.yaml: packages must include packages/cli");
    }
    if (rootPackage.scripts?.agentos !== "node packages/cli/src/main.mjs") {
      failures.push("package.json: scripts.agentos must execute packages/cli/src/main.mjs");
    }

    const cliPackage = readJson("packages/cli/package.json");
    if (cliPackage.name !== "@agent-os/cli") {
      failures.push("packages/cli/package.json: name must be @agent-os/cli");
    }
    if (cliPackage.bin?.agentos !== "./src/main.mjs") {
      failures.push("packages/cli/package.json: bin.agentos must be ./src/main.mjs");
    }
    if (!packageNames.has("@agent-os/cli")) {
      failures.push("@agent-os/cli: workspace package is missing");
    }

    for (const oldName of oldPackageNames) {
      if (packageNames.has(oldName)) failures.push(`${oldName}: old workspace package remains`);
      if (surfaceByName.has(oldName)) failures.push(`${oldName}: old docs/surface package remains`);
    }
    for (const oldPath of oldPackagePaths) {
      if (fs.existsSync(path.join(repoRoot, oldPath))) {
        failures.push(`${oldPath}: old tooling package manifest remains`);
      }
    }
    for (const specifier of Object.keys(sourceAliases)) {
      if (oldPackageNames.some((oldName) => specifierMatchesPackage(specifier, oldName))) {
        failures.push(`${specifier}: old source alias remains`);
      }
    }

    const cliSurface = surfaceByName.get("@agent-os/cli");
    if (cliSurface === undefined) {
      failures.push("docs/surface.json: @agent-os/cli package is missing");
    } else {
      if (cliSurface.path !== "packages/cli") {
        failures.push("docs/surface.json: @agent-os/cli path must be packages/cli");
      }
      if (cliSurface.published !== true) {
        failures.push("docs/surface.json: @agent-os/cli must be published");
      }
    }

    const cliUnits = (packageUnitsRegistry().packageUnits ?? []).filter(
      (unit) => isRecord(unit) && unit.id === "cli",
    );
    if (cliUnits.length !== 1) {
      failures.push(
        `architecture/package-units.json: expected one cli package unit, got ${cliUnits.length}`,
      );
    } else {
      const cliUnit = cliUnits[0];
      if (cliUnit.targetSourcePackageName !== "@agent-os/cli") {
        failures.push("architecture/package-units.json: cli source package must be @agent-os/cli");
      }
      if (cliUnit.publicPackageName !== "@yansirplus/cli") {
        failures.push(
          "architecture/package-units.json: cli public package must be @yansirplus/cli",
        );
      }
    }

    const roots = distributionRootsRegistry();
    const publicCliRoot = (roots.roots ?? []).find(
      (root) => isRecord(root) && root.packageUnit === "cli",
    );
    if (publicCliRoot?.publicPackageName !== "@yansirplus/cli") {
      failures.push(
        "architecture/distribution-roots.json: public-cli root must publish @yansirplus/cli",
      );
    }
    const nodeProfile = (roots.targetProfiles ?? []).find(
      (profile) => isRecord(profile) && profile.id === "node",
    );
    if (!Array.isArray(nodeProfile?.packageUnits) || !nodeProfile.packageUnits.includes("cli")) {
      failures.push("architecture/distribution-roots.json: node profile must include cli");
    }
    if (
      !Array.isArray(nodeProfile?.selectedSubpaths) ||
      !nodeProfile.selectedSubpaths.includes("@yansirplus/cli")
    ) {
      failures.push(
        "architecture/distribution-roots.json: node profile must select @yansirplus/cli",
      );
    }

    const runtimePackage = readJson("packages/runtime/package.json");
    if (runtimePackage.exports?.["./cloudflare/ops-api"] === undefined) {
      failures.push("packages/runtime/package.json: missing ./cloudflare/ops-api export");
    }
    if (!fs.existsSync(path.join(repoRoot, "packages/runtime/src/cloudflare/ops-api/index.ts"))) {
      failures.push(
        "packages/runtime/src/cloudflare/ops-api/index.ts: absorbed ops API is missing",
      );
    }

    failIfAny("cli surface", failures);
  };

  const stringLiteralCallRecords = ({ file, callee }) => {
    const source = read(file);
    const sourceFile = ts.createSourceFile(
      file,
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
    const records = [];
    const visit = (node) => {
      if (
        ts.isCallExpression(node) &&
        callName(node.expression) === callee &&
        node.arguments.length > 0 &&
        ts.isStringLiteralLike(node.arguments[0])
      ) {
        const position = sourceFile.getLineAndCharacterOfPosition(
          node.arguments[0].getStart(sourceFile),
        );
        records.push({
          value: node.arguments[0].text,
          line: position.line + 1,
          column: position.character + 1,
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return records;
  };

  const consumerImportFailures = () => {
    const failures = [];
    const allowedPublicSpecifiers = packageUnitPublicSpecifiers();
    const distributionTool = "tooling/distribution/distribution.mjs";

    for (const record of stringLiteralCallRecords({
      file: distributionTool,
      callee: "publicSpecifier",
    })) {
      const sourceSpecifier = record.value;
      const publicSpecifier = sourceSpecifier.startsWith("@agent-os/")
        ? packageUnitPublicSpecifierForSource(sourceSpecifier)
        : sourceSpecifier;
      if (publicSpecifier === undefined) {
        failures.push(
          `${distributionTool}:${record.line}:${record.column}: ${sourceSpecifier} does not map to a final public package/subpath`,
        );
        continue;
      }
      if (
        publicSpecifier.startsWith("@yansirplus/") &&
        !allowedPublicSpecifiers.has(publicSpecifier)
      ) {
        failures.push(
          `${distributionTool}:${record.line}:${record.column}: ${publicSpecifier} is not in the final public package/subpath set`,
        );
      }
    }

    return failures.sort(compare);
  };

  const checkConsumerImports = (args = []) => {
    if (args.length !== 1 || args[0] !== "--final-public-set") {
      throw new Error("consumer-imports: expected --final-public-set");
    }
    failIfAny("consumer imports", consumerImportFailures());
  };

  const checkDogfoodSmoke = (args = []) => {
    if (args.length !== 2 || args[0] !== "--batch") {
      throw new Error("dogfood-smoke: expected --batch <batch>");
    }
    const batch = args[1];
    if (
      batch !== "core" &&
      batch !== "runtime" &&
      batch !== "client" &&
      batch !== "cli" &&
      batch !== "projection" &&
      batch !== "package-collapse" &&
      batch !== "final-consumer"
    ) {
      throw new Error(`dogfood-smoke: unsupported batch ${batch}`);
    }

    const failures = [];
    const records = workspacePackageRecords();
    const packageNames = new Set(records.map((record) => record.name));
    const unitNames = packageUnitSourceNames();
    const retiredNames =
      batch === "package-collapse"
        ? records
            .map((record) => record.name)
            .filter(
              (name) =>
                typeof name === "string" &&
                name.startsWith("@agent-os/") &&
                !unitNames.has(name) &&
                name !== "@agent-os/docs-site",
            )
        : batch === "core"
          ? [
              "@agent-os/kernel",
              "@agent-os/runtime-protocol",
              "@agent-os/llm-protocol",
              "@agent-os/telemetry-protocol",
              "@agent-os/backend-protocol",
            ]
          : batch === "runtime"
            ? [
                "@agent-os/backend-cloudflare-do",
                "@agent-os/backend-in-memory",
                "@agent-os/backend-node-postgres",
                "@agent-os/llm-transport-effect-ai",
                "@agent-os/telemetry-otlp",
              ]
            : batch === "client"
              ? ["@agent-os/client-react", "@agent-os/client-svelte"]
              : batch === "cli"
                ? ["@agent-os/agentos-cli", "@agent-os/ops-api", "@agent-os/ops-htmx"]
                : [];
    for (const retiredName of retiredNames) {
      if (packageNames.has(retiredName)) {
        failures.push(`${retiredName}: retired ${batch} package remains in workspace`);
      }
    }
    if (!packageNames.has("@agent-os/core")) {
      failures.push("@agent-os/core: core package is missing from workspace");
    }
    if (batch === "runtime" && !packageNames.has("@agent-os/runtime")) {
      failures.push("@agent-os/runtime: runtime package is missing from workspace");
    }
    if (batch === "client" && !packageNames.has("@agent-os/client")) {
      failures.push("@agent-os/client: client package is missing from workspace");
    }
    if (batch === "cli" && !packageNames.has("@agent-os/cli")) {
      failures.push("@agent-os/cli: cli package is missing from workspace");
    }
    if (batch === "package-collapse") {
      for (const unitName of unitNames) {
        if (!packageNames.has(unitName)) {
          failures.push(`${String(unitName)}: final package unit is missing from workspace`);
        }
      }
      failures.push(...obsoletePublicPackageFailures());
      failures.push(...packageUnitOptionalPeerFindings());
    }

    const sourceAliases = readJson("tsconfig.source-paths.json").compilerOptions?.paths ?? {};
    for (const specifier of Object.keys(sourceAliases)) {
      if (retiredNames.some((name) => specifier === name || specifier.startsWith(`${name}/`))) {
        failures.push(`${specifier}: retired ${batch} source alias remains`);
      }
    }

    const surfaceNames = new Set(
      (readJson("docs/surface.json").packages ?? []).map((pkg) => pkg.name),
    );
    for (const retiredName of retiredNames) {
      if (surfaceNames.has(retiredName)) {
        failures.push(`${retiredName}: retired ${batch} package remains in docs/surface.json`);
      }
    }

    if (batch === "runtime" && failures.length === 0) {
      const runtimeUnit = (packageUnitsRegistry().packageUnits ?? []).find(
        (unit) => isRecord(unit) && unit.id === "runtime",
      );
      if (runtimeUnit === undefined) {
        failures.push("runtime dogfood: package unit runtime is missing");
      } else {
        for (const profile of distributionRootsRegistry().targetProfiles ?? []) {
          if (!isRecord(profile) || !(profile.packageUnits ?? []).includes("runtime")) continue;
          const sourceSpecifiers = selectedSourceSpecifiersForProfileUnit({
            profile,
            unit: runtimeUnit,
          });
          if (sourceSpecifiers.length === 0) {
            failures.push(`${profile.id}: runtime dogfood selects no runtime subpath`);
            continue;
          }
          failures.push(
            ...runProfileTypecheck({
              batch: "runtime-dogfood",
              profile,
              sourceSpecifiers,
            }),
          );
        }
      }
    }

    if (batch === "client" && failures.length === 0) {
      const clientUnit = (packageUnitsRegistry().packageUnits ?? []).find(
        (unit) => isRecord(unit) && unit.id === "client",
      );
      if (clientUnit === undefined) {
        failures.push("client dogfood: package unit client is missing");
      } else {
        for (const profile of distributionRootsRegistry().targetProfiles ?? []) {
          if (!isRecord(profile) || !(profile.packageUnits ?? []).includes("client")) continue;
          const sourceSpecifiers = selectedSourceSpecifiersForProfileUnit({
            profile,
            unit: clientUnit,
          });
          if (sourceSpecifiers.length === 0) {
            failures.push(`${profile.id}: client dogfood selects no client subpath`);
            continue;
          }
          failures.push(
            ...runProfileTypecheck({
              batch: "client-dogfood",
              profile,
              sourceSpecifiers,
            }),
          );
        }
      }
    }

    if (batch === "cli" && failures.length === 0) {
      const cliUnit = (packageUnitsRegistry().packageUnits ?? []).find(
        (unit) => isRecord(unit) && unit.id === "cli",
      );
      if (cliUnit === undefined) {
        failures.push("cli dogfood: package unit cli is missing");
      }
      try {
        const output = execFileSync("node", ["packages/cli/src/main.mjs", "--version"], {
          cwd: repoRoot,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        }).trim();
        if (output !== readJson("package.json").agentOsRelease?.version) {
          failures.push(`cli dogfood: --version returned ${output}`);
        }
      } catch (error) {
        failures.push(
          `cli dogfood command failed: ${error.stderr?.toString() || error.message || error}`,
        );
      }
    }

    if (batch === "projection" && failures.length === 0) {
      failures.push(...projectionFoldBoundaryFailures());
      failures.push(
        ...runProfileTypecheck({
          batch: "projection-dogfood",
          profile: { id: "projection", ambient: "neutral" },
          sourceSpecifiers: ["@agent-os/runtime/run-projector", "@agent-os/client"],
        }),
      );
    }

    if (batch === "final-consumer" && failures.length === 0) {
      failures.push(...consumerImportFailures());
      const packageUnitsById = new Map(packageUnitRecords().map((unit) => [unit.id, unit]));
      for (const profile of distributionRootsRegistry().targetProfiles ?? []) {
        if (!isRecord(profile)) continue;
        const sourceSpecifiers = [];
        for (const unitId of profile.packageUnits ?? []) {
          const unit = packageUnitsById.get(unitId);
          if (unit === undefined) {
            failures.push(
              `${profile.id}: target profile references missing package unit ${unitId}`,
            );
            continue;
          }
          sourceSpecifiers.push(...selectedSourceSpecifiersForProfileUnit({ profile, unit }));
        }
        if (sourceSpecifiers.length === 0) {
          failures.push(`${profile.id}: final consumer profile selects no public subpaths`);
          continue;
        }
        failures.push(
          ...runProfileTypecheck({
            batch: "final-consumer-dogfood",
            profile,
            sourceSpecifiers,
          }),
        );
      }
    }

    if (batch === "core" && failures.length === 0) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentos-core-dogfood-"));
      const scopeDir = path.join(dir, "node_modules", "@agent-os");
      fs.mkdirSync(scopeDir, { recursive: true });
      fs.symlinkSync(path.join(repoRoot, "packages", "core"), path.join(scopeDir, "core"));
      fs.symlinkSync(
        path.join(repoRoot, "node_modules", "effect"),
        path.join(dir, "node_modules", "effect"),
      );
      fs.writeFileSync(path.join(dir, "package.json"), '{"type":"module"}\n');
      const code = [
        'import { ABORT } from "@agent-os/core";',
        'import { defineAgentBindings } from "@agent-os/core/runtime-protocol";',
        'import { LLM_WIRE_DESCRIPTOR_VERSION } from "@agent-os/core/llm-protocol";',
        'import { TRACE_CONTEXT_VERSION } from "@agent-os/core/telemetry-protocol";',
        'import { DISPATCH_INBOUND_ACCEPTED } from "@agent-os/core/backend-protocol";',
        "const bindings = defineAgentBindings({ handlers: {} });",
        "if (!ABORT || !bindings || !LLM_WIRE_DESCRIPTOR_VERSION || !TRACE_CONTEXT_VERSION || !DISPATCH_INBOUND_ACCEPTED) throw new Error('missing core import');",
      ].join("\n");
      const entryPath = path.join(dir, "entry.ts");
      const outFile = path.join(dir, "entry.mjs");
      fs.writeFileSync(entryPath, code);
      try {
        execFileSync(
          "pnpm",
          [
            "exec",
            "esbuild",
            entryPath,
            "--bundle",
            "--platform=node",
            "--format=esm",
            `--outfile=${outFile}`,
          ],
          {
            cwd: repoRoot,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        execFileSync(process.execPath, [outFile], {
          cwd: dir,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (error) {
        failures.push(
          `core dogfood import failed: ${error.stderr?.toString() || error.message || error}`,
        );
      }
    }

    failIfAny(`dogfood smoke ${batch}`, failures);
  };

  return {
    checkConvergenceBoundary,
    checkConvergencePublicSurface,
    checkDocsSiteBuild,
    checkCliSurface,
    checkConsumerImports,
    checkDogfoodSmoke,
    checkBlueprintRecipes,
  };
};
