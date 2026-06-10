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
  if (!snapshotBlock.includes("readonly execution: PureToolExecution")) {
    failures.push(`${protocolFile}: ToolResultSnapshot must be pure-execution only`);
  }
  if (/readonly execution:\s*(ToolExecution|EffectfulToolExecution)/u.test(snapshotBlock)) {
    failures.push(`${protocolFile}: ToolResultSnapshot accepts non-pure execution`);
  }

  const snapshotConstructor = blockFrom(
    protocol,
    "export const toolResultSnapshotFromExecutedPayload",
  );
  if (!snapshotConstructor.includes("payload: PureToolExecutedPayload")) {
    failures.push(`${protocolFile}: raw snapshot constructor must accept PureToolExecutedPayload`);
  }
  if (/payload:\s*ToolExecutedPayload/u.test(snapshotConstructor)) {
    failures.push(`${protocolFile}: raw snapshot constructor still accepts generic tool payloads`);
  }

  const receiptBlock = blockFrom(
    protocol,
    "export interface EffectfulToolExecutionReceipt",
  );
  if (receiptBlock.length === 0) {
    failures.push(`${protocolFile}: missing EffectfulToolExecutionReceipt`);
  }
  if (!receiptBlock.includes("ExternalReceiptAnchorRef")) {
    failures.push(`${protocolFile}: effectful receipt must use an external receipt anchor type`);
  }

  const receiptConstructor = blockFrom(
    protocol,
    "export const effectfulToolExecutionReceiptFromExecutedPayload",
  );
  if (!protocol.includes('anchorKind === "external_receipt"')) {
    failures.push(`${protocolFile}: effectful receipt constructor missing external receipt check`);
  }
  for (const term of [
    "idempotencyKey: payload.claim.operationRef",
    "EFFECTFUL_TOOL_REPLAY_REQUIRES_RECEIPT_REASON",
  ]) {
    if (!receiptConstructor.includes(term)) {
      failures.push(`${protocolFile}: effectful receipt constructor missing ${term}`);
    }
  }

  const artifactConstructor = blockFrom(protocol, "export const toolReplayArtifactFromExecutedPayload");
  for (const term of [
    'payload.execution.kind === "pure"',
    "toolResultSnapshotFromExecutedPayload",
    "effectfulToolExecutionReceiptFromExecutedPayload",
  ]) {
    if (!artifactConstructor.includes(term)) {
      failures.push(`${protocolFile}: replay artifact constructor missing ${term}`);
    }
  }

  const snapshotReplay = blockFrom(protocol, "export const replayToolResultFromSnapshot");
  if (/effectful_tool_replay_requires_receipt/u.test(snapshotReplay)) {
    failures.push(`${protocolFile}: raw snapshot replay still case-analyzes effectful execution`);
  }
  if (/\.execute\s*\(/u.test(snapshotReplay)) {
    failures.push(`${protocolFile}: raw snapshot replay calls live tool execute`);
  }
  if (!protocol.includes("export const replayEffectfulToolExecutionFromReceipt")) {
    failures.push(`${protocolFile}: missing effectful receipt replay helper`);
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

  const guardIndex = runtime.indexOf('tool.execution.kind === "effectful"');
  const executeIndex = runtime.indexOf("return yield* executeTool", guardIndex);
  if (guardIndex < 0 || executeIndex < 0) {
    failures.push(`${runtimeFile}: missing submit-time effectful receipt guard before execute`);
  }
  if (!runtime.includes("EFFECTFUL_TOOL_EXECUTION_REQUIRES_RECEIPT_REASON")) {
    failures.push(`${runtimeFile}: missing shared effectful execution receipt reason`);
  }

  if (!/does not build a raw result snapshot for an effectful tool without a receipt/u.test(protocolTests)) {
    failures.push(`${protocolTest}: missing effectful no-raw-snapshot test`);
  }
  if (!/replays receipt-backed effectful tool execution from the receipt artifact/u.test(protocolTests)) {
    failures.push(`${protocolTest}: missing receipt-backed effectful replay test`);
  }
  if (!/does not execute an effectful tool without a receipt-backed terminal contract/u.test(runtimeTests)) {
    failures.push(`${runtimeTest}: missing submit-time effectful receipt guard test`);
  }

  return failures;
};

const writeFixture = (root, file, source) => {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, source);
};

const collectSelfTestFailures = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentos-effectful-tool-replay-"));
  try {
    writeFixture(
      root,
      protocolFile,
      [
        "export type PureToolExecution = { readonly kind: 'pure' };",
        "export type ExternalReceiptAnchorRef = { readonly anchorKind: \"external_receipt\" };",
        "export interface ToolResultSnapshot {",
        "  readonly execution: PureToolExecution;",
        "}",
        "export interface EffectfulToolExecutionReceipt {",
        "  readonly receipt: ExternalReceiptAnchorRef;",
        "}",
        "export const EFFECTFUL_TOOL_REPLAY_REQUIRES_RECEIPT_REASON = \"effectful_tool_replay_requires_receipt\";",
        "export const toolResultSnapshotFromExecutedPayload = (payload: PureToolExecutedPayload) => payload;",
        "export const effectfulToolExecutionReceiptFromExecutedPayload = (payload) => {",
        "  if (payload.claim.anchorRef.anchorKind === \"external_receipt\") {",
        "    return { ok: true, artifact: { idempotencyKey: payload.claim.operationRef, receipt: payload.claim.anchorRef } };",
        "  }",
        "  return { ok: false, reason: EFFECTFUL_TOOL_REPLAY_REQUIRES_RECEIPT_REASON };",
        "};",
        "export const toolReplayArtifactFromExecutedPayload = (payload) => {",
        "  if (payload.execution.kind === \"pure\") return toolResultSnapshotFromExecutedPayload(payload);",
        "  return effectfulToolExecutionReceiptFromExecutedPayload(payload);",
        "};",
        "export const replayToolResultFromSnapshot = (snapshot) => snapshot.result;",
        "export const replayEffectfulToolExecutionFromReceipt = (receipt) => receipt.result;",
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
        "if (tool.execution.kind === \"effectful\") {",
        "  return EFFECTFUL_TOOL_EXECUTION_REQUIRES_RECEIPT_REASON;",
        "}",
        "return yield* executeTool(tool);",
      ].join("\n"),
    );
    writeFixture(
      root,
      protocolTest,
      [
        "it('does not build a raw result snapshot for an effectful tool without a receipt', () => {});",
        "it('replays receipt-backed effectful tool execution from the receipt artifact', () => {});",
      ].join("\n"),
    );
    writeFixture(
      root,
      runtimeTest,
      "it('does not execute an effectful tool without a receipt-backed terminal contract', () => {});",
    );
    const baseline = collectFailures(root);
    if (baseline.length > 0) {
      return [`effectful tool replay receipt positive fixture failed:\n${baseline.join("\n")}`];
    }

    writeFixture(
      root,
      protocolFile,
      [
        "export interface ToolResultSnapshot {",
        "  readonly execution: ToolExecution;",
        "}",
        "export interface EffectfulToolExecutionReceipt {}",
        "export const toolResultSnapshotFromExecutedPayload = (payload: ToolExecutedPayload) => payload;",
        "export const replayToolResultFromSnapshot = (snapshot) => {",
        "  if (snapshot.execution.kind === 'effectful') return { reason: 'effectful_tool_replay_requires_receipt' };",
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
      !rejected.some((failure) => failure.includes("raw snapshot constructor")) ||
      !rejected.some((failure) => failure.includes("resume replay reads raw tool result"))
    ) {
      return [
        `effectful tool replay receipt mutation fixture was not rejected: ${JSON.stringify(
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
    ? "effectful tool replay receipt self-test passed"
    : "effectful tool replay receipt passed",
);
