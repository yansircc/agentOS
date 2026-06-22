import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  moduleAmbientForPath,
  moduleBucketNegativeFixtureFailures,
  moduleBucketFindingsForEdges,
  moduleBucketForPath,
  moduleBucketRegistryFindings,
} from "../src/check/algorithmic-checks.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

void test("module bucket architecture source is valid", () => {
  const registry = JSON.parse(
    fs.readFileSync(path.join(repoRoot, "architecture/module-buckets.json"), "utf8"),
  );
  assert.deepEqual(moduleBucketRegistryFindings(registry), []);
});

void test("module bucket classifier marks product paths as ejection candidates", () => {
  assert.equal(moduleBucketForPath("packages/runtime/src/cloudflare/ops-api/index.ts"), "adapter");
  assert.equal(moduleBucketForPath("packages/core/src/index.ts"), "axioms");
  assert.equal(moduleBucketForPath("packages/runtime/src/ledger.ts"), "ledger");
  assert.equal(moduleBucketForPath("packages/runtime/src/continuation.ts"), "projection");
  assert.equal(moduleBucketForPath("packages/runtime/src/ag-ui.ts"), "projection");
  assert.equal(moduleBucketForPath("packages/runtime/src/sse-http.ts"), "projection");
  assert.equal(
    moduleBucketForPath("packages/runtime/src/attached-stream-protocol.ts"),
    "projection",
  );
  assert.equal(
    moduleBucketForPath("packages/runtime/src/decision-gate/definition.ts"),
    "projection",
  );
  assert.equal(
    moduleBucketForPath("packages/runtime/src/workspace-job-carrier/definition.ts"),
    "projection",
  );
  assert.equal(
    moduleBucketForPath("packages/runtime/src/workspace-op-carrier/definition.ts"),
    "projection",
  );
  assert.equal(moduleBucketForPath("packages/runtime/src/workspace-binding.ts"), "adapter");
  assert.equal(moduleBucketForPath("packages/runtime/src/submit-agent.ts"), "adapter");
  assert.equal(moduleBucketForPath("packages/client/src/index.ts"), "projection");
  assert.equal(moduleBucketForPath("packages/client/src/react/index.ts"), "adapter");
  assert.equal(moduleBucketForPath("packages/runtime/src/cloudflare/ledger/ledger.ts"), "adapter");
  assert.equal(
    moduleBucketForPath("packages/runtime/src/cloudflare/storage/effect-sqlite-do.ts"),
    "adapter",
  );
  assert.equal(
    moduleBucketForPath("packages/runtime/src/cloudflare/materialized-projections.ts"),
    "adapter",
  );
  assert.equal(moduleBucketForPath("packages/runtime/src/in-memory/ledger.ts"), "adapter");
  assert.equal(moduleBucketForPath("packages/runtime/src/in-memory/state.ts"), "adapter");
  assert.equal(
    moduleBucketForPath("packages/carriers/workspace-op/src/safe-events.ts"),
    "projection",
  );
});

void test("module ambient classifier keeps ambient as a module fact", () => {
  assert.equal(moduleAmbientForPath("packages/core/src/index.ts"), "neutral");
  assert.equal(moduleAmbientForPath("packages/client/src/index.ts"), "neutral");
  assert.equal(moduleAmbientForPath("packages/client/src/react/index.ts"), "browser");
  assert.equal(moduleAmbientForPath("packages/wire-adapters/ag-ui/src/index.ts"), "neutral");
  assert.equal(
    moduleAmbientForPath("packages/providers/workspace-op-local/src/index.ts"),
    "neutral",
  );
  assert.equal(moduleAmbientForPath("packages/runtime/src/node/index.ts"), "node");
  assert.equal(
    moduleAmbientForPath("packages/runtime/src/cloudflare/index.ts"),
    "cloudflare-worker",
  );
});

void test("module bucket scanner reports downstream bucket and ambient imports", () => {
  const findings = moduleBucketFindingsForEdges([
    {
      fromFile: "packages/core/src/index.ts",
      toFile: "packages/runtime/src/cloudflare/index.ts",
      specifier: "@agent-os/runtime/cloudflare",
    },
    {
      fromFile: "packages/client/src/index.ts",
      toFile: "packages/runtime/src/node/index.ts",
      specifier: "@agent-os/runtime/node",
    },
  ]);

  assert.deepEqual(
    findings.map((finding) => [finding.kind, finding.message]),
    [
      ["bucket-dag", "axioms module imports downstream adapter module"],
      ["ambient-dag", "neutral module imports cloudflare-worker module"],
      ["bucket-dag", "projection module imports downstream adapter module"],
      ["ambient-dag", "neutral module imports node module"],
    ],
  );
});

void test("module bucket negative fixtures prove enforce gates are live", () => {
  assert.deepEqual(moduleBucketNegativeFixtureFailures(), []);
});
