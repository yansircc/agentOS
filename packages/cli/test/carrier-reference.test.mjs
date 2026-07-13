import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const generator = path.join(root, "packages/cli/src/generate/generate-carrier-reference.mjs");
const reference = path.join(root, "docs/reference/carriers.md");

test("carrier reference exposes positive authority contracts and claim bindings", () => {
  const checked = spawnSync(process.execPath, [generator, "--check"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(checked.status, 0, checked.stderr || checked.stdout);

  const markdown = fs.readFileSync(reference, "utf8");
  assert.match(markdown, /Contract id\s+\| Selector\s+\| Required material slots/u);
  assert.match(markdown, /`decision-gate\.runtime-identity`\s+\| bound at commit/u);
  assert.match(markdown, /pre `claim`; authority `decision-gate\.runtime-identity`/u);
  assert.match(
    markdown,
    /indeterminate `claim`; authority `workspace-job\.runtime-identity`; indeterminate kinds/u,
  );
  assert.doesNotMatch(markdown, /<unknown>/u);
});
