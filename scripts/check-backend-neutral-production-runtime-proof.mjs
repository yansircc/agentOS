#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

const cloudflareWorkerContractTest =
  "packages/backends/cloudflare-do/test/backend-protocol-contract.worker.test.ts";
const cloudflareUnitContractTest =
  "packages/backends/cloudflare-do/test/backend-protocol-contract.test.ts";
const cloudflareTestWorker = "packages/backends/cloudflare-do/test/test-worker.ts";
const cloudflareWorkerConfig = "packages/backends/cloudflare-do/vitest.cloudflare.config.ts";
const wranglerConfig = "packages/backends/cloudflare-do/wrangler-test.jsonc";

const read = (root, file) => fs.readFileSync(path.join(root, file), "utf8");
const exists = (root, file) => fs.existsSync(path.join(root, file));

const blockFrom = (source, startToken, endToken) => {
  const start = source.indexOf(startToken);
  if (start < 0) return "";
  const end = source.indexOf(endToken, start + startToken.length);
  return source.slice(start, end < 0 ? undefined : end);
};

const requireTerms = (failures, file, source, terms) => {
  for (const term of terms) {
    if (!source.includes(term)) failures.push(`${file}: missing ${term}`);
  }
};

const collectFailures = (root = repoRoot) => {
  const failures = [];
  for (const file of [
    cloudflareWorkerContractTest,
    cloudflareUnitContractTest,
    cloudflareTestWorker,
    cloudflareWorkerConfig,
    wranglerConfig,
  ]) {
    if (!exists(root, file)) failures.push(`${file}: missing`);
  }
  if (failures.length > 0) return failures;

  const workerTest = read(root, cloudflareWorkerContractTest);
  const unitTest = read(root, cloudflareUnitContractTest);
  const testWorker = read(root, cloudflareTestWorker);
  const workerConfig = read(root, cloudflareWorkerConfig);
  const wrangler = read(root, wranglerConfig);
  const contractDoBlock = blockFrom(
    testWorker,
    "export class BackendProtocolContractTestDO",
    "export const EmitTestDO",
  );

  requireTerms(failures, cloudflareWorkerContractTest, workerTest, [
    'from "cloudflare:test"',
    'from "cloudflare:workers"',
    "runRuntimeBackendContractSuite",
    "makeCloudflareProductionRuntimeContractDriver",
    "BACKEND_PROTOCOL_CONTRACT_DO",
  ]);
  if (workerTest.includes("makeInMemoryDurableObjectState")) {
    failures.push(
      `${cloudflareWorkerContractTest}: production runtime proof must not use makeInMemoryDurableObjectState`,
    );
  }

  if (!unitTest.includes("makeInMemoryDurableObjectState")) {
    failures.push(
      `${cloudflareUnitContractTest}: unit fixture should remain visibly in-memory instead of being mistaken for production proof`,
    );
  }

  requireTerms(failures, cloudflareTestWorker, testWorker, [
    "BACKEND_PROTOCOL_CONTRACT_BINDING_REF",
    "export class BackendProtocolContractTestDO",
    "makeCloudflareBackendCoreLayer",
    "findNextDue",
  ]);
  if (contractDoBlock.length === 0) {
    failures.push(`${cloudflareTestWorker}: missing BackendProtocolContractTestDO block`);
  } else {
    requireTerms(failures, cloudflareTestWorker, contractDoBlock, [
      "extends DurableObject<BackendProtocolContractEnv>",
      "DurableObjectState",
      "runtimeFor",
      "__agentosTryReceiveDispatch",
      "BACKEND_PROTOCOL_CONTRACT_DO.idFromName",
    ]);
    if (contractDoBlock.includes("makeInMemoryDurableObjectState")) {
      failures.push(
        `${cloudflareTestWorker}: BackendProtocolContractTestDO must use Workers DurableObjectState, not in-memory state`,
      );
    }
  }

  requireTerms(failures, cloudflareWorkerConfig, workerConfig, [
    "cloudflareTest",
    'include: ["test/**/*.worker.test.ts"]',
    "./wrangler-test.jsonc",
  ]);

  requireTerms(failures, wranglerConfig, wrangler, [
    '"name": "BACKEND_PROTOCOL_CONTRACT_DO"',
    '"class_name": "BackendProtocolContractTestDO"',
    '"BackendProtocolContractTestDO"',
  ]);

  return failures;
};

const writeFixture = (root, file, source) => {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, source);
};

const writePositiveFixture = (root) => {
  writeFixture(
    root,
    cloudflareWorkerContractTest,
    [
      'import { runInDurableObject } from "cloudflare:test";',
      'import { env } from "cloudflare:workers";',
      "const BACKEND_PROTOCOL_CONTRACT_DO = env.BACKEND_PROTOCOL_CONTRACT_DO;",
      "const makeCloudflareProductionRuntimeContractDriver = () => BACKEND_PROTOCOL_CONTRACT_DO;",
      "runRuntimeBackendContractSuite('cloudflare-do production runtime', makeCloudflareProductionRuntimeContractDriver, {});",
    ].join("\n"),
  );
  writeFixture(root, cloudflareUnitContractTest, "makeInMemoryDurableObjectState();");
  writeFixture(
    root,
    cloudflareTestWorker,
    [
      "export const BACKEND_PROTOCOL_CONTRACT_BINDING_REF = {};",
      "export class BackendProtocolContractTestDO extends DurableObject<BackendProtocolContractEnv> {",
      "  constructor(ctx: DurableObjectState) { makeCloudflareBackendCoreLayer(ctx); findNextDue(ctx.storage.sql); }",
      "  runtimeFor() { return BACKEND_PROTOCOL_CONTRACT_DO.idFromName('x'); }",
      "  __agentosTryReceiveDispatch() {}",
      "}",
      "export const EmitTestDO = {};",
    ].join("\n"),
  );
  writeFixture(
    root,
    cloudflareWorkerConfig,
    [
      "cloudflareTest({ wrangler: { configPath: './wrangler-test.jsonc' } });",
      'export default { test: { include: ["test/**/*.worker.test.ts"] } };',
    ].join("\n"),
  );
  writeFixture(
    root,
    wranglerConfig,
    [
      '{ "durable_objects": { "bindings": [',
      '{ "name": "BACKEND_PROTOCOL_CONTRACT_DO", "class_name": "BackendProtocolContractTestDO" }',
      '] }, "migrations": [{ "new_sqlite_classes": ["BackendProtocolContractTestDO"] }] }',
    ].join("\n"),
  );
};

const collectSelfTestFailures = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentos-backend-runtime-proof-"));
  try {
    writePositiveFixture(root);
    const baseline = collectFailures(root);
    if (baseline.length > 0) {
      return [`production runtime proof positive fixture failed:\n${baseline.join("\n")}`];
    }

    writeFixture(
      root,
      cloudflareWorkerContractTest,
      [
        'import { runInDurableObject } from "cloudflare:test";',
        'import { env } from "cloudflare:workers";',
        "makeInMemoryDurableObjectState();",
        "const BACKEND_PROTOCOL_CONTRACT_DO = env.BACKEND_PROTOCOL_CONTRACT_DO;",
        "const makeCloudflareProductionRuntimeContractDriver = () => BACKEND_PROTOCOL_CONTRACT_DO;",
        "runRuntimeBackendContractSuite('cloudflare-do production runtime', makeCloudflareProductionRuntimeContractDriver, {});",
      ].join("\n"),
    );
    const fakeStateRejected = collectFailures(root);
    if (!fakeStateRejected.some((failure) => failure.includes("makeInMemoryDurableObjectState"))) {
      return [
        `production runtime proof fake-state mutation was not rejected: ${JSON.stringify(
          fakeStateRejected,
        )}`,
      ];
    }

    writePositiveFixture(root);
    writeFixture(
      root,
      cloudflareWorkerContractTest,
      [
        'import { runInDurableObject } from "cloudflare:test";',
        'import { env } from "cloudflare:workers";',
        "const BACKEND_PROTOCOL_CONTRACT_DO = env.BACKEND_PROTOCOL_CONTRACT_DO;",
        "const makeCloudflareProductionRuntimeContractDriver = () => BACKEND_PROTOCOL_CONTRACT_DO;",
      ].join("\n"),
    );
    const missingSuiteRejected = collectFailures(root);
    if (
      !missingSuiteRejected.some((failure) => failure.includes("runRuntimeBackendContractSuite"))
    ) {
      return [
        `production runtime proof missing-suite mutation was not rejected: ${JSON.stringify(
          missingSuiteRejected,
        )}`,
      ];
    }

    writePositiveFixture(root);
    writeFixture(root, wranglerConfig, "{}");
    const missingBindingRejected = collectFailures(root);
    if (
      !missingBindingRejected.some((failure) => failure.includes("BACKEND_PROTOCOL_CONTRACT_DO"))
    ) {
      return [
        `production runtime proof missing-binding mutation was not rejected: ${JSON.stringify(
          missingBindingRejected,
        )}`,
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
    ? "backend-neutral production runtime proof self-test passed"
    : "backend-neutral production runtime proof passed",
);
