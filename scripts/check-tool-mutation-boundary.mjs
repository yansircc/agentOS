#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

const forbiddenTokens = [
  "\\bLedger\\b",
  "\\bBoundaryEvents\\b",
  "\\bLedgerCommitEventSpec\\b",
  "\\bDispatchTargetAdapter\\b",
  "\\bScheduler\\b",
  "\\bcommit\\s*\\(",
  "\\bappend\\s*\\(",
  "\\binsertEvent\\s*\\(",
];

const regexForToken = (token) => new RegExp(token, "g");

const lineNumber = (source, index) => source.slice(0, index).split("\n").length;

const collectFailures = (root) => {
  const file = path.join(root, "packages", "kernel", "src", "tools.ts");
  const source = fs.readFileSync(file, "utf8");
  const failures = [];
  for (const token of forbiddenTokens) {
    const pattern = regexForToken(token);
    for (const match of source.matchAll(pattern)) {
      failures.push(
        `packages/kernel/src/tools.ts:${lineNumber(source, match.index ?? 0)}: forbidden tool mutation boundary token ${match[0]}`,
      );
    }
  }
  return failures;
};

const writeFixture = (root, source) => {
  const file = path.join(root, "packages", "kernel", "src", "tools.ts");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, source);
};

const collectSelfTestFailures = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentos-tool-boundary-"));
  try {
    const good = "export interface ToolRequirements {}\n";
    writeFixture(root, good);
    const baseline = collectFailures(root);
    if (baseline.length > 0) {
      return [`tool mutation boundary positive fixture failed:\n${baseline.join("\n")}`];
    }

    writeFixture(root, "export interface ToolRequirements { readonly ledger: Ledger }\n");
    const rejected = collectFailures(root);
    if (!rejected.some((failure) => failure.includes("Ledger"))) {
      return [
        `tool mutation boundary mutation fixture was not rejected; failures=${JSON.stringify(rejected)}`,
      ];
    }

    writeFixture(root, good);
    const restored = collectFailures(root);
    if (restored.length > 0) {
      return [`tool mutation boundary restored fixture failed:\n${restored.join("\n")}`];
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
    ? "tool mutation boundary self-test passed"
    : "tool mutation boundary passed",
);
