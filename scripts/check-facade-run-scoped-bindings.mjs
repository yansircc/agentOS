#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

const files = [
  "packages/backends/cloudflare-do/src/agent-do.ts",
  "packages/backends/cloudflare-do/src/facade.ts",
  "packages/backends/cloudflare-do/src/facade-lowering.ts",
  "packages/backends/cloudflare-do/test/facade-submit.worker.test.ts",
  "packages/backends/cloudflare-do/test/facade-types.ts",
  "packages/backends/cloudflare-do/test/test-worker.ts",
  "packages/runtime-protocol/src/bindings.ts",
];

const forbidden = [
  /submitWithDefaults/,
  /_submitDefaults/,
  /defaultSubmit/,
  /SubmitSpec\["tools"\]/,
  /submitAgUiRun/,
  /submitZeroYRun/,
];

const read = (root, file) => fs.readFileSync(path.join(root, file), "utf8");

const collectFailures = (root = repoRoot) => {
  const failures = [];
  for (const file of files) {
    const source = read(root, file);
    for (const pattern of forbidden) {
      if (pattern.test(source)) failures.push(`${file}: forbidden old submit bridge ${pattern}`);
    }
  }
  const agentDo = read(root, "packages/backends/cloudflare-do/src/agent-do.ts");
  if (!/readonly bindings\?: AgentSubmitBindings/.test(agentDo)) {
    failures.push(
      "packages/backends/cloudflare-do/src/agent-do.ts: AgentSubmitSpec lacks bindings",
    );
  }
  if (!/submitWithBindings/.test(agentDo)) {
    failures.push("packages/backends/cloudflare-do/src/agent-do.ts: missing submitWithBindings");
  }
  const facadeSubmitTest = read(
    root,
    "packages/backends/cloudflare-do/test/facade-submit.worker.test.ts",
  );
  if (!/defineAgentSubmitBindings/.test(facadeSubmitTest)) {
    failures.push("facade submit test does not prove run-scoped bindings");
  }
  return failures;
};

const writeFixture = (root, relativePath, source) => {
  const file = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, source);
};

const collectSelfTestFailures = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentos-facade-bindings-"));
  try {
    for (const file of files) writeFixture(root, file, "");
    writeFixture(
      root,
      "packages/backends/cloudflare-do/src/agent-do.ts",
      "export interface AgentSubmitSpec { readonly bindings?: AgentSubmitBindings; } protected submitWithBindings() {}",
    );
    writeFixture(
      root,
      "packages/backends/cloudflare-do/test/facade-submit.worker.test.ts",
      "defineAgentSubmitBindings({ handlers: {}, tools: {} });",
    );
    const baseline = collectFailures(root);
    if (baseline.length > 0) {
      return [`facade bindings positive fixture failed:\n${baseline.join("\n")}`];
    }
    writeFixture(
      root,
      "packages/backends/cloudflare-do/src/facade.ts",
      "class X { private readonly _submitDefaults = null; submitWithDefaults() {} }",
    );
    const rejected = collectFailures(root);
    if (!rejected.some((failure) => failure.includes("_submitDefaults"))) {
      return [`facade bindings mutation fixture was not rejected: ${JSON.stringify(rejected)}`];
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
    ? "facade run-scoped bindings self-test passed"
    : "facade run-scoped bindings passed",
);
