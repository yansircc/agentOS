#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

const files = {
  carrier: "packages/carriers/workspace-op/src/definition.ts",
  carrierEvents: "packages/carriers/workspace-op/src/events.ts",
  provider: "packages/providers/workspace-op-local/src/index.ts",
  binding: "packages/composers/workspace-binding/src/index.ts",
  runtime: "packages/runtime/src/submit-agent.ts",
  protocol: "packages/runtime-protocol/src/runtime-events.ts",
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
  const carrier = read(root, files.carrier);
  const carrierEvents = read(root, files.carrierEvents);
  const provider = read(root, files.provider);
  const binding = read(root, files.binding);
  const runtime = read(root, files.runtime);
  const protocol = read(root, files.protocol);

  requireTerms(failures, carrier, files.carrier, [
    'WORKSPACE_OP_EVENT_PREFIX = "workspace_op."',
    'WORKSPACE_OP_FACT_OWNER = "@agent-os/workspace-op"',
    'WORKSPACE_OP_PROJECTION_KIND = "workspace_op.status"',
    'claim: pre({ key: "claim" })',
    'claim: lived({ key: "claim", anchorKinds: ["external_receipt"] })',
    "claim: rejected({",
  ]);
  requireTerms(failures, carrierEvents, files.carrierEvents, [
    "projectWorkspaceOperation",
    "workspaceOperationToolResult",
    "validateTerminalClaim(workspaceOpSettlementContract",
  ]);

  requireTerms(failures, provider, files.provider, [
    "createWorkspaceOperationLocalProvider",
    "completedByIdempotencyKey",
    "settleWorkspaceOperationCompleted",
    "rejectWorkspaceOperation",
    "resultHash",
    "stdoutPreview",
    "stderrPreview",
    "stdoutHash",
    "stderrHash",
    "truncateUtf8",
  ]);
  rejectPatterns(failures, provider, files.provider, [
    [/toolExecutedEvent|toolRejectedEvent/u, "provider writes runtime tool facts directly"],
    [/effectfulExecutor|externalExecutor/u, "provider exposes inline executor vocabulary"],
    [/\bstdout:\s*result\.stdout/u, "provider emits raw stdout field"],
    [/\bstderr:\s*result\.stderr/u, "provider emits raw stderr field"],
    [/\bcontent:\s*request\.content/u, "provider emits raw file content in completion"],
  ]);

  requireTerms(failures, binding, files.binding, [
    "@agent-os/workspace-op",
    "receiptBackedWorkspaceTool",
    "ctx.emitIntent",
    "ctx.awaitProjection",
    "receiptBackedToolResult",
    "receiptBackedTools",
    "WORKSPACE_OP_KIND.REQUESTED",
    "WORKSPACE_OP_PROJECTION_KIND",
    "WORKSPACE_OP_FACT_OWNER",
  ]);
  rejectPatterns(failures, binding, files.binding, [
    [/effectfulExecutor|externalExecutor/u, "binding exposes inline external executor"],
    [/diagnostics|pathPolicy/u, "binding mixes diagnostics/path policy into receipt path"],
  ]);

  requireTerms(failures, runtime, files.runtime, [
    "receiptBackedToolBindingReason",
    "receiptBackedToolResultFromUnknown",
    "claimMatchesPreClaim",
    "EXTERNAL_TOOL_EXECUTION_REQUIRES_RECEIPT_REASON",
    'resolvedExecution.resolved.witness === "receipt"',
  ]);
  requireTerms(failures, protocol, files.protocol, [
    "RECEIPT_BACKED_TOOL_RESULT_VERSION",
    "receiptBackedToolResult",
    "receiptBackedToolResultFromUnknown",
    'anchorKind !== "external_receipt"',
  ]);

  return failures;
};

const writeFixture = (root, file, source) => {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, source);
};

const positiveFixtures = {
  [files.carrier]: `
export const WORKSPACE_OP_EVENT_PREFIX = "workspace_op.";
export const WORKSPACE_OP_FACT_OWNER = "@agent-os/workspace-op";
export const WORKSPACE_OP_PROJECTION_KIND = "workspace_op.status";
claim: pre({ key: "claim" });
claim: lived({ key: "claim", anchorKinds: ["external_receipt"] });
claim: rejected({
`,
  [files.carrierEvents]: `
validateTerminalClaim(workspaceOpSettlementContract, value);
export const workspaceOperationToolResult = () => {};
export const projectWorkspaceOperation = () => {};
`,
  [files.provider]: `
export const createWorkspaceOperationLocalProvider = () => {
  const completedByIdempotencyKey = new Map();
  settleWorkspaceOperationCompleted();
  rejectWorkspaceOperation();
  const resultHash = "";
  const stdoutPreview = "";
  const stderrPreview = "";
  const stdoutHash = "";
  const stderrHash = "";
  truncateUtf8();
};
`,
  [files.binding]: `
import "@agent-os/workspace-op";
const receiptBackedWorkspaceTool = () => {
  ctx.emitIntent();
  ctx.awaitProjection();
  receiptBackedToolResult();
  receiptBackedTools;
  WORKSPACE_OP_KIND.REQUESTED;
  WORKSPACE_OP_PROJECTION_KIND;
  WORKSPACE_OP_FACT_OWNER;
};
`,
  [files.runtime]: `
const receiptBackedToolBindingReason = () => {};
receiptBackedToolResultFromUnknown();
claimMatchesPreClaim();
EXTERNAL_TOOL_EXECUTION_REQUIRES_RECEIPT_REASON;
if (resolvedExecution.resolved.witness === "receipt") {}
`,
  [files.protocol]: `
export const RECEIPT_BACKED_TOOL_RESULT_VERSION = "receipt-backed-tool-result-v1";
export const receiptBackedToolResult = () => {
  if (anchorKind !== "external_receipt") {}
};
export const receiptBackedToolResultFromUnknown = () => {};
`,
};

const collectSelfTestFailures = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentos-workspace-op-receipt-"));
  try {
    for (const [file, source] of Object.entries(positiveFixtures)) writeFixture(root, file, source);
    const baseline = collectFailures(root);
    if (baseline.length > 0) {
      return [`workspace-op receipt positive fixture failed:\n${baseline.join("\n")}`];
    }

    writeFixture(root, files.binding, "const externalExecutor = () => {};");
    let rejected = collectFailures(root);
    if (!rejected.some((failure) => failure.includes("inline external executor"))) {
      return [`inline executor mutation was not rejected: ${JSON.stringify(rejected)}`];
    }

    writeFixture(root, files.provider, "const payload = { stdout: result.stdout };");
    rejected = collectFailures(root);
    if (!rejected.some((failure) => failure.includes("raw stdout"))) {
      return [`raw stdout mutation was not rejected: ${JSON.stringify(rejected)}`];
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
