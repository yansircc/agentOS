#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

const nodePostgresSourceRoot = "packages/backends/node-postgres/src";
const nodePostgresEntry = `${nodePostgresSourceRoot}/index.ts`;
const protocolPath = "packages/backends/protocol/src/index.ts";

const protocolOwnedSymbols = [
  "DURABLE_TRIGGER_SCHEDULED_REQUESTED",
  "DURABLE_TRIGGER_SCHEDULED_CANCELLED",
  "SCHEDULED_EVENT_TRIGGER_KIND",
  "ScheduledEventIntentPayload",
  "parseScheduledEventIntentPayload",
  "scheduledEventIntentPayload",
];

const requiredNodePostgresProtocolImports = [
  "DURABLE_TRIGGER_SCHEDULED_REQUESTED",
  "SCHEDULED_EVENT_TRIGGER_KIND",
  "parseScheduledEventIntentPayload",
  "scheduledEventIntentPayload",
];

const forbiddenLocalOwnership = [
  {
    name: "scheduled trigger kind literal",
    pattern: /["']scheduled_event["']/u,
  },
  {
    name: "scheduled request event literal",
    pattern: /["']durable_trigger\.scheduled\.requested["']/u,
  },
  {
    name: "scheduled cancellation event literal",
    pattern: /["']durable_trigger\.scheduled\.cancelled["']/u,
  },
  {
    name: "scheduled request constant",
    pattern:
      /\b(?:const|let|var|function|class|interface|type)\s+DURABLE_TRIGGER_SCHEDULED_REQUESTED\b/u,
  },
  {
    name: "scheduled cancellation constant",
    pattern:
      /\b(?:const|let|var|function|class|interface|type)\s+DURABLE_TRIGGER_SCHEDULED_CANCELLED\b/u,
  },
  {
    name: "scheduled trigger kind constant",
    pattern: /\b(?:const|let|var|function|class|interface|type)\s+SCHEDULED_EVENT_TRIGGER_KIND\b/u,
  },
  {
    name: "scheduled payload shape",
    pattern: /\b(?:const|let|var|function|class|interface|type)\s+ScheduledEventIntentPayload\b/u,
  },
  {
    name: "scheduled payload constructor",
    pattern: /\b(?:const|let|var|function|class|interface|type)\s+scheduledEventIntentPayload\b/u,
  },
  {
    name: "scheduled payload parser",
    pattern:
      /\b(?:const|let|var|function|class|interface|type)\s+parseScheduledEventIntentPayload\b/u,
  },
];

const sourceExtensions = /\.(?:ts|tsx|mts|cts)$/u;

const repoPath = (root, file) => path.relative(root, file).split(path.sep).join("/");
const read = (root, file) => fs.readFileSync(path.join(root, file), "utf8");
const exists = (root, file) => fs.existsSync(path.join(root, file));
const lineNumber = (source, index) => source.slice(0, index).split("\n").length;

const sourceFiles = (root, relativeRoot) => {
  const files = [];
  const visit = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules" && entry.name !== "dist") visit(file);
        continue;
      }
      if (sourceExtensions.test(entry.name) && !entry.name.endsWith(".d.ts")) {
        files.push(file);
      }
    }
  };
  visit(path.join(root, relativeRoot));
  return files.sort((left, right) => left.localeCompare(right));
};

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

const namedProtocolImportContains = (source, symbol) => {
  const importBlocks =
    source.match(/import\s*\{[\s\S]*?\}\s*from\s*["']@agent-os\/backend-protocol["'];?/gu) ?? [];
  return importBlocks.some((block) => new RegExp(`\\b${symbol}\\b`, "u").test(block));
};

const protocolExports = (source, symbol) =>
  new RegExp(`export\\s+(?:const|interface|type|function)\\s+${symbol}\\b`, "u").test(source);

export const collectFailures = (root = repoRoot) => {
  const failures = [];

  if (!exists(root, protocolPath)) {
    failures.push(`${protocolPath}: missing backend-protocol source`);
    return failures;
  }
  const protocolSource = read(root, protocolPath);
  for (const symbol of protocolOwnedSymbols) {
    if (!protocolExports(protocolSource, symbol)) {
      failures.push(`${protocolPath}: missing protocol-owned ${symbol}`);
    }
  }

  if (!exists(root, nodePostgresEntry)) {
    failures.push(`${nodePostgresEntry}: missing node-postgres entry source`);
    return failures;
  }

  const entrySource = read(root, nodePostgresEntry);
  for (const symbol of requiredNodePostgresProtocolImports) {
    if (!namedProtocolImportContains(entrySource, symbol)) {
      failures.push(
        `${nodePostgresEntry}: missing @agent-os/backend-protocol import for ${symbol}`,
      );
    }
  }

  for (const file of sourceFiles(root, nodePostgresSourceRoot)) {
    const source = fs.readFileSync(file, "utf8");
    const relative = repoPath(root, file);
    for (const specifier of importSpecifiers(source)) {
      if (importMatches(specifier.value, "@agent-os/runtime")) {
        failures.push(
          `${relative}:${lineNumber(source, specifier.index)}: node-postgres must not import ${specifier.value}; consume scheduled trigger protocol from @agent-os/backend-protocol`,
        );
      }
    }
    for (const { name, pattern } of forbiddenLocalOwnership) {
      for (const match of source.matchAll(new RegExp(pattern.source, "gu"))) {
        failures.push(
          `${relative}:${lineNumber(source, match.index ?? 0)}: node-postgres re-owns ${name}; use @agent-os/backend-protocol`,
        );
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

const protocolFixture = () =>
  protocolOwnedSymbols
    .map((symbol) => {
      if (symbol === "ScheduledEventIntentPayload") {
        return "export interface ScheduledEventIntentPayload {}";
      }
      return symbol.startsWith("parse") || symbol.startsWith("scheduled")
        ? `export const ${symbol} = () => undefined;`
        : `export const ${symbol} = "${symbol}";`;
    })
    .join("\n");

const entryFixture = () => `import {
  DURABLE_TRIGGER_SCHEDULED_REQUESTED,
  SCHEDULED_EVENT_TRIGGER_KIND,
  parseScheduledEventIntentPayload,
  scheduledEventIntentPayload,
} from "@agent-os/backend-protocol";

export const schedule = () => [
  DURABLE_TRIGGER_SCHEDULED_REQUESTED,
  SCHEDULED_EVENT_TRIGGER_KIND,
  parseScheduledEventIntentPayload,
  scheduledEventIntentPayload,
];
`;

const writePositiveFixture = (root) => {
  writeFixture(root, protocolPath, `${protocolFixture()}\n`);
  writeFixture(root, nodePostgresEntry, entryFixture());
};

const collectSelfTestFailures = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentos-node-postgres-runtime-boundary-"));
  try {
    writePositiveFixture(root);
    const baseline = collectFailures(root);
    if (baseline.length > 0) {
      return [`positive fixture failed:\n${baseline.join("\n")}`];
    }

    const cases = [
      {
        name: "runtime import",
        file: nodePostgresEntry,
        source: 'import { scheduledEventIntentPayload } from "@agent-os/runtime";\n',
        expected: "must not import @agent-os/runtime",
      },
      {
        name: "local scheduled kind literal",
        file: `${nodePostgresSourceRoot}/due.ts`,
        source: 'export const localKind = "scheduled_event";\n',
        expected: "re-owns scheduled trigger kind literal",
      },
      {
        name: "missing protocol import",
        file: nodePostgresEntry,
        source: entryFixture().replace("  parseScheduledEventIntentPayload,\n", ""),
        expected: "missing @agent-os/backend-protocol import for parseScheduledEventIntentPayload",
      },
    ];

    const failures = [];
    for (const testCase of cases) {
      writePositiveFixture(root);
      writeFixture(root, testCase.file, testCase.source);
      const rejected = collectFailures(root);
      if (!rejected.some((failure) => failure.includes(testCase.expected))) {
        failures.push(
          `${testCase.name}: did not reject mutation; failures=${JSON.stringify(rejected)}`,
        );
      }
    }
    return failures;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
};

const failures = process.argv.includes("--self-test")
  ? collectSelfTestFailures()
  : collectFailures();
if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(
  process.argv.includes("--self-test")
    ? "node-postgres runtime import boundary self-test passed"
    : "node-postgres runtime import boundary passed",
);
