import assert from "node:assert/strict";
import test from "node:test";
import {
  moduleAmbientForPath,
  moduleBucketFindingsForEdges,
  moduleBucketForPath,
} from "../src/check/algorithmic-checks.mjs";

void test("module bucket classifier marks product paths as ejection candidates", () => {
  assert.equal(moduleBucketForPath("tooling/ops-api/src/index.ts"), "product");
  assert.equal(moduleBucketForPath("packages/kernel/src/index.ts"), "axioms");
  assert.equal(moduleBucketForPath("packages/runtime/src/ledger.ts"), "ledger");
  assert.equal(
    moduleBucketForPath("packages/carriers/workspace-op/src/safe-events.ts"),
    "projection",
  );
});

void test("module ambient classifier keeps ambient as a module fact", () => {
  assert.equal(moduleAmbientForPath("packages/kernel/src/index.ts"), "neutral");
  assert.equal(moduleAmbientForPath("packages/client/core/src/index.ts"), "browser");
  assert.equal(moduleAmbientForPath("packages/backends/node-postgres/src/index.ts"), "node");
  assert.equal(
    moduleAmbientForPath("packages/backends/cloudflare-do/src/index.ts"),
    "cloudflare-worker",
  );
});

void test("module bucket scanner reports downstream bucket and ambient imports", () => {
  const findings = moduleBucketFindingsForEdges([
    {
      fromFile: "packages/kernel/src/index.ts",
      toFile: "packages/providers/deploy-cloudflare/src/index.ts",
      specifier: "@agent-os/deploy-cloudflare",
    },
    {
      fromFile: "packages/client/core/src/index.ts",
      toFile: "packages/backends/node-postgres/src/index.ts",
      specifier: "@agent-os/backend-node-postgres",
    },
  ]);

  assert.deepEqual(
    findings.map((finding) => [finding.kind, finding.message]),
    [
      ["bucket-dag", "axioms module imports downstream adapter module"],
      ["ambient-dag", "neutral module imports cloudflare-worker module"],
      ["ambient-dag", "browser module imports node module"],
    ],
  );
});
