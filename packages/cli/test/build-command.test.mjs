import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const cli = path.join(repoRoot, "packages/cli/src/main.mjs");
const workspaceDefaultToolNames = ["bash", "glob", "grep", "read_file", "write_file"];

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
          tools: {
            write_file: { interaction: "approval" },
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
    assert.match(result.stdout, /generated 11 agentOS files/);
    const manifest = JSON.parse(
      readFileSync(path.join(root, ".agentos/generated/manifest.json"), "utf8"),
    );
    assert.equal(manifest.agentId, "fixture-agent");
    assert.deepEqual(Object.keys(manifest.tools ?? {}).sort(), workspaceDefaultToolNames);
    assert.equal(manifest.tools.bash.interaction, "never");
    assert.equal(manifest.tools.write_file.interaction, "approval");
    const target = readFileSync(path.join(root, ".agentos/generated/target.ts"), "utf8");
    assert.match(target, /import semanticDeclarations from "\.\/manifest\.json";/);
    assert.match(target, /generatedWorkspaceToolInteractions/);
    assert.match(target, /toolInteractions: generatedWorkspaceToolInteractions/);
    assert.doesNotMatch(target, /\.\.\/\.\.\/agent\/tools\/read_file/);
    assert.doesNotMatch(target, /MountPlan|mountPlan|registry\.get/);
    const scopeHelper = readFileSync(
      path.join(root, ".agentos/generated/cloudflare-scope.ts"),
      "utf8",
    );
    assert.match(scopeHelper, /agentOSDurableObjectBinding = "AGENT_OS"/);
    assert.match(scopeHelper, /agentOSScopeId = agentOSTruthIdentity\.scopeRef\.scopeId/);
    assert.match(scopeHelper, /agentOSRpcClient/);
    const worker = readFileSync(path.join(root, ".agentos/generated/worker.ts"), "utf8");
    assert.match(worker, /import \{ Sandbox \} from "@cloudflare\/sandbox";/);
    assert.match(worker, /import \{ AgentOS \} from "\.\/target";/);
    assert.match(worker, /export \{ AgentOS, Sandbox \};/);
    const wrangler = JSON.parse(
      readFileSync(path.join(root, ".agentos/generated/wrangler.jsonc"), "utf8"),
    );
    assert.equal(wrangler.main, "./worker.ts");
    assert.deepEqual(wrangler.compatibility_flags, ["nodejs_compat"]);
    assert.deepEqual(wrangler.containers, [
      {
        class_name: "Sandbox",
        image: "../../Dockerfile",
        instance_type: "lite",
        max_instances: 2,
      },
    ]);
    assert.deepEqual(wrangler.durable_objects.bindings, [
      { class_name: "Sandbox", name: "Sandbox" },
      { class_name: "AgentOS", name: "AGENT_OS" },
    ]);
    assert.deepEqual(wrangler.migrations, [
      { tag: "v1", new_sqlite_classes: ["Sandbox", "AgentOS"] },
    ]);
    const remote = readFileSync(path.join(root, ".agentos/generated/sveltekit.remote.ts"), "utf8");
    assert.match(remote, /import \{ agentOSRpcClient \} from "\.\/cloudflare-scope";/);
    assert.doesNotMatch(remote, /durableObjectRpcClient/);
    assert.doesNotMatch(remote, /manifestTruthIdentity/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
