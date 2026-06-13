#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

const adapterPath = "packages/wire-adapters/ag-ui/src/index.ts";

const read = (root, file) => fs.readFileSync(path.join(root, file), "utf8");

const requiredTokens = [
  "export type AgUiSafeLedgerEvent",
  "export type AgUiSafeEventProjector",
  "readonly safeEventProjectors?:",
  "projectRuntimeSafeLedgerEvent",
  "projectWorkspaceJobSafeLedgerEvent",
  "projectWorkspaceOperationSafeLedgerEvent",
  "export const projectSafeLedgerEventToAgUiFrames",
  "export const verifyAgUiFrameSafety =",
];

const forbiddenTokens = [
  "AgUiFrameMapper",
  "projectExtensionEvent",
  "projectSafeExtensionEvent",
  "safeExtensionPayload",
  "projectAgUiSafeExtensionPayload",
  "decodeRuntimeLedgerEvent",
  "projectRuntimeEventToAgUiFrames",
  "mapFrame",
  "redactAgUiToolPayloadFrame",
  "includeRunInput",
  "inputForRun",
  "stringifyWireValue",
];

const forbiddenPatterns = [
  {
    pattern: /delta:\s*item\.call\.function\.arguments/u,
    description: "raw tool call arguments projected to TOOL_CALL_ARGS",
  },
  {
    pattern: /content:\s*(?:item\.content|event\.payload\.result)/u,
    description: "raw tool result projected to TOOL_CALL_RESULT",
  },
  {
    pattern: /event\.payload/u,
    description: "AG-UI adapter reads raw ledger payload instead of owner safe events",
  },
  {
    pattern: /final:\s*event\.payload\.final/u,
    description: "raw final output projected to RUN_FINISHED",
  },
  {
    pattern: /output:\s*event\.payload\.output/u,
    description: "raw structured output projected to RUN_FINISHED",
  },
  {
    pattern: /readonly\s+scopeRef:/u,
    description: "raw scopeRef exposed in AG-UI envelope",
  },
  {
    pattern: /readonly\s+factOwnerRef:/u,
    description: "raw fact owner exposed in AG-UI envelope",
  },
  {
    pattern: /readonly\s+effectAuthorityRef:/u,
    description: "raw effect authority exposed in AG-UI envelope",
  },
  {
    pattern: /eventScopeRef:/u,
    description: "raw scopeRef exposed in envelope frame",
  },
];

const collectFailures = (root = repoRoot) => {
  const failures = [];
  const source = read(root, adapterPath);

  for (const token of requiredTokens) {
    if (!source.includes(token)) {
      failures.push(`${adapterPath}: missing owner-safe projection token ${token}`);
    }
  }

  for (const token of forbiddenTokens) {
    if (source.includes(token)) {
      failures.push(`${adapterPath}: forbidden raw egress escape hatch ${token}`);
    }
  }

  for (const { pattern, description } of forbiddenPatterns) {
    if (pattern.test(source)) {
      failures.push(`${adapterPath}: ${description}`);
    }
  }

  return failures;
};

const writeFixture = (root, relativePath, source) => {
  const file = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, source);
};

const validAdapterFixture = `
import { projectRuntimeSafeLedgerEvent } from "@agent-os/runtime-protocol";
import { projectWorkspaceJobSafeLedgerEvent } from "@agent-os/workspace-job";
import { projectWorkspaceOperationSafeLedgerEvent } from "@agent-os/workspace-op";
export type AgUiSafeLedgerEvent = { readonly id: number };
export type AgUiSafeEventProjector = (event: unknown) => AgUiSafeLedgerEvent | undefined;
export type AgUiLedgerProjectionSpec = {
  readonly safeEventProjectors?: readonly AgUiSafeEventProjector[];
};
export const verifyAgUiFrameSafety = () => [];
export const projectSafeLedgerEventToAgUiFrames = (event) => [];
void projectRuntimeSafeLedgerEvent;
void projectWorkspaceJobSafeLedgerEvent;
void projectWorkspaceOperationSafeLedgerEvent;
`;

const collectSelfTestFailures = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentos-agui-egress-allowlist-"));
  try {
    writeFixture(root, adapterPath, validAdapterFixture);
    const baseline = collectFailures(root);
    if (baseline.length > 0) {
      return [`AG-UI egress allow-list positive fixture failed:\n${baseline.join("\n")}`];
    }

    writeFixture(
      root,
      adapterPath,
      `${validAdapterFixture}
export type AgUiFrameMapper = (frame, event) => frame;
export const leak = (item, event) => ({
  delta: item.call.function.arguments,
  content: event.payload.result,
});
`,
    );
    const rejected = collectFailures(root);
    if (
      !rejected.some((failure) => failure.includes("AgUiFrameMapper")) ||
      !rejected.some((failure) => failure.includes("raw tool call arguments")) ||
      !rejected.some((failure) => failure.includes("raw tool result")) ||
      !rejected.some((failure) => failure.includes("raw ledger payload"))
    ) {
      return [`AG-UI owner-safe mutation fixture was not rejected: ${JSON.stringify(rejected)}`];
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
    ? "AG-UI owner-safe egress self-test passed"
    : "AG-UI owner-safe egress passed",
);
