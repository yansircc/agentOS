import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const workspaceRoots = ["packages", "tooling"];
const helperPath = join(repoRoot, "tooling", "vitest-config", "source-aliases.ts");

const toRepoPath = (path) => relative(repoRoot, path).split(sep).join("/");

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

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
  return specs;
};

const actualAliasSpecs = () => {
  const helperSource = readFileSync(helperPath, "utf8");
  const specStart = helperSource.indexOf("export const agentOsSourceAliasSpecs = [");
  const specEnd = helperSource.indexOf("] as const", specStart);
  if (specStart === -1 || specEnd === -1) {
    throw new Error(
      "Could not find agentOsSourceAliasSpecs in tooling/vitest-config/source-aliases.ts",
    );
  }
  const specSource = helperSource.slice(specStart, specEnd);
  const specs = new Map();
  const specPattern = /\[\s*"([^"]+)"\s*,\s*"([^"]+)"\s*,?\s*\]/g;
  for (const match of specSource.matchAll(specPattern)) {
    specs.set(match[1], match[2]);
  }
  return specs;
};

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

const manualAliasFindings = () => {
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
const manualAliases = manualAliasFindings();

if (missing.length > 0 || extra.length > 0 || mismatched.length > 0 || manualAliases.length > 0) {
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
      console.error(`${specifier}: expected ${expectedPath}; actual ${actual.get(specifier)}`);
    }
  }
  if (manualAliases.length > 0) {
    console.error("Manual @agent-os source aliases in Vitest configs:");
    console.error(manualAliases.join("\n"));
  }
  process.exit(1);
}

console.log(
  `checked ${actual.size} workspace source aliases and ${findVitestConfigs().length} Vitest configs`,
);
