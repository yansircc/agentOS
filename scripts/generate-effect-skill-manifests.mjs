#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const check = process.argv.includes("--check");
const sourcePath = path.join(root, "docs/effect-skill.json");
const source = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
const failures = [];

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

if (typeof source.root !== "object" || source.root === null) {
  failures.push("docs/effect-skill.json missing root manifest");
} else {
  writeJson(".effect-skill.json", source.root);
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
    writeJson(`${packagePath}/.effect-skill.json`, manifest);
  }

  for (const entry of fs.readdirSync(path.join(root, "packages"), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestFile = `packages/${entry.name}/.effect-skill.json`;
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
