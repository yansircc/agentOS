#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

const protocolFile = "packages/backends/protocol/src/index.ts";
const protocolTest = "packages/backends/protocol/test/dispatch-payload.test.ts";
const cloudflareTest = "packages/backends/cloudflare-do/test/dispatch-contract.worker.test.ts";

const read = (root, file) => fs.readFileSync(path.join(root, file), "utf8");

const replayFunctionBlock = (source) => {
  const match = source.match(/export const replayDispatchDeliveryFromSnapshot[\s\S]*?\n}\);/m);
  return match?.[0] ?? "";
};

const collectFailures = (root = repoRoot) => {
  const failures = [];
  const protocol = read(root, protocolFile);
  if (!protocol.includes("export interface DispatchReplaySnapshot")) {
    failures.push(`${protocolFile}: missing DispatchReplaySnapshot`);
  }
  if (!protocol.includes("dispatchReplaySnapshotFromDeliveredPayload")) {
    failures.push(`${protocolFile}: missing snapshot projection from delivered payload`);
  }
  const replayBlock = replayFunctionBlock(protocol);
  if (replayBlock.length === 0) {
    failures.push(`${protocolFile}: missing replayDispatchDeliveryFromSnapshot`);
  }
  if (/\.deliver\s*\(/.test(replayBlock)) {
    failures.push(`${protocolFile}: replay helper calls live dispatch deliver`);
  }

  const tests = `${read(root, protocolTest)}\n${read(root, cloudflareTest)}`;
  if (
    !/replay mode .*DispatchTargetAdapter not called|replay mode .*live dispatch adapter not called/s.test(
      tests,
    )
  ) {
    failures.push("dispatch replay tests must assert live DispatchTargetAdapter not called");
  }
  return failures;
};

const writeFixture = (root, file, source) => {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, source);
};

const collectSelfTestFailures = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentos-replay-dispatch-"));
  try {
    writeFixture(
      root,
      protocolFile,
      [
        "export interface DispatchReplaySnapshot {}",
        "export const dispatchReplaySnapshotFromDeliveredPayload = () => ({});",
        "export const replayDispatchDeliveryFromSnapshot = (snapshot) => ({",
        "  receipt: snapshot.deliveryReceipt,",
        "});",
      ].join("\n"),
    );
    writeFixture(
      root,
      protocolTest,
      "it('replay mode DispatchTargetAdapter not called', () => {})",
    );
    writeFixture(root, cloudflareTest, "");
    const baseline = collectFailures(root);
    if (baseline.length > 0) {
      return [`replay dispatch positive fixture failed:\n${baseline.join("\n")}`];
    }

    writeFixture(
      root,
      protocolFile,
      [
        "export interface DispatchReplaySnapshot {}",
        "export const dispatchReplaySnapshotFromDeliveredPayload = () => ({});",
        "export const replayDispatchDeliveryFromSnapshot = (_snapshot, adapter) => ({",
        "  receipt: adapter.deliver({}),",
        "});",
      ].join("\n"),
    );
    const rejected = collectFailures(root);
    if (!rejected.some((failure) => failure.includes("calls live dispatch deliver"))) {
      return [`replay dispatch mutation fixture was not rejected: ${JSON.stringify(rejected)}`];
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
    ? "replay dispatch snapshot self-test passed"
    : "replay dispatch snapshot passed",
);
