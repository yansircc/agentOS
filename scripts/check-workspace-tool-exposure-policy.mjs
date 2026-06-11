#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

const files = {
  workspaceEnv: "packages/execution-domains/workspace-env/src/index.ts",
  workspaceEnvTest: "packages/execution-domains/workspace-env/test/workspace-env.test.ts",
  workspaceBinding: "packages/composers/workspace-binding/src/index.ts",
  workspaceBindingTest: "packages/composers/workspace-binding/test/workspace-binding.test.ts",
  runtime: "packages/runtime/src/submit-agent.ts",
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
  const workspaceEnv = read(root, files.workspaceEnv);
  const workspaceEnvTest = read(root, files.workspaceEnvTest);
  const workspaceBinding = read(root, files.workspaceBinding);
  const workspaceBindingTest = read(root, files.workspaceBindingTest);
  const runtime = read(root, files.runtime);
  const runtimeTest = read(root, files.runtimeTest);

  requireTerms(failures, workspaceEnv, files.workspaceEnv, [
    "export type WorkspaceToolCategory",
    "export type WorkspaceToolName",
    "export interface WorkspaceToolSpec",
    "export type WorkspaceTools",
    "const workspaceToolDefinitions",
    "export const WORKSPACE_TOOL_SPECS",
    "workspaceToolDefinitions.map",
    'category: "read"',
    'category: "mutation"',
    'category: "shell"',
    'access: "read"',
    'access: "write"',
  ]);
  requireTerms(failures, workspaceEnvTest, files.workspaceEnvTest, [
    "declares workspace tool specs as the generator for tool names and access",
    "WORKSPACE_TOOL_SPECS.map",
    '["read_file", "read", "read"]',
    '["run_shell", "shell", "write"]',
  ]);

  requireTerms(failures, workspaceBinding, files.workspaceBinding, [
    "export type WorkspaceToolExposureProfile",
    "export interface WorkspaceToolExposurePolicy",
    "export const WORKSPACE_TOOL_EXPOSURE_PROFILES",
    'read: ["read_file", "list_files", "glob_files", "grep_files"]',
    'mutation: ["write_file", "edit_file", "delete_path"]',
    'shell: ["run_shell"]',
    'policy.exposure ?? ["read"]',
    'mutationPolicy === "disabled"',
    'shellPolicy === "disabled"',
    'replay: { access: "read" as const, witness: "snapshot" as const }',
    'replay: { access: "write" as const, witness: "receipt" as const }',
    "selectedWorkspaceToolNames(options)",
    "selectTools(tools, selectedNames)",
  ]);
  rejectPatterns(failures, workspaceBinding, files.workspaceBinding, [
    [/tools:\s*tools\b/u, "binding returns full workspace tool registry"],
    [/filter\([^)]*category/u, "binding derives exposure dynamically from category"],
    [/externalExecutor|effectfulExecutor/u, "binding exposes inline external executor"],
    [/diagnostics|pathPolicy/u, "binding mixes diagnostics/path policy into tool binding"],
  ]);
  requireTerms(failures, workspaceBindingTest, files.workspaceBindingTest, [
    "defaults to read-only submit bindings with snapshot replay law",
    "keeps mutation and shell tools disabled unless receipt-backed policy is explicit",
    'exposure: ["mutation"]',
    'mutationPolicy: "receipt-backed"',
    'witness: "snapshot"',
    'witness: "receipt"',
  ]);

  requireTerms(failures, runtime, files.runtime, [
    "const resolvedExecution = resolveToolExecution(tool.execution",
    'resolvedExecution.resolved.witness === "receipt"',
    "EXTERNAL_TOOL_EXECUTION_REQUIRES_RECEIPT_REASON",
  ]);
  rejectPatterns(failures, runtime, files.runtime, [
    [
      /if\s*\(\s*tool\.execution\.kind === ["']external["']\s*\)\s*\{/u,
      "runtime still rejects all external tools by kind",
    ],
  ]);
  requireTerms(failures, runtimeTest, files.runtimeTest, [
    "executes external read tools when the domain law uses snapshot witness",
    'replay: { access: "read", witness: "snapshot" }',
    "withToolReadRequirement",
  ]);

  return failures;
};

const writeFixture = (root, file, source) => {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, source);
};

const positiveFixtures = {
  [files.workspaceEnv]: `
export type WorkspaceToolCategory = "read" | "mutation" | "shell";
export type WorkspaceToolName = "read_file" | "run_shell";
export interface WorkspaceToolSpec {}
export type WorkspaceTools = {};
const workspaceToolDefinitions = [
  { name: "read_file", category: "read", access: "read" },
  { name: "write_file", category: "mutation", access: "write" },
  { name: "run_shell", category: "shell", access: "write" },
];
export const WORKSPACE_TOOL_SPECS = workspaceToolDefinitions.map((spec) => spec);
`,
  [files.workspaceEnvTest]: `
it("declares workspace tool specs as the generator for tool names and access", () => {
  WORKSPACE_TOOL_SPECS.map((spec) => spec.name);
  expect(value).toEqual([["read_file", "read", "read"], ["run_shell", "shell", "write"]]);
});
`,
  [files.workspaceBinding]: `
export type WorkspaceToolExposureProfile = "read" | "mutation" | "shell";
export interface WorkspaceToolExposurePolicy {}
export const WORKSPACE_TOOL_EXPOSURE_PROFILES = {
  read: ["read_file", "list_files", "glob_files", "grep_files"],
  mutation: ["write_file", "edit_file", "delete_path"],
  shell: ["run_shell"],
};
const exposure = policy.exposure ?? ["read"];
if (mutationPolicy === "disabled") throw new TypeError("mutationPolicy");
if (shellPolicy === "disabled") throw new TypeError("shellPolicy");
const selectedNames = selectedWorkspaceToolNames(options);
const selectedTools = selectTools(tools, selectedNames);
return {
  tools: selectedTools,
  executionDomains: [
    { replay: { access: "read" as const, witness: "snapshot" as const } },
    { replay: { access: "write" as const, witness: "receipt" as const } },
  ],
};
`,
  [files.workspaceBindingTest]: `
it("defaults to read-only submit bindings with snapshot replay law", () => { witness: "snapshot" });
it("keeps mutation and shell tools disabled unless receipt-backed policy is explicit", () => {
  exposure: ["mutation"];
  mutationPolicy: "receipt-backed";
  witness: "receipt";
});
`,
  [files.runtime]: `
const resolvedExecution = resolveToolExecution(tool.execution, { domains });
if (resolvedExecution.resolved.witness === "receipt") {
  return EXTERNAL_TOOL_EXECUTION_REQUIRES_RECEIPT_REASON;
}
`,
  [files.runtimeTest]: `
it("executes external read tools when the domain law uses snapshot witness", () => {
  withToolReadRequirement(read);
  replay: { access: "read", witness: "snapshot" };
});
`,
};

const collectSelfTestFailures = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentos-workspace-exposure-"));
  try {
    for (const [file, source] of Object.entries(positiveFixtures)) {
      writeFixture(root, file, source);
    }
    const baseline = collectFailures(root);
    if (baseline.length > 0) {
      return [`workspace exposure positive fixture failed:\n${baseline.join("\n")}`];
    }

    writeFixture(
      root,
      files.workspaceBinding,
      [
        "export type WorkspaceToolExposureProfile = 'read';",
        "export interface WorkspaceToolExposurePolicy {}",
        "export const WORKSPACE_TOOL_EXPOSURE_PROFILES = { read: [] };",
        "return { tools: tools, diagnostics: {} };",
      ].join("\n"),
    );
    let rejected = collectFailures(root);
    if (!rejected.some((failure) => failure.includes("full workspace tool registry"))) {
      return [`full-registry exposure mutation was not rejected: ${JSON.stringify(rejected)}`];
    }

    writeFixture(root, files.runtime, 'if (tool.execution.kind === "external") {}');
    rejected = collectFailures(root);
    if (!rejected.some((failure) => failure.includes("rejects all external"))) {
      return [`runtime external-kind mutation was not rejected: ${JSON.stringify(rejected)}`];
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
    ? "workspace tool exposure policy self-test passed"
    : "workspace tool exposure policy passed",
);
