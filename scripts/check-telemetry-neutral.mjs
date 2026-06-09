#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

const protocolFile = "packages/telemetry-protocol/src/index.ts";
const protocolTreeTest = "packages/telemetry-protocol/test/telemetry-event-tree.test.ts";
const runtimeTreeFile = "packages/runtime/src/telemetry-tree.ts";
const runtimeTreeTest = "packages/runtime/test/telemetry-tree.test.ts";

const scanRoots = ["packages/backends", "packages/runtime/src", "packages/carriers"];

const forbiddenLocalFanout = [
  /interface .*FanoutDiagnostic/,
  /fanoutDiagnosticsLog/,
  /EventBusFanoutDiagnostic/,
  /fanoutDiagnostics:/,
];

const forbiddenProtocolImports = [
  /from\s+["']@agent-os\/runtime/,
  /from\s+["']@agent-os\/backend-/,
  /from\s+["']@agent-os\/.*cloudflare/,
  /from\s+["'].*otlp/i,
  /from\s+["'].*opentelemetry/i,
];

const read = (root, file) => fs.readFileSync(path.join(root, file), "utf8");

const walkFiles = (root, relativeDir) => {
  const absolute = path.join(root, relativeDir);
  if (!fs.existsSync(absolute)) return [];
  const entries = fs.readdirSync(absolute, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const relative = path.join(relativeDir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") return [];
      return walkFiles(root, relative);
    }
    return /\.(ts|tsx|js|mjs)$/.test(entry.name) ? [relative] : [];
  });
};

const collectFailures = (root = repoRoot) => {
  const failures = [];
  const protocol = read(root, protocolFile);
  const protocolTest = read(root, protocolTreeTest);
  const runtimeTree = read(root, runtimeTreeFile);
  const runtimeTest = read(root, runtimeTreeTest);

  for (const required of [
    "export interface TelemetryFanoutDiagnostic",
    "export interface TelemetryService",
    "export class Telemetry",
    "export const canonicalizeTelemetryEventTree",
    "export const canonicalTelemetryEventTreeJson",
    "export const telemetryEventTreesEqual",
  ]) {
    if (!protocol.includes(required)) failures.push(`${protocolFile}: missing ${required}`);
  }

  for (const pattern of forbiddenProtocolImports) {
    if (pattern.test(protocol)) {
      failures.push(`${protocolFile}: telemetry protocol imports implementation/wire ${pattern}`);
    }
  }

  if (!/canonicalizes timing, generated ids, and backend host ids/.test(protocolTest)) {
    failures.push(`${protocolTreeTest}: missing timing/backend-id canonicalization test`);
  }
  if (!/telemetryEventTreesEqual\(left, right\)\)\.toBe\(true\)/.test(protocolTest)) {
    failures.push(`${protocolTreeTest}: missing canonical tree equality assertion`);
  }
  if (!/export const projectTelemetryEventTree/.test(runtimeTree)) {
    failures.push(`${runtimeTreeFile}: missing runtime telemetry tree projection`);
  }
  if (!/canonicalTelemetryEventTreeJson/.test(runtimeTest)) {
    failures.push(`${runtimeTreeTest}: runtime test must compare telemetry-protocol canonical trees`);
  }

  for (const scanRoot of scanRoots) {
    for (const file of walkFiles(root, scanRoot)) {
      const source = read(root, file);
      for (const pattern of forbiddenLocalFanout) {
        if (pattern.test(source)) failures.push(`${file}: forbidden local fanout vocab ${pattern}`);
      }
    }
  }

  return failures;
};

const writeFixture = (root, relativePath, source) => {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, source);
};

const collectSelfTestFailures = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentos-telemetry-neutral-"));
  try {
    writeFixture(
      root,
      protocolFile,
      [
        "export interface TelemetryFanoutDiagnostic {}",
        "export interface TelemetryService {}",
        "export class Telemetry {}",
        "export const canonicalizeTelemetryEventTree = () => ({});",
        "export const canonicalTelemetryEventTreeJson = () => '{}';",
        "export const telemetryEventTreesEqual = () => true;",
      ].join("\n"),
    );
    writeFixture(
      root,
      protocolTreeTest,
      "it('canonicalizes timing, generated ids, and backend host ids', () => { expect(telemetryEventTreesEqual(left, right)).toBe(true); });",
    );
    writeFixture(root, runtimeTreeFile, "export const projectTelemetryEventTree = () => ({});");
    writeFixture(root, runtimeTreeTest, "canonicalTelemetryEventTreeJson(tree);");
    writeFixture(
      root,
      "packages/backends/example/src/index.ts",
      "export const telemetryDiagnostics = () => [];",
    );
    writeFixture(root, "packages/carriers/example/src/index.ts", "");
    const baseline = collectFailures(root);
    if (baseline.length > 0) {
      return [`telemetry-neutral positive fixture failed:\n${baseline.join("\n")}`];
    }

    writeFixture(
      root,
      "packages/backends/example/src/index.ts",
      [
        "interface LocalFanoutDiagnostic {}",
        "const fanoutDiagnosticsLog = [];",
        "export const driver = { fanoutDiagnostics: () => fanoutDiagnosticsLog };",
      ].join("\n"),
    );
    const rejected = collectFailures(root);
    if (
      !rejected.some((failure) => failure.includes("interface .*FanoutDiagnostic")) ||
      !rejected.some((failure) => failure.includes("fanoutDiagnosticsLog")) ||
      !rejected.some((failure) => failure.includes("fanoutDiagnostics:"))
    ) {
      return [`telemetry-neutral fanout mutation fixture was not rejected: ${JSON.stringify(rejected)}`];
    }

    writeFixture(
      root,
      protocolFile,
      [
        "export interface TelemetryFanoutDiagnostic {}",
        "export interface TelemetryService {}",
        "export const canonicalizeTelemetryEventTree = () => ({});",
        "export const canonicalTelemetryEventTreeJson = () => '{}';",
        "export const telemetryEventTreesEqual = () => true;",
      ].join("\n"),
    );
    writeFixture(
      root,
      "packages/backends/example/src/index.ts",
      "export const telemetryDiagnostics = () => [];",
    );
    const missingService = collectFailures(root);
    if (!missingService.some((failure) => failure.includes("export class Telemetry"))) {
      return [`telemetry-neutral service mutation fixture was not rejected: ${JSON.stringify(missingService)}`];
    }

    return [];
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
};

const failures = process.argv.includes("--self-test")
  ? collectSelfTestFailures()
  : collectFailures(repoRoot);

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(
  process.argv.includes("--self-test")
    ? "telemetry-neutral self-test passed"
    : "telemetry-neutral passed",
);
