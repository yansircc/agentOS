import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { walkRepoSourceFiles } from "../src/lib/repo-source-files.mjs";

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
