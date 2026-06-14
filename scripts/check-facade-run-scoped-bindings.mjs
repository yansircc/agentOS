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
  "packages/runtime/src/internal-submit.ts",
  "packages/runtime/src/workspace-job.ts",
  "packages/runtime-protocol/src/bindings.ts",
  "packages/runtime-protocol/src/capability.ts",
  "packages/composers/workspace-binding/src/index.ts",
  "packages/wire-adapters/ag-ui/src/index.ts",
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
  if (/resolvedMaterials:\s*\{\s*\.\.\.bindings\.resolvedMaterials\s*\}/.test(agentDo)) {
    failures.push(
      "packages/backends/cloudflare-do/src/agent-do.ts: public submit binding forwards resolvedMaterials",
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
  if (/export interface InternalSubmitSpec/.test(submit)) {
    failures.push(
      "packages/runtime-protocol/src/submit.ts: runtime protocol exports InternalSubmitSpec",
    );
  }
  if (/resolvedMaterials/.test(submit)) {
    failures.push(
      "packages/runtime-protocol/src/submit.ts: public SubmitSpec exposes resolvedMaterials",
    );
  }
  const internalSubmit = read(root, "packages/runtime/src/internal-submit.ts");
  if (!/export const internalSubmitSpec/.test(internalSubmit)) {
    failures.push(
      "packages/runtime/src/internal-submit.ts: missing internalSubmitSpec constructor",
    );
  }
  if (/\.\.\.\s*spec/.test(internalSubmit)) {
    failures.push(
      "packages/runtime/src/internal-submit.ts: internalSubmitSpec spreads public spec",
    );
  }
  if (/resolvedMaterials/.test(internalSubmit)) {
    failures.push(
      "packages/runtime/src/internal-submit.ts: internalSubmitSpec copies resolvedMaterials",
    );
  }
  if (
    !/intent: spec\.intent/.test(internalSubmit) ||
    !/scopeRef: scope\.scopeRef/.test(internalSubmit)
  ) {
    failures.push(
      "packages/runtime/src/internal-submit.ts: internalSubmitSpec lacks public field projection",
    );
  }
  if (!/internalSubmitSpec\(spec,\s*\{[\s\S]*scope,[\s\S]*scopeRef/.test(agentDo)) {
    failures.push(
      "packages/backends/cloudflare-do/src/agent-do.ts: submitFull bypasses internalSubmitSpec",
    );
  }
  const workspaceJob = read(root, "packages/runtime/src/workspace-job.ts");
  if (
    !/internalSubmitSpec\(publicSubmitSpec,\s*\{[\s\S]*scope: activeSpec\.scope,[\s\S]*scopeRef: activeSpec\.identity\.scopeRef/.test(
      workspaceJob,
    )
  ) {
    failures.push(
      "packages/runtime/src/workspace-job.ts: workspace-job bypasses internalSubmitSpec",
    );
  }
  const runtime = read(root, "packages/runtime/src/submit-agent.ts");
  if (/spec\.resolvedMaterials/.test(runtime)) {
    failures.push(
      "packages/runtime/src/submit-agent.ts: runtime trusts submit-scoped resolvedMaterials",
    );
  }
  const facadeSubmitTest = read(
    root,
    "packages/backends/cloudflare-do/test/facade-submit.worker.test.ts",
  );
  if (!/defineAgentSubmitBindings/.test(facadeSubmitTest)) {
    failures.push("facade submit test does not prove run-scoped bindings");
  }
  if (/resolvedMaterials:\s*\{/.test(facadeSubmitTest)) {
    failures.push("facade submit test injects public resolvedMaterials");
  }
  if (!/decisionInterrupts:/.test(facadeSubmitTest)) {
    failures.push("facade submit test does not prove submit-scoped decision interrupts");
  }
  const bindingsSource = read(root, "packages/runtime-protocol/src/bindings.ts");
  if (/readonly resolvedMaterials\?/.test(bindingsSource)) {
    failures.push(
      "packages/runtime-protocol/src/bindings.ts: AgentSubmitBindings exposes resolvedMaterials",
    );
  }
  const capability = read(root, "packages/runtime-protocol/src/capability.ts");
  if (/options\.resolvedMaterials|resolvedMaterials:\s*resolvedMaterials/.test(capability)) {
    failures.push(
      "packages/runtime-protocol/src/capability.ts: capability binding emits resolvedMaterials",
    );
  }
  const workspaceBinding = read(root, "packages/composers/workspace-binding/src/index.ts");
  if (/resolvedWorkspace|resolvedMaterials:\s*\{\s*workspace/.test(workspaceBinding)) {
    failures.push(
      "packages/composers/workspace-binding/src/index.ts: workspace binding emits resolvedMaterials",
    );
  }
  const agui = read(root, "packages/wire-adapters/ag-ui/src/index.ts");
  if (/defaults\.resolvedMaterials|resolvedMaterials:\s*defaults\.resolvedMaterials/.test(agui)) {
    failures.push(
      "packages/wire-adapters/ag-ui/src/index.ts: AG-UI defaults forward resolvedMaterials",
    );
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
      "packages/runtime-protocol/src/bindings.ts",
      `export interface AgentSubmitBindings {
        readonly context?: Record<string, unknown>;
        readonly decisionInterrupts?: ReadonlyArray<SubmitDecisionInterrupt>;
      }`,
    );
    writeFixture(
      root,
      "packages/runtime-protocol/src/submit.ts",
      "export interface SubmitSpec { readonly materials?: unknown; }",
    );
    writeFixture(
      root,
      "packages/runtime/src/internal-submit.ts",
      `export const internalSubmitSpec = (spec, scope) => ({
        intent: spec.intent,
        context: spec.context,
        route: spec.route,
        tools: spec.tools,
        effectAuthorityRef: spec.effectAuthorityRef,
        scope: scope.scope,
        scopeRef: scope.scopeRef,
      });`,
    );
    writeFixture(
      root,
      "packages/runtime/src/workspace-job.ts",
      "const submitSpec = internalSubmitSpec(publicSubmitSpec, { scope: activeSpec.scope, scopeRef: activeSpec.identity.scopeRef });",
    );
    writeFixture(
      root,
      "packages/runtime/src/submit-agent.ts",
      "const resolved = yield* refs.material(ref);",
    );
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
          decisionInterrupts: bindings.decisionInterrupts,
          resume: spec.resume,
        });
      }
      protected submitFull(spec) {
        const internalSpec = internalSubmitSpec(spec, { scope, scopeRef });
        return internalSpec;
      }`,
    );
    writeFixture(
      root,
      "packages/backends/cloudflare-do/test/facade-submit.worker.test.ts",
      "defineAgentSubmitBindings({ tools: {}, decisionInterrupts: [] });",
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
      `export interface AgentSubmitBindings {
        readonly resolvedMaterials?: Readonly<Record<string, ResolvedMaterial>>;
        readonly context?: Record<string, unknown>;
        readonly decisionInterrupts?: ReadonlyArray<SubmitDecisionInterrupt>;
      }`,
    );
    const publicResolvedRejected = collectFailures(root);
    if (
      !publicResolvedRejected.some((failure) => failure.includes("AgentSubmitBindings exposes"))
    ) {
      return [
        `public resolvedMaterials mutation fixture was not rejected: ${JSON.stringify(
          publicResolvedRejected,
        )}`,
      ];
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
