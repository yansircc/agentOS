#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

const arrayBlock = (source, name) => {
  const match = source.match(new RegExp(`export const ${name} = \\[([\\s\\S]*?)\\] as const;`));
  return match?.[1] ?? "";
};

const stringLiterals = (source) => [...source.matchAll(/"([^"]+)"/g)].map((match) => match[1]);

const collectFailures = (root = repoRoot) => {
  const file = path.join(root, "packages", "runtime-protocol", "src", "intent.ts");
  const source = fs.readFileSync(file, "utf8");
  const failures = [];
  const intentBlock = arrayBlock(source, "AGENT_INTENT_EVENT_KINDS");
  const settlementBlock = arrayBlock(source, "AGENT_SETTLEMENT_EVENT_KINDS");
  if (intentBlock.length === 0) {
    failures.push("packages/runtime-protocol/src/intent.ts: missing intent kind block");
  }
  if (settlementBlock.length === 0) {
    failures.push("packages/runtime-protocol/src/intent.ts: missing settlement kind block");
  }
  const intentKinds = stringLiterals(intentBlock);
  const settlementKinds = stringLiterals(settlementBlock);
  for (const intentKind of intentKinds) {
    if (!intentKind.startsWith("agent.intent.")) {
      failures.push(
        `packages/runtime-protocol/src/intent.ts: intent kind is not typed intent ${intentKind}`,
      );
    }
    if (settlementKinds.includes(intentKind)) {
      failures.push(
        `packages/runtime-protocol/src/intent.ts: intent also appears in settlement ${intentKind}`,
      );
    }
  }
  for (const settlementKind of settlementKinds) {
    if (settlementKind.startsWith("agent.intent.")) {
      failures.push(
        `packages/runtime-protocol/src/intent.ts: settlement block contains intent kind ${settlementKind}`,
      );
    }
  }
  if (!source.includes("validateIntentSettlementVocabulary")) {
    failures.push("packages/runtime-protocol/src/intent.ts: missing disjoint vocabulary validator");
  }
  return failures;
};

const writeFixture = (root, source) => {
  const file = path.join(root, "packages", "runtime-protocol", "src", "intent.ts");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, source);
};

const collectSelfTestFailures = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentos-intent-boundary-"));
  try {
    writeFixture(
      root,
      [
        'export const AGENT_INTENT_EVENT_KINDS = ["agent.intent.submitted"] as const;',
        'export const AGENT_SETTLEMENT_EVENT_KINDS = ["agent.run.completed"] as const;',
        "export const validateIntentSettlementVocabulary = () => [];",
      ].join("\n"),
    );
    const baseline = collectFailures(root);
    if (baseline.length > 0) {
      return [`intent boundary positive fixture failed:\n${baseline.join("\n")}`];
    }

    writeFixture(
      root,
      [
        'export const AGENT_INTENT_EVENT_KINDS = ["agent.intent.submitted"] as const;',
        'export const AGENT_SETTLEMENT_EVENT_KINDS = ["agent.intent.submitted"] as const;',
        "export const validateIntentSettlementVocabulary = () => [];",
      ].join("\n"),
    );
    const rejected = collectFailures(root);
    if (!rejected.some((failure) => failure.includes("settlement"))) {
      return [`intent boundary mutation fixture was not rejected: ${JSON.stringify(rejected)}`];
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
    ? "intent settlement boundary self-test passed"
    : "intent settlement boundary passed",
);
