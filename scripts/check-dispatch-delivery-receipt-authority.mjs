#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

const files = {
  protocol: "packages/backends/protocol/src/index.ts",
  protocolTest: "packages/backends/protocol/test/dispatch-payload.test.ts",
  backendContract: "packages/backends/protocol/test/contract/runtime-backend-contract.ts",
  cloudflareDispatch: "packages/backends/cloudflare-do/src/dispatch/dispatch.ts",
  cloudflareOutbox: "packages/backends/cloudflare-do/src/dispatch/outbox.ts",
  cloudflareSqlStub: "packages/backends/cloudflare-do/test/_in-memory-do.ts",
  cloudflareFacadeTest: "packages/backends/cloudflare-do/test/facade.test.ts",
};

const read = (root, file) => fs.readFileSync(path.join(root, file), "utf8");

const eventBranch = (source, eventKind) => {
  const start = source.indexOf(`kind: DISPATCH_EVENT_KINDS.${eventKind}`);
  if (start < 0) return "";
  const tail = source.slice(start);
  const end = /\n\s*return;/.exec(tail);
  return tail.slice(0, end === null ? undefined : end.index);
};

const collectFailures = (root = repoRoot) => {
  const failures = [];
  const protocol = read(root, files.protocol);
  const protocolTest = read(root, files.protocolTest);
  const backendContract = read(root, files.backendContract);
  const cloudflareDispatch = read(root, files.cloudflareDispatch);
  const cloudflareOutbox = read(root, files.cloudflareOutbox);
  const cloudflareSqlStub = read(root, files.cloudflareSqlStub);
  const cloudflareFacadeTest = read(root, files.cloudflareFacadeTest);
  const combined = [
    protocol,
    backendContract,
    cloudflareDispatch,
    cloudflareOutbox,
    cloudflareSqlStub,
    cloudflareFacadeTest,
  ].join("\n");

  for (const required of [
    'export const DISPATCH_OUTBOUND_ENQUEUED = "dispatch.outbound.enqueued"',
    "export interface DispatchEnqueueAcknowledgement",
    "export type DispatchTargetResult = DispatchTargetDeliveredResult | DispatchTargetEnqueuedResult",
    "readonly deliver: (envelope: DispatchEnvelope) => Promise<DispatchTargetResult>",
    "export const dispatchExternalEnqueueAcknowledgement",
    "export const dispatchTargetEnqueued",
    "export const dispatchTargetDelivered",
  ]) {
    if (!protocol.includes(required)) failures.push(`${files.protocol}: missing ${required}`);
  }

  if (/dispatchExternalDeliveryReceipt/.test(combined)) {
    failures.push(
      "dispatch external enqueue acknowledgement must not share a delivery receipt helper",
    );
  }
  if (
    /delivered_event_id/.test(`${cloudflareDispatch}\n${cloudflareOutbox}\n${cloudflareSqlStub}`)
  ) {
    failures.push("dispatch_outbox success cache must not be named delivered_event_id");
  }
  if (!/success_event_id/.test(cloudflareOutbox) || !/success_event_id/.test(cloudflareDispatch)) {
    failures.push("Cloudflare dispatch outbox must cache success_event_id");
  }
  if (!/dispatchTargetEnqueued/.test(cloudflareDispatch)) {
    failures.push(
      `${files.cloudflareDispatch}: external adapters must return enqueued target results`,
    );
  }
  if (!/dispatchTargetDelivered/.test(cloudflareDispatch)) {
    failures.push(
      `${files.cloudflareDispatch}: durable object receivers must wrap target delivery`,
    );
  }
  if (!/kind:\s*DISPATCH_EVENT_KINDS\.OUTBOUND_ENQUEUED/.test(cloudflareDispatch)) {
    failures.push(`${files.cloudflareDispatch}: missing dispatch.outbound.enqueued commit branch`);
  }
  if (!/settleDispatchOutboundDelivered/.test(cloudflareDispatch)) {
    failures.push(`${files.cloudflareDispatch}: delivered branch must still settle target receipt`);
  }
  const deliveredBranch = eventBranch(cloudflareDispatch, "OUTBOUND_DELIVERED");
  const enqueuedBranch = eventBranch(cloudflareDispatch, "OUTBOUND_ENQUEUED");
  if (/enqueueAcknowledgement/.test(deliveredBranch)) {
    failures.push(
      `${files.cloudflareDispatch}: delivered branch must not carry enqueue acknowledgement`,
    );
  }
  if (/deliveryReceipt/.test(enqueuedBranch)) {
    failures.push(`${files.cloudflareDispatch}: enqueued branch must not carry deliveryReceipt`);
  }
  if (/claim:/.test(enqueuedBranch)) {
    failures.push(`${files.cloudflareDispatch}: enqueue acknowledgement must not settle claim`);
  }

  if (!/represents external enqueue acknowledgement as a weaker outbound fact/.test(protocolTest)) {
    failures.push(`${files.protocolTest}: missing weak enqueue acknowledgement protocol test`);
  }
  if (
    !/drains Queue, HTTP, and provider target adapters through enqueue acknowledgements/.test(
      backendContract,
    )
  ) {
    failures.push(`${files.backendContract}: missing external enqueue contract`);
  }
  if (!/DISPATCH_EVENT_KINDS\.OUTBOUND_ENQUEUED/.test(backendContract)) {
    failures.push(
      `${files.backendContract}: external contract must assert outbound enqueued facts`,
    );
  }
  if (
    /drains Queue, HTTP, and provider target adapters through delivery receipts/.test(
      backendContract,
    )
  ) {
    failures.push(`${files.backendContract}: stale external delivery receipt contract remains`);
  }
  if (
    !/materializes Queue, HTTP, and provider dispatch targets as enqueue acknowledgements/.test(
      cloudflareFacadeTest,
    )
  ) {
    failures.push(`${files.cloudflareFacadeTest}: missing Cloudflare adapter enqueue test`);
  }
  if (/anchorKind:\s*"external_receipt"/.test(cloudflareFacadeTest)) {
    failures.push(
      `${files.cloudflareFacadeTest}: external adapter ack must not be external_receipt`,
    );
  }

  return failures;
};

const writeFixture = (root, file, source) => {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, source);
};

const positiveFixture = {
  [files.protocol]: [
    'export const DISPATCH_OUTBOUND_ENQUEUED = "dispatch.outbound.enqueued";',
    "export interface DispatchEnqueueAcknowledgement {}",
    "export interface DispatchTargetDeliveredResult {}",
    "export interface DispatchTargetEnqueuedResult {}",
    "export type DispatchTargetResult = DispatchTargetDeliveredResult | DispatchTargetEnqueuedResult;",
    "export interface DispatchEnvelope {}",
    "export interface DispatchTargetAdapter {",
    "  readonly deliver: (envelope: DispatchEnvelope) => Promise<DispatchTargetResult>;",
    "}",
    "export const dispatchExternalEnqueueAcknowledgement = () => ({});",
    "export const dispatchTargetEnqueued = () => ({});",
    "export const dispatchTargetDelivered = () => ({});",
  ].join("\n"),
  [files.protocolTest]:
    "it('represents external enqueue acknowledgement as a weaker outbound fact', () => {});",
  [files.backendContract]: [
    "it('drains Queue, HTTP, and provider target adapters through enqueue acknowledgements', () => {",
    "  DISPATCH_EVENT_KINDS.OUTBOUND_ENQUEUED;",
    "});",
  ].join("\n"),
  [files.cloudflareDispatch]: [
    "dispatchTargetEnqueued();",
    "dispatchTargetDelivered();",
    "settleDispatchOutboundDelivered();",
    "const delivered = { kind: DISPATCH_EVENT_KINDS.OUTBOUND_DELIVERED, payload: { deliveryReceipt: true } };",
    "return;",
    "const enqueued = {",
    "  kind: DISPATCH_EVENT_KINDS.OUTBOUND_ENQUEUED,",
    "  payload: { enqueueAcknowledgement: true },",
    "};",
    "return;",
    '"UPDATE dispatch_outbox SET success_event_id = ?";',
  ].join("\n"),
  [files.cloudflareOutbox]: "success_event_id INTEGER REFERENCES events(id);",
  [files.cloudflareSqlStub]: "row.success_event_id = null;",
  [files.cloudflareFacadeTest]:
    "it('materializes Queue, HTTP, and provider dispatch targets as enqueue acknowledgements', () => {});",
};

const collectSelfTestFailures = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentos-dispatch-authority-"));
  try {
    for (const [file, source] of Object.entries(positiveFixture)) {
      writeFixture(root, file, source);
    }
    const baseline = collectFailures(root);
    if (baseline.length > 0) {
      return [`dispatch authority positive fixture failed:\n${baseline.join("\n")}`];
    }

    writeFixture(
      root,
      files.protocol,
      positiveFixture[files.protocol].replace(
        "export const dispatchExternalEnqueueAcknowledgement = () => ({});",
        "export const dispatchExternalDeliveryReceipt = () => ({});",
      ),
    );
    writeFixture(
      root,
      files.backendContract,
      "it('drains Queue, HTTP, and provider target adapters through delivery receipts', () => {});",
    );
    writeFixture(
      root,
      files.cloudflareDispatch,
      [
        "dispatchTargetDelivered();",
        "settleDispatchOutboundDelivered();",
        "const delivered = {",
        "  kind: DISPATCH_EVENT_KINDS.OUTBOUND_DELIVERED,",
        "  payload: { deliveryReceipt: true, enqueueAcknowledgement: true },",
        "};",
        '"UPDATE dispatch_outbox SET delivered_event_id = ?";',
      ].join("\n"),
    );
    const rejected = collectFailures(root);
    if (
      !rejected.some((failure) => failure.includes("delivery receipt helper")) ||
      !rejected.some((failure) => failure.includes("delivered_event_id")) ||
      !rejected.some((failure) => failure.includes("stale external delivery receipt"))
    ) {
      return [`dispatch authority mutation was not rejected: ${JSON.stringify(rejected)}`];
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
    ? "dispatch delivery receipt authority self-test passed"
    : "dispatch delivery receipt authority passed",
);
