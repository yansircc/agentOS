#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { workspacePackagePaths } from "../lib/workspace-manifest.mjs";

const root = process.cwd();
const check = process.argv.includes("--check");
const sourcePath = path.join(root, "docs/effect-skill.json");
const source = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
const failures = [];
const packageManifests =
  typeof source.packageManifests === "object" && source.packageManifests !== null
    ? source.packageManifests
    : null;

const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const normalizeAdapterPath = (adapterPath) => path.posix.normalize(adapterPath);

const stableJson = (value) =>
  `${JSON.stringify(value, null, 2).replace(
    /\[\n((?:\s+"(?:\\.|[^"\\])*",?\n)+)\s+\]/gu,
    (match, body) => {
      const items = body
        .trim()
        .split("\n")
        .map((line) => line.trim().replace(/,$/u, ""));
      return items.every((item) => item.startsWith('"') && item.endsWith('"'))
        ? `[${items.join(", ")}]`
        : match;
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
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, expected);
};

const validateAllowedAdapters = ({ label, allowedAdapters, resolvePath }) => {
  if (allowedAdapters === undefined) return;
  if (!Array.isArray(allowedAdapters)) {
    failures.push(`${label}.allowedAdapters must be an array`);
    return;
  }
  const seenPaths = new Set();
  for (const [index, adapter] of allowedAdapters.entries()) {
    const adapterLabel = `${label}.allowedAdapters[${index}]`;
    if (!isRecord(adapter) || typeof adapter.path !== "string" || adapter.path.length === 0) {
      failures.push(`${adapterLabel}.path must be a non-empty string`);
      continue;
    }
    const normalizedPath = normalizeAdapterPath(adapter.path);
    if (seenPaths.has(normalizedPath)) {
      failures.push(`${adapterLabel}.path duplicates ${adapter.path}`);
      continue;
    }
    seenPaths.add(normalizedPath);
    const target = resolvePath(adapter.path);
    if (!fs.existsSync(path.join(root, target))) {
      failures.push(`${adapterLabel}.path references missing file ${target}`);
    }
  }
};

const isPathInside = (file, directory) => file === directory || file.startsWith(`${directory}/`);

const rebasePackageAdapterPath = (packagePath, adapterPath, label) => {
  const normalized = normalizeAdapterPath(adapterPath);
  if (path.posix.isAbsolute(adapterPath) || normalized === ".." || normalized.startsWith("../")) {
    failures.push(`${label}.path escapes package ${packagePath}`);
    return null;
  }
  return path.posix.join(packagePath, normalized);
};

const packageAllowedAdapters = (manifests) =>
  Object.entries(manifests).flatMap(([packagePath, manifest]) => {
    if (!isRecord(manifest) || !Array.isArray(manifest.allowedAdapters)) return [];
    return manifest.allowedAdapters.flatMap((adapter, index) => {
      if (!isRecord(adapter) || typeof adapter.path !== "string" || adapter.path.length === 0) {
        return [];
      }
      const rebasedPath = rebasePackageAdapterPath(
        packagePath,
        adapter.path,
        `docs/effect-skill.json.packageManifests.${packagePath}.allowedAdapters[${index}]`,
      );
      return rebasedPath === null ? [] : [{ ...adapter, path: rebasedPath }];
    });
  });

const validateRootAdapterOwnership = (allowedAdapters, declaredPackagePaths) => {
  if (!Array.isArray(allowedAdapters)) return;
  for (const [index, adapter] of allowedAdapters.entries()) {
    if (!isRecord(adapter) || typeof adapter.path !== "string") continue;
    const normalizedPath = normalizeAdapterPath(adapter.path);
    const packagePath = declaredPackagePaths.find((candidate) =>
      isPathInside(normalizedPath, candidate),
    );
    if (packagePath !== undefined) {
      failures.push(
        `docs/effect-skill.json.root.allowedAdapters[${index}].path duplicates package ownership under ${packagePath}`,
      );
    }
  }
};

const scannerPackagesFromWorkspaces = (rootSource) => {
  if (Object.hasOwn(rootSource, "packages")) {
    failures.push("docs/effect-skill.json root.packages duplicates package ownership");
  }

  const packageDefaults = isRecord(rootSource.packageDefaults) ? rootSource.packageDefaults : {};
  const packageOverrides = isRecord(rootSource.packageOverrides) ? rootSource.packageOverrides : {};
  const paths = workspacePackagePaths(root);
  const pathSet = new Set(paths);

  for (const packagePath of Object.keys(packageOverrides)) {
    if (!pathSet.has(packagePath)) {
      failures.push(`${packagePath} has an effect scanner override but is not a workspace package`);
    }
  }

  return paths
    .map((packagePath) => {
      const packagePathText = String(packagePath);
      const override = isRecord(packageOverrides[packagePath]) ? packageOverrides[packagePath] : {};
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
        ...scannerOverride
      } = override;
      return {
        path: packagePathText,
        ...packageDefaults,
        ...scannerOverride,
      };
    })
    .filter(Boolean);
};

if (!isRecord(source.root)) {
  failures.push("docs/effect-skill.json missing root manifest");
} else {
  const rootAllowedAdapters = source.root.allowedAdapters;
  validateAllowedAdapters({
    label: "docs/effect-skill.json.root",
    allowedAdapters: rootAllowedAdapters,
    resolvePath: (adapterPath) => adapterPath,
  });
  if (packageManifests !== null) {
    validateRootAdapterOwnership(rootAllowedAdapters, Object.keys(packageManifests));
  }
  const {
    packageDefaults: _packageDefaults,
    packageOverrides: _packageOverrides,
    allowedAdapters: _allowedAdapters,
    ...rootSource
  } = source.root;
  writeJson(".effect-skill.json", {
    packages: scannerPackagesFromWorkspaces(source.root),
    ...rootSource,
    allowedAdapters: [
      ...(Array.isArray(rootAllowedAdapters) ? rootAllowedAdapters : []),
      ...(packageManifests === null ? [] : packageAllowedAdapters(packageManifests)),
    ],
  });
}

if (packageManifests === null) {
  failures.push("docs/effect-skill.json missing packageManifests object");
} else {
  const expectedPackageFiles = new Set(
    Object.keys(packageManifests).map((packagePath) => `${packagePath}/.effect-skill.json`),
  );

  for (const [packagePath, manifest] of Object.entries(packageManifests)) {
    const packageJson = path.join(root, packagePath, "package.json");
    if (!fs.existsSync(packageJson)) {
      failures.push(`${packagePath} has an effect manifest but no package.json`);
      continue;
    }
    validateAllowedAdapters({
      label: `docs/effect-skill.json.packageManifests.${packagePath}`,
      allowedAdapters: isRecord(manifest) ? manifest.allowedAdapters : undefined,
      resolvePath: (adapterPath) => `${packagePath}/${adapterPath}`,
    });
    writeJson(`${packagePath}/.effect-skill.json`, manifest);
  }

  for (const workspacePath of workspacePackagePaths(root)) {
    const packagePath = String(workspacePath);
    const manifestFile = `${packagePath}/.effect-skill.json`;
    if (fs.existsSync(path.join(root, manifestFile)) && !expectedPackageFiles.has(manifestFile)) {
      failures.push(`${manifestFile} exists but is not declared in docs/effect-skill.json`);
    }
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(check ? "effect skill manifests are current" : "effect skill manifests updated");
