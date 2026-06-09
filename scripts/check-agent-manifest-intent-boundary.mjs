#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

const manifestInterfaceBlock = (source) => {
  const match = source.match(/export interface AgentManifest[\s\S]*?^}\n/m);
  return match?.[0] ?? "";
};

const collectFailures = (root = repoRoot) => {
  const file = path.join(root, "packages", "runtime-protocol", "src", "manifest.ts");
  const source = fs.readFileSync(file, "utf8");
  const manifest = manifestInterfaceBlock(source);
  const failures = [];
  if (manifest.length === 0) {
    failures.push("packages/runtime-protocol/src/manifest.ts: missing AgentManifest interface");
    return failures;
  }
  const forbiddenManifestTokens = [
    /=>/,
    /\bFunction\b/,
    /\bTool\b/,
    /\bLlmRoute\b/,
    /\bDurableObject\b/,
    /\bbindingName\b/,
    /\brouteKey\b/,
    /\browId\b/,
    /\bwp_posts\b/,
    /\bSurfaceProgram\b/,
  ];
  for (const token of forbiddenManifestTokens) {
    if (token.test(manifest)) {
      failures.push(
        `packages/runtime-protocol/src/manifest.ts: AgentManifest contains forbidden token ${token}`,
      );
    }
  }
  if (/from\s+["']@agent-os\/runtime["']/.test(source)) {
    failures.push("packages/runtime-protocol/src/manifest.ts: forbidden runtime import");
  }
  return failures;
};

const writeFixture = (root, source) => {
  const file = path.join(root, "packages", "runtime-protocol", "src", "manifest.ts");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, source);
};

const collectSelfTestFailures = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentos-manifest-boundary-"));
  try {
    writeFixture(
      root,
      "export interface AgentManifest {\n  readonly agentId: string;\n  readonly handlers: readonly string[];\n}\n",
    );
    const baseline = collectFailures(root);
    if (baseline.length > 0) {
      return [`manifest boundary positive fixture failed:\n${baseline.join("\n")}`];
    }

    writeFixture(
      root,
      "export interface AgentManifest {\n  readonly resolve: () => unknown;\n  readonly rowId: string;\n}\n",
    );
    const rejected = collectFailures(root);
    if (!rejected.some((failure) => failure.includes("=>"))) {
      return [`manifest boundary mutation fixture was not rejected: ${JSON.stringify(rejected)}`];
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
    ? "agent manifest intent boundary self-test passed"
    : "agent manifest intent boundary passed",
);
