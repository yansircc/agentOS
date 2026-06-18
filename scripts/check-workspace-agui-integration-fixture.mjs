#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

const files = {
  agui: "packages/wire-adapters/ag-ui/src/index.ts",
  aguiPackage: "packages/wire-adapters/ag-ui/package.json",
  fixture: "packages/wire-adapters/ag-ui/test/workspace-agui-integration.test.ts",
  cloudflareDo: "packages/backends/cloudflare-do/src/agent-do.ts",
  runtimeProtocol: "packages/runtime-protocol/src/submit.ts",
};

const read = (root, file) => fs.readFileSync(path.join(root, file), "utf8");
const readJson = (root, file) => JSON.parse(read(root, file));

const requireTerms = (failures, source, file, terms) => {
  for (const term of terms) {
    if (!source.includes(term)) failures.push(`${file}: missing ${term}`);
  }
};

const rejectPatterns = (failures, source, file, patterns) => {
  for (const [pattern, description] of patterns) {
    if (pattern.test(source)) failures.push(`${file}: ${description}`);
  }
};

const collectFailures = (root = repoRoot) => {
  const failures = [];
  const agui = read(root, files.agui);
  const fixture = read(root, files.fixture);
  const cloudflareDo = read(root, files.cloudflareDo);
  const runtimeProtocol = read(root, files.runtimeProtocol);
  const aguiPackage = readJson(root, files.aguiPackage);

  requireTerms(failures, agui, files.agui, [
    "agUiRunAgentInputToSubmitInput",
    "defaults.toolContext",
  ]);

  rejectPatterns(failures, agui, files.agui, [
    [
      /defaults\.(?:executionDomains|toolIntents|receiptBackedTools)/u,
      "AG-UI adapter owns framework binding facts instead of SubmitRunInput",
    ],
  ]);

  requireTerms(failures, runtimeProtocol, files.runtimeProtocol, [
    "mergeSubmitToolContext(spec.bindings.toolContext, spec.input.toolContext)",
    "spec.bindings.executionDomains",
    "spec.bindings.toolIntents",
    "spec.bindings.receiptBackedTools",
  ]);

  requireTerms(failures, cloudflareDo, files.cloudflareDo, [
    "lowerSubmitRunInput({",
    "...baseBindings",
    "toolIntents: [...this._toolIntents, ...(baseBindings.toolIntents ?? [])]",
  ]);

  requireTerms(failures, fixture, files.fixture, [
    "makeCloudflareWorkspaceEnv",
    "bindWorkspaceToolsForRuntime",
    "createWorkspaceOperationLocalProvider",
    "agUiRunAgentInputToSubmitInput",
    "lowerSubmitRunInput",
    "projectLedgerEventsToAgUiFrames",
    "projectFailureDiagnostics",
    "verifyAgUiFrameSafety",
    'exposure: ["read", "mutation"]',
    'mutationPolicy: "receipt-backed"',
    "receiptBackedTools: bindings.receiptBackedTools",
    "WORKSPACE_OP_KIND.REQUESTED",
    "WORKSPACE_OP_PROJECTION_KIND",
    "WORKSPACE_OP_FACT_OWNER",
    "projectWorkspaceOperation(workspaceEvents, 7)",
    "receiptBackedToolResultFromUnknown",
    "settleToolExecuted(readClaim, readTool.contract)",
    "READ_SECRET",
    "WRITE_SECRET",
    "UI_SECRET",
    "EXTERNAL_TOOL_EXECUTION_REQUIRES_RECEIPT_REASON",
    'category: "missing_execution_path"',
  ]);

  rejectPatterns(failures, fixture, files.fixture, [
    [
      /externalExecutor|effectfulExecutor|pathPolicy/u,
      "fixture uses forbidden local bridge vocabulary",
    ],
    [/payload\.(?:result|args|content)/u, "fixture parses raw runtime payload fields"],
    [/content:\s*readResult\.content/u, "fixture projects raw read content to AG-UI"],
  ]);

  for (const dep of ["@agent-os/workspace-job", "@agent-os/workspace-op"]) {
    if (aguiPackage.dependencies?.[dep] !== "workspace:*") {
      failures.push(`${files.aguiPackage}: missing dependency ${dep}`);
    }
  }

  for (const dep of [
    "@agent-os/workspace-binding",
    "@agent-os/workspace-env-cloudflare",
    "@agent-os/workspace-op-local",
  ]) {
    if (aguiPackage.devDependencies?.[dep] !== "workspace:*") {
      failures.push(`${files.aguiPackage}: missing devDependency ${dep}`);
    }
  }

  return failures;
};

const writeFixture = (root, relativePath, source) => {
  const file = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, source);
};

const positiveFixtures = {
  [files.agui]: `
export const agUiRunAgentInputToSubmitInput = (input, defaults) => ({
  toolContext: defaults.toolContext,
});
`,
  [files.runtimeProtocol]: `
const toolContext = mergeSubmitToolContext(spec.bindings.toolContext, spec.input.toolContext);
export const lowerSubmitRunInput = (spec) => ({
  executionDomains: spec.bindings.executionDomains,
  toolIntents: spec.bindings.toolIntents,
  receiptBackedTools: spec.bindings.receiptBackedTools,
});
`,
  [files.cloudflareDo]: `
this.submitFull(
  lowerSubmitRunInput({
    bindings: {
      ...baseBindings,
      toolIntents: [...this._toolIntents, ...(baseBindings.toolIntents ?? [])],
    },
  }),
);
`,
  [files.fixture]: `
makeCloudflareWorkspaceEnv();
bindWorkspaceToolsForRuntime({
  exposure: ["read", "mutation"],
  mutationPolicy: "receipt-backed",
});
createWorkspaceOperationLocalProvider();
const submitInput = agUiRunAgentInputToSubmitInput(input, {
  receiptBackedTools: bindings.receiptBackedTools,
});
lowerSubmitRunInput({ input: submitInput });
projectLedgerEventsToAgUiFrames();
projectFailureDiagnostics();
verifyAgUiFrameSafety();
WORKSPACE_OP_KIND.REQUESTED;
WORKSPACE_OP_PROJECTION_KIND;
WORKSPACE_OP_FACT_OWNER;
projectWorkspaceOperation(workspaceEvents, 7);
receiptBackedToolResultFromUnknown();
settleToolExecuted(readClaim, readTool.contract);
READ_SECRET;
WRITE_SECRET;
UI_SECRET;
EXTERNAL_TOOL_EXECUTION_REQUIRES_RECEIPT_REASON;
const expected = { category: "missing_execution_path" };
`,
  [files.aguiPackage]: JSON.stringify({
    dependencies: {
      "@agent-os/workspace-job": "workspace:*",
      "@agent-os/workspace-op": "workspace:*",
    },
    devDependencies: {
      "@agent-os/workspace-binding": "workspace:*",
      "@agent-os/workspace-env-cloudflare": "workspace:*",
      "@agent-os/workspace-op-local": "workspace:*",
    },
  }),
};

const collectSelfTestFailures = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentos-workspace-agui-fixture-"));
  try {
    for (const [file, source] of Object.entries(positiveFixtures)) {
      writeFixture(root, file, source);
    }
    const baseline = collectFailures(root);
    if (baseline.length > 0) {
      return [`workspace AG-UI integration positive fixture failed:\n${baseline.join("\n")}`];
    }

    writeFixture(
      root,
      files.runtimeProtocol,
      positiveFixtures[files.runtimeProtocol].replace("spec.bindings.receiptBackedTools", ""),
    );
    let rejected = collectFailures(root);
    if (!rejected.some((failure) => failure.includes("spec.bindings.receiptBackedTools"))) {
      return [
        `missing runtime-protocol receipt-backed pass-through was not rejected: ${JSON.stringify(
          rejected,
        )}`,
      ];
    }

    writeFixture(root, files.agui, positiveFixtures[files.agui]);
    writeFixture(
      root,
      files.fixture,
      `${positiveFixtures[files.fixture]}\nconst leak = payload.content;`,
    );
    rejected = collectFailures(root);
    if (!rejected.some((failure) => failure.includes("raw runtime payload"))) {
      return [`raw payload mutation was not rejected: ${JSON.stringify(rejected)}`];
    }

    writeFixture(root, files.fixture, positiveFixtures[files.fixture]);
    writeFixture(
      root,
      files.cloudflareDo,
      "this.submitFull(lowerSubmitRunInput({ bindings: { toolIntents: [] } }));",
    );
    rejected = collectFailures(root);
    if (!rejected.some((failure) => failure.includes("...baseBindings"))) {
      return [
        `Cloudflare base binding pass-through mutation was not rejected: ${JSON.stringify(
          rejected,
        )}`,
      ];
    }

    return [];
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
};

const failures = process.argv.includes("--self-test")
  ? collectSelfTestFailures()
  : collectFailures(repoRoot);

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(
  process.argv.includes("--self-test")
    ? "workspace AG-UI integration fixture self-test passed"
    : "workspace AG-UI integration fixture passed",
);
