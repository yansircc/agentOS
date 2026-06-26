import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { walkRepoSourceFiles } from "../src/lib/repo-source-files.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

test("repo source file walk ignores local execution surfaces", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentos-source-walk-"));
  try {
    for (const directory of [".git", ".cst", ".parallel", ".codex"]) {
      fs.mkdirSync(path.join(root, directory), { recursive: true });
      fs.writeFileSync(path.join(root, directory, "catalog.source.json"), "{}\n");
    }
    fs.mkdirSync(path.join(root, "docs"), { recursive: true });
    fs.writeFileSync(path.join(root, "docs", "catalog.source.json"), "{}\n");

    assert.deepEqual(walkRepoSourceFiles(root, "."), ["docs/catalog.source.json"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("agent catalog check ignores CST and parallel execution artifacts", () => {
  const artifacts = [
    path.join(repoRoot, ".cst", "catalog.source.json"),
    path.join(repoRoot, ".parallel", "test-agent-catalog", "catalog.source.json"),
    path.join(repoRoot, ".codex", "test-agent-catalog", "catalog.source.json"),
  ];
  try {
    for (const artifact of artifacts) {
      fs.mkdirSync(path.dirname(artifact), { recursive: true });
      fs.writeFileSync(artifact, "{}\n");
    }
    const result = spawnSync(
      process.execPath,
      ["packages/cli/src/generate/generate-agent-catalog.mjs", "--check"],
      { cwd: repoRoot, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    for (const artifact of artifacts) {
      fs.rmSync(artifact, { force: true });
    }
    fs.rmSync(path.join(repoRoot, ".parallel", "test-agent-catalog"), {
      recursive: true,
      force: true,
    });
    fs.rmSync(path.join(repoRoot, ".codex", "test-agent-catalog"), {
      recursive: true,
      force: true,
    });
  }
});
