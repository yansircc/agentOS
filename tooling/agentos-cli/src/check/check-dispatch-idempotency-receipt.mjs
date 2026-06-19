#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const repoRoot = process.cwd();

const protocolFile = "packages/backends/protocol/src/index.ts";
const protocolTest = "packages/backends/protocol/test/dispatch-payload.test.ts";
const backendContractTest = "packages/backends/protocol/test/contract/runtime-backend-contract.ts";
const cloudflareTest = "packages/backends/cloudflare-do/test/dispatch-contract.worker.test.ts";

const read = (root, file) => fs.readFileSync(path.join(root, file), "utf8");

const functionBlock = (source, name) => {
  const start = source.indexOf(`export const ${name}`);
  if (start < 0) return "";
  const nextExport = source.indexOf("\nexport ", start + 1);
  return source.slice(start, nextExport < 0 ? undefined : nextExport);
};

const collectFailures = (root = repoRoot) => {
  const failures = [];
  const protocol = read(root, protocolFile);
  const protocolTestSource = read(root, protocolTest);
  const backendContract = read(root, backendContractTest);
  const cloudflare = read(root, cloudflareTest);

  for (const required of [
    "export interface DispatchReceiptBeforeTerminalProof",
    "export const dispatchReceiptBeforeTerminalProof",
    "export const dispatchFailedHasNoDeliveryReceipt",
  ]) {
    if (!protocol.includes(required)) failures.push(`${protocolFile}: missing ${required}`);
  }

  const proofBlock = functionBlock(protocol, "dispatchReceiptBeforeTerminalProof");
  if (proofBlock.length === 0) failures.push(`${protocolFile}: missing receipt proof block`);
  if (!/idempotencyKey/.test(proofBlock) || !/deliveryReceipt/.test(proofBlock)) {
    failures.push(
      `${protocolFile}: receipt-before-terminal proof must include idempotencyKey and deliveryReceipt`,
    );
  }

  const failedBlock = functionBlock(protocol, "dispatchFailedHasNoDeliveryReceipt");
  if (failedBlock.length === 0)
    failures.push(`${protocolFile}: missing failed terminal receipt exclusion`);
  if (!/deliveryReceipt/.test(failedBlock)) {
    failures.push(`${protocolFile}: failed terminal receipt exclusion must reject deliveryReceipt`);
  }

  if (
    !/receipt-before-terminal proof ties terminal delivery to idempotency receipt/.test(
      protocolTestSource,
    )
  ) {
    failures.push(`${protocolTest}: missing receipt-before-terminal proof test`);
  }
  if (!/dispatchFailedHasNoDeliveryReceipt/.test(protocolTestSource)) {
    failures.push(`${protocolTest}: missing terminal failure no-receipt test`);
  }
  if (
    !/drains Queue, HTTP, and provider target adapters through enqueue acknowledgements/.test(
      backendContract,
    )
  ) {
    failures.push(`${backendContractTest}: missing external enqueue acknowledgement contract`);
  }
  if (!/DISPATCH_EVENT_KINDS\.OUTBOUND_ENQUEUED/.test(backendContract)) {
    failures.push(`${backendContractTest}: external contract must assert outbound enqueued facts`);
  }
  if (
    !/receiver dedupes by \(sourceScope, idempotencyKey\), not outboundEventId/.test(cloudflare)
  ) {
    failures.push(`${cloudflareTest}: missing receiver idempotency contract`);
  }
  if (!/deliveryReceipt/.test(cloudflare)) {
    failures.push(`${cloudflareTest}: missing Cloudflare outbound receipt assertion`);
  }
  return failures;
};

const writeFixture = (root, file, source) => {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, source);
};

const collectSelfTestFailures = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentos-dispatch-receipt-"));
  try {
    writeFixture(
      root,
      protocolFile,
      [
        "export interface DispatchReceiptBeforeTerminalProof {}",
        "export const dispatchReceiptBeforeTerminalProof = (payload) => ({ idempotencyKey: payload.idempotencyKey, deliveryReceipt: payload.deliveryReceipt });",
        "export const dispatchFailedHasNoDeliveryReceipt = (payload) => !('deliveryReceipt' in payload);",
      ].join("\n"),
    );
    writeFixture(
      root,
      protocolTest,
      [
        "it('receipt-before-terminal proof ties terminal delivery to idempotency receipt', () => {",
        "  dispatchFailedHasNoDeliveryReceipt({});",
        "});",
      ].join("\n"),
    );
    writeFixture(
      root,
      backendContractTest,
      [
        "it('drains Queue, HTTP, and provider target adapters through enqueue acknowledgements', () => {",
        "  DISPATCH_EVENT_KINDS.OUTBOUND_ENQUEUED;",
        "});",
      ].join("\n"),
    );
    writeFixture(
      root,
      cloudflareTest,
      [
        "it('receiver dedupes by (sourceScope, idempotencyKey), not outboundEventId', () => {});",
        "expect(payload.deliveryReceipt).toEqual({});",
      ].join("\n"),
    );
    const baseline = collectFailures(root);
    if (baseline.length > 0) {
      return [`dispatch idempotency receipt positive fixture failed:\n${baseline.join("\n")}`];
    }

    writeFixture(
      root,
      protocolFile,
      [
        "export interface DispatchReceiptBeforeTerminalProof {}",
        "export const dispatchReceiptBeforeTerminalProof = (payload) => ({ idempotencyKey: payload.idempotencyKey });",
        "export const dispatchFailedHasNoDeliveryReceipt = (payload) => true;",
      ].join("\n"),
    );
    const rejected = collectFailures(root);
    if (!rejected.some((failure) => failure.includes("deliveryReceipt"))) {
      return [
        `dispatch idempotency receipt mutation was not rejected: ${JSON.stringify(rejected)}`,
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
    ? "dispatch idempotency receipt self-test passed"
    : "dispatch idempotency receipt passed",
);
