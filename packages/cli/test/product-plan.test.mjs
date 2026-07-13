import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { buildSync } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const runTypeScript = (source) => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "agentos-product-plan-"));
  try {
    const outfile = path.join(tempDir, "entry.mjs");
    buildSync({
      stdin: {
        contents: source,
        loader: "ts",
        resolveDir: repoRoot,
        sourcefile: "product-plan-entry.ts",
      },
      outfile,
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node22",
      external: ["cloudflare:*"],
      logLevel: "silent",
    });
    return spawnSync(process.execPath, [outfile], { cwd: repoRoot, encoding: "utf8" });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
};

const compileProbe = () =>
  runTypeScript(`
import {
  compileProductPlan,
  verifyProductPlanDigest,
} from "./packages/cli/src/build/agent-authoring.ts";

const instructions = {
  path: "agent/instructions.md",
  kind: "markdown" as const,
  text: "Help the user with precise answers.\\n",
};
const agent = (value: Record<string, unknown>) => ({
  path: "agent/agent.json",
  kind: "json" as const,
  value,
});
const conventionAssets = [
  {
    path: "agent/tools/echo.ts",
    kind: "tool" as const,
    declaration: {
      executionDomain: "app-runtime",
      interaction: "never",
      materialRefs: ["model-input"],
      effects: ["provider_call"],
      receiptPolicy: "record",
    },
  },
  {
    path: "agent/skills/research/SKILL.md",
    kind: "markdown" as const,
    text: "---\\nname: research\\ndescription: Research a topic.\\n---\\nResearch carefully.\\n",
    sourceKind: "regular" as const,
  },
  {
    path: "agent/instructions/tone.md",
    kind: "markdown" as const,
    text: "Use a direct tone.\\n",
    sourceKind: "regular" as const,
  },
  {
    path: "agent/skills/session.dynamic.ts",
    kind: "dynamic" as const,
    declaration: { outputs: { skills: ["research"] } },
    sourceKind: "regular" as const,
  },
  {
    path: "agent/channels/github.ts",
    kind: "channel" as const,
    sourceKind: "regular" as const,
  },
  {
    path: "workflows/report.ts",
    kind: "workflow" as const,
    sourceKind: "regular" as const,
  },
  {
    path: "agent/schedules/daily.ts",
    kind: "schedule" as const,
    declaration: { cron: "0 * * * *", handler: () => undefined },
    sourceKind: "regular" as const,
  },
];

const validFiles = [
  instructions,
  agent({
    agentId: "answerer",
    kind: "chat",
    model: "fast-reasoning",
    tools: ["echo"],
  }),
  ...conventionAssets,
];
const valid = compileProductPlan({ files: validFiles });
const reordered = compileProductPlan({ files: [...validFiles].reverse() });
const verification = valid.ok
  ? {
      valid: verifyProductPlanDigest(valid.value),
      semanticMutation: verifyProductPlanDigest({
        ...valid.value,
        agent: { ...valid.value.agent, id: "tampered" },
      }),
      provenanceMutation: verifyProductPlanDigest({
        ...valid.value,
        provenance: { ...valid.value.provenance, "/probe": "path:probe" },
      }),
      originMutation: verifyProductPlanDigest({
        ...valid.value,
        assets: {
          ...valid.value.assets,
          tools: valid.value.assets.tools.map((tool) => ({ ...tool, origin: "path:elsewhere" })),
        },
      }),
    }
  : null;

const legacyFields = [
  "version",
  "scope",
  "effectAuthorityRef",
  "handlers",
  "capabilities",
  "llmRoutes",
  "materials",
  "executionDomains",
  "interactions",
];
const legacy = Object.fromEntries(
  legacyFields.map((field) => [
    field,
    compileProductPlan({
      files: [instructions, agent({ agentId: "legacy", kind: "chat", [field]: {} })],
    }),
  ]),
);
const invalid = {
  missingAgentId: compileProductPlan({ files: [instructions, agent({ kind: "chat" })] }),
  missingKind: compileProductPlan({ files: [instructions, agent({ agentId: "missing-kind" })] }),
  invalidKind: compileProductPlan({
    files: [instructions, agent({ agentId: "bad-kind", kind: "workspace@1" })],
  }),
  objectTools: compileProductPlan({
    files: [instructions, agent({ agentId: "object-tools", kind: "chat", tools: {} })],
  }),
  duplicateTools: compileProductPlan({
    files: [instructions, agent({ agentId: "duplicate-tools", kind: "chat", tools: ["echo", "echo"] })],
  }),
  unknownTool: compileProductPlan({
    files: [instructions, agent({ agentId: "unknown-tool", kind: "chat", tools: ["missing"] })],
  }),
  authoredBindingRef: compileProductPlan({
    files: [
      instructions,
      agent({ agentId: "binding-ref", kind: "chat", tools: ["echo"] }),
      {
        path: "agent/tools/echo.ts",
        kind: "tool" as const,
        declaration: { bindingRef: "custom-binding" },
      },
    ],
  }),
  excludedDynamicTool: compileProductPlan({
    files: [
      instructions,
      agent({ agentId: "dynamic-selection", kind: "chat", tools: ["echo"] }),
      { path: "agent/tools/echo.ts", kind: "tool" as const },
      { path: "agent/tools/other.ts", kind: "tool" as const },
      {
        path: "agent/tools/session.dynamic.ts",
        kind: "dynamic" as const,
        declaration: { outputs: { tools: ["other"] } },
      },
    ],
  }),
};

const workspaceBuiltin = "bash";
const workspace = {
  builtinSelection: compileProductPlan({
    files: [
      instructions,
      agent({ agentId: "workspace-builtin", kind: "workspace", tools: [workspaceBuiltin] }),
    ],
  }),
  authoredBuiltinCollision: compileProductPlan({
    files: [
      instructions,
      agent({ agentId: "workspace-collision", kind: "workspace" }),
      { path: "agent/tools/" + workspaceBuiltin + ".ts", kind: "tool" as const },
    ],
  }),
};

console.log(JSON.stringify({ valid, reordered, verification, legacy, invalid, workspace }));
`);

const issue = (result, kind, field, reason) => {
  assert.equal(result.ok, false);
  assert.ok(
    result.issues.some(
      (candidate) =>
        candidate.kind === kind &&
        (field === undefined || candidate.field === field) &&
        (reason === undefined || candidate.reason === reason),
    ),
    JSON.stringify(result.issues),
  );
};

test("compileProductPlan closes authored product facts into a deterministic backend-neutral plan", () => {
  const result = compileProbe();
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.valid.ok, true, JSON.stringify(output.valid));
  assert.equal(output.reordered.ok, true, JSON.stringify(output.reordered));

  const plan = output.valid.value;
  assert.deepEqual(plan.agent, { id: "answerer", kind: "chat" });
  assert.deepEqual(plan.instructions, {
    path: "agent/instructions.md",
    text: "Help the user with precise answers.\n",
    digest: "fnv1a32:42bfb82a:36",
  });
  assert.equal(plan.modelPreference, "fast-reasoning");
  assert.deepEqual(plan.toolSelection, ["echo"]);
  assert.deepEqual(plan.symbolicRequirements, [
    { kind: "execution-domain", ref: "app-runtime", tool: "echo" },
    { kind: "interaction", ref: "never", tool: "echo" },
    { kind: "material", ref: "model-input", tool: "echo" },
    { kind: "model" },
  ]);
  assert.deepEqual(plan.assets.tools, [
    {
      name: "echo",
      path: "agent/tools/echo.ts",
      origin: "path:agent/tools/echo.ts",
      effects: ["provider_call"],
      materialRefs: ["model-input"],
      executionDomain: "app-runtime",
      interaction: "never",
      receiptPolicy: "record",
    },
  ]);
  assert.deepEqual(
    plan.assets.channels.map(({ name, path }) => ({ name, path })),
    [{ name: "github", path: "agent/channels/github.ts" }],
  );
  assert.deepEqual(
    plan.assets.workflows.map(({ name, path }) => ({ name, path })),
    [{ name: "report", path: "workflows/report.ts" }],
  );
  assert.deepEqual(
    plan.assets.schedules.map(({ scheduleId, path }) => ({ scheduleId, path })),
    [{ scheduleId: "daily", path: "agent/schedules/daily.ts" }],
  );
  assert.deepEqual(
    plan.assets.skills.map(({ name }) => name),
    ["research"],
  );
  assert.deepEqual(
    plan.assets.instructionFragments.map(({ fragmentId }) => fragmentId),
    ["tone"],
  );
  assert.deepEqual(
    plan.assets.dynamicResolvers.map(({ resolverId, slot }) => ({ resolverId, slot })),
    [{ resolverId: "session", slot: "skills" }],
  );
  assert.match(plan.productDigest, /^fnv1a32:/u);
  assert.equal(plan.productDigest, output.reordered.value.productDigest);
  assert.deepEqual(plan, output.reordered.value);
  assert.deepEqual(output.verification, {
    valid: true,
    semanticMutation: false,
    provenanceMutation: true,
    originMutation: true,
  });

  const forbiddenKeys = new Set([
    "manifest",
    "scope",
    "scopeRef",
    "effectAuthorityRef",
    "authority",
    "deployment",
    "target",
    "client",
    "provider",
    "workspaceRoot",
    "workspaceTopology",
    "correlation",
  ]);
  const visit = (value) => {
    if (value === null || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      assert.equal(forbiddenKeys.has(key), false, `forbidden ProductPlan key ${key}`);
      visit(child);
    }
  };
  visit(plan);
});

test("compileProductPlan rejects legacy substrate facts and invalid closed ProductIntent shapes", () => {
  const result = compileProbe();
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  for (const [field, rejected] of Object.entries(output.legacy)) {
    issue(rejected, "unknown_field", field);
  }
  issue(output.invalid.missingAgentId, "invalid_authored_value", "/agentId", "required");
  issue(output.invalid.missingKind, "invalid_authored_value", "/kind", "required");
  issue(output.invalid.invalidKind, "invalid_authored_value", "/kind", "product_kind_invalid");
  issue(output.invalid.objectTools, "invalid_authored_value", "/tools", "string_array_required");
  issue(output.invalid.duplicateTools, "invalid_authored_value", "/tools/1", "duplicate_value");
  issue(output.invalid.unknownTool, "unknown_product_tool", "/tools/0", "tool_not_found");
  issue(output.invalid.authoredBindingRef, "unknown_field", "bindingRef");
  issue(output.invalid.excludedDynamicTool, "dynamic_resolver_unknown_target");
  assert.equal(output.workspace.builtinSelection.ok, true, JSON.stringify(output.workspace));
  issue(output.workspace.authoredBuiltinCollision, "reserved_tool_name");
});

test("the public compiler surface has no compileAgentTree compatibility alias", () => {
  const authoring = readFileSync(
    path.join(repoRoot, "packages/cli/src/build/agent-authoring.ts"),
    "utf8",
  );
  const publicRoot = readFileSync(path.join(repoRoot, "packages/cli/src/index.ts"), "utf8");
  assert.match(authoring, /compileProductPlan/u);
  assert.match(publicRoot, /compileProductPlan/u);
  assert.doesNotMatch(authoring, /compileAgentTree/u);
  assert.doesNotMatch(publicRoot, /compileAgentTree/u);
});
