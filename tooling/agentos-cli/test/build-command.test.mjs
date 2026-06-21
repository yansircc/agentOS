import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const cli = path.join(repoRoot, "tooling/agentos-cli/src/main.mjs");
const workspaceDefaultToolNames = [
  "delete_path",
  "edit_file",
  "glob_files",
  "grep_files",
  "list_files",
  "read_file",
  "run_shell",
  "write_file",
];

void test("agentos build compiles an authored workspace tree into generated files", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "agentos-build-"));
  try {
    writeFileSync(path.join(root, "package.json"), JSON.stringify({ type: "module" }, null, 2));
    mkdirSync(path.join(root, "agent"), { recursive: true });
    writeFileSync(path.join(root, "agent/instructions.md"), "Operate on the workspace.");
    writeFileSync(
      path.join(root, "agent/agent.json"),
      JSON.stringify(
        {
          agentId: "fixture-agent",
          scope: {
            kind: "session",
            idSource: "manifest",
            stableScopeId: "fixture-scope",
          },
          effectAuthorityRef: {
            authorityClass: "effect",
            authorityId: "fixture-agent",
          },
          materials: {
            workspace: {
              kind: "external_resource",
              provider: "agent-os",
              resourceKind: "workspace-env",
              ref: "cloudflare-sandbox:fixture-scope",
            },
          },
          executionDomains: {
            workspace: { bindingRef: "workspace" },
          },
        },
        null,
        2,
      ),
    );
    writeFileSync(
      path.join(root, "agentos.config.jsonc"),
      [
        "{",
        '  "$schema": "./node_modules/@agent-os/config/schema.json",',
        '  "profile": "workspace@1",',
        '  "agent": "./agent",',
        '  "deployment": {',
        '    "id": "fixture-deployment",',
        '    "version": "0.1.0", // JSONC comment',
        "  },",
        '  "target": {',
        '    "kind": "cloudflare-do@1",',
        '    "durableObject": { "className": "AgentOS", "binding": "AGENT_OS" },',
        "  },",
        '  "client": { "kind": "svelte-kit-remote@1" },',
        '  "llm": {',
        '    "route": "openai-chat-compatible",',
        '    "endpointRef": "openrouter",',
        '    "credentialRef": "openrouter-key",',
        '    "modelRef": "openrouter-default-text-model",',
        "  },",
        '  "workspace": {',
        '    "binding": "Sandbox",',
        '    "root": "/workspace",',
        "  },",
        "}",
        "",
      ].join("\n"),
    );

    const result = spawnSync(process.execPath, [cli, "build", "--cwd", root], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /generated 8 agentOS files/);
    const manifest = JSON.parse(
      readFileSync(path.join(root, ".agentos/generated/manifest.json"), "utf8"),
    );
    assert.equal(manifest.agentId, "fixture-agent");
    assert.deepEqual(Object.keys(manifest.tools ?? {}).sort(), workspaceDefaultToolNames);
    assert.equal(manifest.tools.run_shell.interaction, "approval");
    const target = readFileSync(path.join(root, ".agentos/generated/target.ts"), "utf8");
    assert.match(target, /import semanticDeclarations from "\.\/manifest\.json";/);
    assert.doesNotMatch(target, /\.\.\/\.\.\/agent\/tools\/read_file/);
    assert.doesNotMatch(target, /MountPlan|mountPlan|registry\.get/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
