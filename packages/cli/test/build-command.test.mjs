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
const forbiddenCloudflareLifecycleTargetFragments = [
  /installCloudflareWorkspaceOperationProvider/,
  /installCloudflareWorkspaceJobProfile/,
  /createCloudflareWorkspaceEnvResolver/,
  /createCloudflareSandboxWorkspaceEnvResolver/,
  /workspace-job-profile/,
];

const assertNoCloudflareLifecycleTargetWiring = (target) => {
  for (const fragment of forbiddenCloudflareLifecycleTargetFragments) {
    assert.doesNotMatch(target, fragment);
  }
};

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

void test("agentos --version derives from the release source fact", () => {
  const rootPackage = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  const result = spawnSync(process.execPath, [cli, "--version"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), rootPackage.agentOsRelease.version);
});

void test("compileAgentTree keeps skills as authoring-only output", () => {
  const result = runTypeScript(
    [
      'import { compileAgentTree, normalizeAgentOsConfig } from "./packages/cli/src/build/agent-authoring.ts";',
      "const utf8 = (text) => new TextEncoder().encode(text);",
      "const compiled = compileAgentTree({",
      "  files: [",
      '    { path: "agent/instructions.md", kind: "markdown", text: "Operate." },',
      '    { path: "agent/agent.json", kind: "json", value: { agentId: "skills-fixture", scope: { kind: "session", idSource: "manifest", stableScopeId: "skills-fixture" } } },',
      '    { path: "agent/skills/echo.md", kind: "markdown", text: "---\\nname: echo\\ndescription: Echo workspace facts\\n---\\nUse echo." },',
      '    { path: "agent/skills/review/SKILL.md", kind: "markdown", text: "---\\nname: review\\ndescription: Review output carefully\\n---\\nReview carefully." },',
      '    { path: "agent/skills/review/references/checklist.md", kind: "text", bytes: utf8("Check every claim.") },',
      '    { path: "agent/skills/review/scripts/audit.sh", kind: "text", bytes: utf8("echo audit") },',
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
      description: skill.description,
      path: skill.path,
      text: skill.text,
      files: skill.files,
    })),
    [
      {
        name: "echo",
        description: "Echo workspace facts",
        path: "agent/skills/echo.md",
        text: "Use echo.",
        files: [],
      },
      {
        name: "review",
        description: "Review output carefully",
        path: "agent/skills/review/SKILL.md",
        text: "Review carefully.",
        files: [
          {
            path: "references/checklist.md",
            digest: digestText("Check every claim."),
            bytes: 18,
            text: "Check every claim.",
          },
          {
            path: "scripts/audit.sh",
            digest: digestText("echo audit"),
            bytes: 10,
            text: "echo audit",
          },
        ],
      },
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

void test("compileAgentTree rejects invalid skill identity and packaged skill file violations", () => {
  const result = runTypeScript(
    [
      'import { compileAgentTree } from "./packages/cli/src/build/agent-authoring.ts";',
      "const utf8 = (text) => new TextEncoder().encode(text);",
      'const instructions = { path: "agent/instructions.md", kind: "markdown", text: "Operate." };',
      'const packagedReview = { path: "agent/skills/review/SKILL.md", kind: "markdown", text: "---\\nname: review\\ndescription: Review facts\\n---\\nReview." };',
      "const compile = (file) => compileAgentTree({ files: [",
      "  instructions,",
      "  file,",
      "] });",
      'const mismatch = compile({ path: "agent/skills/echo.md", kind: "markdown", text: "---\\nname: other\\ndescription: Echo facts\\n---\\nUse echo." });',
      'const duplicateName = compile({ path: "agent/skills/echo.md", kind: "markdown", text: "---\\nname: wrong\\nname: echo\\ndescription: Echo facts\\n---\\nUse echo." });',
      'const missingDescription = compile({ path: "agent/skills/echo.md", kind: "markdown", text: "---\\nname: echo\\n---\\nUse echo." });',
      'const emptyDescription = compile({ path: "agent/skills/echo.md", kind: "markdown", text: "---\\nname: echo\\ndescription:   \\n---\\nUse echo." });',
      'const oversizedDescription = compile({ path: "agent/skills/echo.md", kind: "markdown", text: `---\\nname: echo\\ndescription: ${"x".repeat(241)}\\n---\\nUse echo.` });',
      'const unknownFrontmatter = compile({ path: "agent/skills/echo.md", kind: "markdown", text: "---\\nname: echo\\ndescription: Echo facts\\nallowed-tools: bash\\n---\\nUse echo." });',
      'const supportWithoutPackage = compile({ path: "agent/skills/echo/references/ref.md", kind: "text", bytes: utf8("Ref.") });',
      "const flatSupport = compileAgentTree({ files: [",
      "  instructions,",
      '  { path: "agent/skills/echo.md", kind: "markdown", text: "---\\nname: echo\\ndescription: Echo facts\\n---\\nUse echo." },',
      '  { path: "agent/skills/echo/references/ref.md", kind: "text", bytes: utf8("Ref.") },',
      "] });",
      'const unsupportedRoot = compile({ path: "agent/skills/echo/assets/icon.txt", kind: "text", bytes: utf8("icon") });',
      'const dotdotPath = compile({ path: "agent/skills/echo/references/../secret.md", kind: "text", bytes: utf8("secret") });',
      "const symlinkSupport = compileAgentTree({ files: [",
      "  instructions,",
      "  packagedReview,",
      '  { path: "agent/skills/review/references/ref.md", kind: "text", bytes: new Uint8Array(), sourceKind: "symlink" },',
      "] });",
      "const invalidUtf8 = compileAgentTree({ files: [",
      "  instructions,",
      "  packagedReview,",
      '  { path: "agent/skills/review/references/ref.md", kind: "text", bytes: new Uint8Array([0xff]) },',
      "] });",
      "const oversizedFile = compileAgentTree({ files: [",
      "  instructions,",
      "  packagedReview,",
      '  { path: "agent/skills/review/references/ref.md", kind: "text", bytes: utf8("x".repeat(65537)) },',
      "] });",
      "const tooManyFiles = compileAgentTree({ files: [",
      "  instructions,",
      "  packagedReview,",
      '  ...Array.from({ length: 65 }, (_, index) => ({ path: `agent/skills/review/references/${index}.txt`, kind: "text", bytes: utf8("x") })),',
      "] });",
      "const packageTooLarge = compileAgentTree({ files: [",
      "  instructions,",
      "  packagedReview,",
      '  ...Array.from({ length: 5 }, (_, index) => ({ path: `agent/skills/review/references/large-${index}.txt`, kind: "text", bytes: utf8("x".repeat(65536)) })),',
      "] });",
      "const duplicate = compileAgentTree({ files: [",
      "  instructions,",
      '  { path: "agent/skills/echo.md", kind: "markdown", text: "---\\nname: echo\\ndescription: Echo one\\n---\\nOne." },',
      '  { path: "agent/skills/echo/SKILL.md", kind: "markdown", text: "---\\nname: echo\\ndescription: Echo two\\n---\\nTwo." },',
      "] });",
      "const reservedTool = compileAgentTree({ files: [",
      "  instructions,",
      '  { path: "agent/tools/load_skill.ts", kind: "tool", declaration: {} },',
      "] });",
      "const reservedReadSkillFile = compileAgentTree({ files: [",
      "  instructions,",
      '  { path: "agent/tools/read_skill_file.ts", kind: "tool", declaration: {} },',
      "] });",
      "console.log(JSON.stringify({ mismatch, duplicateName, missingDescription, emptyDescription, oversizedDescription, unknownFrontmatter, supportWithoutPackage, flatSupport, unsupportedRoot, dotdotPath, symlinkSupport, invalidUtf8, oversizedFile, tooManyFiles, packageTooLarge, duplicate, reservedTool, reservedReadSkillFile }));",
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
  assert.equal(output.missingDescription.ok, false);
  assert.deepEqual(output.missingDescription.issues, [
    {
      kind: "invalid_authored_value",
      path: "skills/echo.md",
      field: "/frontmatter/description",
      reason: "non_empty_string_required",
    },
  ]);
  assert.equal(output.emptyDescription.ok, false);
  assert.deepEqual(output.emptyDescription.issues, [
    {
      kind: "invalid_authored_value",
      path: "skills/echo.md",
      field: "/frontmatter/description",
      reason: "non_empty_string_required",
    },
  ]);
  assert.equal(output.oversizedDescription.ok, false);
  assert.deepEqual(output.oversizedDescription.issues, [
    {
      kind: "invalid_authored_value",
      path: "skills/echo.md",
      field: "/frontmatter/description",
      reason: "skill_description_too_large",
    },
  ]);
  assert.equal(output.unknownFrontmatter.ok, false);
  assert.deepEqual(output.unknownFrontmatter.issues, [
    {
      kind: "unknown_field",
      path: "skills/echo.md",
      field: "allowed-tools",
    },
  ]);
  assert.equal(output.supportWithoutPackage.ok, false);
  assert.deepEqual(output.supportWithoutPackage.issues, [
    {
      kind: "unsupported_path",
      path: "skills/echo/references/ref.md",
      reason: "skill_support_requires_packaged_skill",
    },
  ]);
  assert.equal(output.flatSupport.ok, false);
  assert.deepEqual(output.flatSupport.issues, [
    {
      kind: "unsupported_path",
      path: "skills/echo/references/ref.md",
      reason: "skill_support_requires_packaged_skill",
    },
  ]);
  assert.equal(output.unsupportedRoot.ok, false);
  assert.deepEqual(output.unsupportedRoot.issues, [
    {
      kind: "unsupported_path",
      path: "skills/echo/assets/icon.txt",
      reason: "text_path_not_in_grammar",
    },
  ]);
  assert.equal(output.dotdotPath.ok, false);
  assert.deepEqual(output.dotdotPath.issues, [
    {
      kind: "unsupported_path",
      path: "agent/skills/echo/references/../secret.md",
      reason: "path_not_normalized",
    },
  ]);
  assert.equal(output.symlinkSupport.ok, false);
  assert.deepEqual(output.symlinkSupport.issues, [
    {
      kind: "unsupported_path",
      path: "skills/review/references/ref.md",
      reason: "symlink_forbidden",
    },
  ]);
  assert.equal(output.invalidUtf8.ok, false);
  assert.deepEqual(output.invalidUtf8.issues, [
    {
      kind: "invalid_authored_value",
      path: "skills/review/references/ref.md",
      field: "/bytes",
      reason: "utf8_required",
    },
  ]);
  assert.equal(output.oversizedFile.ok, false);
  assert.deepEqual(output.oversizedFile.issues, [
    {
      kind: "invalid_authored_value",
      path: "skills/review/references/ref.md",
      field: "/bytes",
      reason: "skill_file_too_large",
    },
  ]);
  assert.equal(output.tooManyFiles.ok, false);
  assert.deepEqual(output.tooManyFiles.issues, [
    {
      kind: "invalid_authored_value",
      path: "skills/review/references/64.txt",
      field: "/bytes",
      reason: "skill_package_too_many_files",
    },
  ]);
  assert.equal(output.packageTooLarge.ok, false);
  assert.deepEqual(output.packageTooLarge.issues, [
    {
      kind: "invalid_authored_value",
      path: "skills/review/references/large-4.txt",
      field: "/bytes",
      reason: "skill_package_too_large",
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
  assert.equal(output.reservedReadSkillFile.ok, false);
  assert.deepEqual(output.reservedReadSkillFile.issues, [
    {
      kind: "reserved_tool_name",
      path: "tools/read_skill_file.ts",
      toolId: "read_skill_file",
    },
  ]);
});

void test("compileAgentTree keeps channels as authoring-only path-stem facts", () => {
  const result = runTypeScript(
    [
      'import { compileAgentTree } from "./packages/cli/src/build/agent-authoring.ts";',
      'const instructions = { path: "agent/instructions.md", kind: "markdown", text: "Operate." };',
      "const compile = (file) => compileAgentTree({ files: [instructions, file] });",
      "const valid = compileAgentTree({ files: [",
      "  instructions,",
      '  { path: "agent/channels/github.ts", kind: "channel" },',
      '  { path: "agent/channels/stripe_events.ts", kind: "channel" },',
      "] });",
      "if (!valid.ok) { console.error(JSON.stringify(valid.issues)); process.exit(1); }",
      'const nested = compile({ path: "agent/channels/github/events.ts", kind: "channel" });',
      'const emptyName = compile({ path: "agent/channels/.ts", kind: "channel" });',
      'const invalidName = compile({ path: "agent/channels/GitHub.ts", kind: "channel" });',
      'const symlink = compile({ path: "agent/channels/github.ts", kind: "channel", sourceKind: "symlink" });',
      "const duplicate = compileAgentTree({ files: [",
      "  instructions,",
      '  { path: "agent/channels/github.ts", kind: "channel" },',
      '  { path: "channels/github.ts", kind: "channel" },',
      "] });",
      "console.log(JSON.stringify({",
      "  valid: {",
      "    channels: valid.value.channels,",
      '    manifestHasChannels: Object.hasOwn(valid.value.manifest, "channels"),',
      '    provenanceChannelKeys: Object.keys(valid.value.provenance).filter((key) => key.includes("channel")),',
      "  },",
      "  nested,",
      "  emptyName,",
      "  invalidName,",
      "  symlink,",
      "  duplicate,",
      "}));",
    ].join("\n"),
  );
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(output.valid, {
    channels: [
      {
        name: "github",
        path: "agent/channels/github.ts",
        origin: "path:agent/channels/github.ts",
      },
      {
        name: "stripe_events",
        path: "agent/channels/stripe_events.ts",
        origin: "path:agent/channels/stripe_events.ts",
      },
    ],
    manifestHasChannels: false,
    provenanceChannelKeys: [],
  });
  assert.equal(output.nested.ok, false);
  assert.deepEqual(output.nested.issues, [
    {
      kind: "unsupported_path",
      path: "channels/github/events.ts",
      reason: "channel_path_not_in_grammar",
    },
  ]);
  assert.equal(output.emptyName.ok, false);
  assert.deepEqual(output.emptyName.issues, [
    {
      kind: "unsupported_path",
      path: "channels/.ts",
      reason: "empty_path_identity",
    },
  ]);
  assert.equal(output.invalidName.ok, false);
  assert.deepEqual(output.invalidName.issues, [
    {
      kind: "unsupported_path",
      path: "channels/GitHub.ts",
      reason: "channel_name_invalid",
    },
  ]);
  assert.equal(output.symlink.ok, false);
  assert.deepEqual(output.symlink.issues, [
    {
      kind: "unsupported_path",
      path: "channels/github.ts",
      reason: "symlink_forbidden",
    },
  ]);
  assert.equal(output.duplicate.ok, false);
  assert.deepEqual(output.duplicate.issues, [
    {
      kind: "duplicate_path",
      path: "channels/github.ts",
      existingPath: "channels/github.ts",
    },
  ]);
});

void test("compileAgentTree splits workflow lifecycle identity from agent profile", () => {
  const result = runTypeScript(
    [
      'import { compileAgentTree, normalizeAgentOsConfig } from "./packages/cli/src/build/agent-authoring.ts";',
      'const instructions = { path: "agent/instructions.md", kind: "markdown", text: "Operate." };',
      'const agentJson = { path: "agent/agent.json", kind: "json", value: { agentId: "workflow-fixture", scope: { kind: "session", idSource: "manifest", stableScopeId: "workflow-fixture" } } };',
      "const compile = (file) => compileAgentTree({ files: [instructions, file] });",
      "const valid = compileAgentTree({ files: [",
      "  instructions,",
      "  agentJson,",
      '  { path: "workflows/deploy.ts", kind: "workflow" },',
      '  { path: "workflows/reconcile_workspace.ts", kind: "workflow" },',
      "] });",
      "if (!valid.ok) { console.error(JSON.stringify(valid.issues)); process.exit(1); }",
      "const baseConfig = {",
      '  agent: "./agent",',
      '  deployment: { id: "workflow-fixture" },',
      '  target: { kind: "cloudflare-do@1", durableObject: { className: "AgentOS", binding: "AGENT_OS" } },',
      '  client: { kind: "browser-direct@1" },',
      '  llm: { route: "openai-chat-compatible", endpointRef: "openrouter", credentialRef: "openrouter-key", modelRef: "openrouter-model" },',
      "};",
      'const chat = normalizeAgentOsConfig({ ...baseConfig, profile: "chat@1" }, valid.value);',
      'const workspace = normalizeAgentOsConfig({ ...baseConfig, profile: "workspace@1", workspace: { binding: "Sandbox", root: "/workspace" } }, valid.value);',
      "if (!chat.ok) { console.error(JSON.stringify(chat.issues)); process.exit(1); }",
      "if (!workspace.ok) { console.error(JSON.stringify(workspace.issues)); process.exit(1); }",
      'const nested = compile({ path: "workflows/deploy/index.ts", kind: "workflow" });',
      'const emptyName = compile({ path: "workflows/.ts", kind: "workflow" });',
      'const invalidName = compile({ path: "workflows/Deploy.ts", kind: "workflow" });',
      'const agentScoped = compile({ path: "agent/workflows/deploy.ts", kind: "workflow" });',
      'const symlink = compile({ path: "workflows/deploy.ts", kind: "workflow", sourceKind: "symlink" });',
      "const duplicate = compileAgentTree({ files: [",
      "  instructions,",
      '  { path: "workflows/deploy.ts", kind: "workflow" },',
      '  { path: "workflows/deploy.ts", kind: "workflow" },',
      "] });",
      "console.log(JSON.stringify({",
      "  valid: {",
      "    workflows: valid.value.workflows,",
      '    manifestHasWorkflows: Object.hasOwn(valid.value.manifest, "workflows"),',
      '    provenanceWorkflowKeys: Object.keys(valid.value.provenance).filter((key) => key.includes("workflow")),',
      "  },",
      "  normalized: { chat: chat.value.workflows, workspace: workspace.value.workflows },",
      "  nested,",
      "  emptyName,",
      "  invalidName,",
      "  agentScoped,",
      "  symlink,",
      "  duplicate,",
      "}));",
    ].join("\n"),
  );
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  const workflows = [
    {
      name: "deploy",
      path: "workflows/deploy.ts",
      origin: "path:workflows/deploy.ts",
    },
    {
      name: "reconcile_workspace",
      path: "workflows/reconcile_workspace.ts",
      origin: "path:workflows/reconcile_workspace.ts",
    },
  ];
  assert.deepEqual(output.valid, {
    workflows,
    manifestHasWorkflows: false,
    provenanceWorkflowKeys: [],
  });
  assert.deepEqual(output.normalized, { chat: workflows, workspace: workflows });
  assert.equal(output.nested.ok, false);
  assert.deepEqual(output.nested.issues, [
    {
      kind: "unsupported_path",
      path: "workflows/deploy/index.ts",
      reason: "workflow_path_not_in_grammar",
    },
  ]);
  assert.equal(output.emptyName.ok, false);
  assert.deepEqual(output.emptyName.issues, [
    {
      kind: "unsupported_path",
      path: "workflows/.ts",
      reason: "empty_path_identity",
    },
  ]);
  assert.equal(output.invalidName.ok, false);
  assert.deepEqual(output.invalidName.issues, [
    {
      kind: "unsupported_path",
      path: "workflows/Deploy.ts",
      reason: "workflow_name_invalid",
    },
  ]);
  assert.equal(output.agentScoped.ok, false);
  assert.deepEqual(output.agentScoped.issues, [
    {
      kind: "unsupported_path",
      path: "agent/workflows/deploy.ts",
      reason: "workflow_path_not_in_grammar",
    },
  ]);
  assert.equal(output.symlink.ok, false);
  assert.deepEqual(output.symlink.issues, [
    {
      kind: "unsupported_path",
      path: "workflows/deploy.ts",
      reason: "symlink_forbidden",
    },
  ]);
  assert.equal(output.duplicate.ok, false);
  assert.deepEqual(output.duplicate.issues, [
    {
      kind: "duplicate_path",
      path: "workflows/deploy.ts",
      existingPath: "workflows/deploy.ts",
    },
  ]);
});

void test("compileAgentTree keeps schedules as authoring-only nested path facts", () => {
  const result = runTypeScript(
    [
      'import { compileAgentTree, normalizeAgentOsConfig } from "./packages/cli/src/build/agent-authoring.ts";',
      'const instructions = { path: "agent/instructions.md", kind: "markdown", text: "Operate." };',
      'const agentJson = { path: "agent/agent.json", kind: "json", value: { agentId: "schedule-fixture", scope: { kind: "session", idSource: "manifest", stableScopeId: "schedule-fixture" } } };',
      "const handler = () => undefined;",
      'const schedule = (path, cron = "0 9 * * 1-5", extra = {}) => ({ path, kind: "schedule", declaration: { cron, handler, ...extra } });',
      "const compile = (file) => compileAgentTree({ files: [instructions, file] });",
      "const valid = compileAgentTree({ files: [",
      "  instructions,",
      "  agentJson,",
      '  schedule("agent/schedules/daily.ts", "0   9 * * 1-5"),',
      '  schedule("agent/schedules/reports/weekly.ts", "30 8 * * 1"),',
      "] });",
      "if (!valid.ok) { console.error(JSON.stringify(valid.issues)); process.exit(1); }",
      "const baseConfig = {",
      '  agent: "./agent",',
      '  deployment: { id: "schedule-fixture" },',
      '  target: { kind: "cloudflare-do@1", durableObject: { className: "AgentOS", binding: "AGENT_OS" } },',
      '  client: { kind: "browser-direct@1" },',
      '  llm: { route: "openai-chat-compatible", endpointRef: "openrouter", credentialRef: "openrouter-key", modelRef: "openrouter-model" },',
      "};",
      'const chat = normalizeAgentOsConfig({ ...baseConfig, profile: "chat@1" }, valid.value);',
      'const workspace = normalizeAgentOsConfig({ ...baseConfig, profile: "workspace@1", workspace: { binding: "Sandbox", root: "/workspace" } }, valid.value);',
      "if (!chat.ok) { console.error(JSON.stringify(chat.issues)); process.exit(1); }",
      "if (!workspace.ok) { console.error(JSON.stringify(workspace.issues)); process.exit(1); }",
      'const notInGrammar = compile(schedule("agent/schedules.ts"));',
      'const emptySlug = compile(schedule("agent/schedules/reports/.ts"));',
      'const invalidSlug = compile(schedule("agent/schedules/Daily.ts"));',
      'const subagentSchedule = compile(schedule("agent/schedules/subagents/daily.ts"));',
      'const malformedCron = compile(schedule("agent/schedules/daily.ts", "@daily"));',
      'const missingHandler = compile({ path: "agent/schedules/daily.ts", kind: "schedule", declaration: { cron: "0 9 * * *" } });',
      'const identityFields = compile(schedule("agent/schedules/daily.ts", "0 9 * * *", { id: "daily", name: "Daily", kind: "schedule" }));',
      'const symlink = compile({ ...schedule("agent/schedules/daily.ts"), sourceKind: "symlink" });',
      'const missingDeclaration = compile({ path: "agent/schedules/daily.ts", kind: "schedule" });',
      "const duplicate = compileAgentTree({ files: [",
      "  instructions,",
      '  schedule("agent/schedules/daily.ts"),',
      '  schedule("schedules/daily.ts"),',
      "] });",
      "console.log(JSON.stringify({",
      "  valid: {",
      "    schedules: valid.value.schedules,",
      '    manifestHasSchedules: Object.hasOwn(valid.value.manifest, "schedules"),',
      '    provenanceScheduleKeys: Object.keys(valid.value.provenance).filter((key) => key.includes("schedule")),',
      "  },",
      "  normalized: { chat: chat.value.schedules, workspace: workspace.value.schedules },",
      "  notInGrammar,",
      "  emptySlug,",
      "  invalidSlug,",
      "  subagentSchedule,",
      "  malformedCron,",
      "  missingHandler,",
      "  identityFields,",
      "  symlink,",
      "  missingDeclaration,",
      "  duplicate,",
      "}));",
    ].join("\n"),
  );
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  const schedules = [
    {
      scheduleId: "daily",
      cron: "0 9 * * 1-5",
      path: "agent/schedules/daily.ts",
      origin: "path:agent/schedules/daily.ts",
    },
    {
      scheduleId: "reports/weekly",
      cron: "30 8 * * 1",
      path: "agent/schedules/reports/weekly.ts",
      origin: "path:agent/schedules/reports/weekly.ts",
    },
  ];
  assert.deepEqual(output.valid, {
    schedules,
    manifestHasSchedules: false,
    provenanceScheduleKeys: [],
  });
  assert.deepEqual(output.normalized, { chat: schedules, workspace: schedules });
  assert.equal(output.notInGrammar.ok, false);
  assert.deepEqual(output.notInGrammar.issues, [
    {
      kind: "unsupported_path",
      path: "agent/schedules.ts",
      reason: "schedule_path_not_in_grammar",
    },
  ]);
  assert.equal(output.emptySlug.ok, false);
  assert.deepEqual(output.emptySlug.issues, [
    {
      kind: "unsupported_path",
      path: "schedules/reports/.ts",
      reason: "empty_path_identity",
    },
  ]);
  assert.equal(output.invalidSlug.ok, false);
  assert.deepEqual(output.invalidSlug.issues, [
    {
      kind: "unsupported_path",
      path: "schedules/Daily.ts",
      reason: "schedule_slug_invalid",
    },
  ]);
  assert.equal(output.subagentSchedule.ok, false);
  assert.deepEqual(output.subagentSchedule.issues, [
    {
      kind: "unsupported_path",
      path: "schedules/subagents/daily.ts",
      reason: "subagent_schedule_directory_forbidden",
    },
  ]);
  assert.equal(output.malformedCron.ok, false);
  assert.deepEqual(output.malformedCron.issues, [
    {
      kind: "invalid_authored_value",
      path: "schedules/daily.ts",
      field: "/cron",
      reason: "cron_minute_expression_invalid",
    },
  ]);
  assert.equal(output.missingHandler.ok, false);
  assert.deepEqual(output.missingHandler.issues, [
    {
      kind: "invalid_authored_value",
      path: "schedules/daily.ts",
      field: "/handler",
      reason: "schedule_handler_function_required",
    },
  ]);
  assert.equal(output.identityFields.ok, false);
  assert.deepEqual(output.identityFields.issues, [
    { kind: "identity_field_forbidden", path: "schedules/daily.ts", field: "id" },
    { kind: "identity_field_forbidden", path: "schedules/daily.ts", field: "name" },
    { kind: "identity_field_forbidden", path: "schedules/daily.ts", field: "kind" },
  ]);
  assert.equal(output.symlink.ok, false);
  assert.deepEqual(output.symlink.issues, [
    {
      kind: "unsupported_path",
      path: "schedules/daily.ts",
      reason: "symlink_forbidden",
    },
  ]);
  assert.equal(output.missingDeclaration.ok, false);
  assert.deepEqual(output.missingDeclaration.issues, [
    {
      kind: "invalid_authored_value",
      path: "schedules/daily.ts",
      field: "/",
      reason: "schedule_declaration_object_required",
    },
  ]);
  assert.equal(output.duplicate.ok, false);
  assert.deepEqual(output.duplicate.issues, [
    {
      kind: "duplicate_path",
      path: "schedules/daily.ts",
      existingPath: "schedules/daily.ts",
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
    assert.match(target, /from "@agent-os\/runtime\/run-projector";/);
    assert.match(target, /from "@agent-os\/core\/tools";/);
    assert.match(target, /submitSessionTurn\(input: AgentSessionSubmitTurnInput\)/);
    assert.match(target, /runWorkflow\(input: AgentWorkflowRunInput\)/);
    assert.match(target, /inspectSession\(input: \{ readonly sessionRef: string \}\)/);
    assert.match(target, /listWorkflowRuns\(input: \{ readonly workflowId: string \}\)/);
    assert.match(target, /this\.submitWithBindingsAndProductLink/);
    assert.match(target, /projectAgentSessions/);
    assert.match(target, /projectWorkflowRuns/);
    assert.doesNotMatch(target, /submitAgentEffect/);
    assert.doesNotMatch(target, /from "@agent-os\/runtime\/workspace-binding";/);
    assertNoCloudflareLifecycleTargetWiring(target);
    assert.doesNotMatch(target, /bindWorkspaceToolsForRuntime/);
    assert.match(target, /generatedWorkspaceToolInteractions/);
    assert.match(target, /toolInteractions: generatedWorkspaceToolInteractions/);
    assert.match(target, /readonly AGENTOS_ENDPOINT_OPENROUTER\?: string;/);
    assert.match(target, /readonly AGENTOS_CREDENTIAL_OPENROUTER_KEY\?: string;/);
    assert.match(target, /readonly AGENTOS_MODEL_OPENROUTER_DEFAULT_TEXT_MODEL\?: string;/);
    assert.match(target, /materialEnvValue\(env, "AGENTOS_ENDPOINT_OPENROUTER"\)/);
    assert.match(target, /preflightOpenAiCompatibleProviderMaterial/);
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
    assert.match(remote, /WORKSPACE_AGENT_PRODUCT_COMMAND/);
    assert.match(remote, /runtime\.submitSessionTurn/);
    assert.match(remote, /runtime\.inspectSession/);
    assert.match(remote, /runtime\.listSessions/);
    assert.match(remote, /runtime\.runWorkflow/);
    assert.match(remote, /runtime\.inspectWorkflowRun/);
    assert.match(remote, /runtime\.listWorkflowRuns/);
    assert.doesNotMatch(remote, /durableObjectRpcClient/);
    assert.doesNotMatch(remote, /manifestTruthIdentity/);
    const client = readFileSync(path.join(root, ".agentos/generated/client.ts"), "utf8");
    assert.match(client, /GeneratedAgentClientProductProjections/);
    assert.match(client, /WorkspaceAgentProductCommandMap/);
    assert.match(client, /WorkspaceAgentClientBridge<GeneratedAgentClientProductProjections>/);
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
    assert.match(local, /from "@agent-os\/runtime\/llm-effect-ai\/openai-compatible";/);
    assert.match(local, /lowerLocalAgentRuntime/);
    assert.match(local, /OpenAiCompatibleLlmTransportLive/);
    assert.match(local, /preflightOpenAiCompatibleProviderMaterial/);
    assert.match(local, /AGENTOS_ENDPOINT_OPENROUTER/);
    assert.match(local, /AGENTOS_CREDENTIAL_OPENROUTER_KEY/);
    assert.match(local, /AGENTOS_MODEL_OPENROUTER_DEFAULT_TEXT_MODEL/);
    assert.match(local, /export interface LocalAgentApp/);
    assert.match(local, /readonly sessions:/);
    assert.match(local, /readonly workflows:/);
    assert.match(local, /projectAgentSession/);
    assert.match(local, /projectWorkflowRuns/);
    assert.match(local, /export const createLocalAgentApp/);
    assert.match(local, /target: "node@1"/);
    assert.match(local, /llm: options\.llm \?\? generatedLocalLlmFor\(targetEnv\)/);
    assert.match(local, /workspaceOperations: generatedWorkspaceOperations/);
    assert.match(local, /toolInteractions: generatedWorkspaceToolInteractions/);
    assert.match(local, /runtime: lowered\.runtime/);
    assert.match(local, /lowered\.submitWithProductLink/);
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

void test("agentos build emits one channel registry for cloudflare and node targets", () => {
  const writeChannelFixture = (root) => {
    mkdirSync(path.join(root, "agent/channels"), { recursive: true });
    writeFileSync(
      path.join(root, "agent/channels/github.ts"),
      [
        'import { defineChannel, post } from "@agent-os/runtime/channel";',
        "export default defineChannel({",
        '  verify: async (request) => ({ authority: "github.signature", subject: request.request.headers.get("x-github-delivery") ?? "missing-delivery" }),',
        "  routes: [",
        '    post("/events/:eventId", async (request) => new Response(request.params.eventId)),',
        "  ],",
        "});",
        "",
      ].join("\n"),
    );
  };

  const writeBaseAgent = (root, targetLines) => {
    writeFileSync(path.join(root, "package.json"), JSON.stringify({ type: "module" }, null, 2));
    mkdirSync(path.join(root, "agent"), { recursive: true });
    writeFileSync(path.join(root, "agent/instructions.md"), "Handle inbound channels.");
    writeFileSync(
      path.join(root, "agent/agent.json"),
      JSON.stringify(
        {
          agentId: "channel-fixture",
          scope: {
            kind: "session",
            idSource: "manifest",
            stableScopeId: "channel-fixture-scope",
          },
          effectAuthorityRef: {
            authorityClass: "effect",
            authorityId: "channel-fixture",
          },
        },
        null,
        2,
      ),
    );
    writeChannelFixture(root);
    writeFileSync(
      path.join(root, "agentos.config.jsonc"),
      [
        "{",
        '  "profile": "workspace@1",',
        '  "agent": "./agent",',
        '  "deployment": { "id": "channel-fixture", "version": "0.1.0" },',
        ...targetLines,
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
  };

  const cloudflareRoot = mkdtempSync(path.join(os.tmpdir(), "agentos-channel-cloudflare-"));
  const nodeRoot = mkdtempSync(path.join(os.tmpdir(), "agentos-channel-node-"));
  try {
    writeBaseAgent(cloudflareRoot, [
      '  "target": {',
      '    "kind": "cloudflare-do@1",',
      '    "durableObject": { "className": "AgentOS", "binding": "AGENT_OS" }',
      "  },",
    ]);
    const cloudflareResult = spawnSync(process.execPath, [cli, "build", "--cwd", cloudflareRoot], {
      encoding: "utf8",
    });
    assert.equal(cloudflareResult.status, 0, cloudflareResult.stderr);
    assert.match(cloudflareResult.stdout, /generated 11 agentOS files/);
    const cloudflareManifest = JSON.parse(
      readFileSync(path.join(cloudflareRoot, ".agentos/generated/manifest.json"), "utf8"),
    );
    assert.equal(Object.hasOwn(cloudflareManifest, "channels"), false);
    const cloudflareChannels = readFileSync(
      path.join(cloudflareRoot, ".agentos/generated/channels.ts"),
      "utf8",
    );
    assert.match(cloudflareChannels, /from "\.\.\/\.\.\/agent\/channels\/github"/);
    assert.match(cloudflareChannels, /from "@agent-os\/runtime\/channel"/);
    assert.match(cloudflareChannels, /createChannelContext/);
    assert.match(cloudflareChannels, /name: "github"/);
    assert.match(cloudflareChannels, /mountedChannelPath/);
    assert.match(cloudflareChannels, /routePatternsConflict/);
    assert.match(cloudflareChannels, /route\.channel\.verify\(channelRequest\)/);
    assert.match(cloudflareChannels, /dispatchGeneratedChannelRequest/);
    const cloudflareWorker = readFileSync(
      path.join(cloudflareRoot, ".agentos/generated/worker.ts"),
      "utf8",
    );
    assert.match(cloudflareWorker, /from "\.\/channels"/);
    assert.match(cloudflareWorker, /agentOSRpcClient/);
    assert.match(cloudflareWorker, /Pick<AgentRuntimeClient, "events" \| "streamEvents">/);
    assert.match(cloudflareWorker, /generatedChannelRuntimeFor\(env\)/);
    assert.doesNotMatch(cloudflareWorker, /dispatchGeneratedChannelRequest\(request, env\)/);

    writeBaseAgent(nodeRoot, ['  "target": { "kind": "node@1" },']);
    const nodeResult = spawnSync(process.execPath, [cli, "build", "--cwd", nodeRoot], {
      encoding: "utf8",
    });
    assert.equal(nodeResult.status, 0, nodeResult.stderr);
    assert.match(nodeResult.stdout, /generated 6 agentOS files/);
    const nodeLocal = readFileSync(path.join(nodeRoot, ".agentos/generated/local.ts"), "utf8");
    assert.match(nodeLocal, /from "\.\/channels"/);
    assert.match(nodeLocal, /ChannelRuntime/);
    assert.match(nodeLocal, /handleLocalAgentChannelRequest/);
    assert.match(nodeLocal, /dispatchGeneratedChannelRequest\(request, runtime\)/);
    assert.equal(existsSync(path.join(nodeRoot, ".agentos/generated/channels.ts")), true);
  } finally {
    rmSync(cloudflareRoot, { recursive: true, force: true });
    rmSync(nodeRoot, { recursive: true, force: true });
  }
});

void test("agentos build emits one schedule registry for cloudflare and node targets", () => {
  const writeScheduleFixture = (root) => {
    mkdirSync(path.join(root, "agent/schedules"), { recursive: true });
    writeFileSync(
      path.join(root, "agent/schedules/daily.ts"),
      [
        "export default {",
        '  cron: "0 9 * * *",',
        "  handler: async (context) => {",
        "    const session = await context.sessions.submitTurn({",
        '      sessionRef: "daily-session",',
        "      turnRef: context.fireId,",
        '      intent: "scheduled session",',
        "      context: { scheduledAt: context.scheduledAt },",
        "    });",
        "    return {",
        "      contextKeys: Object.keys(context).sort(),",
        "      fireId: context.fireId,",
        "      scheduledAt: context.scheduledAt,",
        "      principal: context.appPrincipal,",
        "      sessionStatus: session.status,",
        "    };",
        "  },",
        "};",
        "",
      ].join("\n"),
    );
  };

  const writeBaseAgent = (root, targetLines) => {
    writeFileSync(path.join(root, "package.json"), JSON.stringify({ type: "module" }, null, 2));
    mkdirSync(path.join(root, "agent"), { recursive: true });
    writeFileSync(path.join(root, "agent/instructions.md"), "Run scheduled ingress.");
    writeFileSync(
      path.join(root, "agent/agent.json"),
      JSON.stringify(
        {
          agentId: "schedule-registry-fixture",
          scope: {
            kind: "session",
            idSource: "manifest",
            stableScopeId: "schedule-registry-scope",
          },
          effectAuthorityRef: {
            authorityClass: "effect",
            authorityId: "schedule-registry-fixture",
          },
        },
        null,
        2,
      ),
    );
    writeScheduleFixture(root);
    writeFileSync(
      path.join(root, "agentos.config.jsonc"),
      [
        "{",
        '  "profile": "workspace@1",',
        '  "agent": "./agent",',
        '  "deployment": { "id": "schedule-registry-fixture", "version": "0.1.0" },',
        ...targetLines,
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
  };

  const cloudflareRoot = mkdtempSync(path.join(os.tmpdir(), "agentos-schedule-cloudflare-"));
  const nodeRoot = mkdtempSync(path.join(os.tmpdir(), "agentos-schedule-node-"));
  try {
    writeBaseAgent(cloudflareRoot, [
      '  "target": {',
      '    "kind": "cloudflare-do@1",',
      '    "durableObject": { "className": "AgentOS", "binding": "AGENT_OS" }',
      "  },",
    ]);
    const cloudflareResult = spawnSync(process.execPath, [cli, "build", "--cwd", cloudflareRoot], {
      encoding: "utf8",
    });
    assert.equal(cloudflareResult.status, 0, cloudflareResult.stderr);
    assert.match(cloudflareResult.stdout, /generated 11 agentOS files/);
    const cloudflareManifest = JSON.parse(
      readFileSync(path.join(cloudflareRoot, ".agentos/generated/manifest.json"), "utf8"),
    );
    assert.equal(Object.hasOwn(cloudflareManifest, "schedules"), false);
    const cloudflareSchedules = readFileSync(
      path.join(cloudflareRoot, ".agentos/generated/schedules.ts"),
      "utf8",
    );
    assert.match(cloudflareSchedules, /from "\.\.\/\.\.\/agent\/schedules\/daily"/);
    assert.match(cloudflareSchedules, /from "@agent-os\/runtime\/schedule"/);
    assert.match(cloudflareSchedules, /generatedSchedules/);
    assert.match(cloudflareSchedules, /generatedScheduleDefinitions/);
    assert.match(cloudflareSchedules, /generatedScheduleRegistry/);
    assert.match(cloudflareSchedules, /dispatchScheduleFire/);
    assert.doesNotMatch(cloudflareSchedules, /scheduleFireId/);
    assert.doesNotMatch(cloudflareSchedules, /createScheduleContext/);
    assert.doesNotMatch(cloudflareSchedules, /readdir|collectFiles/);
    const cloudflareTarget = readFileSync(
      path.join(cloudflareRoot, ".agentos/generated/target.ts"),
      "utf8",
    );
    assert.match(cloudflareTarget, /from "\.\/schedules"/);
    assert.match(cloudflareTarget, /dispatchSchedule\(input: GeneratedScheduleTriggerInput\)/);
    assert.match(cloudflareTarget, /generatedScheduleRuntimeFor\(this\)/);
    assert.match(cloudflareTarget, /commitScheduleFireDispatchFull/);
    assert.doesNotMatch(cloudflareTarget, /agent\/schedules|readdir|collectFiles/);
    const cloudflareWorker = readFileSync(
      path.join(cloudflareRoot, ".agentos/generated/worker.ts"),
      "utf8",
    );
    assert.match(cloudflareWorker, /generatedSchedules/);
    assert.match(cloudflareWorker, /scheduled\(controller: ScheduledController/);
    assert.match(cloudflareWorker, /entry\.cron === controller\.cron/);
    assert.match(cloudflareWorker, /scheduledAt: controller\.scheduledTime/);
    assert.match(cloudflareWorker, /ctx\.waitUntil\(runtime\.dispatchSchedule\(input\)\)/);
    assert.doesNotMatch(cloudflareWorker, /cron-parser|setInterval|setTimeout/);

    writeBaseAgent(nodeRoot, ['  "target": { "kind": "node@1" },']);
    const nodeResult = spawnSync(process.execPath, [cli, "build", "--cwd", nodeRoot], {
      encoding: "utf8",
    });
    assert.equal(nodeResult.status, 0, nodeResult.stderr);
    assert.match(nodeResult.stdout, /generated 6 agentOS files/);
    const nodeLocal = readFileSync(path.join(nodeRoot, ".agentos/generated/local.ts"), "utf8");
    assert.match(nodeLocal, /from "\.\/schedules"/);
    assert.match(nodeLocal, /readonly schedules:/);
    assert.match(nodeLocal, /ids: generatedScheduleIds/);
    assert.match(nodeLocal, /list: \(\) => generatedScheduleDefinitions/);
    assert.match(nodeLocal, /trigger: triggerSchedule/);
    assert.match(nodeLocal, /history: scheduleHistory/);
    assert.match(nodeLocal, /projectScheduleFireHistory/);
    assert.match(nodeLocal, /commitScheduleFireDispatch/);
    assert.doesNotMatch(nodeLocal, /readonly dispatch/);
    assert.doesNotMatch(nodeLocal, /agent\/schedules|readdir|collectFiles/);
    assert.equal(existsSync(path.join(nodeRoot, ".agentos/generated/schedules.ts")), true);

    linkGeneratedTargetSmokeDependencies(nodeRoot);
    const dispatchResult = runTypeScript(
      [
        'import { dispatchGeneratedSchedule, generatedScheduleDefinitions, generatedScheduleIds } from "./.agentos/generated/schedules.ts";',
        "const calls = [];",
        "const runtime = Object.freeze({",
        "  sessions: Object.freeze({",
        "    submitTurn: async (input) => {",
        '      calls.push(["session", input]);',
        '      return { ok: true, status: "delivered", runId: 101, final: "done", eventCount: 4, tokensUsed: 0 };',
        "    },",
        "  }),",
        "  workflows: Object.freeze({",
        "    run: async (input) => {",
        '      calls.push(["workflow", input]);',
        '      return { ok: true, status: "delivered", runId: 202, final: "done", eventCount: 4, tokensUsed: 0 };',
        "    },",
        "  }),",
        "});",
        "const result = await dispatchGeneratedSchedule({",
        '  scheduleId: "daily",',
        '  scheduledAt: "2026-06-26T10:20:42.000Z",',
        '  appPrincipal: { authority: "app", subject: "tenant" },',
        '  identity: { scopeRef: { kind: "conversation", scopeId: "schedule-registry-scope" }, effectAuthorityRef: { authorityClass: "effect", authorityId: "schedule-registry-fixture" } },',
        "  runtime,",
        "});",
        "const outcome = result.outcome(500);",
        "console.log(JSON.stringify({ definitions: generatedScheduleDefinitions, ids: generatedScheduleIds, result: { ok: result.ok, fireId: result.fireId, requested: result.requested, productLink: result.ok ? result.productLink : null, outcome }, calls }));",
      ].join("\n"),
      { cwd: nodeRoot, resolveDir: nodeRoot },
    );
    assert.equal(dispatchResult.status, 0, dispatchResult.stderr);
    const output = JSON.parse(dispatchResult.stdout);
    assert.deepEqual(output.definitions, [
      { scheduleId: "daily", path: "agent/schedules/daily.ts", cron: "0 9 * * *" },
    ]);
    assert.deepEqual(output.ids, ["daily"]);
    assert.equal(output.result.ok, true);
    assert.equal(output.result.requested.kind, "schedule.fire_requested");
    assert.equal(output.result.outcome.kind, "schedule.fire_dispatched");
    assert.equal(output.result.outcome.payload.requestedEventId, 500);
    assert.deepEqual(output.result.requested.payload.appPrincipal, {
      authority: "app",
      subject: "tenant",
    });
    assert.match(
      output.result.fireId,
      /^schedule-fire:app:tenant:daily:2026-06-26T10%3A20%3A00\.000Z$/,
    );
    assert.deepEqual(output.result.productLink, {
      kind: "session_turn",
      sessionRef: "daily-session",
      turnRef: output.result.fireId,
      runtimeRunId: 101,
      idempotencyKey: output.result.fireId,
    });
    assert.deepEqual(output.calls, [
      [
        "session",
        {
          sessionRef: "daily-session",
          turnRef: output.result.fireId,
          idempotencyKey: output.result.fireId,
          intent: "scheduled session",
          context: { scheduledAt: "2026-06-26T10:20:00.000Z" },
        },
      ],
    ]);
  } finally {
    rmSync(cloudflareRoot, { recursive: true, force: true });
    rmSync(nodeRoot, { recursive: true, force: true });
  }
});

void test("generated channel registry rejects ambiguous channel route conflicts", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "agentos-channel-conflict-"));
  try {
    writeFileSync(path.join(root, "package.json"), JSON.stringify({ type: "module" }, null, 2));
    mkdirSync(path.join(root, "agent/channels"), { recursive: true });
    writeFileSync(path.join(root, "agent/instructions.md"), "Reject ambiguous channel routes.");
    writeFileSync(
      path.join(root, "agent/agent.json"),
      JSON.stringify(
        {
          agentId: "channel-conflict",
          scope: {
            kind: "session",
            idSource: "manifest",
            stableScopeId: "channel-conflict-scope",
          },
        },
        null,
        2,
      ),
    );
    writeFileSync(
      path.join(root, "agent/channels/github.ts"),
      [
        'import { defineChannel, post } from "@agent-os/runtime/channel";',
        "export default defineChannel({",
        '  verify: () => ({ authority: "github.signature", subject: "installation:42" }),',
        "  routes: [",
        '    post("/events/:eventId", async () => new Response("param")),',
        '    post("/events/static", async () => new Response("literal")),',
        "  ],",
        "});",
        "",
      ].join("\n"),
    );
    writeFileSync(
      path.join(root, "agentos.config.jsonc"),
      [
        "{",
        '  "profile": "workspace@1",',
        '  "agent": "./agent",',
        '  "deployment": { "id": "channel-conflict" },',
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

    const buildResult = spawnSync(process.execPath, [cli, "build", "--cwd", root], {
      encoding: "utf8",
    });
    assert.equal(buildResult.status, 0, buildResult.stderr);
    linkGeneratedTargetSmokeDependencies(root);
    const importResult = runTypeScript('import "./.agentos/generated/channels.ts";', {
      cwd: root,
      resolveDir: root,
    });
    assert.notEqual(importResult.status, 0);
    assert.match(
      importResult.stderr,
      /generated channel route conflict: POST \/channels\/github\/events\/:eventId conflicts with \/channels\/github\/events\/static/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test("generated channel dispatch preserves raw request and restricts handler context", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "agentos-channel-dispatch-"));
  try {
    writeFileSync(path.join(root, "package.json"), JSON.stringify({ type: "module" }, null, 2));
    mkdirSync(path.join(root, "agent/channels"), { recursive: true });
    writeFileSync(
      path.join(root, "agent/instructions.md"),
      "Handle provider-native channel input.",
    );
    writeFileSync(
      path.join(root, "agent/agent.json"),
      JSON.stringify(
        {
          agentId: "channel-dispatch",
          scope: {
            kind: "session",
            idSource: "manifest",
            stableScopeId: "channel-dispatch-scope",
          },
        },
        null,
        2,
      ),
    );
    writeFileSync(
      path.join(root, "agent/channels/github.ts"),
      [
        'import { defineChannel, post } from "@agent-os/runtime/channel";',
        "export default defineChannel({",
        '  verify: async (request) => ({ authority: "github.signature", subject: request.request.headers.get("x-principal") ?? "missing-principal" }),',
        "  routes: [",
        '    post("/events/:eventId", async (request, context) => {',
        "      const raw = await request.request.text();",
        '      const submitResult = await context.submit({ intent: "channel", context: { eventId: request.params.eventId } });',
        "      const dispatchResult = await context.dispatch({",
        '        target: { bindingRef: { kind: "binding", provider: "test", bindingKind: "queue", ref: "outbound" }, scopeRef: { kind: "session", scopeId: "channel-dispatch-scope" }, effectAuthorityRef: { authorityClass: "channel", authorityId: context.principal.authority } },',
        '        event: "channel.received",',
        "        data: { eventId: request.params.eventId },",
        "        idempotencyKey: request.params.eventId,",
        "      });",
        "      return Response.json({",
        "        raw,",
        "        eventId: request.params.eventId,",
        "        path: request.path,",
        "        principal: context.principal,",
        "        contextKeys: Object.keys(context).sort(),",
        "        submitStatus: submitResult.status,",
        "        outboundEventId: dispatchResult.outboundEventId,",
        "      });",
        "    }),",
        "  ],",
        "});",
        "",
      ].join("\n"),
    );
    writeFileSync(
      path.join(root, "agentos.config.jsonc"),
      [
        "{",
        '  "profile": "workspace@1",',
        '  "agent": "./agent",',
        '  "deployment": { "id": "channel-dispatch" },',
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

    const buildResult = spawnSync(process.execPath, [cli, "build", "--cwd", root], {
      encoding: "utf8",
    });
    assert.equal(buildResult.status, 0, buildResult.stderr);
    linkGeneratedTargetSmokeDependencies(root);
    const dispatchResult = runTypeScript(
      [
        'import { dispatchGeneratedChannelRequest } from "./.agentos/generated/channels.ts";',
        "const calls = [];",
        "const runtime = Object.freeze({",
        "  submit: async (input) => {",
        '    calls.push(["submit", input]);',
        '    return { ok: true, status: "delivered", runId: 1, final: "ok", eventCount: 1, tokensUsed: 0 };',
        "  },",
        "  dispatch: async (spec) => {",
        '    calls.push(["dispatch", spec]);',
        "    return { outboundEventId: 9 };",
        "  },",
        "});",
        'const request = new Request("http://agent.test/channels/github/events/evt_123", {',
        '  method: "POST",',
        '  headers: { "x-principal": "installation:42", "authorization": "secret-token" },',
        '  body: "raw-provider-body",',
        "});",
        "const response = await dispatchGeneratedChannelRequest(request, runtime);",
        "const body = await response.json();",
        "console.log(JSON.stringify({ body, calls }));",
      ].join("\n"),
      { cwd: root, resolveDir: root },
    );
    assert.equal(dispatchResult.status, 0, dispatchResult.stderr);
    const output = JSON.parse(dispatchResult.stdout);
    assert.deepEqual(output.body, {
      raw: "raw-provider-body",
      eventId: "evt_123",
      path: "/channels/github/events/evt_123",
      principal: { authority: "github.signature", subject: "installation:42" },
      contextKeys: ["dispatch", "principal", "submit"],
      submitStatus: "delivered",
      outboundEventId: 9,
    });
    assert.deepEqual(output.calls, [
      ["submit", { intent: "channel", context: { eventId: "evt_123" } }],
      [
        "dispatch",
        {
          target: {
            bindingRef: {
              kind: "binding",
              provider: "test",
              bindingKind: "queue",
              ref: "outbound",
            },
            scopeRef: { kind: "session", scopeId: "channel-dispatch-scope" },
            effectAuthorityRef: { authorityClass: "channel", authorityId: "github.signature" },
          },
          event: "channel.received",
          data: { eventId: "evt_123" },
          idempotencyKey: "evt_123",
        },
      ],
    ]);
    assert.doesNotMatch(JSON.stringify(output), /secret-token/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test("agentos build rejects nested channel files from the filesystem", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "agentos-channel-invalid-"));
  try {
    writeFileSync(path.join(root, "package.json"), JSON.stringify({ type: "module" }, null, 2));
    mkdirSync(path.join(root, "agent/channels/github"), { recursive: true });
    writeFileSync(path.join(root, "agent/instructions.md"), "Reject nested channels.");
    writeFileSync(path.join(root, "agent/channels/github/events.ts"), "export default {};");
    writeFileSync(
      path.join(root, "agentos.config.jsonc"),
      [
        "{",
        '  "profile": "workspace@1",',
        '  "agent": "./agent",',
        '  "deployment": { "id": "channel-invalid" },',
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
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /channel_path_not_in_grammar/);
    assert.match(result.stderr, /channels\/github\/events\.ts/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test("agentos build rejects nested workflow files from the filesystem", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "agentos-workflow-invalid-"));
  try {
    writeFileSync(path.join(root, "package.json"), JSON.stringify({ type: "module" }, null, 2));
    mkdirSync(path.join(root, "agent"), { recursive: true });
    mkdirSync(path.join(root, "workflows/deploy"), { recursive: true });
    writeFileSync(path.join(root, "agent/instructions.md"), "Reject nested workflows.");
    writeFileSync(path.join(root, "workflows/deploy/index.ts"), "export default {};");
    writeFileSync(
      path.join(root, "agentos.config.jsonc"),
      [
        "{",
        '  "profile": "workspace@1",',
        '  "agent": "./agent",',
        '  "deployment": { "id": "workflow-invalid" },',
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
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /workflow_path_not_in_grammar/);
    assert.match(result.stderr, /workflows\/deploy\/index\.ts/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test("agentos info emits compile-only inspection without generated writes", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "agentos-info-"));
  try {
    writeFileSync(path.join(root, "package.json"), JSON.stringify({ type: "module" }, null, 2));
    mkdirSync(path.join(root, "agent"), { recursive: true });
    mkdirSync(path.join(root, "agent/schedules"), { recursive: true });
    mkdirSync(path.join(root, "workflows"), { recursive: true });
    writeFileSync(path.join(root, "agent/instructions.md"), "Operate.");
    writeFileSync(path.join(root, "workflows/deploy.ts"), "export default {};");
    writeFileSync(
      path.join(root, "agent/schedules/daily.ts"),
      ['export default { cron: "0 9 * * *", handler: () => undefined };'].join("\n"),
    );
    writeFileSync(
      path.join(root, "agent/agent.json"),
      JSON.stringify(
        {
          agentId: "info-agent",
          scope: {
            kind: "session",
            idSource: "manifest",
            stableScopeId: "info-agent-scope",
          },
          effectAuthorityRef: {
            authorityClass: "effect",
            authorityId: "info-agent",
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
        '  "deployment": { "id": "info-deployment", "version": "0.1.0" },',
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

    const jsonResult = spawnSync(process.execPath, [cli, "info", "--cwd", root, "--json"], {
      encoding: "utf8",
    });
    assert.equal(jsonResult.status, 0, jsonResult.stderr);
    const info = JSON.parse(jsonResult.stdout);
    assert.equal(info.compile.status, "available");
    assert.equal(info.compile.profile, "workspace@1");
    assert.equal(info.compile.target, "node@1");
    assert.equal(info.compile.agent.id, "info-agent");
    assert.equal(info.compile.deployment.id, "info-deployment");
    assert.equal(info.compile.deployment.backend, "node");
    assert.equal(info.compile.deployment.adapter, "node@1");
    assert.deepEqual(info.compile.manifest.capabilities, ["@agent-os/workspace-op"]);
    assert.deepEqual(info.compile.manifest.tools, workspaceDefaultToolNames);
    assert.deepEqual(info.compile.manifest.workflows, ["deploy"]);
    assert.deepEqual(info.compile.manifest.schedules, ["daily"]);
    assert.deepEqual(info.resolve, {
      status: "unavailable",
      reason: "agentos info is compile-only; resolved install graph is unavailable",
    });
    assert.deepEqual(info.runtime, {
      status: "unavailable",
      reason: "agentos info does not start a local or Cloudflare runtime",
    });
    assert.doesNotMatch(jsonResult.stdout, /\/agentos\/v1\/info/);
    assert.equal(existsSync(path.join(root, ".agentos")), false);

    const humanResult = spawnSync(process.execPath, [cli, "info", "--cwd", root], {
      encoding: "utf8",
    });
    assert.equal(humanResult.status, 0, humanResult.stderr);
    assert.match(humanResult.stdout, /agentOS info/);
    assert.match(humanResult.stdout, /profile: workspace@1/);
    assert.match(humanResult.stdout, /target: node@1/);
    assert.match(humanResult.stdout, /resolve: unavailable/);
    assert.match(humanResult.stdout, /runtime: unavailable/);

    const runnerSource = readFileSync(
      path.join(repoRoot, "packages/cli/src/build/build-cli.ts"),
      "utf8",
    );
    assert.doesNotMatch(
      runnerSource,
      /resolveRuntime|lowerLocalAgentRuntime|createLocalAgentRuntime|wrangler/i,
    );
    const staticTargetSource = readFileSync(
      path.join(repoRoot, "packages/cli/src/build/agent-authoring/static-target.ts"),
      "utf8",
    );
    assert.doesNotMatch(staticTargetSource, /\/agentos\/v1\/info/);
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
    assertNoCloudflareLifecycleTargetWiring(target);
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
      "const utf8 = (text) => new TextEncoder().encode(text);",
      "const compiled = compileAgentTree({ files: [",
      '  { path: "agent/instructions.md", kind: "markdown", text: "Operate." },',
      '  { path: "agent/agent.json", kind: "json", value: { agentId: "target-skills", scope: { kind: "session", idSource: "manifest", stableScopeId: "target-skills" } } },',
      '  { path: "agent/skills/echo.md", kind: "markdown", text: "---\\nname: echo\\ndescription: Echo workspace routing\\n---\\nUse workspace echo skill." },',
      '  { path: "agent/skills/review/SKILL.md", kind: "markdown", text: "---\\nname: review\\ndescription: Review chat routing\\n---\\nUse chat review skill." },',
      '  { path: "agent/skills/review/references/checklist.md", kind: "text", bytes: utf8("Check output.") },',
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
      "  readSkillFile: text.includes('name: \"read_skill_file\"'),",
      "  system: text.includes('system: generatedSystemPrompt(input.system)'),",
      "  echoDescription: text.includes('Echo workspace routing'),",
      "  reviewDescription: text.includes('Review chat routing'),",
      "  advertUsesDescription: text.includes('${skill.name}: ${skill.description}'),",
      "  legacyPathDigestAdvert: text.includes('to load ${skill.path}'),",
      "  fileCatalog: text.includes('generatedSkillFilePathCatalog'),",
      "  metadataLoader: text.includes('generatedLoadedSkill'),",
      "  supportingPath: text.includes('references/checklist.md'),",
      "  supportingText: text.includes('Check output.'),",
      "  echoBody: text.includes('Use workspace echo skill.'),",
      "  reviewBody: text.includes('Use chat review skill.'),",
      "  frameworkTools: text.includes('...generatedFrameworkTools'),",
      "});",
      "console.log(JSON.stringify({ workspace: markers(workspaceTarget), chat: markers(chatTarget) }));",
    ].join("\n"),
  );
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  for (const profile of ["workspace", "chat"]) {
    for (const [marker, present] of Object.entries(output[profile])) {
      if (marker === "legacyPathDigestAdvert") {
        assert.equal(present, false, `${profile} target kept legacy path/digest advert`);
      } else {
        assert.equal(present, true, `${profile} target missing ${marker}`);
      }
    }
  }
});

void test("agentos build emits skill artifact and load_skill executes deterministically", () => {
  const root = mkdtempSync(path.join(repoRoot, ".agentos-skill-smoke-"));
  try {
    writeFileSync(path.join(root, "package.json"), JSON.stringify({ type: "module" }, null, 2));
    linkGeneratedTargetSmokeDependencies(root);
    mkdirSync(path.join(root, "agent/skills/echo/references"), { recursive: true });
    mkdirSync(path.join(root, "agent/skills/echo/scripts"), { recursive: true });
    writeFileSync(path.join(root, "agent/instructions.md"), "Answer with authored skills.");
    writeFileSync(
      path.join(root, "agent/skills/echo/SKILL.md"),
      "---\nname: echo\ndescription: Echo marker loader\n---\nECHO_MARKER_560",
    );
    writeFileSync(path.join(root, "agent/skills/echo/references/checklist.md"), "CHECK_MARKER_560");
    writeFileSync(path.join(root, "agent/skills/echo/scripts/audit.sh"), "SCRIPT_MARKER_560");
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
    assert.match(target, /CHECK_MARKER_560/);
    assert.match(target, /SCRIPT_MARKER_560/);
    assert.match(target, /name: "load_skill"/);
    assert.match(target, /name: "read_skill_file"/);

    let smokeSource = readFileSync(path.join(root, ".agentos/generated/target.ts"), "utf8");
    smokeSource = smokeSource
      .replace(
        'import { createAgentDurableObject } from "@agent-os/runtime/cloudflare";',
        "const createAgentDurableObject = () => class {};",
      )
      .replace(
        /import \{[^}]*OpenAiCompatibleLlmTransportLive[^}]*preflightOpenAiCompatibleProviderMaterial[^}]*\} from "@agent-os\/runtime\/llm-effect-ai\/openai-compatible";/s,
        "const OpenAiCompatibleLlmTransportLive = {}; const preflightOpenAiCompatibleProviderMaterial = () => [];",
      );
    smokeSource += `
export const __agentosSkillSmoke = async () => {
  const agent = Object.create(AgentOS.prototype);
  agent.targetEnv = {
    AGENTOS_ENDPOINT_OPENROUTER: "https://openrouter.example/v1",
    AGENTOS_CREDENTIAL_OPENROUTER_KEY: "smoke-secret",
    AGENTOS_MODEL_OPENROUTER_MODEL: "smoke-model",
  };
  agent.submitWithBindings = async (spec, bindings) => {
    const tools = bindings.tools ?? {};
    const loaded = await Effect.runPromise(
      unsafeRunToolByName(tools, deterministicToolInvocation("load_skill", { name: "echo" })),
    );
    const readReference = await Effect.runPromise(
      unsafeRunToolByName(
        tools,
        deterministicToolInvocation("read_skill_file", {
          name: "echo",
          path: "references/checklist.md",
        }),
      ),
    );
    const readScript = await Effect.runPromise(
      unsafeRunToolByName(
        tools,
        deterministicToolInvocation("read_skill_file", {
          name: "echo",
          path: "scripts/audit.sh",
        }),
      ),
    );
    let unknownRejected = false;
    try {
      await Effect.runPromise(
        unsafeRunToolByName(tools, deterministicToolInvocation("load_skill", { name: "missing" })),
      );
    } catch {
      unknownRejected = true;
    }
    let unknownFileRejected = false;
    try {
      await Effect.runPromise(
        unsafeRunToolByName(
          tools,
          deterministicToolInvocation("read_skill_file", {
            name: "echo",
            path: "references/missing.md",
          }),
        ),
      );
    } catch {
      unknownFileRejected = true;
    }
    return {
      toolNames: Object.keys(tools).sort(),
      systemIncludesAdvert: spec.system.includes("Available agent skills"),
      systemIncludesDescription: spec.system.includes("Echo marker loader"),
      systemIncludesBody: spec.system.includes("ECHO_MARKER_560"),
      systemIncludesReference: spec.system.includes("CHECK_MARKER_560"),
      systemIncludesScript: spec.system.includes("SCRIPT_MARKER_560"),
      loaded,
      readReference,
      readScript,
      unknownRejected,
      unknownFileRejected,
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
    assert.deepEqual(output.toolNames, ["load_skill", "read_skill_file"]);
    assert.equal(output.systemIncludesAdvert, true);
    assert.equal(output.systemIncludesDescription, true);
    assert.equal(output.systemIncludesBody, false);
    assert.equal(output.systemIncludesReference, false);
    assert.equal(output.systemIncludesScript, false);
    assert.equal(output.loaded.name, "echo");
    assert.equal(output.loaded.description, "Echo marker loader");
    assert.equal(output.loaded.text, "ECHO_MARKER_560");
    assert.deepEqual(output.loaded.files, [
      {
        path: "references/checklist.md",
        digest: digestText("CHECK_MARKER_560"),
        bytes: 16,
      },
      {
        path: "scripts/audit.sh",
        digest: digestText("SCRIPT_MARKER_560"),
        bytes: 17,
      },
    ]);
    assert.equal(JSON.stringify(output.loaded).includes("CHECK_MARKER_560"), false);
    assert.equal(JSON.stringify(output.loaded).includes("SCRIPT_MARKER_560"), false);
    assert.deepEqual(output.readReference, {
      name: "echo",
      path: "references/checklist.md",
      digest: digestText("CHECK_MARKER_560"),
      text: "CHECK_MARKER_560",
    });
    assert.deepEqual(output.readScript, {
      name: "echo",
      path: "scripts/audit.sh",
      digest: digestText("SCRIPT_MARKER_560"),
      text: "SCRIPT_MARKER_560",
    });
    assert.equal(output.unknownRejected, true);
    assert.equal(output.unknownFileRejected, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test("agentos build rejects unsafe packaged skill supporting files from the filesystem", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "agentos-skill-package-negative-"));
  try {
    writeFileSync(path.join(root, "package.json"), JSON.stringify({ type: "module" }, null, 2));
    mkdirSync(path.join(root, "agent/skills/review/references"), { recursive: true });
    mkdirSync(path.join(root, "agent/skills/review/scripts"), { recursive: true });
    writeFileSync(path.join(root, "agent/instructions.md"), "Answer with authored skills.");
    writeFileSync(
      path.join(root, "agent/skills/review/SKILL.md"),
      "---\nname: review\ndescription: Review output carefully\n---\nReview carefully.",
    );
    writeFileSync(path.join(root, "agent/skills/review/references/checklist.md"), "Check claims.");
    writeFileSync(path.join(root, "agent/skills/review/scripts/audit.sh"), "echo audit");
    writeFileSync(path.join(root, "unsafe-target.md"), "Unsafe.");
    symlinkSync(
      path.join(root, "unsafe-target.md"),
      path.join(root, "agent/skills/review/references/link.md"),
    );
    writeFileSync(
      path.join(root, "agent/agent.json"),
      JSON.stringify(
        {
          agentId: "skill-package-negative",
          scope: {
            kind: "session",
            idSource: "manifest",
            stableScopeId: "skill-package-negative-scope",
          },
          effectAuthorityRef: {
            authorityId: "skill-package-negative",
            proofClass: "test",
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
        '  "deployment": { "id": "skill-package-negative", "version": "0.1.0" },',
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
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /symlink_forbidden/);
    assert.match(result.stderr, /skills\/review\/references\/link\.md/);
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
