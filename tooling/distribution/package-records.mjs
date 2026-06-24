import fs from "node:fs";
import path from "node:path";
import {
  fail,
  packageUnitOptionalPeers,
  readJson,
  releaseVersion,
  repoPath,
  repoRoot,
  stagingRoot,
  surface,
} from "./support.mjs";
import {
  workspaceCatalog,
  workspacePackagePaths,
} from "../../packages/cli/src/lib/workspace-manifest.mjs";

export const catalog = () => workspaceCatalog(repoRoot);

export const workspacePackageJsons = () =>
  workspacePackagePaths(repoRoot)
    .map((packagePath) => path.join(repoRoot, packagePath, "package.json"))
    .sort((left, right) => left.localeCompare(right));

export const sourceRecords = () => {
  const surfaceByPath = new Map(surface().packages.map((pkg) => [pkg.path, pkg]));
  return workspacePackageJsons().map((packageJsonPath) => {
    const packageDir = path.dirname(packageJsonPath);
    const packagePath = repoPath(packageDir);
    const packageJson = readJson(packageJsonPath);
    const declaration = surfaceByPath.get(packagePath);
    if (declaration === undefined) {
      fail(`${packagePath} is missing from docs/surface.json`);
    }
    return {
      declaration,
      packageDir,
      packageJsonPath,
      packagePath,
      packageJson,
      stageDir: path.join(stagingRoot, declaration.slug),
    };
  });
};

export const publishedRecords = () =>
  sourceRecords().filter((record) => record.declaration.published === true);

export const sourceFiles = (record) => {
  const srcDir = path.join(record.packageDir, "src");
  const files = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(target);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
        files.push(target);
      }
    }
  };
  visit(srcDir);
  return files.sort((left, right) => left.localeCompare(right));
};

export const sourceMjsFiles = (record) => {
  const srcDir = path.join(record.packageDir, "src");
  const files = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(target);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".mjs")) {
        files.push(target);
      }
    }
  };
  visit(srcDir);
  return files.sort((left, right) => left.localeCompare(right));
};

export const isBinTsTarget = (target) => target.startsWith("./bin/") && target.endsWith(".ts");
export const isBinMjsTarget = (target) => target.startsWith("./bin/") && target.endsWith(".mjs");
export const isSourceTsExportTarget = (target) =>
  target.startsWith("./src/") && target.endsWith(".ts");
export const isSourceMjsTarget = (target) => target.startsWith("./src/") && target.endsWith(".mjs");
export const isPackageBinSourceTarget = (target) =>
  isBinTsTarget(target) ||
  isBinMjsTarget(target) ||
  isSourceTsExportTarget(target) ||
  isSourceMjsTarget(target);

export const packageBinTargets = (record) => {
  const bin = record.packageJson.bin;
  if (bin === undefined) return [];
  if (typeof bin === "string") return [bin];
  if (bin === null || typeof bin !== "object" || Array.isArray(bin)) {
    fail(`${record.packagePath}: package bin must be a string or record`);
  }
  return Object.values(bin).map((target) => {
    if (typeof target !== "string") {
      fail(`${record.packagePath}: package bin targets must be strings`);
    }
    return target;
  });
};

export const binSourceFiles = (record) =>
  [
    ...new Set(
      packageBinTargets(record)
        .filter(isPackageBinSourceTarget)
        .map((target) => path.join(record.packageDir, target.slice("./".length))),
    ),
  ].sort((left, right) => left.localeCompare(right));

export const packageImportsEffect = (record) =>
  sourceFiles(record).some((file) =>
    /\bfrom\s+["']effect["']|\bimport\s*\(\s*["']effect["']\s*\)/.test(
      fs.readFileSync(file, "utf8"),
    ),
  );

const privateSourcePackageIssue = (record) =>
  record.packageJson.private === true
    ? undefined
    : `${record.packagePath}: source package must stay private`;

export const assertSurface = () => {
  const records = sourceRecords();
  const packagePaths = new Set(records.map((record) => record.packagePath));
  const surfacePackages = surface().packages;
  const issues = [];
  for (const pkg of surfacePackages) {
    if (typeof pkg.published !== "boolean") {
      issues.push(`${pkg.path}: docs/surface.json published must be true or false`);
    }
    if (!packagePaths.has(pkg.path)) {
      issues.push(`${pkg.path}: docs/surface.json package has no workspace package.json`);
    }
    const shouldPublish = pkg.path.startsWith("packages/");
    if (pkg.published !== shouldPublish) {
      issues.push(`${pkg.path}: expected published=${shouldPublish}`);
    }
  }
  for (const record of records) {
    if (!surfacePackages.some((pkg) => pkg.path === record.packagePath)) {
      issues.push(`${record.packagePath}: workspace package missing from docs/surface.json`);
    }
  }
  if (issues.length > 0) fail(issues.join("\n"));
};

export const assertSourceManifests = () => {
  const version = releaseVersion();
  const rootCatalog = catalog();
  const issues = [];
  for (const record of publishedRecords()) {
    const pkg = record.packageJson;
    const unitOptionalPeers = packageUnitOptionalPeers(record);
    const privateIssue = privateSourcePackageIssue(record);
    if (privateIssue !== undefined) issues.push(privateIssue);
    if (pkg.version !== version) {
      issues.push(`${record.packagePath}: expected version ${version}; actual ${pkg.version}`);
    }
    if (packageImportsEffect(record) && pkg.peerDependencies?.effect !== "catalog:") {
      issues.push(`${record.packagePath}: package imports effect and must peer depend on catalog:`);
    }
    for (const peerName of unitOptionalPeers) {
      if (rootCatalog[peerName] === undefined) {
        issues.push(`${record.packagePath}: missing catalog value for ${String(peerName)}`);
      }
      if (pkg.peerDependencies?.[peerName] !== "catalog:") {
        issues.push(`${record.packagePath}: optional peer ${String(peerName)} must use catalog:`);
      }
      if (pkg.peerDependenciesMeta?.[peerName]?.optional !== true) {
        issues.push(
          `${record.packagePath}: optional peer ${String(peerName)} must be marked optional`,
        );
      }
    }
    for (const peerName of Object.keys(pkg.peerDependencies ?? {})) {
      if (peerName === "effect") continue;
      if (!unitOptionalPeers.has(peerName)) {
        issues.push(
          `${record.packagePath}: peer ${peerName} must be declared by architecture/package-units.json optionalPeers`,
        );
      }
    }
  }
  if (issues.length > 0) fail(issues.join("\n"));
};

export const sourcePublishGuards = () => {
  const issues = publishedRecords()
    .map(privateSourcePackageIssue)
    .filter((issue) => issue !== undefined);
  if (issues.length > 0) fail(issues.join("\n"));
};
