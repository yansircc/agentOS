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

const canonicalJson = (value) => JSON.stringify(value);

export const collectFailures = (root = repoRoot) => {
  const failures = [];
  const backendSet = collectProductionBackendPackageSet(root, {
    minCount: 2,
    requireExistingSrc: true,
  });
  failures.push(...backendSet.failures);
  const expectedBackends = backendSet.productionBackends;
  const fixture = readJson(root, "test/backend-neutral-telemetry.json");
  if (!sameStringSet(fixture.productionBackends ?? [], expectedBackends)) {
    failures.push(
      `backend-neutral telemetry fixture productionBackends must equal package.json ${productionBackendPackagesPath}`,
    );
  }
  const trees = fixture.canonicalTrees ?? {};
  const baseline = trees[expectedBackends[0]];
  for (const backend of expectedBackends) {
    if (trees[backend] === undefined) failures.push(`telemetry fixture missing ${backend}`);
  }
  if (baseline !== undefined) {
    for (const backend of expectedBackends.slice(1)) {
      if (canonicalJson(trees[backend]) !== canonicalJson(baseline)) {
        failures.push(`telemetry canonical tree differs for ${backend}`);
      }
    }
  }
  const protocol = fs.readFileSync(
    path.join(root, "packages/telemetry-protocol/src/index.ts"),
    "utf8",
  );
  if (!protocol.includes("canonicalTelemetryEventTreeJson")) {
    failures.push("telemetry-protocol must own canonical telemetry tree JSON");
  }
  if (!protocol.includes("telemetryEventTreesEqual")) {
    failures.push("telemetry-protocol must own telemetry tree equality");
  }
  return failures;
};

const writeFixture = (root, rel, source) => {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, source);
};

const collectSelfTestFailures = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentos-backend-neutral-telemetry-"));
  try {
    const selfTestBackends = [
      "packages/backends/telemetry-alpha",
      "packages/backends/telemetry-beta",
    ];
    const tree = { nodes: [{ id: "a", emitKind: "runtime", name: "dispatch" }] };
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
      "test/backend-neutral-telemetry.json",
      JSON.stringify({
        productionBackends: selfTestBackends,
        canonicalTrees: Object.fromEntries(selfTestBackends.map((backend) => [backend, tree])),
      }),
    );
    for (const backend of selfTestBackends) {
      writeFixture(root, `${backend}/src/index.ts`, "");
    }
    writeFixture(
      root,
      "packages/telemetry-protocol/src/index.ts",
      "canonicalTelemetryEventTreeJson\ntelemetryEventTreesEqual",
    );
    const baseline = collectFailures(root);
    if (baseline.length > 0) return [`telemetry positive fixture failed:\n${baseline.join("\n")}`];
    writeFixture(
      root,
      "test/backend-neutral-telemetry.json",
      JSON.stringify({
        productionBackends: selfTestBackends,
        canonicalTrees: {
          [selfTestBackends[0]]: tree,
          [selfTestBackends[1]]: {
            nodes: [{ id: "b", emitKind: "backend", name: "dispatch" }],
          },
        },
      }),
    );
    const rejected = collectFailures(root);
    if (!rejected.some((failure) => failure.includes("canonical tree differs"))) {
      return [`telemetry mutation fixture was not rejected: ${JSON.stringify(rejected)}`];
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
      ? "backend-neutral telemetry self-test passed"
      : "backend-neutral telemetry passed",
  );
}
