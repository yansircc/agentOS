#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

const files = {
  kernel: "packages/kernel/src/tools.ts",
  runtimeProtocol: "packages/runtime-protocol/src/runtime-events.ts",
  submit: "packages/runtime-protocol/src/submit.ts",
  bindings: "packages/runtime-protocol/src/bindings.ts",
  runtime: "packages/runtime/src/submit-agent.ts",
  kernelTest: "packages/kernel/test/tools.test.ts",
  runtimeProtocolTest: "packages/runtime-protocol/test/runtime-events.test.ts",
  runtimeTest: "packages/runtime/test/submit-agent-runtime-events.test.ts",
};

const read = (root, file) => fs.readFileSync(path.join(root, file), "utf8");

const requireTerms = (failures, source, file, terms) => {
  for (const term of terms) {
    if (!source.includes(term)) failures.push(`${file}: missing ${term}`);
  }
};

const rejectPatterns = (failures, source, file, patterns) => {
  for (const [pattern, description] of patterns) {
    if (pattern.test(source)) failures.push(`${file}: ${description}`);
  }
};

const collectFailures = (root = repoRoot) => {
  const failures = [];
  const kernel = read(root, files.kernel);
  const runtimeProtocol = read(root, files.runtimeProtocol);
  const submit = read(root, files.submit);
  const bindings = read(root, files.bindings);
  const runtime = read(root, files.runtime);
  const tests = [
    read(root, files.kernelTest),
    read(root, files.runtimeProtocolTest),
    read(root, files.runtimeTest),
  ].join("\n");

  requireTerms(failures, kernel, files.kernel, [
    'export type ToolReplayWitness = "snapshot" | "receipt"',
    "export interface ExecutionDomainReplayLaw",
    "readonly replay: ExecutionDomainReplayLaw",
    "export type ResolvedToolExecution",
    "export const resolveToolExecution",
    "validateExecutionDomainRegistry",
    'declaration.replay.access === "write" && declaration.replay.witness === "snapshot"',
    'kind: "invalid_write_snapshot_law"',
    'kind: "access_mismatch"',
    'kind: "missing_declaration"',
    'kind: "duplicate_declaration"',
  ]);

  requireTerms(failures, runtimeProtocol, files.runtimeProtocol, [
    "type { ExecutionDomain, ResolvedToolExecution, ToolExecution }",
    "toolResultSnapshotFromExecutedPayload",
    "resolved: ResolvedToolExecution",
    "externalToolExecutionReceiptFromExecutedPayload",
    'Extract<ResolvedToolExecution, { readonly kind: "external" }>',
    "toolReplayArtifactFromExecutedPayload",
    "resolved.witness",
  ]);
  rejectPatterns(failures, runtimeProtocol, files.runtimeProtocol, [
    [
      /toolReplayArtifactFromExecutedPayload\s*=\s*\(\s*payload:\s*ToolExecutedPayload\s*\)/u,
      "tool replay artifact can be built without resolved execution",
    ],
    [
      /payload\.execution\.kind === ["']deterministic["'][\s\S]{0,220}toolResultSnapshotFromExecutedPayload/u,
      "artifact builder derives snapshot witness from payload execution",
    ],
  ]);

  requireTerms(failures, submit, files.submit, [
    "readonly executionDomains?: ReadonlyArray<ExecutionDomainDeclaration>",
  ]);
  requireTerms(failures, bindings, files.bindings, [
    "readonly executionDomains?: ReadonlyArray<ExecutionDomainDeclaration>",
  ]);
  rejectPatterns(failures, `${submit}\n${bindings}`, "runtime-protocol submit/bindings", [
    [/readonly\s+witness\s*:/u, "submit/bindings expose witness override"],
    [/ToolReplayWitness/u, "submit/bindings import witness vocabulary"],
  ]);

  requireTerms(failures, runtime, files.runtime, [
    "validateExecutionDomainRegistry(spec.tools",
    "resolveToolExecution(decodedTool.event.payload.execution",
    "domains: executionDomains",
    "toolReplayArtifactFromExecutedPayload(",
    "resolvedExecution.resolved",
    'reason: "invalid_execution_domain_registry"',
    'reason: "tool_execution_witness_resolution_failed"',
  ]);

  requireTerms(failures, tests, "tool witness tests", [
    "rejects access-mismatched and write snapshot replay laws",
    "resolves replay witness only from the domain law",
    "resolveToolExecution(execution, { domains })",
    "toolReplayArtifactFromExecutedPayload(payload, resolved)",
    "executionDomains: [",
    'replay: { access: "write", witness: "receipt" }',
  ]);

  return failures;
};

const writeFixture = (root, file, source) => {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, source);
};

const positiveFixtures = {
  [files.kernel]: `
export type ToolReplayWitness = "snapshot" | "receipt";
export interface ExecutionDomainReplayLaw { readonly access: ToolAccess; readonly witness: ToolReplayWitness; }
export interface ExecutionDomainDeclaration { readonly replay: ExecutionDomainReplayLaw; }
export type ResolvedToolExecution = { readonly witness: ToolReplayWitness };
export const validateExecutionDomainRegistry = () => {
  if (declaration.replay.access === "write" && declaration.replay.witness === "snapshot") return { kind: "invalid_write_snapshot_law" };
  return [{ kind: "access_mismatch" }, { kind: "missing_declaration" }, { kind: "duplicate_declaration" }];
};
export const resolveToolExecution = () => ({ ok: true });
`,
  [files.runtimeProtocol]: `
import type { ExecutionDomain, ResolvedToolExecution, ToolExecution } from "@agent-os/kernel/tools";
export const toolResultSnapshotFromExecutedPayload = (payload, resolved: ResolvedToolExecution) => ({ execution: resolved.execution });
export const externalToolExecutionReceiptFromExecutedPayload = (payload, resolved: Extract<ResolvedToolExecution, { readonly kind: "external" }>) => ({ execution: resolved.execution });
export const toolReplayArtifactFromExecutedPayload = (payload: ToolExecutedPayload, resolved: ResolvedToolExecution) => resolved.witness;
`,
  [files.submit]: `
import type { ExecutionDomainDeclaration } from "@agent-os/kernel/tools";
export interface SubmitSpec { readonly executionDomains?: ReadonlyArray<ExecutionDomainDeclaration>; }
`,
  [files.bindings]: `
import type { ExecutionDomainDeclaration } from "@agent-os/kernel/tools";
export interface AgentBindings { readonly executionDomains?: ReadonlyArray<ExecutionDomainDeclaration>; }
export interface AgentSubmitBindings { readonly executionDomains?: ReadonlyArray<ExecutionDomainDeclaration>; }
`,
  [files.runtime]: `
validateExecutionDomainRegistry(spec.tools, { domains: spec.executionDomains ?? [] });
const resolvedExecution = resolveToolExecution(decodedTool.event.payload.execution, { domains: executionDomains });
if (!resolvedExecution.ok) return { reason: "tool_execution_witness_resolution_failed" };
toolReplayArtifactFromExecutedPayload(payload, resolvedExecution.resolved);
return { reason: "invalid_execution_domain_registry" };
`,
  [files.kernelTest]: `
it("rejects access-mismatched and write snapshot replay laws", () => {});
it("resolves replay witness only from the domain law", () => {});
`,
  [files.runtimeProtocolTest]: `
const resolved = resolveToolExecution(execution, { domains });
toolReplayArtifactFromExecutedPayload(payload, resolved);
`,
  [files.runtimeTest]: `
executionDomains: [
  { replay: { access: "write", witness: "receipt" } }
]
`,
};

const collectSelfTestFailures = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentos-tool-witness-single-source-"));
  try {
    for (const [file, source] of Object.entries(positiveFixtures)) {
      writeFixture(root, file, source);
    }
    const baseline = collectFailures(root);
    if (baseline.length > 0) {
      return [`tool witness positive fixture failed:\n${baseline.join("\n")}`];
    }

    writeFixture(
      root,
      files.submit,
      "export interface SubmitSpec { readonly witness: ToolReplayWitness; }",
    );
    let rejected = collectFailures(root);
    if (!rejected.some((failure) => failure.includes("witness override"))) {
      return [`submit witness mutation was not rejected: ${JSON.stringify(rejected)}`];
    }

    writeFixture(
      root,
      files.runtimeProtocol,
      "export const toolReplayArtifactFromExecutedPayload = (payload: ToolExecutedPayload) => payload.execution.kind === 'deterministic';",
    );
    rejected = collectFailures(root);
    if (!rejected.some((failure) => failure.includes("without resolved execution"))) {
      return [`payload-derived witness mutation was not rejected: ${JSON.stringify(rejected)}`];
    }

    writeFixture(
      root,
      files.runtime,
      "toolReplayArtifactFromExecutedPayload(payload, payload.execution);",
    );
    rejected = collectFailures(root);
    if (!rejected.some((failure) => failure.includes("resolveToolExecution"))) {
      return [`runtime missing resolution mutation was not rejected: ${JSON.stringify(rejected)}`];
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
    ? "tool witness single-source self-test passed"
    : "tool witness single-source passed",
);
