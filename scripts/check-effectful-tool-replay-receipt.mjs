#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

const protocolFile = "packages/runtime-protocol/src/runtime-events.ts";
const protocolTest = "packages/runtime-protocol/test/runtime-events.test.ts";
const runtimeFile = "packages/runtime/src/submit-agent.ts";
const runtimeTest = "packages/runtime/test/submit-agent-runtime-events.test.ts";

const read = (root, file) => fs.readFileSync(path.join(root, file), "utf8");

const blockFrom = (source, marker, nextMarker = "\nexport ") => {
  const start = source.indexOf(marker);
  if (start < 0) return "";
  const next = source.indexOf(nextMarker, start + marker.length);
  return source.slice(start, next < 0 ? undefined : next);
};

const collectFailures = (root = repoRoot) => {
  const failures = [];
  const protocol = read(root, protocolFile);
  const runtime = read(root, runtimeFile);
  const protocolTests = read(root, protocolTest);
  const runtimeTests = read(root, runtimeTest);

  const snapshotBlock = blockFrom(protocol, "export interface ToolResultSnapshot");
  if (!snapshotBlock.includes("readonly execution: ToolExecution")) {
    failures.push(`${protocolFile}: ToolResultSnapshot must record the resolved snapshot execution`);
  }
  if (/readonly execution:\s*DeterministicToolExecution/u.test(snapshotBlock)) {
    failures.push(`${protocolFile}: ToolResultSnapshot is still deterministic-only`);
  }

  const snapshotConstructor = blockFrom(
    protocol,
    "export const toolResultSnapshotFromExecutedPayload",
  );
  if (!snapshotConstructor.includes("resolved: ResolvedToolExecution")) {
    failures.push(`${protocolFile}: raw snapshot constructor must accept resolved witness input`);
  }
  if (!snapshotConstructor.includes("execution: resolved.execution")) {
    failures.push(`${protocolFile}: raw snapshot constructor must use resolved execution`);
  }

  const receiptBlock = blockFrom(protocol, "export interface ExternalToolExecutionReceipt");
  if (receiptBlock.length === 0) {
    failures.push(`${protocolFile}: missing ExternalToolExecutionReceipt`);
  }
  if (!receiptBlock.includes("ExternalReceiptAnchorRef")) {
    failures.push(`${protocolFile}: external receipt must use an external receipt anchor type`);
  }

  const receiptConstructor = blockFrom(
    protocol,
    "export const externalToolExecutionReceiptFromExecutedPayload",
  );
  if (!protocol.includes('anchorKind === "external_receipt"')) {
    failures.push(`${protocolFile}: external receipt constructor missing external receipt check`);
  }
  for (const term of [
    "idempotencyKey: payload.claim.operationRef",
    "EXTERNAL_TOOL_REPLAY_REQUIRES_RECEIPT_REASON",
  ]) {
    if (!receiptConstructor.includes(term)) {
      failures.push(`${protocolFile}: external receipt constructor missing ${term}`);
    }
  }

  const artifactConstructor = blockFrom(
    protocol,
    "export const toolReplayArtifactFromExecutedPayload",
  );
  for (const term of [
    'resolved.witness === "snapshot"',
    "toolResultSnapshotFromExecutedPayload",
    "externalToolExecutionReceiptFromExecutedPayload",
  ]) {
    if (!artifactConstructor.includes(term)) {
      failures.push(`${protocolFile}: replay artifact constructor missing ${term}`);
    }
  }

  const snapshotReplay = blockFrom(protocol, "export const replayToolResultFromSnapshot");
  if (/external_tool_replay_requires_receipt/u.test(snapshotReplay)) {
    failures.push(`${protocolFile}: raw snapshot replay still case-analyzes external execution`);
  }
  if (/\.execute\s*\(/u.test(snapshotReplay)) {
    failures.push(`${protocolFile}: raw snapshot replay calls live tool execute`);
  }
  if (!protocol.includes("export const replayExternalToolExecutionFromReceipt")) {
    failures.push(`${protocolFile}: missing external receipt replay helper`);
  }

  const resumeReplay = blockFrom(
    runtime,
    "const replayMessagesToInterruptedTool",
    "\n/** The single termination funnel",
  );
  if (!resumeReplay.includes("toolReplayArtifactFromExecutedPayload")) {
    failures.push(`${runtimeFile}: resume replay must use protocol replay artifacts`);
  }
  if (!resumeReplay.includes("replayToolFromArtifact")) {
    failures.push(`${runtimeFile}: resume replay must replay the selected artifact`);
  }
  if (/decodedTool\.event\.payload\.result/u.test(resumeReplay)) {
    failures.push(`${runtimeFile}: resume replay reads raw tool result payload`);
  }

  const guardIndex = runtime.indexOf('tool.execution.kind === "external"');
  const executeIndex = runtime.indexOf("return yield* executeTool", guardIndex);
  if (guardIndex < 0 || executeIndex < 0) {
    failures.push(`${runtimeFile}: missing submit-time external receipt guard before execute`);
  }
  if (!runtime.includes("EXTERNAL_TOOL_EXECUTION_REQUIRES_RECEIPT_REASON")) {
    failures.push(`${runtimeFile}: missing shared external execution receipt reason`);
  }

  if (
    !/does not build a raw result snapshot for an external tool without a receipt/u.test(
      protocolTests,
    )
  ) {
    failures.push(`${protocolTest}: missing external no-raw-snapshot test`);
  }
  if (
    !/replays receipt-backed external tool execution from the receipt artifact/u.test(
      protocolTests,
    )
  ) {
    failures.push(`${protocolTest}: missing receipt-backed external replay test`);
  }
  if (
    !/does not execute an external tool without a receipt-backed terminal contract/u.test(
      runtimeTests,
    )
  ) {
    failures.push(`${runtimeTest}: missing submit-time external receipt guard test`);
  }

  return failures;
};

const writeFixture = (root, file, source) => {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, source);
};

const collectSelfTestFailures = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentos-external-tool-replay-"));
  try {
    writeFixture(
      root,
      protocolFile,
      [
        "export type ToolExecution = { readonly kind: 'deterministic' } | { readonly kind: 'external' };",
        "export type ResolvedToolExecution = { readonly witness: 'snapshot' | 'receipt'; readonly execution: ToolExecution };",
        'export type ExternalReceiptAnchorRef = { readonly anchorKind: "external_receipt" };',
        "export interface ToolResultSnapshot {",
        "  readonly execution: ToolExecution;",
        "}",
        "export interface ExternalToolExecutionReceipt {",
        "  readonly receipt: ExternalReceiptAnchorRef;",
        "}",
        'export const EXTERNAL_TOOL_REPLAY_REQUIRES_RECEIPT_REASON = "external_tool_replay_requires_receipt";',
        "export const toolResultSnapshotFromExecutedPayload = (payload, resolved: ResolvedToolExecution) => ({ ...payload, execution: resolved.execution });",
        "export const externalToolExecutionReceiptFromExecutedPayload = (payload) => {",
        '  if (payload.claim.anchorRef.anchorKind === "external_receipt") {',
        "    return { ok: true, artifact: { idempotencyKey: payload.claim.operationRef, receipt: payload.claim.anchorRef } };",
        "  }",
        "  return { ok: false, reason: EXTERNAL_TOOL_REPLAY_REQUIRES_RECEIPT_REASON };",
        "};",
        "export const toolReplayArtifactFromExecutedPayload = (payload, resolved) => {",
        '  if (resolved.witness === "snapshot") return toolResultSnapshotFromExecutedPayload(payload, resolved);',
        "  return externalToolExecutionReceiptFromExecutedPayload(payload);",
        "};",
        "export const replayToolResultFromSnapshot = (snapshot) => snapshot.result;",
        "export const replayExternalToolExecutionFromReceipt = (receipt) => receipt.result;",
      ].join("\n"),
    );
    writeFixture(
      root,
      runtimeFile,
      [
        "const replayMessagesToInterruptedTool = () => {",
        "  const artifact = toolReplayArtifactFromExecutedPayload(payload);",
        "  return replayToolFromArtifact(artifact.artifact);",
        "}",
        "/** The single termination funnel */",
        'if (tool.execution.kind === "external") {',
        "  return EXTERNAL_TOOL_EXECUTION_REQUIRES_RECEIPT_REASON;",
        "}",
        "return yield* executeTool(tool);",
      ].join("\n"),
    );
    writeFixture(
      root,
      protocolTest,
      [
        "it('does not build a raw result snapshot for an external tool without a receipt', () => {});",
        "it('replays receipt-backed external tool execution from the receipt artifact', () => {});",
      ].join("\n"),
    );
    writeFixture(
      root,
      runtimeTest,
      "it('does not execute an external tool without a receipt-backed terminal contract', () => {});",
    );
    const baseline = collectFailures(root);
    if (baseline.length > 0) {
      return [`external tool replay receipt positive fixture failed:\n${baseline.join("\n")}`];
    }

    writeFixture(
      root,
      protocolFile,
      [
        "export interface ToolResultSnapshot {",
        "  readonly execution: DeterministicToolExecution;",
        "}",
        "export interface ExternalToolExecutionReceipt {}",
        "export const toolResultSnapshotFromExecutedPayload = (payload: ToolExecutedPayload) => payload;",
        "export const replayToolResultFromSnapshot = (snapshot) => {",
        "  if (snapshot.execution.kind === 'external') return { reason: 'external_tool_replay_requires_receipt' };",
        "  return snapshot.result;",
        "};",
      ].join("\n"),
    );
    writeFixture(
      root,
      runtimeFile,
      [
        "const replayMessagesToInterruptedTool = () => decodedTool.event.payload.result;",
        "/** The single termination funnel */",
        "return yield* executeTool(tool);",
      ].join("\n"),
    );
    const rejected = collectFailures(root);
    if (
      !rejected.some((failure) => failure.includes("deterministic-only")) ||
      !rejected.some((failure) => failure.includes("resume replay reads raw tool result"))
    ) {
      return [
        `external tool replay receipt mutation fixture was not rejected: ${JSON.stringify(
          rejected,
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
    ? "external tool replay receipt self-test passed"
    : "external tool replay receipt passed",
);
