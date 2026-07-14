import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
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

const normalizedCommand = (command) => command.replace(/\s+/gu, " ").trim();
const stepUsing = (job, action) => job.steps.find((step) => step.uses === action);
const namedStep = (job, name) => job.steps.find((step) => step.name === name);

void test("CI routes each event through its manifest-owned acceptance contract", () => {
  const workflow = parseYaml(readFileSync(path.join(repoRoot, ".github/workflows/ci.yml"), "utf8"));
  const rootPackage = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  const nodeVersion = readFileSync(path.join(repoRoot, ".node-version"), "utf8");
  const verificationDocs = readFileSync(path.join(repoRoot, "docs/verification.md"), "utf8");

  assert.match(nodeVersion, /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\n$/u);
  assert.equal(rootPackage.engines?.node, undefined);
  assert.match(rootPackage.packageManager, /^pnpm@\d+\.\d+\.\d+$/u);

  assert.deepEqual(Object.keys(workflow.on).sort(), ["pull_request", "push", "release"]);
  assert.deepEqual(workflow.on.push.branches, ["main"]);
  assert.deepEqual(workflow.on.release.types, ["published"]);
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.deepEqual(Object.keys(workflow.jobs).sort(), ["full", "pull-request"]);

  const pullRequest = workflow.jobs["pull-request"];
  const full = workflow.jobs.full;
  assert.equal(pullRequest.if, "github.event_name == 'pull_request'");
  assert.equal(full.if, "github.event_name == 'push' || github.event_name == 'release'");

  for (const job of [pullRequest, full]) {
    assert.equal(job["runs-on"], "ubuntu-latest");
    assert.equal(stepUsing(job, "actions/checkout@v4").with["fetch-depth"], 0);

    const pnpm = stepUsing(job, "pnpm/action-setup@v4");
    assert.ok(pnpm);
    assert.equal(pnpm.with?.version, undefined);

    const node = stepUsing(job, "actions/setup-node@v4");
    assert.equal(node.with["node-version-file"], ".node-version");
    assert.equal(node.with["node-version"], undefined);
    assert.equal(node.with.cache, "pnpm");
    assert.equal(node.with["cache-dependency-path"], "pnpm-lock.yaml");
    assert.ok(job.steps.some((step) => step.run === "pnpm install --frozen-lockfile"));
  }

  assert.equal(
    normalizedCommand(namedStep(pullRequest, "Run affected gates").run),
    'pnpm run agentos check affected --base "${{ github.event.pull_request.base.sha }}" --head "${{ github.event.pull_request.head.sha }}" --run',
  );
  assert.equal(namedStep(full, "Run full gate").run, "pnpm run check:full");
  assert.equal(namedStep(pullRequest, "Run full gate"), undefined);
  assert.equal(namedStep(full, "Run affected gates"), undefined);

  const exactNodeVersion = nodeVersion.trim();
  const exactPnpmVersion = rootPackage.packageManager.slice("pnpm@".length);
  assert.ok(!JSON.stringify(workflow).includes(exactNodeVersion));
  assert.ok(!JSON.stringify(workflow).includes(exactPnpmVersion));
  assert.ok(!verificationDocs.includes(exactNodeVersion));
});
