import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { buildSync } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const cli = path.join(repoRoot, "packages/cli/src/main.mjs");
const workspaceDefaultToolNames = ["bash", "glob", "grep", "read_file", "write_file"];

const runTypeScript = (source, { cwd = repoRoot, resolveDir = repoRoot } = {}) => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "agentos-ts-eval-"));
  try {
    const outfile = path.join(tempDir, "entry.mjs");
    buildSync({
      stdin: {
        contents: source,
        loader: "ts",
        resolveDir,
        sourcefile: "entry.ts",
      },
      outfile,
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node22",
      external: ["cloudflare:*"],
      logLevel: "silent",
    });
    return spawnSync(process.execPath, [outfile], { cwd, encoding: "utf8" });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
};

const digestText = (text) => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `fnv1a32:${hash.toString(16).padStart(8, "0")}:${text.length}`;
};

const linkSmokeDependency = (root, specifier, target) => {
  const destination = path.join(root, "node_modules", ...specifier.split("/"));
  mkdirSync(path.dirname(destination), { recursive: true });
  symlinkSync(target, destination, process.platform === "win32" ? "junction" : "dir");
};

const linkGeneratedTargetSmokeDependencies = (root) => {
  linkSmokeDependency(root, "@agent-os/core", path.join(repoRoot, "packages/core"));
  linkSmokeDependency(root, "@agent-os/runtime", path.join(repoRoot, "packages/runtime"));
  linkSmokeDependency(root, "effect", path.join(repoRoot, "node_modules/effect"));
};

void test("compileAgentTree keeps skills as authoring-only output", () => {
  const result = runTypeScript(
    [
      'import { compileAgentTree, normalizeAgentOsConfig } from "./packages/cli/src/build/agent-authoring.ts";',
      "const compiled = compileAgentTree({",
      "  files: [",
      '    { path: "agent/instructions.md", kind: "markdown", text: "Operate." },',
      '    { path: "agent/agent.json", kind: "json", value: { agentId: "skills-fixture", scope: { kind: "session", idSource: "manifest", stableScopeId: "skills-fixture" } } },',
      '    { path: "agent/skills/echo.md", kind: "markdown", text: "---\\nname: echo\\n---\\nUse echo." },',
      '    { path: "agent/skills/review/SKILL.md", kind: "markdown", text: "---\\nname: review\\n---\\nReview carefully." },',
      "  ],",
      "});",
      "if (!compiled.ok) { console.error(JSON.stringify(compiled.issues)); process.exit(1); }",
      "const normalized = normalizeAgentOsConfig({",
      '  profile: "chat@1",',
      '  agent: "./agent",',
      '  deployment: { id: "skills-fixture" },',
      '  target: { kind: "cloudflare-do@1", durableObject: { className: "AgentOS", binding: "AGENT_OS" } },',
      '  client: { kind: "browser-direct@1" },',
      '  llm: { route: "openai-chat-compatible", endpointRef: "openrouter", credentialRef: "openrouter-key", modelRef: "openrouter-model" },',
      "}, compiled.value);",
      "if (!normalized.ok) { console.error(JSON.stringify(normalized.issues)); process.exit(1); }",
      "console.log(JSON.stringify({",
      "  skills: compiled.value.skills,",
      "  normalizedSkills: normalized.value.skills,",
      '  manifestHasSkills: Object.hasOwn(compiled.value.manifest, "skills"),',
      "  manifestToolNames: Object.keys(compiled.value.manifest.tools ?? {}).sort(),",
      "}));",
    ].join("\n"),
  );
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(
    output.skills.map((skill) => ({
      name: skill.name,
      path: skill.path,
      text: skill.text,
    })),
    [
      { name: "echo", path: "agent/skills/echo.md", text: "Use echo." },
      { name: "review", path: "agent/skills/review/SKILL.md", text: "Review carefully." },
    ],
  );
  assert.deepEqual(output.normalizedSkills, output.skills);
  assert.equal(output.skills[0].digest, digestText("Use echo."));
  assert.equal(output.skills[1].digest, digestText("Review carefully."));
  assert.equal(output.manifestHasSkills, false);
  assert.deepEqual(output.manifestToolNames, []);
});

void test("agentos.config normalizes node@1 as the local convention target", () => {
  const result = runTypeScript(
    [
      'import { AGENTOS_CONFIG_TARGET, compileAgentTree, decodeAgentOsConfig, linkWorkspaceStaticTarget, normalizeAgentOsConfig } from "./packages/cli/src/build/agent-authoring.ts";',
      "const compiled = compileAgentTree({",
      "  files: [",
      '    { path: "agent/instructions.md", kind: "markdown", text: "Operate." },',
      '    { path: "agent/agent.json", kind: "json", value: { agentId: "node-target-fixture", scope: { kind: "session", idSource: "manifest", stableScopeId: "node-target-fixture" } } },',
      "  ],",
      "});",
      "if (!compiled.ok) { console.error(JSON.stringify(compiled.issues)); process.exit(1); }",
      "const config = {",
      '  profile: "workspace@1",',
      '  agent: "./agent",',
      '  deployment: { id: "node-target-fixture" },',
      '  target: { kind: "node@1" },',
      '  client: { kind: "browser-direct@1" },',
      '  llm: { route: "openai-chat-compatible", endpointRef: "openrouter", credentialRef: "openrouter-key", modelRef: "openrouter-model" },',
      '  workspace: { binding: "Sandbox", root: "/workspace" },',
      "};",
      "const decoded = decodeAgentOsConfig(config);",
      "if (!decoded.ok) { console.error(JSON.stringify(decoded.issues)); process.exit(1); }",
      "const normalized = normalizeAgentOsConfig(decoded.value, compiled.value);",
      "if (!normalized.ok) { console.error(JSON.stringify(normalized.issues)); process.exit(1); }",
      "const linked = linkWorkspaceStaticTarget(normalized.value);",
      'const nodeWithEntry = decodeAgentOsConfig({ ...config, target: { kind: "node@1", entry: "./src/app.ts" } });',
      'const nodeWithDurableObject = decodeAgentOsConfig({ ...config, target: { kind: "node@1", durableObject: { className: "AgentOS", binding: "AGENT_OS" } } });',
      'const bunTarget = decodeAgentOsConfig({ ...config, target: { kind: "bun@1" } });',
      "console.log(JSON.stringify({",
      "  targetKinds: Object.values(AGENTOS_CONFIG_TARGET).sort(),",
      "  normalizedTarget: normalized.value.target,",
      "  deploymentBackend: normalized.value.deployment.backend,",
      "  deploymentAdapter: normalized.value.deployment.adapter,",
      '  targetOrigins: Object.fromEntries(Object.entries(normalized.value.provenance.deployment).filter(([key]) => key.startsWith("/target"))),',
      "  linkIssues: linked.ok ? [] : linked.issues,",
      "  linkFiles: linked.ok ? linked.value.files.map((file) => file.path).sort() : [],",
      "  nodeWithEntryIssues: nodeWithEntry.ok ? [] : nodeWithEntry.issues,",
      "  nodeWithDurableObjectIssues: nodeWithDurableObject.ok ? [] : nodeWithDurableObject.issues,",
      "  bunTargetIssues: bunTarget.ok ? [] : bunTarget.issues,",
      "}));",
    ].join("\n"),
  );
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(output.targetKinds, ["cloudflare-do@1", "node@1"]);
  assert.deepEqual(output.normalizedTarget, { kind: "node@1" });
  assert.equal(output.deploymentBackend, "node");
  assert.equal(output.deploymentAdapter, "node@1");
  assert.deepEqual(output.targetOrigins, {
    "/target/kind": "author:agentos.config.jsonc#/target/kind",
  });
  assert.deepEqual(output.linkIssues, []);
  assert.deepEqual(output.linkFiles, [
    ".agentos/generated/deployment.json",
    ".agentos/generated/fingerprints.json",
    ".agentos/generated/local.ts",
    ".agentos/generated/manifest.json",
    ".agentos/generated/provenance.json",
  ]);
  assert.deepEqual(output.nodeWithEntryIssues, [
    { kind: "unknown_field", path: "/target", field: "entry" },
  ]);
  assert.deepEqual(output.nodeWithDurableObjectIssues, [
    { kind: "unknown_field", path: "/target", field: "durableObject" },
  ]);
  assert.deepEqual(output.bunTargetIssues, [
    {
      kind: "invalid_config_value",
      path: "/target",
      field: "/target/kind",
      reason: "target_kind_invalid",
    },
  ]);
});

void test("compileAgentTree rejects invalid skill identity and v1 sibling files", () => {
  const result = runTypeScript(
    [
      'import { compileAgentTree } from "./packages/cli/src/build/agent-authoring.ts";',
      "const compile = (file) => compileAgentTree({ files: [",
      '  { path: "agent/instructions.md", kind: "markdown", text: "Operate." },',
      "  file,",
      "] });",
      'const mismatch = compile({ path: "agent/skills/echo.md", kind: "markdown", text: "---\\nname: other\\n---\\nUse echo." });',
      'const duplicateName = compile({ path: "agent/skills/echo.md", kind: "markdown", text: "---\\nname: wrong\\nname: echo\\n---\\nUse echo." });',
      'const sibling = compile({ path: "agent/skills/echo/references/ref.md", kind: "markdown", text: "Ref." });',
      "const duplicate = compileAgentTree({ files: [",
      '  { path: "agent/instructions.md", kind: "markdown", text: "Operate." },',
      '  { path: "agent/skills/echo.md", kind: "markdown", text: "---\\nname: echo\\n---\\nOne." },',
      '  { path: "agent/skills/echo/SKILL.md", kind: "markdown", text: "---\\nname: echo\\n---\\nTwo." },',
      "] });",
      "const reservedTool = compileAgentTree({ files: [",
      '  { path: "agent/instructions.md", kind: "markdown", text: "Operate." },',
      '  { path: "agent/tools/load_skill.ts", kind: "tool", declaration: {} },',
      "] });",
      "console.log(JSON.stringify({ mismatch, duplicateName, sibling, duplicate, reservedTool }));",
    ].join("\n"),
  );
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.mismatch.ok, false);
  assert.deepEqual(output.mismatch.issues, [
    {
      kind: "skill_identity_mismatch",
      path: "skills/echo.md",
      expectedName: "echo",
      actualName: "other",
    },
  ]);
  assert.equal(output.duplicateName.ok, false);
  assert.deepEqual(output.duplicateName.issues, [
    {
      kind: "invalid_authored_value",
      path: "skills/echo.md",
      field: "/frontmatter/name",
      reason: "frontmatter_field_duplicate",
    },
  ]);
  assert.equal(output.sibling.ok, false);
  assert.deepEqual(output.sibling.issues, [
    {
      kind: "unsupported_path",
      path: "skills/echo/references/ref.md",
      reason: "skill_path_not_in_grammar",
    },
  ]);
  assert.equal(output.duplicate.ok, false);
  assert.deepEqual(output.duplicate.issues, [
    {
      kind: "duplicate_skill",
      name: "echo",
      path: "skills/echo/SKILL.md",
      existingPath: "agent/skills/echo.md",
    },
  ]);
  assert.equal(output.reservedTool.ok, false);
  assert.deepEqual(output.reservedTool.issues, [
    {
      kind: "reserved_tool_name",
      path: "tools/load_skill.ts",
      toolId: "load_skill",
    },
  ]);
});

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
    assert.deepEqual(manifest.capabilities?.workspaceOperations, {
      bindingRef: "@agent-os/workspace-op",
    });
    assert.equal(manifest.tools.bash.interaction, "never");
    assert.equal(manifest.tools.write_file.interaction, "approval");
    const target = readFileSync(path.join(root, ".agentos/generated/target.ts"), "utf8");
    assert.match(target, /import semanticDeclarations from "\.\/manifest\.json";/);
    assert.match(target, /from "@agent-os\/runtime\/capability";/);
    assert.match(target, /resolveRuntimeInstallGraph/);
    assert.match(target, /workspaceOperations/);
    assert.match(target, /WORKSPACE_OPERATION_HOST_FACT/);
    assert.match(target, /\[WORKSPACE_OPERATION_HOST_FACT\]: \(\) => workspaceEnvFor\(env\)/);
    assert.doesNotMatch(target, /workspaceOperations\(\{\s*env:/);
    assert.match(target, /from "@agent-os\/core\/runtime-protocol";/);
    assert.match(target, /from "@agent-os\/core\/tools";/);
    assert.doesNotMatch(target, /from "@agent-os\/runtime\/workspace-binding";/);
    assert.doesNotMatch(target, /installCloudflareWorkspaceOperationProvider/);
    assert.doesNotMatch(target, /bindWorkspaceToolsForRuntime/);
    assert.match(target, /generatedWorkspaceToolInteractions/);
    assert.match(target, /toolInteractions: generatedWorkspaceToolInteractions/);
    assert.match(target, /readonly AGENTOS_ENDPOINT_OPENROUTER\?: string;/);
    assert.match(target, /readonly AGENTOS_CREDENTIAL_OPENROUTER_KEY\?: string;/);
    assert.match(target, /readonly AGENTOS_MODEL_OPENROUTER_DEFAULT_TEXT_MODEL\?: string;/);
    assert.match(target, /materialEnvValue\(env, "AGENTOS_ENDPOINT_OPENROUTER"\)/);
    assert.doesNotMatch(target, /readonly OPENROUTER_KEY\?: string;/);
    assert.doesNotMatch(target, /readonly OPENROUTER_ENDPOINT\?: string;/);
    assert.doesNotMatch(target, /readonly OPENROUTER_DEFAULT_TEXT_MODEL\?: string;/);
    assert.doesNotMatch(target, /materialEnvValue\(env, "OPENROUTER_KEY"\)/);
    assert.doesNotMatch(target, /materialEnvValue\(env, "OPENROUTER_ENDPOINT"\)/);
    assert.doesNotMatch(target, /materialEnvValue\(env, "OPENROUTER_DEFAULT_TEXT_MODEL"\)/);
    assert.doesNotMatch(target, /https:\/\/openrouter\.ai\/api\/v1/);
    assert.doesNotMatch(target, /\.\.\/\.\.\/agent\/tools\/read_file/);
    assert.doesNotMatch(target, /MountPlan|mountPlan|registry\.get/);
    const scopeHelper = readFileSync(
      path.join(root, ".agentos/generated/cloudflare-scope.ts"),
      "utf8",
    );
    assert.match(scopeHelper, /agentOSDurableObjectBinding = "AGENT_OS"/);
    assert.match(scopeHelper, /agentOSScopeId = agentOSTruthIdentity\.scopeRef\.scopeId/);
    assert.match(scopeHelper, /agentOSRpcClient/);
    assert.match(scopeHelper, /DurableObjectRpcClient/);
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
    assert.match(
      remote,
      /import \{ agentOSRpcClient, agentOSTruthIdentity \} from "\.\/cloudflare-scope";/,
    );
    assert.doesNotMatch(remote, /durableObjectRpcClient/);
    assert.doesNotMatch(remote, /manifestTruthIdentity/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test("agentos build emits node local agent app target", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "agentos-node-build-"));
  try {
    writeFileSync(path.join(root, "package.json"), JSON.stringify({ type: "module" }, null, 2));
    mkdirSync(path.join(root, "agent"), { recursive: true });
    writeFileSync(path.join(root, "agent/instructions.md"), "Operate locally.");
    writeFileSync(
      path.join(root, "agent/agent.json"),
      JSON.stringify(
        {
          agentId: "node-local-agent",
          scope: {
            kind: "session",
            idSource: "manifest",
            stableScopeId: "node-local-scope",
          },
          effectAuthorityRef: {
            authorityClass: "effect",
            authorityId: "node-local-agent",
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
        '  "profile": "workspace@1",',
        '  "agent": "./agent",',
        '  "deployment": { "id": "node-local-deployment", "version": "0.1.0" },',
        '  "target": { "kind": "node@1" },',
        '  "client": { "kind": "browser-direct@1" },',
        '  "llm": {',
        '    "route": "openai-chat-compatible",',
        '    "endpointRef": "openrouter",',
        '    "credentialRef": "openrouter-key",',
        '    "modelRef": "openrouter-default-text-model"',
        "  },",
        '  "workspace": { "binding": "Sandbox", "root": "/workspace" }',
        "}",
        "",
      ].join("\n"),
    );

    const result = spawnSync(process.execPath, [cli, "build", "--cwd", root], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /generated 5 agentOS files/);

    const deployment = JSON.parse(
      readFileSync(path.join(root, ".agentos/generated/deployment.json"), "utf8"),
    );
    assert.equal(deployment.backend, "node");
    assert.equal(deployment.adapter, "node@1");
    assert.equal(Object.hasOwn(deployment.workspace, "cloudflareSandboxId"), false);

    const local = readFileSync(path.join(root, ".agentos/generated/local.ts"), "utf8");
    assert.match(local, /from "@agent-os\/runtime\/local";/);
    assert.match(local, /lowerLocalAgentRuntime/);
    assert.match(local, /export type LocalAgentApp = LocalAgentRuntime/);
    assert.match(local, /export const createLocalAgentApp/);
    assert.match(local, /target: "node@1"/);
    assert.match(local, /workspaceOperations: generatedWorkspaceOperations/);
    assert.match(local, /toolInteractions: generatedWorkspaceToolInteractions/);
    assert.match(local, /return lowered\.runtime/);
    assert.doesNotMatch(local, /resolveRuntime|submitAgentEffect|workspaceOperations\(/);
    assert.doesNotMatch(local, /cloudflare|createAgentDurableObject|wrangler/i);
    assert.doesNotMatch(local, /blueprints|target--node|Provider Material Binding/);
    assert.equal(existsSync(path.join(root, ".agentos/generated/target.ts")), false);
    assert.equal(existsSync(path.join(root, ".agentos/generated/worker.ts")), false);
    assert.equal(existsSync(path.join(root, ".agentos/generated/wrangler.jsonc")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test("agentos build compiles chat profile without workspace surface", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "agentos-chat-build-"));
  try {
    writeFileSync(path.join(root, "package.json"), JSON.stringify({ type: "module" }, null, 2));
    mkdirSync(path.join(root, "agent/tools"), { recursive: true });
    writeFileSync(path.join(root, "agent/instructions.md"), "Answer in chat.");
    writeFileSync(
      path.join(root, "agent/agent.json"),
      JSON.stringify(
        {
          agentId: "chat-fixture",
          scope: {
            kind: "session",
            idSource: "manifest",
            stableScopeId: "chat-fixture-scope",
          },
          effectAuthorityRef: {
            authorityClass: "effect",
            authorityId: "chat-fixture",
          },
        },
        null,
        2,
      ),
    );
    writeFileSync(
      path.join(root, "agent/tools/echo.ts"),
      [
        'export const declaration = { interaction: "approval" };',
        "export default {} as never;",
        "",
      ].join("\n"),
    );
    writeFileSync(
      path.join(root, "agentos.config.jsonc"),
      [
        "{",
        '  "profile": "chat@1",',
        '  "agent": "./agent",',
        '  "deployment": { "id": "chat-fixture", "version": "0.1.0" },',
        '  "target": {',
        '    "kind": "cloudflare-do@1",',
        '    "durableObject": { "className": "AgentOS", "binding": "AGENT_OS" }',
        "  },",
        '  "client": { "kind": "svelte-kit-remote@1" },',
        '  "llm": {',
        '    "route": "openai-chat-compatible",',
        '    "endpointRef": "openrouter",',
        '    "credentialRef": "openrouter-key",',
        '    "modelRef": "openrouter-default-text-model"',
        "  }",
        "}",
        "",
      ].join("\n"),
    );

    const result = spawnSync(process.execPath, [cli, "build", "--cwd", root], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    const manifest = JSON.parse(
      readFileSync(path.join(root, ".agentos/generated/manifest.json"), "utf8"),
    );
    assert.deepEqual(Object.keys(manifest.tools ?? {}).sort(), ["echo"]);
    for (const workspaceTool of workspaceDefaultToolNames) {
      assert.equal(manifest.tools?.[workspaceTool], undefined);
    }
    assert.equal(manifest.materials?.workspace, undefined);
    assert.equal(manifest.executionDomains?.workspace, undefined);

    const deployment = JSON.parse(
      readFileSync(path.join(root, ".agentos/generated/deployment.json"), "utf8"),
    );
    assert.equal(deployment.workspace, undefined);

    const target = readFileSync(path.join(root, ".agentos/generated/target.ts"), "utf8");
    assert.match(target, /customCommand\(input: WorkspaceAgentCustomCommandInput\)/);
    assert.match(target, /generatedCustomTools/);
    assert.doesNotMatch(target, /@cloudflare\/sandbox/);
    assert.doesNotMatch(target, /installCloudflareWorkspaceOperationProvider/);
    assert.doesNotMatch(target, /bindWorkspaceToolsForRuntime/);
    assert.doesNotMatch(target, /makeCloudflareWorkspaceEnv/);
    assert.doesNotMatch(target, /readWorkspaceState/);
    assert.doesNotMatch(target, /readWorkspaceFile/);
    assert.doesNotMatch(target, /resetWorkspace/);
    assert.doesNotMatch(target, /destroyWorkspace/);

    const worker = readFileSync(path.join(root, ".agentos/generated/worker.ts"), "utf8");
    assert.doesNotMatch(worker, /Sandbox/);
    assert.match(worker, /export \{ AgentOS \};/);

    const wrangler = JSON.parse(
      readFileSync(path.join(root, ".agentos/generated/wrangler.jsonc"), "utf8"),
    );
    assert.equal(wrangler.containers, undefined);
    assert.deepEqual(wrangler.durable_objects.bindings, [
      { class_name: "AgentOS", name: "AGENT_OS" },
    ]);
    assert.deepEqual(wrangler.migrations, [{ tag: "v1", new_sqlite_classes: ["AgentOS"] }]);

    const remote = readFileSync(path.join(root, ".agentos/generated/sveltekit.remote.ts"), "utf8");
    assert.match(remote, /WORKSPACE_AGENT_COMMAND\.CUSTOM/);
    assert.match(remote, /runtime\.customCommand/);
    assert.doesNotMatch(remote, /WORKSPACE_AGENT_COMMAND\.READ_STATE/);
    assert.doesNotMatch(remote, /WORKSPACE_AGENT_COMMAND\.READ_FILE/);
    assert.doesNotMatch(remote, /WORKSPACE_AGENT_COMMAND\.RESET/);
    assert.doesNotMatch(remote, /WORKSPACE_AGENT_COMMAND\.DESTROY/);
    assert.doesNotMatch(remote, /readStateInputFromUnknown/);
    assert.doesNotMatch(remote, /readFileInputFromUnknown/);

    const client = readFileSync(path.join(root, ".agentos/generated/client.ts"), "utf8");
    assert.match(client, /custom\(/);
    assert.doesNotMatch(client, /readState\(/);
    assert.doesNotMatch(client, /readFile\(/);
    assert.doesNotMatch(client, /reset\(/);
    assert.doesNotMatch(client, /destroy\(/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test("static target injects skill advert and load_skill for workspace and chat profiles", () => {
  const result = runTypeScript(
    [
      'import { compileAgentTree, linkWorkspaceStaticTarget, normalizeAgentOsConfig } from "./packages/cli/src/build/agent-authoring.ts";',
      "const compiled = compileAgentTree({ files: [",
      '  { path: "agent/instructions.md", kind: "markdown", text: "Operate." },',
      '  { path: "agent/agent.json", kind: "json", value: { agentId: "target-skills", scope: { kind: "session", idSource: "manifest", stableScopeId: "target-skills" } } },',
      '  { path: "agent/skills/echo.md", kind: "markdown", text: "---\\nname: echo\\n---\\nUse workspace echo skill." },',
      '  { path: "agent/skills/review/SKILL.md", kind: "markdown", text: "---\\nname: review\\n---\\nUse chat review skill." },',
      "] });",
      "if (!compiled.ok) { console.error(JSON.stringify(compiled.issues)); process.exit(1); }",
      "const baseConfig = {",
      '  agent: "./agent",',
      '  deployment: { id: "target-skills" },',
      '  target: { kind: "cloudflare-do@1", durableObject: { className: "AgentOS", binding: "AGENT_OS" } },',
      '  client: { kind: "browser-direct@1" },',
      '  llm: { route: "openai-chat-compatible", endpointRef: "openrouter", credentialRef: "openrouter-key", modelRef: "openrouter-model" },',
      "};",
      "const targetFor = (config) => {",
      "  const normalized = normalizeAgentOsConfig(config, compiled.value);",
      "  if (!normalized.ok) { console.error(JSON.stringify(normalized.issues)); process.exit(1); }",
      "  const linked = linkWorkspaceStaticTarget(normalized.value);",
      "  if (!linked.ok) { console.error(JSON.stringify(linked.issues)); process.exit(1); }",
      '  return linked.value.files.find((file) => file.path === ".agentos/generated/target.ts").text;',
      "};",
      'const workspaceTarget = targetFor({ ...baseConfig, profile: "workspace@1", workspace: { binding: "Sandbox", root: "/workspace" } });',
      'const chatTarget = targetFor({ ...baseConfig, profile: "chat@1" });',
      "const markers = (text) => ({",
      "  defineProductTool: text.includes('defineProductTool'),",
      "  advert: text.includes('generatedSkillsSystemAdvert'),",
      "  loadSkill: text.includes('name: \"load_skill\"'),",
      "  system: text.includes('system: generatedSystemPrompt(input.system)'),",
      "  echo: text.includes('Use workspace echo skill.'),",
      "  review: text.includes('Use chat review skill.'),",
      "  frameworkTools: text.includes('...generatedFrameworkTools'),",
      "});",
      "console.log(JSON.stringify({ workspace: markers(workspaceTarget), chat: markers(chatTarget) }));",
    ].join("\n"),
  );
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  for (const profile of ["workspace", "chat"]) {
    for (const [marker, present] of Object.entries(output[profile])) {
      assert.equal(present, true, `${profile} target missing ${marker}`);
    }
  }
});

void test("agentos build emits skill artifact and load_skill executes deterministically", () => {
  const root = mkdtempSync(path.join(repoRoot, ".agentos-skill-smoke-"));
  try {
    writeFileSync(path.join(root, "package.json"), JSON.stringify({ type: "module" }, null, 2));
    linkGeneratedTargetSmokeDependencies(root);
    mkdirSync(path.join(root, "agent/skills"), { recursive: true });
    writeFileSync(path.join(root, "agent/instructions.md"), "Answer with authored skills.");
    writeFileSync(path.join(root, "agent/skills/echo.md"), "---\nname: echo\n---\nECHO_MARKER_560");
    writeFileSync(
      path.join(root, "agent/agent.json"),
      JSON.stringify(
        {
          agentId: "skill-smoke-fixture",
          scope: {
            kind: "session",
            idSource: "manifest",
            stableScopeId: "skill-smoke-fixture-scope",
          },
          effectAuthorityRef: {
            authorityClass: "effect",
            authorityId: "skill-smoke-fixture",
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
        '  "profile": "chat@1",',
        '  "agent": "./agent",',
        '  "deployment": { "id": "skill-smoke-fixture", "version": "0.1.0" },',
        '  "target": {',
        '    "kind": "cloudflare-do@1",',
        '    "durableObject": { "className": "AgentOS", "binding": "AGENT_OS" }',
        "  },",
        '  "client": { "kind": "browser-direct@1" },',
        '  "llm": {',
        '    "route": "openai-chat-compatible",',
        '    "endpointRef": "openrouter",',
        '    "credentialRef": "openrouter-key",',
        '    "modelRef": "openrouter-model"',
        "  }",
        "}",
        "",
      ].join("\n"),
    );

    const build = spawnSync(process.execPath, [cli, "build", "--cwd", root], {
      encoding: "utf8",
    });
    assert.equal(build.status, 0, build.stderr);
    const manifest = JSON.parse(
      readFileSync(path.join(root, ".agentos/generated/manifest.json"), "utf8"),
    );
    assert.equal(Object.hasOwn(manifest, "skills"), false);
    const target = readFileSync(path.join(root, ".agentos/generated/target.ts"), "utf8");
    assert.match(target, /ECHO_MARKER_560/);
    assert.match(target, /name: "load_skill"/);

    let smokeSource = readFileSync(path.join(root, ".agentos/generated/target.ts"), "utf8");
    smokeSource = smokeSource
      .replace(
        'import { createAgentDurableObject } from "@agent-os/runtime/cloudflare";',
        "const createAgentDurableObject = () => class {};",
      )
      .replace(
        'import { OpenAiCompatibleLlmTransportLive } from "@agent-os/runtime/llm-effect-ai/openai-compatible";',
        "const OpenAiCompatibleLlmTransportLive = {};",
      );
    smokeSource += `
export const __agentosSkillSmoke = async () => {
  const agent = Object.create(AgentOS.prototype);
  agent.targetEnv = { AGENTOS_MODEL_OPENROUTER_MODEL: "smoke-model" };
  agent.submitWithBindings = async (spec, bindings) => {
    const tools = bindings.tools ?? {};
    const loaded = await Effect.runPromise(
      unsafeRunToolByName(tools, deterministicToolInvocation("load_skill", { name: "echo" })),
    );
    let unknownRejected = false;
    try {
      await Effect.runPromise(
        unsafeRunToolByName(tools, deterministicToolInvocation("load_skill", { name: "missing" })),
      );
    } catch {
      unknownRejected = true;
    }
    return {
      toolNames: Object.keys(tools).sort(),
      systemIncludesAdvert: spec.system.includes("Available agent skills"),
      loaded,
      unknownRejected,
    };
  };
  return await agent.submitRunInput({ intent: "smoke", context: {} });
};
`;
    writeFileSync(path.join(root, ".agentos/generated/target.smoke.ts"), smokeSource);
    const smoke = runTypeScript(
      [
        'import { __agentosSkillSmoke } from "./.agentos/generated/target.smoke.ts";',
        "const result = await __agentosSkillSmoke();",
        "console.log(JSON.stringify(result));",
      ].join("\n"),
      { cwd: root, resolveDir: root },
    );
    assert.equal(smoke.status, 0, smoke.stderr);
    const output = JSON.parse(smoke.stdout);
    assert.deepEqual(output.toolNames, ["load_skill"]);
    assert.equal(output.systemIncludesAdvert, true);
    assert.equal(output.loaded.name, "echo");
    assert.equal(output.loaded.text, "ECHO_MARKER_560");
    assert.equal(output.unknownRejected, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test("agentos build omits load_skill support when no skills are authored", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "agentos-no-skills-build-"));
  try {
    writeFileSync(path.join(root, "package.json"), JSON.stringify({ type: "module" }, null, 2));
    mkdirSync(path.join(root, "agent"), { recursive: true });
    writeFileSync(path.join(root, "agent/instructions.md"), "Answer without skills.");
    writeFileSync(
      path.join(root, "agent/agent.json"),
      JSON.stringify(
        {
          agentId: "no-skills-fixture",
          scope: {
            kind: "session",
            idSource: "manifest",
            stableScopeId: "no-skills-fixture-scope",
          },
          effectAuthorityRef: {
            authorityClass: "effect",
            authorityId: "no-skills-fixture",
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
        '  "profile": "chat@1",',
        '  "agent": "./agent",',
        '  "deployment": { "id": "no-skills-fixture", "version": "0.1.0" },',
        '  "target": {',
        '    "kind": "cloudflare-do@1",',
        '    "durableObject": { "className": "AgentOS", "binding": "AGENT_OS" }',
        "  },",
        '  "client": { "kind": "browser-direct@1" },',
        '  "llm": {',
        '    "route": "openai-chat-compatible",',
        '    "endpointRef": "openrouter",',
        '    "credentialRef": "openrouter-key",',
        '    "modelRef": "openrouter-default-text-model"',
        "  }",
        "}",
        "",
      ].join("\n"),
    );

    const result = spawnSync(process.execPath, [cli, "build", "--cwd", root], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    const target = readFileSync(path.join(root, ".agentos/generated/target.ts"), "utf8");
    assert.doesNotMatch(target, /defineProductTool/);
    assert.doesNotMatch(target, /generatedSkillsSystemAdvert/);
    assert.doesNotMatch(target, /name: "load_skill"/);
    assert.doesNotMatch(target, /generatedSystemPrompt/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test("agentos build keeps workspace and chat profile boundaries closed", () => {
  const writeFixture = (root, profile, workspaceBlock) => {
    writeFileSync(path.join(root, "package.json"), JSON.stringify({ type: "module" }, null, 2));
    mkdirSync(path.join(root, "agent"), { recursive: true });
    writeFileSync(path.join(root, "agent/instructions.md"), "Operate.");
    writeFileSync(
      path.join(root, "agent/agent.json"),
      JSON.stringify(
        {
          agentId: "boundary-fixture",
          scope: {
            kind: "session",
            idSource: "manifest",
            stableScopeId: "boundary-fixture-scope",
          },
          effectAuthorityRef: {
            authorityClass: "effect",
            authorityId: "boundary-fixture",
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
        `  "profile": "${profile}",`,
        '  "agent": "./agent",',
        '  "deployment": { "id": "boundary-fixture", "version": "0.1.0" },',
        '  "target": {',
        '    "kind": "cloudflare-do@1",',
        '    "durableObject": { "className": "AgentOS", "binding": "AGENT_OS" }',
        "  },",
        '  "client": { "kind": "browser-direct@1" },',
        '  "llm": {',
        '    "route": "openai-chat-compatible",',
        '    "endpointRef": "openrouter",',
        '    "credentialRef": "openrouter-key",',
        '    "modelRef": "openrouter-default-text-model"',
        "  }" + workspaceBlock,
        "}",
        "",
      ].join("\n"),
    );
  };

  const chatRoot = mkdtempSync(path.join(os.tmpdir(), "agentos-chat-negative-"));
  const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), "agentos-workspace-negative-"));
  try {
    writeFixture(
      chatRoot,
      "chat@1",
      ',\n  "workspace": { "binding": "Sandbox", "root": "/workspace" }',
    );
    const chatResult = spawnSync(process.execPath, [cli, "build", "--cwd", chatRoot], {
      encoding: "utf8",
    });
    assert.notEqual(chatResult.status, 0);
    assert.match(chatResult.stderr, /workspace_forbidden_for_chat_profile/);

    writeFixture(workspaceRoot, "workspace@1", "");
    const workspaceResult = spawnSync(process.execPath, [cli, "build", "--cwd", workspaceRoot], {
      encoding: "utf8",
    });
    assert.notEqual(workspaceResult.status, 0);
    assert.match(workspaceResult.stderr, /object_required/);
    assert.match(workspaceResult.stderr, /\/workspace/);
  } finally {
    rmSync(chatRoot, { recursive: true, force: true });
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

void test("llm material env names fail closed on ref folding collisions", () => {
  const result = runTypeScript(
    [
      'import { llmMaterialEnvBindingsForRefs, llmMaterialEnvNameCollisionIssues } from "./packages/cli/src/build/agent-authoring.ts";',
      "const bindings = llmMaterialEnvBindingsForRefs([",
      '  { kind: "endpoint", ref: "a.b" },',
      '  { kind: "endpoint", ref: "a-b" },',
      "]);",
      "console.log(JSON.stringify(llmMaterialEnvNameCollisionIssues(bindings)));",
    ].join("\n"),
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [
    {
      kind: "llm_material_env_name_collision",
      path: "agentos.config.jsonc#/llm",
      envName: "AGENTOS_ENDPOINT_A_B",
      refs: ["endpoint:a.b", "endpoint:a-b"],
    },
  ]);
});
