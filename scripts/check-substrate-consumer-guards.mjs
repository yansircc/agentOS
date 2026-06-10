#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

const aggregateScript = "test:substrate-consumer-guards";
const aggregateCommand =
  "node scripts/check-substrate-consumer-guards.mjs --self-test && node scripts/check-substrate-consumer-guards.mjs";

const guardScripts = [
  "test:ag-ui-resume-boundary",
  "test:ag-ui-sse-axis",
  "test:facade-handler-capability-boundary",
  "test:agent-doc-primitive-evidence",
  "test:resource-quota-protocol-ownership",
  "test:resource-reservation-concurrency",
  "test:node-postgres-runtime-import-boundary",
  "test:node-postgres-effect-governance",
  "test:backend-provider-axis-boundary",
  "test:backend-neutral-backend-set-ssot",
  "test:backend-neutral-production-runtime-proof",
  "test:run-scoped-material-bindings",
  "test:effectful-tool-replay-receipt",
  "test:dispatch-delivery-receipt-authority",
  "test:telemetry-otlp-tree-parity",
  "test:carrier-projection-source-truth",
  "test:turn-stream-provider-wire-boundary",
  "test:decision-gate-lifecycle-boundary",
  "test:workspace-exec-material-ref-boundary",
  "test:d12-a155-substrate-absorption",
  "test:tool-mutation-boundary",
  "test:agent-manifest-intent-boundary",
  "test:intent-settlement-boundary",
  "test:facade-run-scoped-bindings",
  "test:replay-dispatch-snapshot",
  "test:replay-llm-snapshot",
  "test:replay-tool-snapshot",
  "test:telemetry-neutral",
  "test:product-resource-boundary",
  "test:projection-wait-primitive",
  "test:dispatch-idempotency-receipt",
];

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

const packageScripts = (root) => readJson(path.join(root, "package.json")).scripts ?? {};

export const collectSubstrateConsumerGuardFailures = (root = repoRoot) => {
  const failures = [];
  const scripts = packageScripts(root);
  const check = scripts.check ?? "";

  if (scripts[aggregateScript] !== aggregateCommand) {
    failures.push(
      `package.json scripts.${aggregateScript}: expected ${JSON.stringify(aggregateCommand)}; actual ${JSON.stringify(scripts[aggregateScript])}`,
    );
  }

  if (!check.includes(`bun run ${aggregateScript}`)) {
    failures.push(`package.json scripts.check: missing bun run ${aggregateScript}`);
  }

  for (const scriptName of guardScripts) {
    if (scripts[scriptName] === undefined) {
      failures.push(`package.json scripts.${scriptName}: missing substrate consumer guard member`);
    }
    if (check.includes(`bun run ${scriptName}`)) {
      failures.push(
        `package.json scripts.check: ${scriptName} must be reached through ${aggregateScript}, not wired directly`,
      );
    }
  }

  return failures;
};

const writePackageJson = (root, scripts) => {
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ private: true, scripts }, null, 2) + "\n",
  );
};

const collectSelfTestFailures = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentos-substrate-consumer-guards-"));
  try {
    const okScripts = Object.fromEntries(
      guardScripts.map((scriptName) => [scriptName, "node ok.mjs"]),
    );
    writePackageJson(root, {
      ...okScripts,
      [aggregateScript]: aggregateCommand,
      check: `bun run docs:check && bun run ${aggregateScript} && bun run test`,
    });

    const baseline = collectSubstrateConsumerGuardFailures(root);
    if (baseline.length > 0) {
      return [`substrate consumer guard positive fixture failed:\n${baseline.join("\n")}`];
    }

    const failures = [];

    const missingMember = { ...okScripts };
    delete missingMember["test:tool-mutation-boundary"];
    writePackageJson(root, {
      ...missingMember,
      [aggregateScript]: aggregateCommand,
      check: `bun run ${aggregateScript}`,
    });
    const missingMemberFailures = collectSubstrateConsumerGuardFailures(root);
    if (!missingMemberFailures.some((failure) => failure.includes("test:tool-mutation-boundary"))) {
      failures.push(
        `missing member mutation was not rejected: ${JSON.stringify(missingMemberFailures)}`,
      );
    }

    writePackageJson(root, {
      ...okScripts,
      [aggregateScript]: aggregateCommand,
      check: "bun run test",
    });
    const missingCheckFailures = collectSubstrateConsumerGuardFailures(root);
    if (!missingCheckFailures.some((failure) => failure.includes("scripts.check"))) {
      failures.push(
        `missing check aggregate mutation was not rejected: ${JSON.stringify(missingCheckFailures)}`,
      );
    }

    writePackageJson(root, {
      ...okScripts,
      [aggregateScript]: aggregateCommand,
      check: `bun run ${aggregateScript} && bun run test:product-resource-boundary`,
    });
    const directMemberFailures = collectSubstrateConsumerGuardFailures(root);
    if (!directMemberFailures.some((failure) => failure.includes("wired directly"))) {
      failures.push(
        `direct member mutation was not rejected: ${JSON.stringify(directMemberFailures)}`,
      );
    }

    return failures;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
};

const runGuardScripts = () => {
  for (const scriptName of guardScripts) {
    const result = spawnSync("bun", ["run", scriptName], {
      cwd: repoRoot,
      env: process.env,
      stdio: "inherit",
    });
    if (result.status !== 0) return result.status ?? 1;
    if (result.signal !== null) {
      console.error(`${scriptName}: terminated by ${result.signal}`);
      return 1;
    }
  }
  return 0;
};

const failures = process.argv.includes("--self-test")
  ? collectSelfTestFailures()
  : collectSubstrateConsumerGuardFailures(repoRoot);

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

if (process.argv.includes("--self-test")) {
  console.log("substrate consumer guards self-test passed");
  process.exit(0);
}

const exitCode = runGuardScripts();
if (exitCode !== 0) process.exit(exitCode);

console.log("substrate consumer guards passed");
