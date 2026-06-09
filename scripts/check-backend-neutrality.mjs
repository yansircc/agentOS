#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const repoRoot = process.cwd();

const allowedStatuses = new Set(["boundary-prepared", "backend-neutral"]);
const requiredProofScripts = [
  "test:backend-neutral-golden",
  "test:backend-neutral-telemetry",
  "test:backend-neutral-replay",
];

const readRootPackage = (root) =>
  JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

export const collectBackendNeutralityFailures = (root = repoRoot) => {
  const rootPackage = readRootPackage(root);
  const failures = [];
  const fail = (message) => failures.push(message);

  const agentos = rootPackage.agentos;
  if (agentos === undefined || agentos === null || typeof agentos !== "object") {
    fail("package.json must declare agentos metadata");
  }

  const status = agentos?.backendNeutralityStatus;
  if (typeof status !== "string") {
    fail("package.json must declare agentos.backendNeutralityStatus");
  } else if (!allowedStatuses.has(status)) {
    fail(
      `agentos.backendNeutralityStatus must be one of ${[...allowedStatuses].join(", ")}; actual ${JSON.stringify(status)}`,
    );
  }

  const productionBackendPackages =
    agentos?.backendNeutrality?.productionBackendPackages === undefined
      ? []
      : agentos.backendNeutrality.productionBackendPackages;

  if (!Array.isArray(productionBackendPackages)) {
    fail("agentos.backendNeutrality.productionBackendPackages must be an array");
  }

  const normalizedProductionBackends = Array.isArray(productionBackendPackages)
    ? productionBackendPackages
        .filter((value) => typeof value === "string")
        .map((value) => value.replace(/^\.\//u, "").replace(/\/+$/u, ""))
    : [];

  for (const backendPath of normalizedProductionBackends) {
    if (!backendPath.startsWith("packages/backends/")) {
      fail(`production backend must live under packages/backends: ${backendPath}`);
    }
    if (/(?:^|\/)(?:in-memory|protocol|reference)(?:$|\/)/u.test(backendPath)) {
      fail(
        `non-production/reference backend cannot count toward backend-neutral status: ${backendPath}`,
      );
    }
    if (!fs.existsSync(path.join(root, backendPath, "src"))) {
      fail(`production backend path must exist and contain src: ${backendPath}`);
    }
  }

  if (status === "backend-neutral") {
    const uniqueBackends = new Set(normalizedProductionBackends);
    if (uniqueBackends.size < 2) {
      fail(
        `backend-neutral requires at least 2 production backends, excluding in-memory/reference; actual ${uniqueBackends.size}`,
      );
    }
    for (const script of requiredProofScripts) {
      if (rootPackage.scripts?.[script] === undefined) {
        fail(`backend-neutral requires root proof script ${script}`);
      }
    }
  }

  return { failures, status };
};

const writePackageJson = (root, packageJson) => {
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify(packageJson, null, 2));
};

const collectSelfTestFailures = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentos-backend-neutrality-"));
  try {
    writePackageJson(root, {
      scripts: {},
      agentos: {
        backendNeutralityStatus: "boundary-prepared",
        backendNeutrality: { productionBackendPackages: [] },
      },
    });
    const prepared = collectBackendNeutralityFailures(root).failures;
    if (prepared.length > 0) {
      return [
        `backend neutrality self-test positive boundary-prepared fixture failed: ${prepared.join("\n")}`,
      ];
    }

    writePackageJson(root, {
      scripts: {},
      agentos: {
        backendNeutralityStatus: "backend-neutral",
        backendNeutrality: { productionBackendPackages: [] },
      },
    });
    const missingProof = collectBackendNeutralityFailures(root).failures;
    if (
      !missingProof.some((failure) =>
        failure.includes("requires at least 2 production backends"),
      ) ||
      !missingProof.some((failure) => failure.includes("test:backend-neutral-golden"))
    ) {
      return [
        `backend neutrality self-test did not reject backend-neutral without production backends/proofs; failures=${JSON.stringify(missingProof)}`,
      ];
    }

    for (const backend of ["cloudflare-do", "node-postgres"]) {
      fs.mkdirSync(path.join(root, "packages/backends", backend, "src"), { recursive: true });
    }
    writePackageJson(root, {
      scripts: Object.fromEntries(requiredProofScripts.map((script) => [script, "echo ok"])),
      agentos: {
        backendNeutralityStatus: "backend-neutral",
        backendNeutrality: {
          productionBackendPackages: [
            "packages/backends/cloudflare-do",
            "packages/backends/node-postgres",
          ],
        },
      },
    });
    const complete = collectBackendNeutralityFailures(root).failures;
    if (complete.length > 0) {
      return [
        `backend neutrality self-test complete backend-neutral fixture failed: ${complete.join("\n")}`,
      ];
    }
    return [];
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
};

const selfTest = process.argv.includes("--self-test");
const { failures, status } = selfTest
  ? { failures: collectSelfTestFailures(), status: "self-test" }
  : collectBackendNeutralityFailures(repoRoot);

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(
  selfTest ? "backend neutrality self-test passed" : `backend neutrality status ok: ${status}`,
);
