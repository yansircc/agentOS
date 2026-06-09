#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const expectedBackends = [
  "packages/backends/cloudflare-do",
  "packages/backends/node-postgres",
];
const requiredPhases = [
  "schedule_requested",
  "scheduled_event_fired",
  "dispatch_requested",
  "dispatch_retry_failed",
  "dispatch_retry_delivered",
  "dispatch_inbound_accepted",
  "receiver_app_event",
];

const readJson = (root, rel) => JSON.parse(fs.readFileSync(path.join(root, rel), "utf8"));
const read = (root, rel) => fs.readFileSync(path.join(root, rel), "utf8");
const sameSet = (left, right) =>
  left.length === right.length && left.every((value) => right.includes(value));

const collectFailures = (root = repoRoot) => {
  const failures = [];
  const pkg = readJson(root, "package.json");
  const fixture = readJson(root, "test/backend-neutral-golden.json");
  const productionBackends = pkg.agentos?.backendNeutrality?.productionBackendPackages ?? [];
  if (pkg.agentos?.backendNeutralityStatus !== "backend-neutral") {
    failures.push("package.json must declare backendNeutralityStatus=backend-neutral");
  }
  if (!sameSet(productionBackends, expectedBackends)) {
    failures.push(`productionBackendPackages must equal ${expectedBackends.join(", ")}`);
  }
  if (!sameSet(fixture.productionBackends ?? [], expectedBackends)) {
    failures.push("backend-neutral golden fixture must cover both production backends");
  }
  if (!Array.isArray(fixture.canonicalFlow)) {
    failures.push("backend-neutral golden fixture canonicalFlow must be an array");
  } else {
    const phases = fixture.canonicalFlow.map((step) => step.phase);
    for (const phase of requiredPhases) {
      if (!phases.includes(phase)) failures.push(`backend-neutral golden missing phase ${phase}`);
    }
    if (phases.indexOf("dispatch_retry_failed") >= phases.indexOf("dispatch_retry_delivered")) {
      failures.push("dispatch retry failure must precede delivered terminal fact");
    }
    const delivered = fixture.canonicalFlow.find((step) => step.phase === "dispatch_retry_delivered");
    if (delivered?.eventKind !== "dispatch.outbound.delivered") {
      failures.push("retry delivered phase must be dispatch.outbound.delivered");
    }
    if (delivered?.deliveryReceipt?.anchorKind !== "ledger_event") {
      failures.push("retry delivered phase must carry ledger_event delivery receipt");
    }
  }
  for (const backend of expectedBackends) {
    const contractTest = path.join(backend, "test/backend-protocol-contract.test.ts");
    if (!fs.existsSync(path.join(root, contractTest))) {
      failures.push(`${contractTest}: missing production backend contract test`);
      continue;
    }
    if (!read(root, contractTest).includes("runRuntimeBackendContractSuite")) {
      failures.push(`${contractTest}: must run shared runtime backend contract suite`);
    }
  }
  const nodePg = read(root, "packages/backends/node-postgres/src/index.ts");
  if (!/FOR UPDATE SKIP LOCKED/.test(nodePg)) {
    failures.push("node-postgres backend must prove concurrent due-work claim with SKIP LOCKED");
  }
  const contract = read(root, "packages/backends/protocol/test/contract/runtime-backend-contract.ts");
  for (const term of [
    "drains scheduler and delivery retry work from one due-work queue",
    "claims one due dispatch retry across concurrent drainers",
  ]) {
    if (!contract.includes(term)) failures.push(`backend protocol contract missing ${term}`);
  }
  return failures;
};

const writeFixture = (root, rel, source) => {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, source);
};

const collectSelfTestFailures = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentos-backend-neutral-golden-"));
  try {
    writeFixture(
      root,
      "package.json",
      JSON.stringify({
        scripts: {},
        agentos: {
          backendNeutralityStatus: "backend-neutral",
          backendNeutrality: { productionBackendPackages: expectedBackends },
        },
      }),
    );
    writeFixture(
      root,
      "test/backend-neutral-golden.json",
      JSON.stringify({ productionBackends: expectedBackends, canonicalFlow: requiredPhases.map((phase) => ({
        phase,
        eventKind: phase === "dispatch_retry_delivered" ? "dispatch.outbound.delivered" : "x",
        deliveryReceipt: phase === "dispatch_retry_delivered" ? { anchorKind: "ledger_event" } : undefined,
      })) }),
    );
    for (const backend of expectedBackends) {
      writeFixture(root, `${backend}/test/backend-protocol-contract.test.ts`, "runRuntimeBackendContractSuite");
      writeFixture(root, `${backend}/src/index.ts`, "FOR UPDATE SKIP LOCKED");
    }
    writeFixture(
      root,
      "packages/backends/protocol/test/contract/runtime-backend-contract.ts",
      "drains scheduler and delivery retry work from one due-work queue\nclaims one due dispatch retry across concurrent drainers",
    );
    const baseline = collectFailures(root);
    if (baseline.length > 0) return [`golden positive fixture failed:\n${baseline.join("\n")}`];
    writeFixture(root, "packages/backends/node-postgres/src/index.ts", "");
    const rejected = collectFailures(root);
    if (!rejected.some((failure) => failure.includes("SKIP LOCKED"))) {
      return [`golden mutation fixture was not rejected: ${JSON.stringify(rejected)}`];
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
console.log(process.argv.includes("--self-test") ? "backend-neutral golden self-test passed" : "backend-neutral golden passed");
