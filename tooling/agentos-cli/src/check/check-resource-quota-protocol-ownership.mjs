#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { collectBoundaryRuleMembershipFailures } from "../lib/boundary-rules.mjs";

const repoRoot = process.cwd();

const protocolPath = "packages/backends/protocol/src/index.ts";

const removedBackendPayloadFiles = [
  "packages/backends/cloudflare-do/src/resources/payload.ts",
  "packages/backends/cloudflare-do/src/quota/payload.ts",
];

const backendSourceFiles = [
  "packages/backends/cloudflare-do/src/agent-do.ts",
  "packages/backends/cloudflare-do/src/projections.ts",
  "packages/backends/cloudflare-do/src/quota/service.ts",
  "packages/backends/cloudflare-do/src/resources/projection.ts",
  "packages/backends/cloudflare-do/src/resources/resources.ts",
  "packages/backends/in-memory/src/quota.ts",
  "packages/backends/in-memory/src/resources.ts",
  "packages/backends/node-postgres/src/index.ts",
];

const protocolExports = [
  "RESOURCE_EVENT_KIND",
  "QUOTA_EVENT_KIND",
  "ResourceGrantPayloadSchema",
  "ResourceReservePayloadSchema",
  "ResourceReserveRejectedPayloadSchema",
  "ResourceTerminalPayloadSchema",
  "QuotaConsumedPayloadSchema",
  "decodeResourceGrantPayloadSync",
  "decodeResourceReservePayloadSync",
  "decodeResourceReserveRejectedPayloadSync",
  "decodeResourceTerminalPayloadSync",
  "decodeQuotaConsumedPayloadSync",
  "projectResourceRows",
  "projectResourceEvents",
  "projectResourceState",
  "projectQuotaState",
  "projectQuotaGrantUsage",
];

const requiredBackendImports = {
  "packages/backends/cloudflare-do/src/agent-do.ts": ["RESOURCE_EVENT_KIND", "QUOTA_EVENT_KIND"],
  "packages/backends/cloudflare-do/src/projections.ts": [
    "projectQuotaState",
    "projectResourceState",
  ],
  "packages/backends/cloudflare-do/src/quota/service.ts": [
    "decodeQuotaConsumedPayloadSync",
    "QUOTA_EVENT_KIND",
  ],
  "packages/backends/cloudflare-do/src/resources/projection.ts": [
    "projectResourceRows",
    "emptyResourceProjection",
  ],
  "packages/backends/cloudflare-do/src/resources/resources.ts": ["RESOURCE_EVENT_KIND"],
  "packages/backends/in-memory/src/quota.ts": ["projectQuotaGrantUsage", "QUOTA_EVENT_KIND"],
  "packages/backends/in-memory/src/resources.ts": ["projectResourceEvents", "RESOURCE_EVENT_KIND"],
  "packages/backends/node-postgres/src/index.ts": [
    "projectQuotaGrantUsage",
    "projectResourceEvents",
    "RESOURCE_EVENT_KIND",
    "QUOTA_EVENT_KIND",
  ],
};

const forbiddenBackendPatterns = [
  {
    name: "resource payload schema",
    pattern: /\b(?:export\s+)?const\s+Resource[A-Za-z]*PayloadSchema\s*=\s*Schema\.Struct/u,
  },
  {
    name: "quota payload schema",
    pattern: /\b(?:export\s+)?const\s+Quota[A-Za-z]*PayloadSchema\s*=\s*Schema\.Struct/u,
  },
  {
    name: "resource projection state",
    pattern: /\binterface\s+ProjectedResourceState\b/u,
  },
  {
    name: "reservation state",
    pattern: /\binterface\s+ReservationState\b/u,
  },
  {
    name: "empty resource projection fold",
    pattern: /\bconst\s+emptyResourceProjection\b/u,
  },
  {
    name: "resource projection accumulator",
    pattern: /\bconst\s+addResourceProjection\b/u,
  },
];

const read = (root, file) => fs.readFileSync(path.join(root, file), "utf8");
const exists = (root, file) => fs.existsSync(path.join(root, file));

const hasProtocolImport = (source, symbol) => {
  const importBlocks =
    source.match(/import\s*\{[\s\S]*?\}\s*from\s*["']@agent-os\/backend-protocol["'];?/gu) ?? [];
  return importBlocks.some((block) => new RegExp(`\\b${symbol}\\b`, "u").test(block));
};

const collectFailures = (root = repoRoot) => {
  const failures = [];

  if (!exists(root, protocolPath)) {
    failures.push(`${protocolPath}: missing backend-protocol source`);
    return failures;
  }

  const protocolSource = read(root, protocolPath);
  for (const symbol of protocolExports) {
    if (
      !new RegExp(`export\\s+(?:const|interface|type)\\s+${symbol}\\b`, "u").test(protocolSource)
    ) {
      failures.push(`${protocolPath}: missing protocol-owned ${symbol}`);
    }
  }

  for (const file of removedBackendPayloadFiles) {
    if (exists(root, file)) {
      failures.push(`${file}: resource/quota payload codecs must live in ${protocolPath}`);
    }
  }

  for (const file of backendSourceFiles) {
    if (!exists(root, file)) {
      failures.push(`${file}: missing backend source checked by resource/quota ownership gate`);
      continue;
    }
    const source = read(root, file);
    for (const { name, pattern } of forbiddenBackendPatterns) {
      if (pattern.test(source)) {
        failures.push(`${file}: backend re-owns ${name}; use @agent-os/backend-protocol`);
      }
    }
    for (const symbol of requiredBackendImports[file] ?? []) {
      if (!hasProtocolImport(source, symbol)) {
        failures.push(`${file}: missing @agent-os/backend-protocol import for ${symbol}`);
      }
    }
  }

  failures.push(
    ...collectBoundaryRuleMembershipFailures(root, [
      {
        ruleId: "resource-quota-protocol-ownership",
        commandGroup: "substrate-consumer",
        reachableFrom: ["substrate-consumer", "all"],
      },
    ]),
  );

  return failures;
};

const writeFixture = (root, relativePath, source) => {
  const file = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, source);
};

const writePositiveFixture = (root) => {
  writeFixture(
    root,
    protocolPath,
    `export const RESOURCE_EVENT_KIND = {};
export const QUOTA_EVENT_KIND = {};
export const ResourceGrantPayloadSchema = {};
export const ResourceReservePayloadSchema = {};
export const ResourceReserveRejectedPayloadSchema = {};
export const ResourceTerminalPayloadSchema = {};
export const QuotaConsumedPayloadSchema = {};
export const decodeResourceGrantPayloadSync = () => {};
export const decodeResourceReservePayloadSync = () => {};
export const decodeResourceReserveRejectedPayloadSync = () => {};
export const decodeResourceTerminalPayloadSync = () => {};
export const decodeQuotaConsumedPayloadSync = () => {};
export const projectResourceRows = () => {};
export const projectResourceEvents = () => {};
export const projectResourceState = () => {};
export const projectQuotaState = () => {};
export const projectQuotaGrantUsage = () => {};
`,
  );
  writeFixture(
    root,
    "docs/agent/boundary-rules.source.json",
    JSON.stringify(
      {
        schemaVersion: 1,
        commandGroups: {
          all: [{ type: "group", id: "substrate-consumer" }],
          "substrate-consumer": [{ type: "rule", id: "resource-quota-protocol-ownership" }],
        },
        rules: [
          {
            id: "resource-quota-protocol-ownership",
            commandGroup: "substrate-consumer",
          },
        ],
      },
      null,
      2,
    ),
  );

  const importLine = (symbols) =>
    `import { ${symbols.join(", ")} } from "@agent-os/backend-protocol";\n`;
  for (const file of backendSourceFiles) {
    writeFixture(root, file, importLine(requiredBackendImports[file] ?? []));
  }
};

const collectSelfTestFailures = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentos-resource-quota-protocol-"));
  try {
    writePositiveFixture(root);
    const baseline = collectFailures(root);
    if (baseline.length > 0) {
      return [`resource/quota ownership positive fixture failed:\n${baseline.join("\n")}`];
    }

    writeFixture(
      root,
      "packages/backends/cloudflare-do/src/resources/payload.ts",
      `import { Schema } from "effect";
export const ResourceGrantPayloadSchema = Schema.Struct({ key: Schema.String });
`,
    );
    const rejected = collectFailures(root);
    if (!rejected.some((failure) => failure.includes("payload codecs must live"))) {
      return [
        `resource/quota ownership mutation fixture was not rejected: ${JSON.stringify(rejected)}`,
      ];
    }
    return [];
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
};

const selfTest = process.argv.includes("--self-test");
const failures = selfTest ? collectSelfTestFailures() : collectFailures(repoRoot);

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(
  selfTest
    ? "resource/quota protocol ownership self-test passed"
    : "resource/quota protocol ownership passed",
);
