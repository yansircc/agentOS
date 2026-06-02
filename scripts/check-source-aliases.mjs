import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const workspaceRoots = ["packages", "tooling"];
const sharedTsconfigPath = join(repoRoot, "tsconfig.source-paths.json");

const { agentOsSourceAliasSpecs } = await import(
  pathToFileURL(join(repoRoot, "tooling", "vitest-config", "source-aliases.ts")).href
);

const toRepoPath = (path) => relative(repoRoot, path).split(sep).join("/");

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

const sortedMap = (entries) =>
  new Map([...entries].sort(([left], [right]) => left.localeCompare(right)));

const workspacePackageJsons = () => {
  const packageJsons = [];
  const visit = (dir) => {
    const packageJson = join(dir, "package.json");
    if (existsSync(packageJson)) {
      packageJsons.push(packageJson);
      return;
    }
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === "node_modules") {
        continue;
      }
      visit(join(dir, entry.name));
    }
  };
  for (const root of workspaceRoots) {
    visit(join(repoRoot, root));
  }
  return packageJsons.sort((left, right) => left.localeCompare(right));
};

const workspaceTsconfigs = () =>
  workspacePackageJsons()
    .map((packageJsonPath) => join(dirname(packageJsonPath), "tsconfig.json"))
    .filter((path) => existsSync(path));

const resolveExportTarget = (value) => {
  if (typeof value === "string") {
    return value;
  }
  if (value === null || typeof value !== "object") {
    return undefined;
  }
  return (
    resolveExportTarget(value.default) ??
    resolveExportTarget(value.import) ??
    resolveExportTarget(value.types)
  );
};

const exportEntries = (packageDir, packageJson) => {
  if (!packageJson.name?.startsWith("@agent-os/")) {
    return [];
  }
  const exportsValue = packageJson.exports ?? packageJson.main ?? "./src/index.ts";
  if (typeof exportsValue === "string") {
    return [[packageJson.name, toRepoPath(join(packageDir, exportsValue))]];
  }
  if (exportsValue === null || typeof exportsValue !== "object") {
    return [];
  }
  return Object.entries(exportsValue)
    .flatMap(([exportPath, exportTarget]) => {
      const target = resolveExportTarget(exportTarget);
      if (target === undefined) {
        return [];
      }
      const specifier =
        exportPath === "."
          ? packageJson.name
          : `${packageJson.name}/${exportPath.replace(/^\.\//, "")}`;
      return [[specifier, toRepoPath(join(packageDir, target))]];
    })
    .sort(([left], [right]) => left.localeCompare(right));
};

const expectedAliasSpecs = () => {
  const specs = new Map();
  for (const packageJsonPath of workspacePackageJsons()) {
    const packageDir = dirname(packageJsonPath);
    const packageJson = readJson(packageJsonPath);
    for (const [specifier, sourcePath] of exportEntries(packageDir, packageJson)) {
      specs.set(specifier, sourcePath.replace(/^\.\//, ""));
    }
  }
  return sortedMap(specs);
};

const actualAliasSpecs = () => sortedMap(agentOsSourceAliasSpecs);

const findVitestConfigs = () => {
  const configs = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules" && path !== join(repoRoot, "tooling", "vitest-config")) {
          visit(path);
        }
        continue;
      }
      if (/^vitest(?:\.cloudflare)?\.config\.ts$/.test(entry.name)) {
        configs.push(path);
      }
    }
  };
  for (const root of workspaceRoots) {
    visit(join(repoRoot, root));
  }
  return configs.sort((left, right) => left.localeCompare(right));
};

const manualAliasPatterns = [/"@agent-os\/[^"]+"\s*:/g, /find:\s*"@agent-os\/[^"]+"/g];

const manualVitestAliasFindings = () => {
  const findings = [];
  for (const configPath of findVitestConfigs()) {
    const source = readFileSync(configPath, "utf8");
    for (const pattern of manualAliasPatterns) {
      for (const match of source.matchAll(pattern)) {
        const prefix = source.slice(0, match.index);
        const line = prefix.split("\n").length;
        findings.push(`${toRepoPath(configPath)}:${line}: ${match[0]}`);
      }
    }
  }
  return findings;
};

const expectedTsconfigPaths = (aliasSpecs) =>
  Object.fromEntries(
    [...aliasSpecs.entries()].map(([specifier, sourcePath]) => [specifier, [`./${sourcePath}`]]),
  );

const sharedTsconfigFindings = (aliasSpecs) => {
  const findings = [];
  if (!existsSync(sharedTsconfigPath)) {
    return ["missing tsconfig.source-paths.json"];
  }
  const tsconfig = readJson(sharedTsconfigPath);
  if (tsconfig.compilerOptions?.baseUrl !== undefined) {
    findings.push("tsconfig.source-paths.json must not set compilerOptions.baseUrl");
  }
  const expectedPaths = expectedTsconfigPaths(aliasSpecs);
  const actualPaths = tsconfig.compilerOptions?.paths ?? {};
  for (const [specifier, sourcePaths] of Object.entries(expectedPaths)) {
    if (JSON.stringify(actualPaths[specifier]) !== JSON.stringify(sourcePaths)) {
      findings.push(
        `tsconfig.source-paths.json paths.${specifier}: expected ${JSON.stringify(
          sourcePaths,
        )}; actual ${JSON.stringify(actualPaths[specifier])}`,
      );
    }
  }
  for (const specifier of Object.keys(actualPaths)) {
    if (!aliasSpecs.has(specifier)) {
      findings.push(`tsconfig.source-paths.json has extra path ${specifier}`);
    }
  }
  return findings;
};

const workspaceTsconfigFindings = () => {
  const findings = [];
  for (const tsconfigPath of workspaceTsconfigs()) {
    const tsconfig = readJson(tsconfigPath);
    const expectedExtends = relative(dirname(tsconfigPath), sharedTsconfigPath)
      .split(sep)
      .join("/");
    if (tsconfig.extends !== expectedExtends) {
      findings.push(
        `${toRepoPath(tsconfigPath)}: expected extends ${JSON.stringify(expectedExtends)}; actual ${JSON.stringify(
          tsconfig.extends,
        )}`,
      );
    }
    const localAgentOsPaths = Object.keys(tsconfig.compilerOptions?.paths ?? {}).filter(
      (specifier) => specifier.startsWith("@agent-os/"),
    );
    if (localAgentOsPaths.length > 0) {
      findings.push(
        `${toRepoPath(tsconfigPath)} has package-local @agent-os paths: ${localAgentOsPaths.join(", ")}`,
      );
    }
  }
  return findings;
};

const formatMap = (map) =>
  [...map.entries()].map(([specifier, sourcePath]) => `${specifier} -> ${sourcePath}`).join("\n");

const expected = expectedAliasSpecs();
const actual = actualAliasSpecs();
const missing = [...expected.entries()].filter(([specifier]) => !actual.has(specifier));
const extra = [...actual.entries()].filter(([specifier]) => !expected.has(specifier));
const mismatched = [...expected.entries()].filter(
  ([specifier, sourcePath]) =>
    actual.get(specifier) !== undefined && actual.get(specifier) !== sourcePath,
);
const manualVitestAliases = manualVitestAliasFindings();
const sharedTsconfigIssues = sharedTsconfigFindings(actual);
const workspaceTsconfigIssues = workspaceTsconfigFindings();

if (
  missing.length > 0 ||
  extra.length > 0 ||
  mismatched.length > 0 ||
  manualVitestAliases.length > 0 ||
  sharedTsconfigIssues.length > 0 ||
  workspaceTsconfigIssues.length > 0
) {
  if (missing.length > 0) {
    console.error("Missing source aliases:");
    console.error(formatMap(new Map(missing)));
  }
  if (extra.length > 0) {
    console.error("Extra source aliases:");
    console.error(formatMap(new Map(extra)));
  }
  if (mismatched.length > 0) {
    console.error("Mismatched source aliases:");
    for (const [specifier, expectedPath] of mismatched) {
      console.error(
        `${String(specifier)}: expected ${String(expectedPath)}; actual ${String(actual.get(specifier))}`,
      );
    }
  }
  if (manualVitestAliases.length > 0) {
    console.error("Manual @agent-os source aliases in Vitest configs:");
    console.error(manualVitestAliases.join("\n"));
  }
  if (sharedTsconfigIssues.length > 0) {
    console.error("Shared tsconfig source paths issues:");
    console.error(sharedTsconfigIssues.join("\n"));
  }
  if (workspaceTsconfigIssues.length > 0) {
    console.error("Workspace tsconfig source path ownership issues:");
    console.error(workspaceTsconfigIssues.join("\n"));
  }
  process.exit(1);
}

console.log(
  `checked ${actual.size} source aliases, ${findVitestConfigs().length} Vitest configs, and ${workspaceTsconfigs().length} workspace tsconfigs`,
);
