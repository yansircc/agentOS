#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

const protocolFile = "packages/runtime-protocol/src/runtime-events.ts";
const protocolTest = "packages/runtime-protocol/test/runtime-events.test.ts";
const runtimeTest = "packages/runtime/test/submit-agent-runtime-events.test.ts";
const kernelTest = "packages/kernel/test/tools.test.ts";

const read = (root, file) => fs.readFileSync(path.join(root, file), "utf8");

const replayFunctionBlock = (source) => {
  const start = source.indexOf("export const replayToolResultFromSnapshot");
  if (start < 0) return "";
  const nextExport = source.indexOf("\nexport const ", start + 1);
  return source.slice(start, nextExport < 0 ? undefined : nextExport);
};

const collectFailures = (root = repoRoot) => {
  const failures = [];
  const protocol = read(root, protocolFile);
  if (!protocol.includes("export interface ToolResultSnapshot")) {
    failures.push(`${protocolFile}: missing ToolResultSnapshot`);
  }
  if (!protocol.includes("toolResultSnapshotFromExecutedPayload")) {
    failures.push(`${protocolFile}: missing snapshot constructor`);
  }
  if (!protocol.includes("external_tool_replay_requires_receipt")) {
    failures.push(`${protocolFile}: missing external-tool replay exclusion`);
  }
  const replayBlock = replayFunctionBlock(protocol);
  if (replayBlock.length === 0) {
    failures.push(`${protocolFile}: missing replayToolResultFromSnapshot`);
  }
  if (/\.execute\s*\(/.test(replayBlock)) {
    failures.push(`${protocolFile}: replay helper calls live tool execute`);
  }

  const tests = [read(root, protocolTest), read(root, runtimeTest), read(root, kernelTest)].join(
    "\n",
  );
  if (!/replay.*tool.*not.*called|tool execute.*not.*called|live tool.*not.*called/s.test(tests)) {
    failures.push("tool replay tests must assert live tool execute not called");
  }
  return failures;
};

const writeFixture = (root, file, source) => {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, source);
};

const collectSelfTestFailures = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentos-replay-tool-"));
  try {
    writeFixture(
      root,
      protocolFile,
      [
        "export interface ToolResultSnapshot {}",
        "export const toolResultSnapshotFromExecutedPayload = () => ({});",
        "export const replayToolResultFromSnapshot = (snapshot) => {",
        "  if (snapshot.execution?.kind === 'external') return { ok: false, reason: 'external_tool_replay_requires_receipt' };",
        "  return { ok: true, result: snapshot.result };",
        "};",
      ].join("\n"),
    );
    writeFixture(root, protocolTest, "it('replay mode tool execute not called', () => {})");
    writeFixture(root, runtimeTest, "");
    writeFixture(root, kernelTest, "");
    const baseline = collectFailures(root);
    if (baseline.length > 0) {
      return [`tool replay positive fixture failed:\n${baseline.join("\n")}`];
    }

    writeFixture(
      root,
      protocolFile,
      [
        "export interface ToolResultSnapshot {}",
        "export const toolResultSnapshotFromExecutedPayload = () => ({});",
        "export const replayToolResultFromSnapshot = (_snapshot, tool) => tool.execute({});",
      ].join("\n"),
    );
    const rejected = collectFailures(root);
    if (!rejected.some((failure) => failure.includes("calls live tool execute"))) {
      return [`tool replay mutation fixture was not rejected: ${JSON.stringify(rejected)}`];
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
    ? "replay tool snapshot self-test passed"
    : "replay tool snapshot passed",
);
