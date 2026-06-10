#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

const protocolFile = "packages/telemetry-protocol/src/index.ts";
const runtimeTreeFile = "packages/runtime/src/telemetry-tree.ts";
const otlpSourceFile = "packages/wire-adapters/telemetry-otlp/src/index.ts";
const otlpTestFile = "packages/wire-adapters/telemetry-otlp/test/telemetry-otlp.test.ts";

const read = (root, rel) => fs.readFileSync(path.join(root, rel), "utf8");

const forbiddenOtlpPatterns = [
  {
    pattern: /from\s+["']@agent-os\/kernel(?:\/[^"']*)?["']/u,
    reason: "OTLP source must not import kernel ledger/effect-claim facts",
  },
  {
    pattern: /from\s+["']@agent-os\/runtime(?:\/[^"']*)?["']/u,
    reason: "OTLP source must not import runtime projection code",
  },
  {
    pattern: /from\s+["']@agent-os\/runtime-protocol["']/u,
    reason: "OTLP source must not import runtime event vocabulary",
  },
  { pattern: /\bLedgerEvent\b/u, reason: "OTLP source must not accept raw ledger events" },
  {
    pattern: /\bdecodeRuntimeLedgerEvent\b/u,
    reason: "OTLP source must not decode runtime ledger events",
  },
  {
    pattern: /\bRUNTIME_EVENT_KIND\b/u,
    reason: "OTLP source must not branch on runtime event kinds",
  },
  { pattern: /\bisRuntimeAbortEventKind\b/u, reason: "OTLP source must not classify abort facts" },
  { pattern: /\bABORT\b/u, reason: "OTLP source must not import abort vocabulary" },
  { pattern: /\bevent\.kind\b/u, reason: "OTLP source must not classify ledger event.kind" },
  {
    pattern: /\.kind\.startsWith\(["']dispatch\./u,
    reason: "OTLP source must not classify dispatch events",
  },
  {
    pattern: /\.kind\.startsWith\(["']durable_trigger\./u,
    reason: "OTLP source must not classify durable trigger events",
  },
  {
    pattern: /\.kind\.includes\(["']\.verification\./u,
    reason: "OTLP source must not classify verification events",
  },
  {
    pattern: /\.kind\.endsWith\(["']\.failed["']\)/u,
    reason: "OTLP source must not derive status from ledger kind suffixes",
  },
  {
    pattern: /\.kind\.endsWith\(["']\.cancelled["']\)/u,
    reason: "OTLP source must not derive status from ledger kind suffixes",
  },
];

const collectFailures = (root = repoRoot) => {
  const failures = [];
  const protocol = read(root, protocolFile);
  const runtimeTree = read(root, runtimeTreeFile);
  const otlpSource = read(root, otlpSourceFile);
  const otlpTest = read(root, otlpTestFile);

  if (!/readonly\s+telemetryKind:\s+TelemetryEventKind/u.test(protocol)) {
    failures.push(`${protocolFile}: TelemetryEventNode must carry telemetryKind`);
  }
  if (!/readonly\s+outcome\?:\s+TelemetryOutcome/u.test(protocol)) {
    failures.push(`${protocolFile}: TelemetryEventNode must carry protocol-owned outcome`);
  }
  if (!/readonly\s+endedAt\?:\s+number/u.test(protocol)) {
    failures.push(`${protocolFile}: TelemetryEventNode must carry interval end time`);
  }

  for (const kind of [
    "agent_run",
    "llm_call",
    "tool_execution",
    "dispatch_delivery",
    "durable_trigger",
    "verification_gate",
  ]) {
    if (!runtimeTree.includes(`telemetryKind: "${kind}"`)) {
      failures.push(`${runtimeTreeFile}: missing telemetryKind ${kind}`);
    }
  }
  if (!runtimeTree.includes("outcome: genericOutcome(event)")) {
    failures.push(`${runtimeTreeFile}: generic telemetry status must be tree-owned`);
  }

  if (!/TelemetryEventTree/u.test(otlpSource)) {
    failures.push(`${otlpSourceFile}: OTLP source must consume TelemetryEventTree`);
  }
  if (!/projectOtlpSpans\s*=\s*\(\s*tree:\s*TelemetryEventTree/u.test(otlpSource)) {
    failures.push(`${otlpSourceFile}: projectOtlpSpans input must be TelemetryEventTree`);
  }
  for (const { pattern, reason } of forbiddenOtlpPatterns) {
    if (pattern.test(otlpSource)) {
      failures.push(`${otlpSourceFile}: ${reason}`);
    }
  }

  if (!/projectTelemetryEventTree/u.test(otlpTest) || !/projectOtlpSpans/u.test(otlpTest)) {
    failures.push(`${otlpTestFile}: tests must verify runtime tree to OTLP projection parity`);
  }

  return failures;
};

const writeFixture = (root, relativePath, source) => {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, source);
};

const writePositiveFixture = (root) => {
  writeFixture(
    root,
    protocolFile,
    [
      "export type TelemetryEventKind = 'agent_run';",
      "export type TelemetryOutcome = 'ok' | 'error' | 'unset';",
      "export interface TelemetryEventNode {",
      "  readonly telemetryKind: TelemetryEventKind;",
      "  readonly outcome?: TelemetryOutcome;",
      "  readonly endedAt?: number;",
      "}",
    ].join("\n"),
  );
  writeFixture(
    root,
    runtimeTreeFile,
    [
      'telemetryKind: "agent_run"',
      'telemetryKind: "llm_call"',
      'telemetryKind: "tool_execution"',
      'telemetryKind: "dispatch_delivery"',
      'telemetryKind: "durable_trigger"',
      'telemetryKind: "verification_gate"',
      "outcome: genericOutcome(event)",
    ].join("\n"),
  );
  writeFixture(
    root,
    otlpSourceFile,
    [
      'import type { TelemetryEventTree } from "@agent-os/telemetry-protocol";',
      "export const projectOtlpSpans = (tree: TelemetryEventTree) => tree.nodes;",
    ].join("\n"),
  );
  writeFixture(root, otlpTestFile, "projectTelemetryEventTree(events); projectOtlpSpans(tree);");
};

const collectSelfTestFailures = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentos-telemetry-otlp-tree-"));
  try {
    writePositiveFixture(root);
    const baseline = collectFailures(root);
    if (baseline.length > 0) {
      return [`telemetry OTLP tree positive fixture failed:\n${baseline.join("\n")}`];
    }

    writeFixture(
      root,
      otlpSourceFile,
      [
        'import type { LedgerEvent } from "@agent-os/kernel/types";',
        'import { RUNTIME_EVENT_KIND } from "@agent-os/runtime-protocol";',
        "export const projectOtlpSpans = (events: ReadonlyArray<LedgerEvent>) =>",
        '  events.filter((event) => event.kind.startsWith("dispatch.") || event.kind === RUNTIME_EVENT_KIND.AGENT_RUN_STARTED);',
      ].join("\n"),
    );
    const ledgerLeak = collectFailures(root);
    if (
      !ledgerLeak.some((failure) => failure.includes("raw ledger events")) ||
      !ledgerLeak.some((failure) => failure.includes("runtime event vocabulary")) ||
      !ledgerLeak.some((failure) => failure.includes("ledger event.kind"))
    ) {
      return [
        `telemetry OTLP ledger-classifier mutation was not rejected: ${JSON.stringify(
          ledgerLeak,
        )}`,
      ];
    }

    writePositiveFixture(root);
    writeFixture(
      root,
      protocolFile,
      [
        "export type TelemetryEventKind = 'agent_run';",
        "export interface TelemetryEventNode {",
        "  readonly telemetryKind: TelemetryEventKind;",
        "}",
      ].join("\n"),
    );
    const missingOutcome = collectFailures(root);
    if (!missingOutcome.some((failure) => failure.includes("protocol-owned outcome"))) {
      return [
        `telemetry OTLP missing-outcome mutation was not rejected: ${JSON.stringify(
          missingOutcome,
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
    ? "telemetry OTLP tree parity self-test passed"
    : "telemetry OTLP tree parity passed",
);
