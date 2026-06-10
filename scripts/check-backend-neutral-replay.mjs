#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  collectProductionBackendPackageSet,
  productionBackendPackagesPath,
  readJson,
  sameStringSet,
} from "./backend-neutral-production-backends.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const requiredKinds = ["dispatch.delivery", "llm.call", "tool.call"];

export const collectFailures = (root = repoRoot) => {
  const failures = [];
  const backendSet = collectProductionBackendPackageSet(root, {
    minCount: 2,
    requireExistingSrc: true,
  });
  failures.push(...backendSet.failures);
  const expectedBackends = backendSet.productionBackends;
  const fixture = readJson(root, "test/backend-neutral-replay.json");
  if (!sameStringSet(fixture.productionBackends ?? [], expectedBackends)) {
    failures.push(
      `backend-neutral replay fixture productionBackends must equal package.json ${productionBackendPackagesPath}`,
    );
  }
  const scenarios = Array.isArray(fixture.scenarios) ? fixture.scenarios : [];
  for (const kind of requiredKinds) {
    const scenario = scenarios.find((entry) => entry.kind === kind);
    if (scenario === undefined) failures.push(`replay fixture missing ${kind}`);
    if (scenario !== undefined && scenario.liveIoAdapterCalls !== 0) {
      failures.push(`${kind} replay must assert live IO adapters are not called`);
    }
  }
  const results = fixture.backendResults ?? {};
  for (const backend of expectedBackends) {
    if (!sameStringSet(results[backend] ?? [], requiredKinds)) {
      failures.push(`replay backend result missing required scenarios for ${backend}`);
    }
  }
  for (const script of [
    "scripts/check-replay-dispatch-snapshot.mjs",
    "scripts/check-replay-llm-snapshot.mjs",
    "scripts/check-replay-tool-snapshot.mjs",
  ]) {
    if (!fs.existsSync(path.join(root, script)))
      failures.push(`${script}: missing replay snapshot gate`);
  }
  return failures;
};

const writeFixture = (root, rel, source) => {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, source);
};

const collectSelfTestFailures = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentos-backend-neutral-replay-"));
  try {
    const selfTestBackends = ["packages/backends/replay-alpha", "packages/backends/replay-beta"];
    writeFixture(
      root,
      "package.json",
      JSON.stringify({
        agentos: {
          backendNeutralityStatus: "backend-neutral",
          backendNeutrality: { productionBackendPackages: selfTestBackends },
        },
      }),
    );
    writeFixture(
      root,
      "test/backend-neutral-replay.json",
      JSON.stringify({
        productionBackends: selfTestBackends,
        scenarios: requiredKinds.map((kind) => ({ kind, liveIoAdapterCalls: 0 })),
        backendResults: Object.fromEntries(
          selfTestBackends.map((backend) => [backend, requiredKinds]),
        ),
      }),
    );
    for (const backend of selfTestBackends) {
      writeFixture(root, `${backend}/src/index.ts`, "");
    }
    for (const script of [
      "scripts/check-replay-dispatch-snapshot.mjs",
      "scripts/check-replay-llm-snapshot.mjs",
      "scripts/check-replay-tool-snapshot.mjs",
    ]) {
      writeFixture(root, script, "");
    }
    const baseline = collectFailures(root);
    if (baseline.length > 0) return [`replay positive fixture failed:\n${baseline.join("\n")}`];
    writeFixture(
      root,
      "test/backend-neutral-replay.json",
      JSON.stringify({
        productionBackends: selfTestBackends,
        scenarios: requiredKinds.map((kind) => ({
          kind,
          liveIoAdapterCalls: kind === "tool.call" ? 1 : 0,
        })),
        backendResults: Object.fromEntries(
          selfTestBackends.map((backend) => [backend, requiredKinds]),
        ),
      }),
    );
    const rejected = collectFailures(root);
    if (!rejected.some((failure) => failure.includes("live IO adapters are not called"))) {
      return [`replay mutation fixture was not rejected: ${JSON.stringify(rejected)}`];
    }
    return [];
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
};

const isMain =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const failures = process.argv.includes("--self-test")
    ? collectSelfTestFailures()
    : collectFailures(repoRoot);
  if (failures.length > 0) {
    console.error(failures.join("\n"));
    process.exit(1);
  }
  console.log(
    process.argv.includes("--self-test")
      ? "backend-neutral replay self-test passed"
      : "backend-neutral replay passed",
  );
}
