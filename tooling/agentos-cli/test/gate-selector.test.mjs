import assert from "node:assert/strict";
import test from "node:test";
import { deriveAffectedGates } from "../src/check/gate-selector.mjs";

void test("affected selector fails closed for global surfaces and unknown paths", () => {
  assert.equal(
    deriveAffectedGates({ changedPaths: ["docs/agent/gates.source.json"] }).mode,
    "full",
  );
  assert.equal(deriveAffectedGates({ changedPaths: ["unknown/path.txt"] }).mode, "full");
});

void test("affected selector routes runtime package changes to runtime proof", () => {
  const result = deriveAffectedGates({
    changedPaths: ["packages/runtime/src/node/index.ts"],
  });
  assert.equal(result.mode, "affected");
  assert.ok(result.proofClasses.includes("runtime"));
  assert.ok(result.run.some((entry) => entry.command === "bun run check:runtime"));
});

void test("affected selector uses reverse dependency closure", () => {
  const result = deriveAffectedGates({ changedPaths: ["packages/core/src/index.ts"] });
  assert.equal(result.mode, "affected");
  assert.ok(result.affectedPackages.includes("@agent-os/runtime"));
  assert.ok(result.proofClasses.includes("runtime"));
});

void test("affected selector maps package manifest changes to distribution proof", () => {
  const result = deriveAffectedGates({
    changedPaths: ["packages/runtime/package.json"],
  });
  assert.equal(result.mode, "affected");
  assert.ok(result.proofClasses.includes("distribution"));
});
