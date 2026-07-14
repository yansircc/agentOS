#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { workspacePackagePaths } from "../lib/workspace-manifest.mjs";

const root = process.cwd();
const check = process.argv.includes("--check");
const sourcePath = path.join(root, "docs/effect-skill.json");
const source = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
const failures = [];
const pendingWrites = [];
const packageManifests =
  typeof source.packageManifests === "object" && source.packageManifests !== null
    ? source.packageManifests
    : null;

const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const normalizeManifestPath = (itemPath) => path.posix.normalize(itemPath);
const packagePathItemFields = ["executableEdges", "allowedAdapters", "aiProviderTransports"];
const packageDescriptorPolicies = [
  { field: "shape", required: true, projection: "value" },
  { field: "effectMajorPolicy", required: false, projection: "value" },
  { field: "wranglerPath", required: false, projection: "package-path" },
];
const packageDescriptorFields = packageDescriptorPolicies.map(({ field }) => field);
const projectedPackageManifestFields = new Set([
  ...packagePathItemFields,
  ...packageDescriptorFields,
]);
const packageDefaultFields = new Set([
  "shape",
  "dependencyOwner",
  "dependencyOwnerReason",
  "effectMajorPolicy",
  "wranglerPath",
]);
const packageOverrideFields = new Set([...packageDefaultFields, "scan", "scanExclusionReason"]);
const rootProjectionFields = new Set([
  "packageDefaults",
  "packageOverrides",
  ...packagePathItemFields,
  "generatedPaths",
  "hostTooling",
  "testGlobs",
  "gate",
  "suppression",
]);
const workspacePaths = workspacePackagePaths(root).map(String);
const workspacePathSet = new Set(workspacePaths);

if (packageManifests === null) {
  failures.push("docs/effect-skill.json missing packageManifests object");
} else {
  const normalizedOwners = new Map();
  for (const packagePath of Object.keys(packageManifests)) {
    const normalizedPath = path.posix.normalize(packagePath);
    if (packagePath !== normalizedPath || !workspacePathSet.has(packagePath)) {
      failures.push(
        `docs/effect-skill.json.packageManifests.${packagePath} must exactly equal a canonical workspace package path`,
      );
    }
    const previousOwner = normalizedOwners.get(normalizedPath);
    if (previousOwner !== undefined) {
      failures.push(
        `docs/effect-skill.json.packageManifests.${packagePath} duplicates canonical package owner ${previousOwner}`,
      );
    } else {
      normalizedOwners.set(normalizedPath, packagePath);
    }
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

const formatterPrintWidth = 100;

const stableJson = (value) =>
  `${JSON.stringify(value, null, 2).replace(
    /\[\n((?:\s+"(?:\\.|[^"\\])*",?\n)+)\s+\]/gu,
    (match, body, offset, source) => {
      const items = body
        .trim()
        .split("\n")
        .map((line) => line.trim().replace(/,$/u, ""));
      if (!items.every((item) => item.startsWith('"') && item.endsWith('"'))) return match;
      const compact = `[${items.join(", ")}]`;
      const lineStart = source.lastIndexOf("\n", offset) + 1;
      const column = offset - lineStart;
      return column + compact.length <= formatterPrintWidth ? compact : match;
    },
  )}\n`;

const writeJson = (file, value) => {
  const target = path.join(root, file);
  const expected = stableJson(value);
  if (check) {
    const actual = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "";
    if (actual !== expected) failures.push(`${file} is stale`);
    return;
  }
  pendingWrites.push({ target, expected });
};

const validateKnownFields = ({ label, value, allowed }) => {
  if (!isRecord(value)) {
    failures.push(`${label} must be an object`);
    return;
  }
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) failures.push(`${label}.${field} has no declared projection`);
  }
};

const isExistingFile = (target) => {
  try {
    return fs.statSync(path.join(root, target)).isFile();
  } catch {
    return false;
  }
};

const relativeManifestPath = (itemPath) => {
  const normalizedPath = normalizeManifestPath(itemPath);
  if (
    path.posix.isAbsolute(itemPath) ||
    normalizedPath === ".." ||
    normalizedPath.startsWith("../")
  ) {
    return { error: "escape", normalizedPath };
  }
  if (itemPath.includes("\\") || itemPath !== normalizedPath) {
    return { error: "non-canonical", normalizedPath };
  }
  return { error: null, normalizedPath };
};

const validatePathItems = ({ label, field, items, basePath, boundary }) => {
  if (items === undefined) return;
  if (!Array.isArray(items)) {
    failures.push(`${label}.${field} must be an array`);
    return;
  }
  const seenPaths = new Set();
  for (const [index, item] of items.entries()) {
    const itemLabel = `${label}.${field}[${index}]`;
    if (!isRecord(item) || typeof item.path !== "string" || item.path.length === 0) {
      failures.push(`${itemLabel}.path must be a non-empty string`);
      continue;
    }
    const pathResult = relativeManifestPath(item.path);
    if (pathResult.error === "escape") {
      failures.push(`${itemLabel}.path escapes ${boundary}`);
      continue;
    }
    if (pathResult.error === "non-canonical") {
      failures.push(`${itemLabel}.path must be canonical POSIX path ${pathResult.normalizedPath}`);
      continue;
    }
    const { normalizedPath } = pathResult;
    if (seenPaths.has(normalizedPath)) {
      failures.push(`${itemLabel}.path duplicates ${item.path}`);
      continue;
    }
    seenPaths.add(normalizedPath);
    const target = path.posix.join(basePath, normalizedPath);
    if (!isExistingFile(target)) {
      failures.push(`${itemLabel}.path references missing or non-file target ${target}`);
    }
  }
};

const isPathInside = (file, directory) => file === directory || file.startsWith(`${directory}/`);

const rebasePackageItemPath = (packagePath, itemPath) => {
  const pathResult = relativeManifestPath(itemPath);
  if (pathResult.error !== null) return null;
  return path.posix.join(packagePath, pathResult.normalizedPath);
};

const packagePathItems = (manifests, field) =>
  Object.entries(manifests).flatMap(([packagePath, manifest]) => {
    const items = isRecord(manifest) ? manifest[field] : undefined;
    if (!Array.isArray(items)) return [];
    return items.flatMap((item) => {
      if (!isRecord(item) || typeof item.path !== "string" || item.path.length === 0) {
        return [];
      }
      const rebasedPath = rebasePackageItemPath(packagePath, item.path);
      return rebasedPath === null ? [] : [{ ...item, path: rebasedPath }];
    });
  });

const validateRootPathItemOwnership = (field, items, declaredPackagePaths) => {
  if (!Array.isArray(items)) return;
  for (const [index, item] of items.entries()) {
    if (!isRecord(item) || typeof item.path !== "string") continue;
    const normalizedPath = normalizeManifestPath(item.path);
    const packagePath = declaredPackagePaths.find((candidate) =>
      isPathInside(normalizedPath, candidate),
    );
    if (packagePath !== undefined) {
      failures.push(
        `docs/effect-skill.json.root.${field}[${index}].path duplicates package ownership under ${packagePath}`,
      );
    }
  }
};

const validateUniqueProjectedPaths = (field, items) => {
  const owners = new Map();
  for (const [index, item] of items.entries()) {
    if (!isRecord(item) || typeof item.path !== "string") continue;
    const normalizedPath = normalizeManifestPath(item.path);
    const previous = owners.get(normalizedPath);
    if (previous !== undefined) {
      failures.push(`generated root ${field}[${index}].path duplicates ${previous}`);
    } else {
      owners.set(normalizedPath, `${field}[${index}].path ${item.path}`);
    }
  }
};

const packageWranglerPath = (packagePath, manifest) => {
  if (!isRecord(manifest) || manifest.wranglerPath === undefined) return null;
  const label = `docs/effect-skill.json.packageManifests.${packagePath}.wranglerPath`;
  if (typeof manifest.wranglerPath !== "string" || manifest.wranglerPath.length === 0) {
    failures.push(`${label} must be a non-empty string`);
    return null;
  }
  const pathResult = relativeManifestPath(manifest.wranglerPath);
  if (pathResult.error === "escape") {
    failures.push(`${label} escapes package ${packagePath}`);
    return null;
  }
  if (pathResult.error === "non-canonical") {
    failures.push(`${label} must be canonical POSIX path ${pathResult.normalizedPath}`);
    return null;
  }
  const { normalizedPath } = pathResult;
  const target = path.posix.join(packagePath, normalizedPath);
  if (!isExistingFile(target)) {
    failures.push(`${label} references missing or non-file target ${target}`);
  }
  return normalizedPath;
};

const validatePackageManifestProjection = (packagePath, manifest) => {
  const label = `docs/effect-skill.json.packageManifests.${packagePath}`;
  validateKnownFields({ label, value: manifest, allowed: projectedPackageManifestFields });
  if (!isRecord(manifest)) return;
  for (const { field, required } of packageDescriptorPolicies) {
    if (required && !Object.hasOwn(manifest, field)) {
      failures.push(`${label}.${field} is required for package and root projections`);
    }
  }
};

const packageDescriptor = (packagePath, manifest) => {
  if (!isRecord(manifest)) return {};
  const descriptor = {};
  for (const { field, projection } of packageDescriptorPolicies) {
    if (!Object.hasOwn(manifest, field)) continue;
    if (projection === "package-path") {
      const projectedPath = packageWranglerPath(packagePath, manifest);
      if (projectedPath !== null) descriptor[field] = projectedPath;
    } else {
      descriptor[field] = manifest[field];
    }
  }
  return descriptor;
};

const scannerPackagesFromWorkspaces = (rootSource, manifests) => {
  if (Object.hasOwn(rootSource, "packages")) {
    failures.push("docs/effect-skill.json root.packages duplicates package ownership");
  }

  const packageDefaults = isRecord(rootSource.packageDefaults) ? rootSource.packageDefaults : {};
  const packageOverrides = isRecord(rootSource.packageOverrides) ? rootSource.packageOverrides : {};
  if (rootSource.packageDefaults !== undefined) {
    validateKnownFields({
      label: "docs/effect-skill.json.root.packageDefaults",
      value: rootSource.packageDefaults,
      allowed: packageDefaultFields,
    });
  }
  if (rootSource.packageOverrides !== undefined) {
    validateKnownFields({
      label: "docs/effect-skill.json.root.packageOverrides",
      value: rootSource.packageOverrides,
      allowed: new Set(workspacePaths),
    });
  }
  if (Object.hasOwn(packageDefaults, "wranglerPath")) {
    failures.push(
      "docs/effect-skill.json.root.packageDefaults.wranglerPath duplicates package manifest ownership",
    );
  }
  for (const packagePath of Object.keys(packageOverrides)) {
    if (!workspacePathSet.has(packagePath)) {
      failures.push(`${packagePath} has an effect scanner override but is not a workspace package`);
    }
    validateKnownFields({
      label: `docs/effect-skill.json.root.packageOverrides.${packagePath}`,
      value: packageOverrides[packagePath],
      allowed: packageOverrideFields,
    });
  }

  return workspacePaths
    .map((packagePath) => {
      const packagePathText = String(packagePath);
      const override = isRecord(packageOverrides[packagePath]) ? packageOverrides[packagePath] : {};
      const manifest = manifests[packagePathText];
      if (Object.hasOwn(override, "wranglerPath")) {
        failures.push(
          `docs/effect-skill.json.root.packageOverrides.${packagePathText}.wranglerPath duplicates package manifest ownership`,
        );
      }
      for (const { field } of packageDescriptorPolicies) {
        if (isRecord(manifest) && Object.hasOwn(override, field)) {
          failures.push(
            `docs/effect-skill.json.root.packageOverrides.${packagePathText}.${field} duplicates package manifest ownership`,
          );
        }
      }
      if (override.scan === false) {
        if (
          typeof override.scanExclusionReason !== "string" ||
          override.scanExclusionReason.trim().length === 0
        ) {
          failures.push(`${packagePathText} scan:false requires scanExclusionReason`);
        }
        return null;
      }
      const {
        scan: _scan,
        scanExclusionReason: _scanExclusionReason,
        wranglerPath: _rootWranglerPath,
        ...scannerOverride
      } = override;
      const { wranglerPath: _defaultWranglerPath, ...scannerDefaults } = packageDefaults;
      if (isRecord(manifest)) {
        for (const { field } of packageDescriptorPolicies) {
          if (!Object.hasOwn(manifest, field)) delete scannerDefaults[field];
          delete scannerOverride[field];
        }
      }
      return {
        path: packagePathText,
        ...scannerDefaults,
        ...scannerOverride,
        ...packageDescriptor(packagePathText, manifest),
      };
    })
    .filter(Boolean);
};

if (!isRecord(source.root)) {
  failures.push("docs/effect-skill.json missing root manifest");
} else {
  validateKnownFields({
    label: "docs/effect-skill.json.root",
    value: source.root,
    allowed: rootProjectionFields,
  });
  const projectedPathItems = {};
  for (const field of packagePathItemFields) {
    const rootItems = source.root[field];
    validatePathItems({
      label: "docs/effect-skill.json.root",
      field,
      items: rootItems,
      basePath: ".",
      boundary: "repository root",
    });
    validateRootPathItemOwnership(field, rootItems, Object.keys(packageManifests));
    const packageItems = packagePathItems(packageManifests, field);
    const projectedItems = [...(Array.isArray(rootItems) ? rootItems : []), ...packageItems];
    validateUniqueProjectedPaths(field, projectedItems);
    if (rootItems !== undefined || packageItems.length > 0) {
      projectedPathItems[field] = projectedItems;
    }
  }
  const {
    packageDefaults: _packageDefaults,
    packageOverrides: _packageOverrides,
    allowedAdapters: _allowedAdapters,
    executableEdges: _executableEdges,
    aiProviderTransports: _aiProviderTransports,
    ...rootSource
  } = source.root;
  writeJson(".effect-skill.json", {
    packages: scannerPackagesFromWorkspaces(source.root, packageManifests),
    ...rootSource,
    ...projectedPathItems,
  });
}

const expectedPackageFiles = new Set(
  Object.keys(packageManifests).map((packagePath) => `${packagePath}/.effect-skill.json`),
);

for (const [packagePath, manifest] of Object.entries(packageManifests)) {
  const packageJson = path.join(root, packagePath, "package.json");
  if (!fs.existsSync(packageJson)) {
    failures.push(`${packagePath} has an effect manifest but no package.json`);
    continue;
  }
  validatePackageManifestProjection(packagePath, manifest);
  for (const field of packagePathItemFields) {
    validatePathItems({
      label: `docs/effect-skill.json.packageManifests.${packagePath}`,
      field,
      items: isRecord(manifest) ? manifest[field] : undefined,
      basePath: packagePath,
      boundary: `package ${packagePath}`,
    });
  }
  writeJson(`${packagePath}/.effect-skill.json`, manifest);
}

for (const packagePath of workspacePaths) {
  const manifestFile = `${packagePath}/.effect-skill.json`;
  if (fs.existsSync(path.join(root, manifestFile)) && !expectedPackageFiles.has(manifestFile)) {
    failures.push(`${manifestFile} exists but is not declared in docs/effect-skill.json`);
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

for (const { target, expected } of pendingWrites) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, expected);
}

console.log(check ? "effect skill manifests are current" : "effect skill manifests updated");
