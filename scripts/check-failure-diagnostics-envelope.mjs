#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

const protocolFile = "packages/runtime-protocol/src/failure-diagnostics.ts";
const protocolTest = "packages/runtime-protocol/test/failure-diagnostics.test.ts";
const runtimeTest = "packages/runtime/test/submit-agent-runtime-events.test.ts";

const read = (root, file) => fs.readFileSync(path.join(root, file), "utf8");

const requiredProtocolTerms = [
  "export type FailureDiagnosticCategory",
  "export type FailureDiagnosticOwner",
  "export interface FailureDiagnosticInternalFacts",
  "readonly category: FailureDiagnosticCategory",
  "readonly owner: FailureDiagnosticOwner",
  "readonly retryable: boolean",
  "readonly publicMessage: string",
  "readonly internalFacts: FailureDiagnosticInternalFacts",
  "categoryForReason",
  "ownerForCategory",
  "retryableForCategory",
  "publicMessageForCategory",
  "failureEnvelope",
  "EXTERNAL_TOOL_EXECUTION_REQUIRES_RECEIPT_REASON",
  "missing_execution_path",
];

const requiredTestTerms = [
  "category: \"invalid_args\"",
  "owner: \"model\"",
  "category: \"unknown_tool\"",
  "category: \"missing_execution_path\"",
  "owner: \"integrator\"",
  "retryable: false",
  "publicMessage: \"This tool requires a receipt-backed execution path before it can run.\"",
];

const collectFailures = (root = repoRoot) => {
  const failures = [];
  const protocol = read(root, protocolFile);
  const tests = `${read(root, protocolTest)}\n${read(root, runtimeTest)}`;

  for (const term of requiredProtocolTerms) {
    if (!protocol.includes(term)) {
      failures.push(`${protocolFile}: missing ${term}`);
    }
  }

  if (/SubmitResult/u.test(protocol)) {
    failures.push(`${protocolFile}: diagnostics projection must not depend on SubmitResult`);
  }
  if (/owner:\s*"consumer"/u.test(`${protocol}\n${tests}`)) {
    failures.push("failure diagnostics owner must be derived, not hard-coded to consumer");
  }

  for (const term of requiredTestTerms) {
    if (!tests.includes(term)) {
      failures.push(`failure diagnostics tests missing ${term}`);
    }
  }

  return failures;
};

const writeFixture = (root, file, source) => {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, source);
};

const collectSelfTestFailures = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentos-failure-diagnostics-"));
  try {
    writeFixture(
      root,
      protocolFile,
      [
        "export type FailureDiagnosticCategory = 'invalid_args' | 'unknown_tool' | 'missing_execution_path';",
        "export type FailureDiagnosticOwner = 'model' | 'integrator';",
        "export interface FailureDiagnosticInternalFacts {}",
        "export interface FailureDiagnostic {",
        "  readonly category: FailureDiagnosticCategory;",
        "  readonly owner: FailureDiagnosticOwner;",
        "  readonly retryable: boolean;",
        "  readonly publicMessage: string;",
        "  readonly internalFacts: FailureDiagnosticInternalFacts;",
        "}",
        "export const EXTERNAL_TOOL_EXECUTION_REQUIRES_RECEIPT_REASON = 'external_tool_execution_requires_receipt';",
        "const categoryForReason = () => 'missing_execution_path';",
        "const ownerForCategory = () => 'integrator';",
        "const retryableForCategory = () => false;",
        "const publicMessageForCategory = () => 'This tool requires a receipt-backed execution path before it can run.';",
        "const failureEnvelope = () => ({ category: 'missing_execution_path' });",
      ].join("\n"),
    );
    const positiveTest = [
      'category: "invalid_args"',
      'owner: "model"',
      'category: "unknown_tool"',
      'category: "missing_execution_path"',
      'owner: "integrator"',
      "retryable: false",
      'publicMessage: "This tool requires a receipt-backed execution path before it can run."',
    ].join("\n");
    writeFixture(root, protocolTest, positiveTest);
    writeFixture(root, runtimeTest, positiveTest);
    const baseline = collectFailures(root);
    if (baseline.length > 0) {
      return [`failure diagnostics positive fixture failed:\n${baseline.join("\n")}`];
    }

    writeFixture(
      root,
      protocolFile,
      [
        "export interface FailureDiagnostic { readonly reason: string }",
        "import type { SubmitResult } from './submit';",
      ].join("\n"),
    );
    const rejected = collectFailures(root);
    if (
      !rejected.some((failure) => failure.includes("FailureDiagnosticCategory")) ||
      !rejected.some((failure) => failure.includes("SubmitResult"))
    ) {
      return [
        `failure diagnostics mutation fixture was not rejected: ${JSON.stringify(rejected)}`,
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
    ? "failure diagnostics envelope self-test passed"
    : "failure diagnostics envelope passed",
);
