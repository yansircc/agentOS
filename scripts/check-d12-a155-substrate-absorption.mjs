#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

const read = (root, rel) => fs.readFileSync(path.join(root, rel), "utf8");

const requiredTerms = [
  {
    file: "packages/runtime-protocol/src/manifest.ts",
    terms: [
      "export interface AgentManifest",
      "export type HandlerKind",
      "export interface AgentScopeIdentityPolicy",
      "readonly llmRoutes?: Readonly<Record<string, AgentLlmRouteBindingRef>>",
      "readonly tools?: Readonly<Record<string, AgentToolBindingRef>>",
      "readonly materials?: Readonly<Record<string, MaterialRef>>",
    ],
  },
  {
    file: "packages/runtime-protocol/src/bindings.ts",
    terms: [
      "export interface AgentBindings",
      "export interface AgentSubmitBindings",
      "export const defineAgentSubmitBindings",
    ],
  },
  {
    file: "packages/runtime-protocol/src/mount.ts",
    terms: [
      "export const validateAgentMount",
      'kind: "function_in_manifest"',
      'kind: "missing_handler_binding"',
      'kind: "dead_handler_binding"',
    ],
  },
  {
    file: "packages/runtime-protocol/src/intent.ts",
    terms: [
      "export interface AgentIntent",
      "AGENT_INTENT_EVENT_KINDS",
      "AGENT_SETTLEMENT_EVENT_KINDS",
      "validateIntentSettlementVocabulary",
    ],
  },
  {
    file: "packages/backends/cloudflare-do/src/agent-do.ts",
    terms: [
      "readonly bindings?: AgentSubmitBindings",
      "protected submitWithBindings",
      "mergeSubmitBindings",
    ],
  },
  {
    file: "packages/backends/cloudflare-do/src/facade.ts",
    terms: ["readonly manifest?: AgentManifest", "readonly agentBindings?: AgentBindings"],
  },
  {
    file: "packages/runtime/src/projection.ts",
    terms: [
      "export interface ProjectionWaitSpec",
      "export class ProjectionWaitTimedOut",
      "export const waitForProjection",
      "MaterializedProjections",
    ],
  },
  {
    file: "packages/kernel/src/tools.ts",
    terms: [
      "export interface ToolExternalReadRequirement",
      "export interface ToolExternalWriteRequirement",
      "export type ToolRequirements = ToolExternalReadRequirement | ToolExternalWriteRequirement",
      "export type ToolEffect<R, Requirements = never>",
      "readonly [TOOL_EXTERNAL_REQUIREMENT_BRAND]: Requirements",
      "export type ToolExecutionRequirements<E extends ToolExecution>",
      "export const withToolReadRequirement",
      "export const withToolWriteRequirement",
      "readonly emitIntent?: ToolIntentEmitter",
      "readonly awaitProjection?: ToolProjectionWaiter",
      ") => Effect.Effect<AdmitVerdict, ToolError, never>",
    ],
  },
  {
    file: "packages/runtime-protocol/src/submit.ts",
    terms: ["export interface SubmitToolIntent", "readonly toolIntents?: ReadonlyArray"],
  },
  {
    file: "packages/backends/protocol/src/index.ts",
    terms: [
      "idempotencyKey",
      "deliveryReceipt",
      "export interface DispatchReplaySnapshot",
      "dispatchReceiptBeforeTerminalProof",
      "replayDispatchDeliveryFromSnapshot",
    ],
  },
  {
    file: "packages/llm-protocol/src/index.ts",
    terms: [
      "export interface LlmCallSnapshot",
      "LlmWireDescriptor",
      "llmWireDescriptorFingerprint",
    ],
  },
  {
    file: "packages/runtime-protocol/src/runtime-events.ts",
    terms: ["export interface ToolResultSnapshot", "replayToolResultFromSnapshot"],
  },
  {
    file: "packages/telemetry-protocol/src/index.ts",
    terms: [
      "export interface TelemetryEventTree",
      "canonicalizeTelemetryEventTree",
      "canonicalTelemetryEventTreeJson",
    ],
  },
  {
    file: "scripts/check-tool-mutation-boundary.mjs",
    terms: [
      "ToolRequirements must be external access only",
      "ToolAdmitter requirements must be never",
      "ToolExecute must return access-derived ToolEffect",
      "tool emitted mutation lifecycle fact",
    ],
  },
  {
    file: "scripts/check-backend-neutral-mutation-golden.mjs",
    terms: [
      "tool/UI input must emit typed Intent only",
      "candidate lifecycle must be carrier settlement",
      "dispatch terminal fact must be backed by external delivery receipt",
    ],
  },
];

const obsoletePatterns = [
  /context\.emitIntent/u,
  /_submitDefaults/u,
  /submitWithDefaults/u,
  /@agent-os\/kernel\/(?:llm|trace-context)/u,
];

const productLeakPatterns = [
  new RegExp(["Surface", "Program"].join(""), "u"),
  new RegExp(["Word", "Press"].join(""), "u"),
  new RegExp(["wp", "posts"].join("_"), "u"),
  new RegExp(`${["zeroy", "surface_edit"].join("\\.")}`, "u"),
  new RegExp(`${["mutation", "(?:proposed|settled)"].join("\\.")}`, "u"),
  new RegExp(`${["state", "transitioned"].join("\\.")}`, "u"),
  new RegExp(`${["entity", "updated"].join("\\.")}`, "u"),
];

const scanRoots = [
  "packages/kernel/src",
  "packages/runtime-protocol/src",
  "packages/runtime/src",
  "packages/backends/cloudflare-do/src",
  "packages/backends/protocol/src",
  "packages/composers",
  "packages/transports",
  "packages/wire-adapters",
];

const ignoredDirs = new Set(["node_modules", "dist", ".wrangler", ".git"]);
const sourceExtensions = /\.(?:ts|tsx|mts|cts|mjs|json)$/u;

const repoPath = (root, file) => path.relative(root, file).split(path.sep).join("/");

const sourceFiles = (root, dirs) => {
  const files = [];
  const visit = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!ignoredDirs.has(entry.name)) visit(file);
        continue;
      }
      if (sourceExtensions.test(entry.name) && !entry.name.endsWith(".d.ts")) files.push(file);
    }
  };
  for (const dir of dirs) visit(path.join(root, dir));
  return files.sort((left, right) => left.localeCompare(right));
};

const lineNumber = (source, index) => source.slice(0, index).split("\n").length;

const requiredTermFailures = (root) => {
  const failures = [];
  for (const requirement of requiredTerms) {
    const source = read(root, requirement.file);
    for (const term of requirement.terms) {
      if (!source.includes(term)) {
        failures.push(`${requirement.file}: missing D12/a155 absorption term ${term}`);
      }
    }
  }
  return failures;
};

const sourceScanFailures = (root) => {
  const failures = [];
  for (const file of sourceFiles(root, scanRoots)) {
    const source = fs.readFileSync(file, "utf8");
    const rel = repoPath(root, file);
    for (const pattern of obsoletePatterns) {
      const match = source.match(pattern);
      if (match !== null) {
        failures.push(
          `${rel}:${lineNumber(source, match.index ?? 0)}: obsolete a155 shape ${match[0]}`,
        );
      }
    }
    for (const pattern of productLeakPatterns) {
      const match = source.match(pattern);
      if (match !== null) {
        failures.push(
          `${rel}:${lineNumber(source, match.index ?? 0)}: product mutation/resource vocabulary leaked into substrate ${match[0]}`,
        );
      }
    }
  }
  return failures;
};

const packageGateFailures = (root) => {
  const pkg = JSON.parse(read(root, "package.json"));
  const scripts = pkg.scripts ?? {};
  const failures = [];
  const expected =
    "node scripts/check-d12-a155-substrate-absorption.mjs --self-test && node scripts/check-d12-a155-substrate-absorption.mjs";
  const aggregateExpected =
    "node scripts/check-substrate-consumer-guards.mjs --self-test && node scripts/check-substrate-consumer-guards.mjs";
  const check = scripts.check;
  const directRootCheck =
    typeof check === "string" && check.includes("bun run test:d12-a155-substrate-absorption");
  const aggregateRootCheck =
    typeof check === "string" &&
    check.includes("bun run test:substrate-consumer-guards") &&
    scripts["test:substrate-consumer-guards"] === aggregateExpected;
  if (scripts["test:d12-a155-substrate-absorption"] !== expected) {
    failures.push("package.json: missing canonical test:d12-a155-substrate-absorption script");
  }
  if (!directRootCheck && !aggregateRootCheck) {
    failures.push(
      "package.json: root check must include test:d12-a155-substrate-absorption directly or through test:substrate-consumer-guards",
    );
  }
  return failures;
};

const goldenFailures = (root) => {
  const failures = [];
  const mutation = JSON.parse(read(root, "test/backend-neutral-mutation-golden.json"));
  if (!Array.isArray(mutation)) {
    failures.push("test/backend-neutral-mutation-golden.json: expected array");
  } else {
    const toolStep = mutation.find((step) => step.phase === "tool_intent");
    const carrierStep = mutation.find((step) => step.phase === "carrier_settlement");
    const dispatchStep = mutation.find((step) => step.phase === "dispatch_terminal");
    if (toolStep?.actor !== "tool" || !String(toolStep?.eventKind).startsWith("agent.intent.")) {
      failures.push(
        "test/backend-neutral-mutation-golden.json: tool phase must be agent intent only",
      );
    }
    if (
      carrierStep?.actor !== "carrier" ||
      !String(carrierStep?.eventKind).includes("candidate_lived")
    ) {
      failures.push(
        "test/backend-neutral-mutation-golden.json: candidate lifecycle must be carrier-owned",
      );
    }
    if (
      dispatchStep?.actor !== "dispatch" ||
      dispatchStep.deliveryReceipt?.anchorKind !== "external_receipt" ||
      typeof dispatchStep.idempotencyKey !== "string"
    ) {
      failures.push(
        "test/backend-neutral-mutation-golden.json: apply terminal must be dispatch receipt-owned",
      );
    }
  }

  for (const fixture of [
    "test/backend-neutral-replay.json",
    "test/backend-neutral-telemetry.json",
  ]) {
    const parsed = JSON.parse(read(root, fixture));
    const text = JSON.stringify(parsed);
    if (!text.includes("cloudflare-do") || !text.includes("node-postgres")) {
      failures.push(`${fixture}: must cover both production backends`);
    }
  }
  return failures;
};

const collectFailures = (root = repoRoot) => [
  ...requiredTermFailures(root),
  ...sourceScanFailures(root),
  ...packageGateFailures(root),
  ...goldenFailures(root),
];

const writeFixture = (root, rel, source) => {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, source);
};

const positivePackageJson = {
  scripts: {
    "test:d12-a155-substrate-absorption":
      "node scripts/check-d12-a155-substrate-absorption.mjs --self-test && node scripts/check-d12-a155-substrate-absorption.mjs",
    "test:substrate-consumer-guards":
      "node scripts/check-substrate-consumer-guards.mjs --self-test && node scripts/check-substrate-consumer-guards.mjs",
    check: "bun run test:substrate-consumer-guards",
  },
};

const writePositiveFixture = (root) => {
  for (const requirement of requiredTerms) {
    writeFixture(root, requirement.file, requirement.terms.join("\n"));
  }
  writeFixture(root, "package.json", JSON.stringify(positivePackageJson));
  writeFixture(
    root,
    "test/backend-neutral-mutation-golden.json",
    JSON.stringify([
      {
        phase: "tool_intent",
        actor: "tool",
        eventKind: "agent.intent.submitted",
      },
      {
        phase: "carrier_settlement",
        actor: "carrier",
        eventKind: "example_product.surface_edit.candidate_lived",
      },
      {
        phase: "dispatch_terminal",
        actor: "dispatch",
        eventKind: "dispatch.outbound.delivered",
        idempotencyKey: "apply/example/1",
        deliveryReceipt: { anchorKind: "external_receipt" },
      },
    ]),
  );
  writeFixture(
    root,
    "test/backend-neutral-replay.json",
    JSON.stringify({ backends: ["cloudflare-do", "node-postgres"] }),
  );
  writeFixture(
    root,
    "test/backend-neutral-telemetry.json",
    JSON.stringify({ backends: ["cloudflare-do", "node-postgres"] }),
  );
};

const collectSelfTestFailures = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentos-d12-a155-"));
  try {
    writePositiveFixture(root);
    const baseline = collectFailures(root);
    if (baseline.length > 0) {
      return [`D12/a155 absorption positive fixture failed:\n${baseline.join("\n")}`];
    }

    const cases = [
      {
        name: "obsolete submit defaults",
        file: "packages/backends/cloudflare-do/src/agent-do.ts",
        mutate: (source) => `${source}\nconst _submitDefaults = {};\n`,
        expected: "obsolete a155 shape",
      },
      {
        name: "product resource leak",
        file: "packages/runtime-protocol/src/manifest.ts",
        mutate: (source) =>
          `${source}\nexport interface Leaked { readonly surface: ${["Surface", "Program"].join(
            "",
          )} }\n`,
        expected: "product mutation/resource vocabulary",
      },
      {
        name: "missing root check gate",
        file: "package.json",
        mutate: () =>
          JSON.stringify({ scripts: { ...positivePackageJson.scripts, check: "bun run test" } }),
        expected: "root check must include",
      },
      {
        name: "missing aggregate script",
        file: "package.json",
        mutate: () => {
          const scripts = { ...positivePackageJson.scripts };
          delete scripts["test:substrate-consumer-guards"];
          return JSON.stringify({ scripts });
        },
        expected: "root check must include",
      },
      {
        name: "tool direct settlement",
        file: "test/backend-neutral-mutation-golden.json",
        mutate: () =>
          JSON.stringify([
            {
              phase: "tool_intent",
              actor: "tool",
              eventKind: "example_product.surface_edit.apply_lived",
            },
          ]),
        expected: "tool phase must be agent intent only",
      },
    ];

    const failures = [];
    for (const testCase of cases) {
      const target = path.join(root, testCase.file);
      const original = fs.readFileSync(target, "utf8");
      fs.writeFileSync(target, testCase.mutate(original));
      const rejected = collectFailures(root);
      if (!rejected.some((failure) => failure.includes(testCase.expected))) {
        failures.push(
          `${testCase.name}: mutation fixture was not rejected; failures=${JSON.stringify(
            rejected,
          )}`,
        );
      }
      fs.writeFileSync(target, original);
      const restored = collectFailures(root);
      if (restored.length > 0) {
        failures.push(`${testCase.name}: restored fixture failed:\n${restored.join("\n")}`);
      }
    }
    return failures;
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
    ? "D12/a155 substrate absorption self-test passed"
    : "D12/a155 substrate absorption passed",
);
