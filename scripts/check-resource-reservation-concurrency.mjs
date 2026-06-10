#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

const rootPackagePath = "package.json";
const backendContractPath = "packages/backends/protocol/test/contract/runtime-backend-contract.ts";
const nodePostgresPath = "packages/backends/node-postgres/src/index.ts";

const expectedScript =
  "node scripts/check-resource-reservation-concurrency.mjs --self-test && node scripts/check-resource-reservation-concurrency.mjs";

const read = (root, file) => fs.readFileSync(path.join(root, file), "utf8");
const readJson = (root, file) => JSON.parse(read(root, file));

const methodBlock = (source, name) => {
  const start = source.indexOf(`async ${name}`);
  if (start < 0) return "";
  const next = source.indexOf("\n  async ", start + 1);
  return source.slice(start, next < 0 ? undefined : next);
};

const collectFailures = (root = repoRoot) => {
  const failures = [];
  const rootPackage = readJson(root, rootPackagePath);
  const backendContract = read(root, backendContractPath);
  const nodePostgres = read(root, nodePostgresPath);

  if (rootPackage.scripts?.["test:resource-reservation-concurrency"] !== expectedScript) {
    failures.push(`${rootPackagePath}: missing test:resource-reservation-concurrency script`);
  }

  for (const required of [
    "serializes concurrent resource reserve decisions",
    "dedupes concurrent resource reserves by idempotency key",
    "terminalizes resource reservations idempotently",
    "Promise.allSettled",
    "Promise.all(",
    "agent_os.resource_insufficient",
    "resource_pool.reserved",
    "resource_pool.reserve_rejected",
  ]) {
    if (!backendContract.includes(required)) {
      failures.push(`${backendContractPath}: missing ${required}`);
    }
  }

  for (const required of [
    "ResourceReserveTransactionRow",
    "ResourceTerminalTransactionRow",
    "resourceLockKey",
    "resourceProjectionCtes",
    "pg_advisory_xact_lock",
    "#appendResourceEventLocked",
    "#terminalResourceReservationLocked",
  ]) {
    if (!nodePostgres.includes(required)) {
      failures.push(`${nodePostgresPath}: missing ${required}`);
    }
  }

  const grant = methodBlock(nodePostgres, "grantResource");
  if (!grant.includes("#appendResourceEventLocked")) {
    failures.push(`${nodePostgresPath}: grantResource must use the resource lock`);
  }

  const reserve = methodBlock(nodePostgres, "reserveResource");
  if (!reserve.includes("jsonArrayStatement<ResourceReserveTransactionRow>")) {
    failures.push(`${nodePostgresPath}: reserveResource must decide and append in one SQL result`);
  }
  if (/await this\.#loadResourceState\(identity\)/u.test(reserve)) {
    failures.push(`${nodePostgresPath}: reserveResource still reads projection outside the lock`);
  }

  for (const name of ["consumeResource", "releaseResource"]) {
    const block = methodBlock(nodePostgres, name);
    if (!block.includes("#terminalResourceReservationLocked")) {
      failures.push(`${nodePostgresPath}: ${name} must use the resource terminal lock`);
    }
    if (/await this\.#loadResourceState\(identity\)/u.test(block)) {
      failures.push(`${nodePostgresPath}: ${name} still reads projection outside the lock`);
    }
  }

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
    rootPackagePath,
    JSON.stringify(
      {
        scripts: {
          "test:resource-reservation-concurrency": expectedScript,
        },
      },
      null,
      2,
    ),
  );
  writeFixture(
    root,
    backendContractPath,
    [
      "it.effect('serializes concurrent resource reserve decisions', () => Promise.allSettled([]));",
      "it.effect('dedupes concurrent resource reserves by idempotency key', () => Promise.all([]));",
      "it.effect('terminalizes resource reservations idempotently', () => driver.consumeResource());",
      "expect(error.name).toContain('agent_os.resource_insufficient');",
      "expect(payloadsOf(events, 'resource_pool.reserved')).toHaveLength(1);",
      "expect(payloadsOf(events, 'resource_pool.reserve_rejected')).toHaveLength(7);",
    ].join("\n"),
  );
  writeFixture(
    root,
    nodePostgresPath,
    [
      "interface ResourceReserveTransactionRow {}",
      "interface ResourceTerminalTransactionRow {}",
      "const resourceLockKey = () => 'lock';",
      "const resourceProjectionCtes = () => '';",
      "async grantResource() { return this.#appendResourceEventLocked({}); }",
      "async reserveResource() { await this.#sql.jsonArrayStatement<ResourceReserveTransactionRow>('SELECT pg_advisory_xact_lock(1)'); }",
      "async consumeResource() { return this.#terminalResourceReservationLocked(); }",
      "async releaseResource() { return this.#terminalResourceReservationLocked(); }",
      "async #appendResourceEventLocked() {}",
      "async #terminalResourceReservationLocked() {}",
    ].join("\n"),
  );
};

const collectSelfTestFailures = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentos-resource-reservation-"));
  try {
    writePositiveFixture(root);
    const baseline = collectFailures(root);
    if (baseline.length > 0) {
      return [`resource reservation positive fixture failed:\n${baseline.join("\n")}`];
    }

    writeFixture(
      root,
      nodePostgresPath,
      [
        "interface ResourceReserveTransactionRow {}",
        "interface ResourceTerminalTransactionRow {}",
        "const resourceLockKey = () => 'lock';",
        "const resourceProjectionCtes = () => '';",
        "async grantResource() { return this.#appendResourceEventLocked({}); }",
        "async reserveResource() { const projected = await this.#loadResourceState(identity); return projected; }",
        "async consumeResource() { return this.#terminalResourceReservationLocked(); }",
        "async releaseResource() { return this.#terminalResourceReservationLocked(); }",
        "async #appendResourceEventLocked() {}",
        "async #terminalResourceReservationLocked() {}",
      ].join("\n"),
    );
    const rejected = collectFailures(root);
    if (!rejected.some((failure) => failure.includes("outside the lock"))) {
      return [
        `resource reservation mutation fixture was not rejected: ${JSON.stringify(rejected)}`,
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
    ? "resource reservation concurrency self-test passed"
    : "resource reservation concurrency passed",
);
