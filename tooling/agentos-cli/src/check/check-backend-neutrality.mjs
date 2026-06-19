#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { collectProductionBackendPackageSet } from "./backend-neutral-production-backends.mjs";
import { collectBoundaryRuleMembershipFailures } from "../lib/boundary-rules.mjs";

const repoRoot = process.cwd();

const allowedStatuses = new Set(["boundary-prepared", "backend-neutral"]);

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

  const backendSet = collectProductionBackendPackageSet(root, {
    minCount: status === "backend-neutral" ? 2 : 0,
    requireExistingSrc: true,
  });
  failures.push(...backendSet.failures);

  if (status === "backend-neutral") {
    failures.push(
      ...collectBoundaryRuleMembershipFailures(root, [
        {
          ruleId: "backend-neutral-production-runtime-proof",
          commandGroup: "substrate-consumer",
          reachableFrom: ["substrate-consumer", "all"],
        },
      ]),
    );
    for (const backend of backendSet.productionBackends) {
      const contractTest = path.join(root, backend, "test/backend-protocol-contract.test.ts");
      if (!fs.existsSync(contractTest)) {
        fail(`backend-neutral production backend lacks protocol contract test: ${backend}`);
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
    fs.mkdirSync(path.join(root, "docs/agent"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "docs/agent/boundary-rules.source.json"),
      JSON.stringify({ schemaVersion: 1, commandGroups: { all: [] }, rules: [] }, null, 2),
    );
    const missingProof = collectBackendNeutralityFailures(root).failures;
    if (
      !missingProof.some((failure) =>
        failure.includes("requires at least 2 production backends"),
      ) ||
      !missingProof.some((failure) => failure.includes("backend-neutral-production-runtime-proof"))
    ) {
      return [
        `backend neutrality self-test did not reject backend-neutral without production backends/proofs; failures=${JSON.stringify(missingProof)}`,
      ];
    }

    for (const backend of ["cloudflare-do", "node-postgres"]) {
      fs.mkdirSync(path.join(root, "packages/backends", backend, "src"), { recursive: true });
      fs.mkdirSync(path.join(root, "packages/backends", backend, "test"), { recursive: true });
      fs.writeFileSync(
        path.join(root, "packages/backends", backend, "test/backend-protocol-contract.test.ts"),
        "runRuntimeBackendContractSuite();",
      );
    }
    writePackageJson(root, {
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
    fs.mkdirSync(path.join(root, "docs/agent"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "docs/agent/boundary-rules.source.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          commandGroups: {
            all: [{ type: "group", id: "substrate-consumer" }],
            "substrate-consumer": [
              { type: "rule", id: "backend-neutral-production-runtime-proof" },
            ],
          },
          rules: [
            {
              id: "backend-neutral-production-runtime-proof",
              commandGroup: "substrate-consumer",
            },
          ],
        },
        null,
        2,
      ),
    );
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
