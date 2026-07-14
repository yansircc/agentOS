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

const executableEdge = (edgePath, owner) => ({
  path: edgePath,
  owner,
  reason: `${owner} owns the test lifecycle`,
  execution: {
    lifecycle: "host-callback",
    runners: ["Effect.runPromise"],
    hosts: [{ module: "test-host", export: "test", callbackArgument: 1 }],
  },
});

const aiProviderTransport = (transportPath, owner) => ({
  path: transportPath,
  owner,
  reason: `${owner} owns the provider transport`,
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
  fs.writeFileSync(path.join(root, "packages/core/src/edge.ts"), "export {};\n");
  fs.writeFileSync(path.join(root, "packages/core/src/provider.ts"), "export {};\n");
  fs.writeFileSync(path.join(root, "packages/core/wrangler.jsonc"), '{"main":"src/edge.ts"}\n');
  fs.writeFileSync(path.join(root, "tooling/root.ts"), "export {};\n");
  const packageAdapter = adapter("src/adapter.ts", "@agent-os/core/adapter");
  const packageEdge = executableEdge("src/edge.ts", "@agent-os/core/edge");
  const packageTransport = aiProviderTransport("src/provider.ts", "@agent-os/core/provider");
  fs.writeFileSync(
    path.join(root, "docs/effect-skill.json"),
    JSON.stringify({
      root: { packageDefaults: { shape: ["node"] }, allowedAdapters: rootAdapters },
      packageManifests: {
        "packages/core": {
          shape: ["library"],
          effectMajorPolicy: "dual-track",
          wranglerPath: "wrangler.jsonc",
          executableEdges: [packageEdge],
          allowedAdapters: [packageAdapter],
          aiProviderTransports: [packageTransport],
        },
      },
    }),
  );
  return { root, packageAdapter, packageEdge, packageTransport };
};

const runGenerator = (root) =>
  spawnSync(process.execPath, [generator], { cwd: root, encoding: "utf8" });

void test("effect manifest generator projects package path and descriptor facts into root", () => {
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
    assert.deepEqual(packageManifest.executableEdges, [fixture.packageEdge]);
    assert.deepEqual(packageManifest.aiProviderTransports, [fixture.packageTransport]);
    assert.equal(packageManifest.wranglerPath, "wrangler.jsonc");
    assert.deepEqual(rootManifest.allowedAdapters, [
      rootAdapter,
      { ...fixture.packageAdapter, path: "packages/core/src/adapter.ts" },
    ]);
    assert.deepEqual(rootManifest.executableEdges, [
      { ...fixture.packageEdge, path: "packages/core/src/edge.ts" },
    ]);
    assert.deepEqual(rootManifest.aiProviderTransports, [
      { ...fixture.packageTransport, path: "packages/core/src/provider.ts" },
    ]);
    assert.deepEqual(rootManifest.packages, [
      {
        path: "packages/core",
        shape: ["library"],
        effectMajorPolicy: "dual-track",
        wranglerPath: "wrangler.jsonc",
      },
    ]);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

void test("effect manifest generator keeps string arrays within formatter print width", () => {
  const fixture = makeFixture([]);
  try {
    const sourcePath = path.join(fixture.root, "docs/effect-skill.json");
    const source = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
    source.root.testGlobs = [
      "**/first-extremely-long-runtime-contract.test.ts",
      "**/second-extremely-long-runtime-contract.test.ts",
      "**/third-extremely-long-runtime-contract.test.ts",
    ];
    fs.writeFileSync(sourcePath, JSON.stringify(source));

    const result = runGenerator(fixture.root);
    assert.equal(result.status, 0, result.stderr);
    const rootText = fs.readFileSync(path.join(fixture.root, ".effect-skill.json"), "utf8");
    const packageText = fs.readFileSync(
      path.join(fixture.root, "packages/core/.effect-skill.json"),
      "utf8",
    );
    assert.match(rootText, /"testGlobs": \[\n/u);
    assert.match(packageText, /"shape": \["library"\]/u);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

void test("effect manifest generator rejects a root-authored package executable edge", () => {
  const fixture = makeFixture([]);
  try {
    fs.writeFileSync(path.join(fixture.root, "packages/core/src/root-edge.ts"), "export {};\n");
    const sourcePath = path.join(fixture.root, "docs/effect-skill.json");
    const source = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
    source.root.executableEdges = [
      executableEdge("packages/core/src/root-edge.ts", "@agent-os/root-duplicate"),
    ];
    fs.writeFileSync(sourcePath, JSON.stringify(source));

    const result = runGenerator(fixture.root);
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /root\.executableEdges\[0\]\.path duplicates package ownership under packages\/core/u,
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

void test("effect manifest generator rejects duplicate package descriptor ownership", () => {
  const fixture = makeFixture([]);
  try {
    const sourcePath = path.join(fixture.root, "docs/effect-skill.json");
    const source = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
    source.root.packageOverrides = {
      "packages/core": {
        shape: ["node"],
        effectMajorPolicy: "dual-track",
        wranglerPath: "wrangler.jsonc",
      },
    };
    fs.writeFileSync(sourcePath, JSON.stringify(source));

    const result = runGenerator(fixture.root);
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /root\.packageOverrides\.packages\/core\.wranglerPath duplicates package manifest ownership/u,
    );
    assert.match(
      result.stderr,
      /root\.packageOverrides\.packages\/core\.shape duplicates package manifest ownership/u,
    );
    assert.match(
      result.stderr,
      /root\.packageOverrides\.packages\/core\.effectMajorPolicy duplicates package manifest ownership/u,
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

void test("effect manifest generator does not inject descriptor defaults into package owners", () => {
  const fixture = makeFixture([]);
  try {
    const sourcePath = path.join(fixture.root, "docs/effect-skill.json");
    const source = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
    delete source.packageManifests["packages/core"].effectMajorPolicy;
    source.root.packageDefaults.effectMajorPolicy = "dual-track";
    fs.writeFileSync(sourcePath, JSON.stringify(source));

    const result = runGenerator(fixture.root);
    assert.equal(result.status, 0, result.stderr);
    const rootManifest = JSON.parse(
      fs.readFileSync(path.join(fixture.root, ".effect-skill.json"), "utf8"),
    );
    const packageManifest = JSON.parse(
      fs.readFileSync(path.join(fixture.root, "packages/core/.effect-skill.json"), "utf8"),
    );
    assert.equal(Object.hasOwn(rootManifest.packages[0], "effectMajorPolicy"), false);
    assert.equal(Object.hasOwn(packageManifest, "effectMajorPolicy"), false);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

void test("effect manifest generator rejects descriptor overrides for package owners", () => {
  const fixture = makeFixture([]);
  try {
    const sourcePath = path.join(fixture.root, "docs/effect-skill.json");
    const source = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
    delete source.packageManifests["packages/core"].effectMajorPolicy;
    source.root.packageOverrides = {
      "packages/core": { effectMajorPolicy: "dual-track" },
    };
    fs.writeFileSync(sourcePath, JSON.stringify(source));

    const result = runGenerator(fixture.root);
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /root\.packageOverrides\.packages\/core\.effectMajorPolicy duplicates package manifest ownership/u,
    );
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

void test("effect manifest generator rejects root path items escaping the repository", () => {
  const fixture = makeFixture([]);
  const outsideName = `${path.basename(fixture.root)}-outside.ts`;
  const outsidePath = path.join(fixture.root, "..", outsideName);
  try {
    fs.writeFileSync(outsidePath, "export {};\n");
    const sourcePath = path.join(fixture.root, "docs/effect-skill.json");
    const source = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
    source.root.allowedAdapters = [adapter(`../${outsideName}`, "@agent-os/root-escape")];
    fs.writeFileSync(sourcePath, JSON.stringify(source));

    const result = runGenerator(fixture.root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /root\.allowedAdapters\[0\]\.path escapes repository root/u);
  } finally {
    fs.rmSync(outsidePath, { force: true });
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

void test("effect manifest generator rejects duplicate package adapters", () => {
  const fixture = makeFixture([]);
  try {
    const sourcePath = path.join(fixture.root, "docs/effect-skill.json");
    const source = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
    source.packageManifests["packages/core"].allowedAdapters.push(
      adapter("src/adapter.ts", "@agent-os/core/duplicate"),
    );
    fs.writeFileSync(sourcePath, JSON.stringify(source));

    const result = runGenerator(fixture.root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /allowedAdapters\[1\]\.path duplicates src\/adapter\.ts/u);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

void test("effect manifest generator rejects duplicate package executable edges", () => {
  const fixture = makeFixture([]);
  try {
    const sourcePath = path.join(fixture.root, "docs/effect-skill.json");
    const source = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
    source.packageManifests["packages/core"].executableEdges.push(
      executableEdge("src/edge.ts", "@agent-os/core/duplicate"),
    );
    fs.writeFileSync(sourcePath, JSON.stringify(source));

    const result = runGenerator(fixture.root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /executableEdges\[1\]\.path duplicates src\/edge\.ts/u);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

void test("effect manifest generator rejects executable edges escaping the package root", () => {
  const fixture = makeFixture([]);
  try {
    fs.writeFileSync(path.join(fixture.root, "packages/outside.ts"), "export {};\n");
    const sourcePath = path.join(fixture.root, "docs/effect-skill.json");
    const source = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
    source.packageManifests["packages/core"].executableEdges = [
      executableEdge("../outside.ts", "@agent-os/core/escape"),
    ];
    fs.writeFileSync(sourcePath, JSON.stringify(source));

    const result = runGenerator(fixture.root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /executableEdges\[0\]\.path escapes package packages\/core/u);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

void test("effect manifest generator rejects non-canonical package paths", () => {
  const fixture = makeFixture([]);
  try {
    const sourcePath = path.join(fixture.root, "docs/effect-skill.json");
    const source = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
    source.packageManifests["packages/core"].allowedAdapters = [
      adapter("src/./adapter.ts", "@agent-os/core/alias"),
    ];
    fs.writeFileSync(sourcePath, JSON.stringify(source));

    const result = runGenerator(fixture.root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /path must be canonical POSIX path src\/adapter\.ts/u);
    assert.equal(fs.existsSync(path.join(fixture.root, ".effect-skill.json")), false);
    assert.equal(fs.existsSync(path.join(fixture.root, "packages/core/.effect-skill.json")), false);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

void test("effect manifest generator rejects non-canonical package Wrangler paths", () => {
  const fixture = makeFixture([]);
  try {
    const sourcePath = path.join(fixture.root, "docs/effect-skill.json");
    const source = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
    source.packageManifests["packages/core"].wranglerPath = "./wrangler.jsonc";
    fs.writeFileSync(sourcePath, JSON.stringify(source));

    const result = runGenerator(fixture.root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /wranglerPath must be canonical POSIX path wrangler\.jsonc/u);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

void test("effect manifest generator rejects directories as path-item files", () => {
  const fixture = makeFixture([]);
  try {
    const sourcePath = path.join(fixture.root, "docs/effect-skill.json");
    const source = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
    source.packageManifests["packages/core"].aiProviderTransports = [
      aiProviderTransport("src", "@agent-os/core/directory"),
    ];
    fs.writeFileSync(sourcePath, JSON.stringify(source));

    const result = runGenerator(fixture.root);
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /aiProviderTransports\[0\]\.path references missing or non-file target packages\/core\/src/u,
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

void test("effect manifest generator fails closed for package fields without a root projection", () => {
  const fixture = makeFixture([]);
  try {
    const sourcePath = path.join(fixture.root, "docs/effect-skill.json");
    const source = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
    source.packageManifests["packages/core"].generatedPaths = [
      { glob: "src/generated/**", owner: "@agent-os/core/generated", reason: "generated fixture" },
    ];
    fs.writeFileSync(sourcePath, JSON.stringify(source));

    const result = runGenerator(fixture.root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /generatedPaths has no declared projection/u);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

void test("effect manifest generator requires package-owned shape", () => {
  const fixture = makeFixture([]);
  try {
    const sourcePath = path.join(fixture.root, "docs/effect-skill.json");
    const source = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
    delete source.packageManifests["packages/core"].shape;
    fs.writeFileSync(sourcePath, JSON.stringify(source));

    const result = runGenerator(fixture.root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /shape is required for package and root projections/u);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

void test("effect manifest generator rejects unknown package default fields", () => {
  const fixture = makeFixture([]);
  try {
    const generatedRoot = path.join(fixture.root, ".effect-skill.json");
    fs.writeFileSync(generatedRoot, "sentinel\n");
    const sourcePath = path.join(fixture.root, "docs/effect-skill.json");
    const source = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
    source.root.packageDefaults.mystery = true;
    fs.writeFileSync(sourcePath, JSON.stringify(source));

    const result = runGenerator(fixture.root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /root\.packageDefaults\.mystery has no declared projection/u);
    assert.equal(fs.readFileSync(generatedRoot, "utf8"), "sentinel\n");
    assert.equal(fs.existsSync(path.join(fixture.root, "packages/core/.effect-skill.json")), false);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

void test("effect manifest generator rejects single-package fields on the root projection", () => {
  const fixture = makeFixture([]);
  try {
    const sourcePath = path.join(fixture.root, "docs/effect-skill.json");
    const source = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
    source.root.shape = ["library"];
    fs.writeFileSync(sourcePath, JSON.stringify(source));

    const result = runGenerator(fixture.root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /root\.shape has no declared projection/u);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

void test("effect manifest generator rejects canonical and aliased package owners before writes", () => {
  const fixture = makeFixture([]);
  try {
    const sourcePath = path.join(fixture.root, "docs/effect-skill.json");
    const source = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
    source.packageManifests["packages/./core"] = {
      shape: ["library"],
      allowedAdapters: [adapter("src/adapter.ts", "@agent-os/core/divergent-owner")],
    };
    fs.writeFileSync(sourcePath, JSON.stringify(source));

    const result = runGenerator(fixture.root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /must exactly equal a canonical workspace package path/u);
    assert.match(result.stderr, /duplicates canonical package owner packages\/core/u);
    assert.equal(fs.existsSync(path.join(fixture.root, ".effect-skill.json")), false);
    assert.equal(fs.existsSync(path.join(fixture.root, "packages/core/.effect-skill.json")), false);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

void test("effect manifest generator rejects a lone aliased package owner before writes", () => {
  const fixture = makeFixture([]);
  try {
    const sourcePath = path.join(fixture.root, "docs/effect-skill.json");
    const source = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
    source.packageManifests["packages/./core"] = source.packageManifests["packages/core"];
    delete source.packageManifests["packages/core"];
    fs.writeFileSync(sourcePath, JSON.stringify(source));

    const result = runGenerator(fixture.root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /must exactly equal a canonical workspace package path/u);
    assert.doesNotMatch(result.stderr, /duplicates canonical package owner/u);
    assert.equal(fs.existsSync(path.join(fixture.root, ".effect-skill.json")), false);
    assert.equal(fs.existsSync(path.join(fixture.root, "packages/core/.effect-skill.json")), false);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});
