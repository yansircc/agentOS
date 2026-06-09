#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

const sourceExtensions = /\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/u;
const ignoredDirs = new Set(["node_modules", "dist", ".wrangler", ".turbo", ".git"]);

const scannedRoots = [
  "packages/kernel/src",
  "packages/runtime-protocol/src",
  "packages/backends/protocol/src",
  "packages/backends/protocol/test",
  "packages/runtime-protocol/test",
  "packages/runtime/test",
  "scripts",
  "test",
];

const allowedGuardFiles = new Set([
  "scripts/check-agent-manifest-intent-boundary.mjs",
  "scripts/check-boundaries.mjs",
  "scripts/check-product-resource-boundary.mjs",
]);

const forbiddenTokens = [
  "\\bSurfaceProgram\\b",
  "\\bWordPress\\b",
  "\\bwp_posts\\b",
  "\\bNotion\\b",
  "\\bGhost\\b",
  "\\bDurableObjectId\\b",
  "\\bDO instance\\b",
  "\\brouteKey\\b",
  "\\broute key\\b",
  "\\bbackend row id\\b",
  "\\bPostgres row id\\b",
  "\\bwp_post\\b",
  "mutation\\.(?:proposed|settled)",
  "state\\.transitioned",
  "entity\\.updated",
];

const toRepoPath = (root, file) => path.relative(root, file).split(path.sep).join("/");

const regexForToken = (token) => new RegExp(token, "gu");

const lineNumber = (source, index) => source.slice(0, index).split("\n").length;

const collectFiles = (root) => {
  const files = [];
  const visit = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!ignoredDirs.has(entry.name)) visit(file);
        continue;
      }
      if (sourceExtensions.test(entry.name)) files.push(file);
    }
  };
  for (const scannedRoot of scannedRoots) visit(path.join(root, scannedRoot));
  return files.sort((left, right) => left.localeCompare(right));
};

export const collectProductResourceBoundaryFailures = (root = repoRoot) => {
  const failures = [];
  for (const file of collectFiles(root)) {
    const repoPath = toRepoPath(root, file);
    if (allowedGuardFiles.has(repoPath)) continue;

    const source = fs.readFileSync(file, "utf8");
    for (const token of forbiddenTokens) {
      const pattern = regexForToken(token);
      for (const match of source.matchAll(pattern)) {
        failures.push(
          `${repoPath}:${lineNumber(source, match.index ?? 0)}: product-resource-boundary: forbidden token ${match[0]}`,
        );
      }
    }
  }
  return failures;
};

const writeFixture = (root, relativePath, source) => {
  const file = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, source);
};

const writePositiveFixture = (root) => {
  writeFixture(root, "packages/kernel/src/index.ts", "export interface ScopeRef {}\n");
  writeFixture(
    root,
    "packages/runtime-protocol/src/manifest.ts",
    "export interface AgentManifest { readonly agentId: string }\n",
  );
  writeFixture(root, "packages/backends/protocol/src/index.ts", "export interface Port {}\n");
  writeFixture(
    root,
    "packages/backends/protocol/test/contract.ts",
    "export const backendProtocolContract = true;\n",
  );
  writeFixture(root, "packages/runtime-protocol/test/intent.test.ts", "export const ok = true;\n");
  writeFixture(root, "packages/runtime/test/runtime.test.ts", "export const ok = true;\n");
  writeFixture(root, "scripts/generate-ok.mjs", "export const ok = true;\n");
  writeFixture(
    root,
    "scripts/check-boundaries.mjs",
    "export const guardPattern = /SurfaceProgram/u;\n",
  );
};

const collectSelfTestFailures = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentos-product-resource-boundary-"));
  try {
    writePositiveFixture(root);
    const baseline = collectProductResourceBoundaryFailures(root);
    if (baseline.length > 0) {
      return [`product resource boundary positive fixture failed:\n${baseline.join("\n")}`];
    }

    const cases = [
      {
        name: "product model in runtime protocol",
        file: "packages/runtime-protocol/src/manifest.ts",
        bad: "export interface Manifest { readonly surface: SurfaceProgram }\n",
        expected: "SurfaceProgram",
      },
      {
        name: "host storage identity in backend contract",
        file: "packages/backends/protocol/test/contract.ts",
        bad: "export const storage = 'Postgres row id';\n",
        expected: "Postgres row id",
      },
      {
        name: "fake generic lifecycle in script",
        file: "scripts/generate-ok.mjs",
        bad: "export const eventKind = 'state.transitioned';\n",
        expected: "state.transitioned",
      },
    ];

    const failures = [];
    for (const testCase of cases) {
      const file = path.join(root, testCase.file);
      const original = fs.readFileSync(file, "utf8");
      fs.writeFileSync(file, testCase.bad);
      const rejected = collectProductResourceBoundaryFailures(root);
      if (!rejected.some((failure) => failure.includes(testCase.expected))) {
        failures.push(
          `${testCase.name}: mutation was not rejected; failures=${JSON.stringify(rejected)}`,
        );
      }
      fs.writeFileSync(file, original);
      const restored = collectProductResourceBoundaryFailures(root);
      if (restored.length > 0) {
        failures.push(`${testCase.name}: restored fixture still failed:\n${restored.join("\n")}`);
      }
    }
    return failures;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
};

const failures = process.argv.includes("--self-test")
  ? collectSelfTestFailures()
  : collectProductResourceBoundaryFailures(repoRoot);

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(
  process.argv.includes("--self-test")
    ? "product resource boundary self-test passed"
    : "product resource boundary passed",
);
