import fs from "node:fs";
import path from "node:path";

import { parse as parseYaml } from "yaml";

const compare = (left, right) => left.localeCompare(right);
const readJsonFile = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

const workspaceManifestPath = (repoRoot) => path.join(repoRoot, "pnpm-workspace.yaml");

const requireRecord = (value, label) => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
};

export const readWorkspaceManifest = (repoRoot) => {
  const file = workspaceManifestPath(repoRoot);
  if (!fs.existsSync(file)) {
    throw new Error("pnpm-workspace.yaml is the workspace manifest SSOT and must exist");
  }
  const manifest = requireRecord(parseYaml(fs.readFileSync(file, "utf8")), "pnpm-workspace.yaml");
  return manifest;
};

export const workspacePackagePatterns = (repoRoot) => {
  const packages = readWorkspaceManifest(repoRoot).packages;
  if (!Array.isArray(packages)) {
    throw new Error("pnpm-workspace.yaml packages must be an array");
  }
  return packages.filter((entry) => typeof entry === "string").sort(compare);
};

export const workspaceCatalog = (repoRoot) => {
  const catalog = readWorkspaceManifest(repoRoot).catalog;
  if (catalog === undefined) return {};
  return requireRecord(catalog, "pnpm-workspace.yaml catalog");
};

export const workspaceOverrides = (repoRoot) => {
  const overrides = readWorkspaceManifest(repoRoot).overrides;
  if (overrides === undefined) return {};
  return requireRecord(overrides, "pnpm-workspace.yaml overrides");
};

export const workspacePackagePaths = (repoRoot) => {
  const paths = new Set();
  for (const workspace of workspacePackagePatterns(repoRoot)) {
    if (workspace.endsWith("/*")) {
      const base = workspace.slice(0, -2);
      const baseDir = path.join(repoRoot, base);
      if (!fs.existsSync(baseDir)) continue;
      for (const entry of fs.readdirSync(baseDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const packagePath = `${base}/${entry.name}`;
        if (fs.existsSync(path.join(repoRoot, packagePath, "package.json"))) {
          paths.add(packagePath);
        }
      }
      continue;
    }

    if (fs.existsSync(path.join(repoRoot, workspace, "package.json"))) {
      paths.add(workspace);
    }
  }
  return [...paths].sort(compare);
};

export const workspacePackageRecords = (repoRoot) =>
  workspacePackagePaths(repoRoot)
    .map((packagePath) => ({
      name: readJsonFile(path.join(repoRoot, packagePath, "package.json")).name,
      path: packagePath,
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
