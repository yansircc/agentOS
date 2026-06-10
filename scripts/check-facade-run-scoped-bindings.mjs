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
  /export type AgentSubmitBindings = AgentBindings<never>/,
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
  if (!/readonly resume\?: SubmitSpec\["resume"\]/.test(agentDo)) {
    failures.push("packages/backends/cloudflare-do/src/agent-do.ts: AgentSubmitSpec lacks resume");
  }
  if (!/submitWithBindings/.test(agentDo)) {
    failures.push("packages/backends/cloudflare-do/src/agent-do.ts: missing submitWithBindings");
  }
  if (!/context: bindings\.context \?\? \{ input: spec\.input \}/.test(agentDo)) {
    failures.push(
      "packages/backends/cloudflare-do/src/agent-do.ts: submit binding context is not forwarded",
    );
  }
  if (!/resolvedMaterials: \{ \.\.\.bindings\.resolvedMaterials \}/.test(agentDo)) {
    failures.push(
      "packages/backends/cloudflare-do/src/agent-do.ts: submit binding resolvedMaterials is not forwarded",
    );
  }
  if (!/decisionInterrupts: bindings\.decisionInterrupts/.test(agentDo)) {
    failures.push(
      "packages/backends/cloudflare-do/src/agent-do.ts: submit binding decisionInterrupts is not forwarded",
    );
  }
  if (!/resume: spec\.resume/.test(agentDo)) {
    failures.push(
      "packages/backends/cloudflare-do/src/agent-do.ts: AgentSubmitSpec.resume is not forwarded",
    );
  }
  const bindings = read(root, "packages/runtime-protocol/src/bindings.ts");
  if (!/export interface AgentSubmitBindings/.test(bindings)) {
    failures.push(
      "packages/runtime-protocol/src/bindings.ts: AgentSubmitBindings is not an owned submit type",
    );
  }
  for (const [field, message] of [
    ["resolvedMaterials", "resolved material values"],
    ["context", "run context"],
    ["decisionInterrupts", "decision interrupts"],
  ]) {
    if (!new RegExp(`readonly ${field}\\?`).test(bindings)) {
      failures.push(
        `packages/runtime-protocol/src/bindings.ts: AgentSubmitBindings lacks ${message}`,
      );
    }
  }
  const submit = read(root, "packages/runtime-protocol/src/submit.ts");
  if (!/readonly resolvedMaterials\?: Readonly<Record<string, ResolvedMaterial>>/.test(submit)) {
    failures.push(
      "packages/runtime-protocol/src/submit.ts: SubmitSpec lacks submit-scoped resolvedMaterials",
    );
  }
  const runtime = read(root, "packages/runtime/src/submit-agent.ts");
  if (!/const runResolved = spec\.resolvedMaterials\?\.\[requirement\.slot\]/.test(runtime)) {
    failures.push(
      "packages/runtime/src/submit-agent.ts: runtime does not read submit-scoped resolved materials",
    );
  }
  const facadeSubmitTest = read(
    root,
    "packages/backends/cloudflare-do/test/facade-submit.worker.test.ts",
  );
  if (!/defineAgentSubmitBindings/.test(facadeSubmitTest)) {
    failures.push("facade submit test does not prove run-scoped bindings");
  }
  if (!/resolvedMaterials:/.test(facadeSubmitTest)) {
    failures.push("facade submit test does not prove submit-scoped resolved materials");
  }
  if (!/decisionInterrupts:/.test(facadeSubmitTest)) {
    failures.push("facade submit test does not prove submit-scoped decision interrupts");
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
      `export interface AgentSubmitSpec {
        readonly bindings?: AgentSubmitBindings;
        readonly resume?: SubmitSpec["resume"];
      }
      protected submitWithBindings() {
        return this.submitFull({
          context: bindings.context ?? { input: spec.input },
          resolvedMaterials: { ...bindings.resolvedMaterials },
          decisionInterrupts: bindings.decisionInterrupts,
          resume: spec.resume,
        });
      }`,
    );
    writeFixture(
      root,
      "packages/runtime-protocol/src/bindings.ts",
      `export interface AgentSubmitBindings {
        readonly resolvedMaterials?: Readonly<Record<string, ResolvedMaterial>>;
        readonly context?: Record<string, unknown>;
        readonly decisionInterrupts?: ReadonlyArray<SubmitDecisionInterrupt>;
      }`,
    );
    writeFixture(
      root,
      "packages/runtime-protocol/src/submit.ts",
      "export interface SubmitSpec { readonly resolvedMaterials?: Readonly<Record<string, ResolvedMaterial>>; }",
    );
    writeFixture(
      root,
      "packages/runtime/src/submit-agent.ts",
      "const runResolved = spec.resolvedMaterials?.[requirement.slot];",
    );
    writeFixture(
      root,
      "packages/backends/cloudflare-do/test/facade-submit.worker.test.ts",
      "defineAgentSubmitBindings({ tools: {}, resolvedMaterials: {}, decisionInterrupts: [] });",
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
    writeFixture(root, "packages/backends/cloudflare-do/src/facade.ts", "");
    writeFixture(
      root,
      "packages/runtime-protocol/src/bindings.ts",
      "export type AgentSubmitBindings = AgentBindings<never>;",
    );
    const submitBindingRejected = collectFailures(root);
    if (
      !submitBindingRejected.some((failure) =>
        failure.includes("AgentSubmitBindings is not an owned submit type"),
      )
    ) {
      return [
        `facade submit binding mutation fixture was not rejected: ${JSON.stringify(
          submitBindingRejected,
        )}`,
      ];
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
