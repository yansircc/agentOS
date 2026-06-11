#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

const files = {
  kernel: "packages/kernel/src/tools.ts",
  kernelTest: "packages/kernel/test/tools.test.ts",
  runtimeProtocol: "packages/runtime-protocol/src/runtime-events.ts",
  runtime: "packages/runtime/src/submit-agent.ts",
  runtimeTest: "packages/runtime/test/submit-agent-runtime-events.test.ts",
  workspaceEnv: "packages/execution-domains/workspace-env/src/index.ts",
  workspaceBindingTest: "packages/composers/workspace-binding/test/workspace-binding.test.ts",
  sandbox: "packages/execution-domains/sandbox/src/tool.ts",
  cloudflareFacadeTest: "packages/backends/cloudflare-do/test/facade.test.ts",
};

const read = (root, file) => fs.readFileSync(path.join(root, file), "utf8");

const blockFrom = (source, marker, nextMarker = "\n    }),") => {
  const start = source.indexOf(marker);
  if (start < 0) return "";
  const next = source.indexOf(nextMarker, start + marker.length);
  return source.slice(start, next < 0 ? undefined : next + nextMarker.length);
};

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

const assertToolBlock = (failures, source, file, name, executionToken, requirementToken) => {
  const block = blockFrom(source, `name: "${name}"`);
  if (block.length === 0) {
    failures.push(`${file}: missing workspace tool ${name}`);
    return;
  }
  requireTerms(failures, block, `${file}:${name}`, [
    `execution: ${executionToken}`,
    requirementToken,
  ]);
};

const collectFailures = (root = repoRoot) => {
  const failures = [];
  const kernel = read(root, files.kernel);
  const runtimeProtocol = read(root, files.runtimeProtocol);
  const runtime = read(root, files.runtime);
  const workspaceEnv = read(root, files.workspaceEnv);
  const workspaceBindingTest = read(root, files.workspaceBindingTest);
  const sandbox = read(root, files.sandbox);

  requireTerms(failures, kernel, files.kernel, [
    'export type ToolAccess = "read" | "write"',
    'readonly kind: "deterministic"',
    'readonly kind: "external"; readonly access: ToolAccess; readonly domain: ExecutionDomain',
    "export const deterministicToolExecution",
    "export const externalToolExecution = <A extends ToolAccess>",
    "export const withToolReadRequirement",
    "export const withToolWriteRequirement",
    "export type ToolExecutionRequirements<E extends ToolExecution>",
  ]);
  rejectPatterns(failures, kernel, files.kernel, [
    [/\bpureToolExecution\b/u, "legacy pureToolExecution constructor remains"],
    [/\beffectfulToolExecution\b/u, "legacy effectfulToolExecution constructor remains"],
    [/readonly kind:\s*["']pure["']/u, "legacy pure execution kind remains"],
    [/readonly kind:\s*["']effectful["']/u, "legacy effectful execution kind remains"],
  ]);

  requireTerms(failures, runtimeProtocol, files.runtimeProtocol, [
    "export type DeterministicToolExecution",
    "export type ExternalToolExecution",
    "export interface ExternalToolExecutionReceipt",
    "EXTERNAL_TOOL_REPLAY_REQUIRES_RECEIPT_REASON",
    "EXTERNAL_TOOL_EXECUTION_REQUIRES_RECEIPT_REASON",
    'payload.execution.kind === "deterministic"',
    "externalToolExecutionReceiptFromExecutedPayload",
    "replayExternalToolExecutionFromReceipt",
  ]);
  rejectPatterns(failures, runtimeProtocol, files.runtimeProtocol, [
    [/\bPureToolExecution\b/u, "legacy PureToolExecution type remains"],
    [/\bEffectfulToolExecution\b/u, "legacy EffectfulToolExecution type remains"],
    [/effectful_tool_/u, "legacy effectful reason vocabulary remains"],
    [/kind:\s*Schema\.Literal\(["']pure["']\)/u, "legacy pure schema remains"],
    [/kind:\s*Schema\.Literal\(["']effectful["']\)/u, "legacy effectful schema remains"],
  ]);

  requireTerms(failures, runtime, files.runtime, [
    'resolvedExecution.resolved.witness === "receipt"',
    "EXTERNAL_TOOL_EXECUTION_REQUIRES_RECEIPT_REASON",
  ]);
  rejectPatterns(failures, runtime, files.runtime, [
    [/tool\.execution\.kind === ["']effectful["']/u, "submit guard still checks effectful"],
    [/EFFECTFUL_TOOL_EXECUTION_REQUIRES_RECEIPT_REASON/u, "legacy effectful execution reason remains"],
  ]);

  requireTerms(failures, workspaceEnv, files.workspaceEnv, [
    'const readExecution = externalToolExecution("read", env.domain)',
    'const writeExecution = externalToolExecution("write", env.domain)',
  ]);
  for (const name of ["read_file", "list_files", "glob_files", "grep_files"]) {
    assertToolBlock(failures, workspaceEnv, files.workspaceEnv, name, "readExecution", "withToolReadRequirement");
  }
  for (const name of ["write_file", "edit_file", "delete_path", "run_shell"]) {
    assertToolBlock(
      failures,
      workspaceEnv,
      files.workspaceEnv,
      name,
      "writeExecution",
      "withToolWriteRequirement",
    );
  }

  requireTerms(failures, sandbox, files.sandbox, [
    'externalToolExecution("write"',
    "withToolWriteRequirement",
  ]);

  requireTerms(failures, workspaceBindingTest, files.workspaceBindingTest, [
    'kind: "external"',
    'access: "write"',
  ]);
  rejectPatterns(failures, workspaceBindingTest, files.workspaceBindingTest, [
    [/kind:\s*["']effectful["']/u, "workspace-binding still expects effectful execution"],
    [/effectfulExecutor/u, "workspace-binding still names effectful executor"],
  ]);

  const accesslessFiles = [
    files.kernelTest,
    files.runtimeProtocol,
    files.runtimeTest,
    files.workspaceEnv,
    files.workspaceBindingTest,
    files.sandbox,
    files.cloudflareFacadeTest,
  ];
  for (const file of accesslessFiles) {
    const source = read(root, file);
    rejectPatterns(failures, source, file, [
      [/kind:\s*["']external["']\s*,\s*domain/u, "external execution literal missing access"],
      [/externalToolExecution\(\s*\{/u, "externalToolExecution call missing access"],
    ]);
  }

  return failures;
};

const writeFixture = (root, file, source) => {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, source);
};

const positiveFixtures = {
  [files.kernel]: `
export type ToolAccess = "read" | "write";
export type ToolExecution =
  | { readonly kind: "deterministic" }
  | { readonly kind: "external"; readonly access: ToolAccess; readonly domain: ExecutionDomain };
export const deterministicToolExecution = () => ({ kind: "deterministic" });
export const externalToolExecution = <A extends ToolAccess>(access: A, domain: ExecutionDomain) => ({ kind: "external", access, domain });
export const withToolReadRequirement = (effect) => effect;
export const withToolWriteRequirement = (effect) => effect;
export type ToolExecutionRequirements<E extends ToolExecution> = never;
`,
  [files.runtimeProtocol]: `
export type DeterministicToolExecution = Extract<ToolExecution, { readonly kind: "deterministic" }>;
export type ExternalToolExecution = Extract<ToolExecution, { readonly kind: "external" }>;
export interface ExternalToolExecutionReceipt {}
export const EXTERNAL_TOOL_REPLAY_REQUIRES_RECEIPT_REASON = "external_tool_replay_requires_receipt";
export const EXTERNAL_TOOL_EXECUTION_REQUIRES_RECEIPT_REASON = "external_tool_execution_requires_receipt";
export const toolReplayArtifactFromExecutedPayload = (payload) => payload.execution.kind === "deterministic";
export const externalToolExecutionReceiptFromExecutedPayload = () => {};
export const replayExternalToolExecutionFromReceipt = () => {};
`,
  [files.runtime]: `
if (resolvedExecution.resolved.witness === "receipt") {
  return EXTERNAL_TOOL_EXECUTION_REQUIRES_RECEIPT_REASON;
}
`,
  [files.workspaceEnv]: `
const readExecution = externalToolExecution("read", env.domain);
const writeExecution = externalToolExecution("write", env.domain);
const tools = {
  read_file: defineTool({ name: "read_file", execution: readExecution, execute: () => withToolReadRequirement(read()) }),
  list_files: defineTool({ name: "list_files", execution: readExecution, execute: () => withToolReadRequirement(read()) }),
  glob_files: defineTool({ name: "glob_files", execution: readExecution, execute: () => withToolReadRequirement(read()) }),
  grep_files: defineTool({ name: "grep_files", execution: readExecution, execute: () => withToolReadRequirement(read()) }),
  write_file: defineTool({ name: "write_file", execution: writeExecution, execute: () => withToolWriteRequirement(write()) }),
  edit_file: defineTool({ name: "edit_file", execution: writeExecution, execute: () => withToolWriteRequirement(write()) }),
  delete_path: defineTool({ name: "delete_path", execution: writeExecution, execute: () => withToolWriteRequirement(write()) }),
  run_shell: defineTool({ name: "run_shell", execution: writeExecution, execute: () => withToolWriteRequirement(write()) }),
};
`,
  [files.sandbox]: 'externalToolExecution("write", { kind: "sandbox", ref: "sandbox" }); withToolWriteRequirement(run);',
  [files.workspaceBindingTest]: 'expect(value).toEqual({ kind: "external", access: "write" });',
  [files.kernelTest]: 'execution: { kind: "external", access: "write", domain }',
  [files.runtimeTest]: 'externalToolExecution("write", { kind: "workspace", ref: "workspace" });',
  [files.cloudflareFacadeTest]: 'externalToolExecution("write", domain);',
};

const collectSelfTestFailures = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentos-tool-execution-access-"));
  try {
    for (const [file, source] of Object.entries(positiveFixtures)) {
      writeFixture(root, file, source);
    }
    const baseline = collectFailures(root);
    if (baseline.length > 0) {
      return [`tool execution access positive fixture failed:\n${baseline.join("\n")}`];
    }

    writeFixture(
      root,
      files.kernel,
      `${positiveFixtures[files.kernel]}
export const pureToolExecution = () => ({ kind: "pure" });
export const effectfulToolExecution = () => ({ kind: "effectful" });
`,
    );
    writeFixture(
      root,
      files.workspaceEnv,
      positiveFixtures[files.workspaceEnv].replace('externalToolExecution("read"', "externalToolExecution("),
    );
    writeFixture(root, files.runtime, 'if (tool.execution.kind === "effectful") return EFFECTFUL_TOOL_EXECUTION_REQUIRES_RECEIPT_REASON;');

    const rejected = collectFailures(root);
    if (
      !rejected.some((failure) => failure.includes("pureToolExecution")) ||
      !rejected.some(
        (failure) =>
          failure.includes("externalToolExecution call missing access") ||
          failure.includes('missing const readExecution = externalToolExecution("read", env.domain)'),
      ) ||
      !rejected.some((failure) => failure.includes("submit guard still checks effectful"))
    ) {
      return [
        `tool execution access mutation fixture was not rejected: ${JSON.stringify(rejected)}`,
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
    ? "tool execution access requirements self-test passed"
    : "tool execution access requirements passed",
);
