#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const repoRoot = process.cwd();
const sourceExtensions = /\.(?:ts|tsx|mts|cts)$/u;
const ignoredDirs = new Set(["node_modules", "dist", ".wrangler", ".turbo", ".git"]);

const toRepoPath = (root, file) => path.relative(root, file).split(path.sep).join("/");

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

const sourceFiles = (root) => {
  const files = [];
  const visit = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!ignoredDirs.has(entry.name)) visit(file);
        continue;
      }
      if (sourceExtensions.test(entry.name) && !entry.name.endsWith(".d.ts")) {
        const repoPath = toRepoPath(root, file);
        if (repoPath.split("/").includes("src")) files.push(file);
      }
    }
  };
  for (const sourceRoot of ["packages", "tooling"]) visit(path.join(root, sourceRoot));
  return files.sort((left, right) => left.localeCompare(right));
};

const lineNumber = (source, index) => source.slice(0, index).split("\n").length;

const importSpecifiers = (source) => {
  const specifiers = [];
  const patterns = [
    /\b(?:import|export)\s+(?:type\s+)?(?:[^"'()]*?\s+from\s+)?["']([^"']+)["']/gu,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/gu,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      specifiers.push({ value: match[1], index: match.index ?? 0 });
    }
  }
  return specifiers;
};

const importMatches = (specifier, forbidden) =>
  specifier === forbidden || specifier.startsWith(`${forbidden}/`);

const regexForToken = (token) => new RegExp(token, "gu");

const pathStarts = (prefix) => (repoPath) => repoPath.startsWith(prefix);
const pathMatches = (pattern) => (repoPath) => pattern.test(repoPath);

const packageJson = (root) => {
  const file = path.join(root, "package.json");
  return fs.existsSync(file) ? readJson(file) : {};
};

const activeStages = (root, extraStages) => {
  const manifest = packageJson(root);
  const status = manifest.agentos?.backendNeutralityStatus;
  const configured = manifest.agentos?.boundaryGuard?.activeStages;
  const stages = new Set(
    Array.isArray(configured) && configured.length > 0 ? configured : ["boundary-prepared"],
  );
  if (status === "backend-neutral") stages.add("backend-neutral");
  for (const stage of extraStages) stages.add(stage);
  return stages;
};

const matrix = [
  {
    id: "kernel-import-boundary",
    stage: "boundary-prepared",
    include: pathStarts("packages/kernel/src/"),
    forbiddenImports: [
      "@agent-os/runtime",
      "@agent-os/backend-protocol",
      "@agent-os/backend-cloudflare-do",
      "@agent-os/backend-in-memory",
      "@agent-os/runtime-protocol",
      "@agent-os/llm-protocol",
      "@agent-os/telemetry-protocol",
      "@agent-os/transports",
      "@agent-os/wire-adapters",
      "cloudflare:workers",
    ],
    forbiddenTokens: ["\\bDurableObject\\b", "\\bResponse\\b", "\\bReadableStream\\b"],
  },
  {
    id: "kernel-final-vendor-telemetry-boundary",
    stage: "backend-neutral",
    include: pathStarts("packages/kernel/src/"),
    forbiddenTokens: [
      "\\bOpenAI\\b",
      "\\bAnthropic\\b",
      "\\bGemini\\b",
      "\\bopenai\\b",
      "\\banthropic\\b",
      "\\bgemini\\b",
      "\\bTraceContext\\b",
      "\\btraceparent\\b",
      "\\btracestate\\b",
      "\\bInvalidTraceContext\\b",
    ],
  },
  {
    id: "backend-protocol-main-runtime-blind",
    stage: "boundary-prepared",
    include: (repoPath) =>
      repoPath.startsWith("packages/backends/protocol/src/") &&
      !repoPath.startsWith("packages/backends/protocol/src/reference/"),
    forbiddenImports: [
      "@agent-os/runtime",
      "@agent-os/backend-cloudflare-do",
      "@agent-os/backend-in-memory",
      "@agent-os/transports",
      "cloudflare:workers",
    ],
    forbiddenTokens: ["\\bDurableObject\\b", "\\bWrangler\\b", "\\bRUNTIME_FACT_OWNER\\b"],
  },
  {
    id: "backend-protocol-reference-runtime-blind",
    stage: "boundary-prepared",
    include: pathStarts("packages/backends/protocol/src/reference/"),
    forbiddenImports: [
      "@agent-os/runtime",
      "@agent-os/backend-cloudflare-do",
      "@agent-os/backend-in-memory",
      "cloudflare:workers",
    ],
  },
  {
    id: "runtime-interpreter-boundary",
    stage: "boundary-prepared",
    include: pathStarts("packages/runtime/src/"),
    forbiddenImports: [
      "@agent-os/backend-cloudflare-do",
      "@agent-os/backend-in-memory",
      "@agent-os/backends",
      "@agent-os/transports",
      "@agent-os/providers",
      "@agent-os/wire-adapters",
      "cloudflare:workers",
    ],
    forbiddenTokens: ["\\bDurableObject\\b"],
  },
  {
    id: "runtime-final-telemetry-wire-boundary",
    stage: "backend-neutral",
    include: pathStarts("packages/runtime/src/"),
    forbiddenTokens: ["\\bOTLP\\b", "\\bOtlp\\b"],
  },
  {
    id: "runtime-protocol-vocab-boundary",
    stage: "boundary-prepared",
    include: pathStarts("packages/runtime-protocol/src/"),
    forbiddenImports: [
      "@agent-os/runtime",
      "@agent-os/backend-cloudflare-do",
      "@agent-os/backend-in-memory",
      "@agent-os/transports",
      "@agent-os/providers",
      "cloudflare:workers",
    ],
    forbiddenTokens: ["\\bDurableObject\\b", "\\bResponse\\b", "\\bReadableStream\\b"],
  },
  {
    id: "llm-protocol-provider-neutral",
    stage: "boundary-prepared",
    include: pathStarts("packages/llm-protocol/src/"),
    forbiddenImports: [
      "@agent-os/runtime",
      "@agent-os/providers",
      "@effect/ai-openai",
      "@effect/ai-anthropic",
      "@effect/ai-google",
    ],
    forbiddenTokens: [
      "\\bOpenAI\\b",
      "\\bAnthropic\\b",
      "\\bGemini\\b",
      "\\bopenai\\b",
      "\\banthropic\\b",
      "\\bgemini\\b",
    ],
  },
  {
    id: "telemetry-protocol-vocab-only",
    stage: "boundary-prepared",
    include: pathStarts("packages/telemetry-protocol/src/"),
    forbiddenImports: [
      "@agent-os/runtime",
      "@agent-os/backend-cloudflare-do",
      "@agent-os/backend-in-memory",
      "@agent-os/wire-adapters",
      "@agent-os/transports",
      "cloudflare:workers",
    ],
    forbiddenTokens: ["\\bOTLP\\b", "\\bOtlp\\b", "\\bDatadog\\b", "\\bPrometheus\\b"],
  },
  {
    id: "carrier-host-boundary",
    stage: "boundary-prepared",
    include: pathMatches(/^packages\/carriers\/[^/]+\/src\//u),
    forbiddenImports: [
      "@agent-os/backend-cloudflare-do",
      "@agent-os/backend-in-memory",
      "@agent-os/backends",
      "cloudflare:workers",
    ],
  },
  {
    id: "carrier-final-vocab-only",
    stage: "backend-neutral",
    include: pathMatches(/^packages\/carriers\/[^/]+\/src\//u),
    forbiddenImports: ["@agent-os/runtime"],
    forbiddenTokens: [
      "export\\s+const\\s+\\w+\\s*=\\s*Effect\\.",
      "\\bLayer\\.",
      "\\bEffect\\.(?:map|fail|void|matchEffect|gen|sync|promise)\\b",
    ],
  },
  {
    id: "composer-host-boundary",
    stage: "boundary-prepared",
    include: pathMatches(/^packages\/composers\/[^/]+\/src\//u),
    forbiddenImports: [
      "@agent-os/backend-cloudflare-do",
      "@agent-os/backend-in-memory",
      "@agent-os/backends",
      "cloudflare:workers",
    ],
  },
  {
    id: "composer-final-codec-boundary",
    stage: "backend-neutral",
    include: pathMatches(/^packages\/composers\/[^/]+\/src\//u),
    forbiddenImports: ["@agent-os/runtime"],
    forbiddenTokens: ["export\\s+const\\s+\\w+\\s*=\\s*Effect\\.", "\\bLayer\\."],
  },
  {
    id: "composer-final-wire-boundary",
    stage: "backend-neutral",
    include: pathMatches(/^packages\/composers\/[^/]+\/src\//u),
    forbiddenTokens: [
      "\\bResponse\\b",
      "\\bReadableStream\\b",
      "\\bWebSocket\\b",
      "text/event-stream",
      "\\bAG-UI\\b",
      "\\bag-ui\\b",
    ],
  },
  {
    id: "transport-axis-boundary",
    stage: "boundary-prepared",
    include: pathMatches(/^packages\/transports\/[^/]+\/src\//u),
    forbiddenImports: [
      "@agent-os/backend-cloudflare-do",
      "@agent-os/backend-in-memory",
      "@agent-os/runtime",
      "cloudflare:workers",
    ],
  },
  {
    id: "wire-adapter-axis-boundary",
    stage: "boundary-prepared",
    include: pathMatches(/^packages\/wire-adapters\/[^/]+\/src\//u),
    forbiddenImports: [
      "@agent-os/backend-cloudflare-do",
      "@agent-os/backend-in-memory",
      "@agent-os/backends",
      "cloudflare:workers",
    ],
  },
  {
    id: "llm-provider-adapter-boundary",
    stage: "backend-neutral",
    include: (repoPath) =>
      /^packages\/providers\/llm-[^/]+\/src\//u.test(repoPath) ||
      /^packages\/llm-providers\/[^/]+\/src\//u.test(repoPath),
    forbiddenImports: [
      "@agent-os/runtime",
      "@agent-os/backend-cloudflare-do",
      "@agent-os/backend-in-memory",
      "@agent-os/backends",
    ],
  },
  {
    id: "cloudflare-backend-boundary",
    stage: "boundary-prepared",
    include: pathStarts("packages/backends/cloudflare-do/src/"),
    forbiddenImports: ["@agent-os/backend-node-postgres", "@agent-os/backends/node-postgres"],
  },
  {
    id: "node-postgres-backend-boundary",
    stage: "boundary-prepared",
    include: pathStarts("packages/backends/node-postgres/src/"),
    forbiddenImports: [
      "cloudflare:workers",
      "@agent-os/backend-cloudflare-do",
      "@agent-os/runtime",
    ],
  },
  {
    id: "tool-mutation-write-port-boundary",
    stage: "boundary-prepared",
    include: (repoPath) => repoPath === "packages/kernel/src/tools.ts",
    forbiddenTokens: [
      "\\bLedger\\b",
      "\\bBoundaryEvents\\b",
      "\\bLedgerCommitEventSpec\\b",
      "\\bDispatchTargetAdapter\\b",
      "\\bScheduler\\b",
      "\\bcommit\\s*\\(",
      "\\bappend\\s*\\(",
      "\\binsertEvent\\s*\\(",
    ],
  },
  {
    id: "product-resource-substrate-boundary",
    stage: "boundary-prepared",
    include: (repoPath) =>
      repoPath.startsWith("packages/kernel/src/") ||
      repoPath.startsWith("packages/runtime-protocol/src/") ||
      repoPath.startsWith("packages/backends/protocol/src/"),
    forbiddenTokens: [
      "\\bSurfaceProgram\\b",
      "\\bWordPress\\b",
      "\\bwp_posts\\b",
      "\\bNotion\\b",
      "\\bGhost\\b",
      "\\bDurableObjectId\\b",
      "\\bDO instance\\b",
      "\\brouteKey\\b",
      "\\broute key\\b",
      "\\bbackend row id\\b",
      "\\bPostgres row id\\b",
      "\\bwp_post\\b",
      "mutation\\.(?:proposed|settled)",
      "state\\.transitioned",
      "entity\\.updated",
    ],
  },
  {
    id: "tool-final-effect-pure-boundary",
    stage: "backend-neutral",
    include: (repoPath) => repoPath === "packages/kernel/src/tools.ts",
    forbiddenTokens: [
      "execute:\\s*.*Promise",
      "AdmitVerdict\\s*\\|\\s*Promise",
      "Promise<AdmitVerdict>",
      "readonly\\s+signal:\\s*AbortSignal",
      "traceContext\\?:\\s*TraceContext",
    ],
  },
];

export const collectBoundaryFailures = (root = repoRoot, options = {}) => {
  const stages = activeStages(root, options.stages ?? []);
  const rules = matrix.filter((rule) => stages.has(rule.stage));
  const failures = [];

  for (const file of sourceFiles(root)) {
    const repoPath = toRepoPath(root, file);
    const source = fs.readFileSync(file, "utf8");
    const matchingRules = rules.filter((rule) => rule.include(repoPath));
    if (matchingRules.length === 0) continue;

    const imports = importSpecifiers(source);
    for (const rule of matchingRules) {
      for (const forbidden of rule.forbiddenImports ?? []) {
        for (const specifier of imports) {
          if (importMatches(specifier.value, forbidden)) {
            failures.push(
              `${repoPath}:${lineNumber(source, specifier.index)}: ${rule.id}: forbidden import ${specifier.value}`,
            );
          }
        }
      }
      for (const token of rule.forbiddenTokens ?? []) {
        const pattern = regexForToken(token);
        for (const match of source.matchAll(pattern)) {
          failures.push(
            `${repoPath}:${lineNumber(source, match.index ?? 0)}: ${rule.id}: forbidden token ${match[0]}`,
          );
        }
      }
    }
  }

  return failures;
};

const writeFixture = (root, relativePath, source) => {
  const file = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, source);
};

const writePositiveFixture = (root) => {
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify(
      {
        agentos: {
          backendNeutralityStatus: "boundary-prepared",
          boundaryGuard: { matrixVersion: "2026-06-09.1", activeStages: ["boundary-prepared"] },
        },
      },
      null,
      2,
    ),
  );
  writeFixture(root, "packages/kernel/src/index.ts", "export const kernelValue = 1;\n");
  writeFixture(root, "packages/backends/protocol/src/index.ts", "export interface Port {}\n");
  writeFixture(
    root,
    "packages/backends/protocol/src/reference/index.ts",
    "export const ref = 1;\n",
  );
  writeFixture(root, "packages/runtime/src/index.ts", "export const runtimeValue = 1;\n");
  writeFixture(
    root,
    "packages/runtime-protocol/src/index.ts",
    "export interface AgentManifest {}\n",
  );
  writeFixture(root, "packages/llm-protocol/src/index.ts", "export interface WireDescriptor {}\n");
  writeFixture(
    root,
    "packages/telemetry-protocol/src/index.ts",
    "export interface TelemetryEventTree {}\n",
  );
  writeFixture(
    root,
    "packages/carriers/deploy/src/index.ts",
    "export interface DeployCarrier {}\n",
  );
  writeFixture(
    root,
    "packages/composers/run-stream/src/index.ts",
    "export const encode = () => '';\n",
  );
  writeFixture(
    root,
    "packages/transports/sse-http/src/index.ts",
    "export const response = () => undefined;\n",
  );
  writeFixture(
    root,
    "packages/wire-adapters/ag-ui/src/index.ts",
    "export const adapter = () => undefined;\n",
  );
  writeFixture(
    root,
    "packages/providers/llm-http/src/index.ts",
    "export const provider = () => undefined;\n",
  );
  writeFixture(
    root,
    "packages/backends/cloudflare-do/src/index.ts",
    "export const cloudflare = 1;\n",
  );
  writeFixture(
    root,
    "packages/backends/node-postgres/src/index.ts",
    "export const nodePostgres = 1;\n",
  );
  writeFixture(root, "packages/kernel/src/tools.ts", "export interface ToolRequirements {}\n");
};

const collectSelfTestFailures = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentos-boundary-"));
  try {
    writePositiveFixture(root);
    const baseline = collectBoundaryFailures(root);
    if (baseline.length > 0) {
      return [`boundary self-test positive fixture failed:\n${baseline.join("\n")}`];
    }

    const cases = [
      {
        name: "kernel forbidden import",
        file: "packages/kernel/src/index.ts",
        bad: 'import "@agent-os/runtime";\nexport const kernelValue = 1;\n',
        expected: "kernel-import-boundary",
      },
      {
        name: "backend protocol runtime import",
        file: "packages/backends/protocol/src/index.ts",
        bad: 'import type { SubmitSpec } from "@agent-os/runtime";\nexport interface Port {}\n',
        expected: "backend-protocol-main-runtime-blind",
      },
      {
        name: "carrier Effect implementation",
        file: "packages/carriers/deploy/src/index.ts",
        bad: "export const DeployLive = Effect.gen(function* () { return 1; });\n",
        expected: "carrier-final-vocab-only",
        stages: ["backend-neutral"],
      },
      {
        name: "tool write port",
        file: "packages/kernel/src/tools.ts",
        bad: "export interface ToolRequirements { readonly ledger: Ledger }\n",
        expected: "tool-mutation-write-port-boundary",
      },
      {
        name: "node postgres runtime import",
        file: "packages/backends/node-postgres/src/index.ts",
        bad:
          'import { scheduledEventIntentPayload } from "@agent-os/runtime";\n' +
          "export const nodePostgres = 1;\n",
        expected: "node-postgres-backend-boundary",
      },
      {
        name: "product resource leakage",
        file: "packages/runtime-protocol/src/index.ts",
        bad: "export interface AgentManifest { readonly surface: SurfaceProgram }\n",
        expected: "product-resource-substrate-boundary",
      },
    ];

    const failures = [];
    for (const testCase of cases) {
      const file = path.join(root, testCase.file);
      const original = fs.readFileSync(file, "utf8");
      fs.writeFileSync(file, testCase.bad);
      const rejected = collectBoundaryFailures(root, { stages: testCase.stages ?? [] });
      if (!rejected.some((failure) => failure.includes(testCase.expected))) {
        failures.push(
          `${testCase.name}: did not reject mutation with ${testCase.expected}; failures=${JSON.stringify(rejected)}`,
        );
      }
      fs.writeFileSync(file, original);
      const restored = collectBoundaryFailures(root, { stages: testCase.stages ?? [] });
      if (restored.length > 0) {
        failures.push(`${testCase.name}: restored fixture still failed:\n${restored.join("\n")}`);
      }
    }
    return failures;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
};

const selfTest = process.argv.includes("--self-test");
const finalStage = process.argv.includes("--backend-neutral");
const failures = selfTest
  ? collectSelfTestFailures()
  : collectBoundaryFailures(repoRoot, { stages: finalStage ? ["backend-neutral"] : [] });

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(selfTest ? "boundary guard self-test passed" : "boundary guard passed");
