#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const check = process.argv.includes("--check");
const sourcePath = path.join(root, "docs/effect-skill.json");
const source = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
const failures = [];

const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

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
  for (const [index, adapter] of allowedAdapters.entries()) {
    const adapterLabel = `${label}.allowedAdapters[${index}]`;
    if (!isRecord(adapter) || typeof adapter.path !== "string" || adapter.path.length === 0) {
      failures.push(`${adapterLabel}.path must be a non-empty string`);
      continue;
    }
    const target = resolvePath(adapter.path);
    if (!fs.existsSync(path.join(root, target))) {
      failures.push(`${adapterLabel}.path references missing file ${target}`);
    }
  }
};

const workspacePackagePaths = () => {
  const rootPackage = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const workspaces = Array.isArray(rootPackage.workspaces)
    ? rootPackage.workspaces
    : Array.isArray(rootPackage.workspaces?.packages)
      ? rootPackage.workspaces.packages
      : [];
  const paths = new Set();

  for (const workspace of workspaces) {
    if (typeof workspace !== "string") continue;
    if (workspace.endsWith("/*")) {
      const base = workspace.slice(0, -2);
      const baseDir = path.join(root, base);
      if (!fs.existsSync(baseDir)) continue;
      for (const entry of fs.readdirSync(baseDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const packagePath = `${base}/${entry.name}`;
        if (fs.existsSync(path.join(root, packagePath, "package.json"))) {
          paths.add(packagePath);
        }
      }
      continue;
    }

    if (fs.existsSync(path.join(root, workspace, "package.json"))) {
      paths.add(workspace);
    }
  }

  return [...paths].sort((left, right) => left.localeCompare(right));
};

const scannerPackagesFromWorkspaces = (rootSource) => {
  if (Object.hasOwn(rootSource, "packages")) {
    failures.push("docs/effect-skill.json root.packages duplicates package ownership");
  }

  const packageDefaults = isRecord(rootSource.packageDefaults) ? rootSource.packageDefaults : {};
  const packageOverrides = isRecord(rootSource.packageOverrides) ? rootSource.packageOverrides : {};
  const paths = workspacePackagePaths();
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
  validateAllowedAdapters({
    label: "docs/effect-skill.json.root",
    allowedAdapters: source.root.allowedAdapters,
    resolvePath: (adapterPath) => adapterPath,
  });
  const {
    packageDefaults: _packageDefaults,
    packageOverrides: _packageOverrides,
    ...rootSource
  } = source.root;
  writeJson(".effect-skill.json", {
    packages: scannerPackagesFromWorkspaces(source.root),
    ...rootSource,
  });
}

const packageManifests =
  typeof source.packageManifests === "object" && source.packageManifests !== null
    ? source.packageManifests
    : null;

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

  for (const workspacePath of workspacePackagePaths()) {
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
