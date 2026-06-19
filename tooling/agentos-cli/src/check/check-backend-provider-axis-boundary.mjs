#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const ignoredDirs = new Set(["node_modules", "dist", ".wrangler", ".turbo", ".git"]);
const sourceExtensions = /\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/u;
const forbiddenPackage = /^@agent-os\/llm-transport-/u;
const forbiddenProviderPath = /^packages\/providers\/llm-transport-[^/]+(?:\/|$)/u;

const toRepoPath = (file) => path.relative(repoRoot, file).split(path.sep).join("/");

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

const importSpecifiers = (source) => {
  const specifiers = [];
  const patterns = [
    /\b(?:import|export)\s+(?:type\s+)?(?:[^"'()]*?\s+from\s+)?["']([^"']+)["']/gu,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/gu,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      specifiers.push({ value: match[1], index: match.index ?? 0 });
    }
  }
  return specifiers;
};

const lineNumber = (source, index) => source.slice(0, index).split("\n").length;

const productionBackendPackages = () => {
  const rootManifest = readJson(path.join(repoRoot, "package.json"));
  const packages = rootManifest.agentos?.backendNeutrality?.productionBackendPackages;
  if (!Array.isArray(packages) || packages.length === 0) {
    throw new Error(
      "package.json agentos.backendNeutrality.productionBackendPackages must declare production backend packages",
    );
  }
  return packages;
};

const packageManifestDependencyFailures = (packageDir) => {
  const manifestPath = path.join(repoRoot, packageDir, "package.json");
  const manifest = readJson(manifestPath);
  const dependencyFields = [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ];
  const failures = [];
  for (const field of dependencyFields) {
    for (const name of Object.keys(manifest[field] ?? {})) {
      if (forbiddenPackage.test(name)) {
        failures.push(`${packageDir}/package.json: ${field}.${name} is a provider-axis edge`);
      }
    }
  }
  return failures;
};

const sourceFiles = (packageDir) => {
  const files = [];
  const visit = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!ignoredDirs.has(entry.name)) visit(file);
        continue;
      }
      if (sourceExtensions.test(entry.name) && !entry.name.endsWith(".d.ts")) {
        files.push(file);
      }
    }
  };
  visit(path.join(repoRoot, packageDir));
  return files.sort((left, right) => left.localeCompare(right));
};

const resolvedRelativeImportRepoPath = (fromFile, specifier) => {
  if (!specifier.startsWith(".")) return null;
  const resolved = path.resolve(path.dirname(fromFile), specifier);
  return toRepoPath(resolved);
};

const importFailures = (packageDir) => {
  const failures = [];
  for (const file of sourceFiles(packageDir)) {
    const source = fs.readFileSync(file, "utf8");
    for (const specifier of importSpecifiers(source)) {
      const relativeTarget = resolvedRelativeImportRepoPath(file, specifier.value);
      if (forbiddenPackage.test(specifier.value)) {
        failures.push(
          `${toRepoPath(file)}:${lineNumber(source, specifier.index)}: forbidden provider-axis import ${specifier.value}`,
        );
      }
      if (relativeTarget !== null && forbiddenProviderPath.test(relativeTarget)) {
        failures.push(
          `${toRepoPath(file)}:${lineNumber(source, specifier.index)}: forbidden relative provider-axis import ${specifier.value}`,
        );
      }
    }
  }
  return failures;
};

const failures = productionBackendPackages().flatMap((packageDir) => [
  ...packageManifestDependencyFailures(packageDir),
  ...importFailures(packageDir),
]);

if (failures.length > 0) {
  console.error("Backend/LLM provider axis boundary failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("Backend/LLM provider axis boundary passed.");
