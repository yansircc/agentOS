import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const evaluate = (expression) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "agentos-deployment-intent-"));
  const outfile = path.join(root, "probe.mjs");
  try {
    buildSync({
      stdin: {
        contents: `
          import { decodeDeploymentIntent } from "./packages/cli/src/build/agent-authoring/deployment-intent.ts";
          process.stdout.write(JSON.stringify(${expression}));
        `,
        loader: "ts",
        resolveDir: repoRoot,
      },
      outfile,
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node22",
      logLevel: "silent",
    });
    const result = spawnSync(process.execPath, [outfile], { cwd: repoRoot, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

test("deployment intent accepts only explicit host-owned facts", () => {
  const result = evaluate(`decodeDeploymentIntent({
    kind: "deployment",
    release: { id: "workspace-agent-prod", version: "1.0.0" },
    target: {
      kind: "cloudflare-do",
      className: "WorkspaceAgent",
      binding: "AGENT_OS",
      materialResolver: "./deployment/material-resolver.ts"
    },
    transport: "svelte-kit-remote",
    providers: {
      default: {
        protocol: "openai-chat-compatible",
        endpointRef: "openrouter",
        credentialRef: "openrouter-key",
        modelRef: "default-text-model"
      }
    },
    workspace: { binding: "Sandbox", root: "/workspace" }
  })`);

  assert.equal(result.ok, true);
  assert.equal(result.value.kind, "deployment");
  assert.equal(result.value.target.kind, "cloudflare-do");
  assert.equal(result.value.providers.default.credentialRef, "openrouter-key");
});

test("deployment intent rejects every old ordinary config axis", () => {
  const result = evaluate(`decodeDeploymentIntent({
    kind: "deployment",
    profile: "workspace@1",
    agent: "./agent",
    deployment: { id: "legacy" },
    client: { kind: "browser-direct@1" },
    llm: { route: "openai-chat-compatible" },
    release: { id: "agent-prod", version: "1.0.0" },
    target: { kind: "node" },
    transport: "direct",
    providers: {
      default: {
        protocol: "openai-chat-compatible",
        endpointRef: "endpoint",
        credentialRef: "credential",
        modelRef: "model"
      }
    }
  })`);

  assert.equal(result.ok, false);
  const unknown = result.issues
    .filter((issue) => issue.kind === "unknown_field")
    .map((issue) => issue.field)
    .sort();
  assert.deepEqual(unknown, ["agent", "client", "deployment", "llm", "profile"]);
});

test("cloudflare deployment fails closed without an explicit resolver module", () => {
  const result = evaluate(`decodeDeploymentIntent({
    kind: "deployment",
    release: { id: "agent-prod", version: "1.0.0" },
    target: { kind: "cloudflare-do", className: "Agent", binding: "AGENT_OS" },
    transport: "svelte-kit-remote",
    providers: {
      default: {
        protocol: "openai-chat-compatible",
        endpointRef: "endpoint",
        credentialRef: "credential",
        modelRef: "model"
      }
    }
  })`);

  assert.equal(result.ok, false);
  assert.ok(
    result.issues.some(
      (issue) =>
        issue.kind === "invalid_deployment_value" && issue.field === "/target/materialResolver",
    ),
  );
});
