#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { collectFailures as collectGoldenFailures } from "./check-backend-neutral-golden.mjs";
import { collectFailures as collectReplayFailures } from "./check-backend-neutral-replay.mjs";
import { collectFailures as collectTelemetryFailures } from "./check-backend-neutral-telemetry.mjs";
import { productionBackendPackagesPath } from "./backend-neutral-production-backends.mjs";

const requiredPhases = [
  "schedule_requested",
  "scheduled_event_fired",
  "dispatch_requested",
  "dispatch_retry_failed",
  "dispatch_retry_delivered",
  "dispatch_inbound_accepted",
  "receiver_app_event",
];

const requiredKinds = ["dispatch.delivery", "llm.call", "tool.call"];
const driftFailure = `productionBackends must equal package.json ${productionBackendPackagesPath}`;

const writeFixture = (root, rel, source) => {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, source);
};

const writeJson = (root, rel, value) => {
  writeFixture(root, rel, `${JSON.stringify(value, null, 2)}\n`);
};

const writePackage = (root, productionBackends) => {
  writeJson(root, "package.json", {
    agentos: {
      backendNeutralityStatus: "backend-neutral",
      backendNeutrality: { productionBackendPackages: productionBackends },
    },
  });
};

const writeBackendSurfaces = (root, productionBackends) => {
  for (const backend of productionBackends) {
    writeFixture(root, `${backend}/src/index.ts`, "");
    writeFixture(
      root,
      `${backend}/test/backend-protocol-contract.test.ts`,
      "runRuntimeBackendContractSuite",
    );
  }
};

const writeGoldenProjection = (root, productionBackends) => {
  writeJson(root, "test/backend-neutral-golden.json", {
    version: 1,
    productionBackends,
    canonicalFlow: requiredPhases.map((phase) => ({
      phase,
      eventKind: phase === "dispatch_retry_delivered" ? "dispatch.outbound.delivered" : "x",
      deliveryReceipt:
        phase === "dispatch_retry_delivered" ? { anchorKind: "ledger_event" } : undefined,
    })),
  });
};

const writeReplayProjection = (root, productionBackends) => {
  writeJson(root, "test/backend-neutral-replay.json", {
    version: 1,
    productionBackends,
    scenarios: requiredKinds.map((kind) => ({ kind, liveIoAdapterCalls: 0 })),
    backendResults: Object.fromEntries(
      productionBackends.map((backend) => [backend, requiredKinds]),
    ),
  });
};

const writeTelemetryProjection = (root, productionBackends) => {
  const tree = { nodes: [{ id: "a", emitKind: "runtime", name: "dispatch" }] };
  writeJson(root, "test/backend-neutral-telemetry.json", {
    version: 1,
    productionBackends,
    canonicalTrees: Object.fromEntries(productionBackends.map((backend) => [backend, tree])),
  });
};

const writeSharedProofSurfaces = (root) => {
  writeFixture(
    root,
    "packages/backends/protocol/test/contract/runtime-backend-contract.ts",
    "drains scheduler and delivery retry work from one due-work queue\nclaims one due dispatch retry across concurrent drainers",
  );
  for (const script of [
    "scripts/check-replay-dispatch-snapshot.mjs",
    "scripts/check-replay-llm-snapshot.mjs",
    "scripts/check-replay-tool-snapshot.mjs",
  ]) {
    writeFixture(root, script, "");
  }
  writeFixture(
    root,
    "packages/telemetry-protocol/src/index.ts",
    "canonicalTelemetryEventTreeJson\ntelemetryEventTreesEqual",
  );
};

const writeProjections = (root, productionBackends) => {
  writeGoldenProjection(root, productionBackends);
  writeReplayProjection(root, productionBackends);
  writeTelemetryProjection(root, productionBackends);
};

const collectAllFailures = (root) => [
  { name: "golden", failures: collectGoldenFailures(root) },
  { name: "replay", failures: collectReplayFailures(root) },
  { name: "telemetry", failures: collectTelemetryFailures(root) },
];

const expectPass = (root, label) => {
  const failures = collectAllFailures(root).filter((script) => script.failures.length > 0);
  if (failures.length > 0) {
    return [
      `${label} expected metadata-derived backend projections to pass:\n${failures
        .map((script) => `${script.name}:\n${script.failures.join("\n")}`)
        .join("\n")}`,
    ];
  }
  return [];
};

const expectDriftFailure = (root) => {
  const failures = [];
  for (const script of collectAllFailures(root)) {
    if (!script.failures.some((failure) => failure.includes(driftFailure))) {
      failures.push(
        `${script.name} did not reject backend projection drift from ${productionBackendPackagesPath}; failures=${JSON.stringify(script.failures)}`,
      );
    }
  }
  return failures;
};

const collectSelfTestFailures = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentos-backend-set-ssot-"));
  try {
    const firstBackends = ["packages/backends/ssot-alpha", "packages/backends/ssot-beta"];
    const secondBackends = ["packages/backends/ssot-alpha", "packages/backends/ssot-gamma"];

    writePackage(root, firstBackends);
    writeBackendSurfaces(root, firstBackends);
    writeSharedProofSurfaces(root);
    writeProjections(root, firstBackends);

    const firstPass = expectPass(root, "initial alternate backend set");
    if (firstPass.length > 0) return firstPass;

    writePackage(root, secondBackends);
    writeBackendSurfaces(root, secondBackends);
    const drift = expectDriftFailure(root);
    if (drift.length > 0) return drift;

    writeProjections(root, secondBackends);
    return expectPass(root, "regenerated alternate backend set");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
};

const failures = collectSelfTestFailures();
if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log("backend-neutral backend-set SSOT passed");
