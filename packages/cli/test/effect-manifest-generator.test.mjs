import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const generator = fileURLToPath(
  new URL("../src/generate/generate-effect-skill-manifests.mjs", import.meta.url),
);

const adapter = (adapterPath, owner) => ({
  path: adapterPath,
  owner,
  reason: `${owner} owns the test boundary`,
  rules: ["EFF001", "EFF025"],
});

const makeFixture = (rootAdapters) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentos-effect-manifest-"));
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  fs.mkdirSync(path.join(root, "packages/core/src"), { recursive: true });
  fs.mkdirSync(path.join(root, "tooling"), { recursive: true });
  fs.writeFileSync(path.join(root, "pnpm-workspace.yaml"), "packages:\n  - packages/core\n");
  fs.writeFileSync(
    path.join(root, "packages/core/package.json"),
    JSON.stringify({ name: "@agent-os/core" }),
  );
  fs.writeFileSync(path.join(root, "packages/core/src/adapter.ts"), "export {};\n");
  fs.writeFileSync(path.join(root, "tooling/root.ts"), "export {};\n");
  const packageAdapter = adapter("src/adapter.ts", "@agent-os/core/adapter");
  fs.writeFileSync(
    path.join(root, "docs/effect-skill.json"),
    JSON.stringify({
      root: { allowedAdapters: rootAdapters },
      packageManifests: {
        "packages/core": { shape: ["library"], allowedAdapters: [packageAdapter] },
      },
    }),
  );
  return { root, packageAdapter };
};

const runGenerator = (root) =>
  spawnSync(process.execPath, [generator], { cwd: root, encoding: "utf8" });

void test("effect manifest generator rebases one package adapter fact into root projection", () => {
  const rootAdapter = adapter("tooling/root.ts", "@agent-os/root-adapter");
  const fixture = makeFixture([rootAdapter]);
  try {
    const result = runGenerator(fixture.root);
    assert.equal(result.status, 0, result.stderr);
    const rootManifest = JSON.parse(
      fs.readFileSync(path.join(fixture.root, ".effect-skill.json"), "utf8"),
    );
    const packageManifest = JSON.parse(
      fs.readFileSync(path.join(fixture.root, "packages/core/.effect-skill.json"), "utf8"),
    );
    assert.deepEqual(packageManifest.allowedAdapters, [fixture.packageAdapter]);
    assert.deepEqual(rootManifest.allowedAdapters, [
      rootAdapter,
      { ...fixture.packageAdapter, path: "packages/core/src/adapter.ts" },
    ]);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

void test("effect manifest generator rejects a root-authored package adapter duplicate", () => {
  const fixture = makeFixture([
    adapter("packages/./core/src/adapter.ts", "@agent-os/root-duplicate"),
  ]);
  try {
    const result = runGenerator(fixture.root);
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /root\.allowedAdapters\[0\]\.path duplicates package ownership under packages\/core/u,
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

void test("effect manifest generator rejects normalized package adapter duplicates", () => {
  const fixture = makeFixture([]);
  try {
    const sourcePath = path.join(fixture.root, "docs/effect-skill.json");
    const source = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
    source.packageManifests["packages/core"].allowedAdapters.push(
      adapter("src/./adapter.ts", "@agent-os/core/duplicate"),
    );
    fs.writeFileSync(sourcePath, JSON.stringify(source));

    const result = runGenerator(fixture.root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /allowedAdapters\[1\]\.path duplicates src\/\.\/adapter\.ts/u);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});
