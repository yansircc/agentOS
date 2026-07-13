import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const cli = path.join(repoRoot, "packages/cli/src/main.mjs");

const linkSourceDependencies = (root) => {
  const scope = path.join(root, "node_modules/@agent-os");
  mkdirSync(scope, { recursive: true });
  for (const name of ["client", "core", "runtime"]) {
    symlinkSync(path.join(repoRoot, `packages/${name}`), path.join(scope, name), "dir");
  }
  symlinkSync(path.join(repoRoot, "node_modules/effect"), path.join(root, "node_modules/effect"));
};

const writeProduct = (root, declaration = { agentId: "first-agent", kind: "workspace" }) => {
  mkdirSync(path.join(root, "agent"), { recursive: true });
  writeFileSync(path.join(root, "agent/agent.json"), `${JSON.stringify(declaration, null, 2)}\n`);
  writeFileSync(
    path.join(root, "agent/instructions.md"),
    "You are concise. Answer the user's request directly.\n",
  );
};

test("CLI exposes ask/dev as the only ordinary local commands", () => {
  const result = spawnSync(process.execPath, [cli, "--help"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /agentos ask /);
  assert.match(result.stdout, /agentos dev /);
  assert.doesNotMatch(result.stdout, /agentos serve /);
});

test("agentos ask compiles the minimal product and owns local correlation", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "agentos-product-ask-"));
  try {
    linkSourceDependencies(root);
    writeProduct(root);
    const result = spawnSync(
      process.execPath,
      [
        cli,
        "ask",
        "Say hello",
        "--cwd",
        root,
        "--llm",
        "test",
        "--llm-response",
        "Hello from agentOS",
      ],
      { cwd: repoRoot, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "Hello from agentOS");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("old product and CLI config fields are rejected instead of inferred", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "agentos-product-old-fields-"));
  try {
    writeProduct(root, {
      agentId: "legacy-agent",
      kind: "workspace",
      scope: { kind: "session", idSource: "manifest", stableScopeId: "legacy" },
      effectAuthorityRef: { authorityClass: "effect", authorityId: "legacy" },
    });
    const productResult = spawnSync(
      process.execPath,
      [cli, "ask", "hello", "--cwd", root, "--llm", "test"],
      { cwd: repoRoot, encoding: "utf8" },
    );
    assert.notEqual(productResult.status, 0);
    assert.match(productResult.stderr, /unknown_field/);
    assert.match(productResult.stderr, /scope/);
    assert.match(productResult.stderr, /effectAuthorityRef/);

    const configResult = spawnSync(
      process.execPath,
      [cli, "ask", "hello", "--cwd", root, "--config", "agentos.config.jsonc"],
      { cwd: repoRoot, encoding: "utf8" },
    );
    assert.notEqual(configResult.status, 0);
    assert.match(configResult.stderr, /unexpected argument --config/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
