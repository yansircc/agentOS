import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runAlgorithmicChecker } from "../src/check/algorithmic-checks.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

void test("gate tier governance ignores parallel-dev execution surfaces", async () => {
  const noiseRoot = path.join(repoRoot, ".parallel", "test-gate-tier-governance");
  try {
    mkdirSync(noiseRoot, { recursive: true });
    writeFileSync(path.join(noiseRoot, "noise.tsbuildinfo"), "{}\n");

    await assert.doesNotReject(runAlgorithmicChecker("gate-tier-governance"));
  } finally {
    rmSync(noiseRoot, { recursive: true, force: true });
  }
});
