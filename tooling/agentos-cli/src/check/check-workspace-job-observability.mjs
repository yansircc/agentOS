#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const repoRoot = process.cwd();

const files = {
  runtimeProjection: "packages/runtime/src/workspace-job-observability.ts",
  runtimeIndex: "packages/runtime/src/index.ts",
  carrierEvents: "packages/carriers/workspace-job/src/events.ts",
  carrierDefinition: "packages/carriers/workspace-job/src/definition.ts",
  runtimeTest: "packages/runtime/test/workspace-job.test.ts",
};

const read = (root, file) => fs.readFileSync(path.join(root, file), "utf8");

const requireTerms = (failures, source, file, terms) => {
  for (const term of terms) {
    if (!source.includes(term)) failures.push(`${file}: missing ${term}`);
  }
};

const rejectTerms = (failures, source, file, terms) => {
  for (const term of terms) {
    if (source.includes(term)) failures.push(`${file}: must not contain ${term}`);
  }
};

const collectFailures = (root = repoRoot) => {
  const failures = [];
  const runtimeProjection = read(root, files.runtimeProjection);
  const runtimeIndex = read(root, files.runtimeIndex);
  const carrier = `${read(root, files.carrierEvents)}\n${read(root, files.carrierDefinition)}`;
  const runtimeTest = read(root, files.runtimeTest);

  requireTerms(failures, runtimeProjection, files.runtimeProjection, [
    "projectWorkspaceJob(events, jobRunId)",
    "projectFailureDiagnostics(events, projection.failed.submitRunId)",
    "failureDiagnosticEnvelopeForReason",
    "WorkspaceJobObservabilityProjection",
    "WorkspaceJobFailureExplanation",
    "failureExplanation",
    "projection.failed.submitRunId === undefined",
  ]);
  rejectTerms(failures, runtimeProjection, files.runtimeProjection, [
    "latest",
    "WorkspaceJobProjection.failed",
  ]);
  requireTerms(failures, runtimeIndex, files.runtimeIndex, [
    'export * from "./workspace-job-observability";',
  ]);
  rejectTerms(failures, carrier, "@agent-os/workspace-job carrier", [
    "projectFailureDiagnostics",
    "FailureDiagnostic",
    "failureExplanation",
  ]);
  requireTerms(failures, runtimeTest, files.runtimeTest, [
    "joins exact submit run diagnostics without leaking submitRunId to consumers",
    'not.toContain("submitRunId")',
    'not.toContain("out.txt")',
    "keeps pre-submit seed failures uncorrelated and still observable",
    "projection.failed.submitRunId).toBeUndefined()",
  ]);
  if (/latest/i.test(runtimeTest)) {
    failures.push(`${files.runtimeTest}: observability tests must not use latest correlation`);
  }

  return failures;
};

const writeFixture = (root, file, source) => {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, source);
};

const collectSelfTestFailures = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentos-workspace-job-observability-"));
  try {
    writeFixture(
      root,
      files.runtimeProjection,
      [
        "projectWorkspaceJob(events, jobRunId);",
        "projectFailureDiagnostics(events, projection.failed.submitRunId);",
        "failureDiagnosticEnvelopeForReason();",
        "export interface WorkspaceJobFailureExplanation {}",
        "export type WorkspaceJobObservabilityProjection = unknown;",
        "const failureExplanation = () => undefined;",
        "projection.failed.submitRunId === undefined;",
      ].join("\n"),
    );
    writeFixture(root, files.runtimeIndex, 'export * from "./workspace-job-observability";');
    writeFixture(root, files.carrierEvents, "export const carrier = true;");
    writeFixture(root, files.carrierDefinition, "export const definition = true;");
    writeFixture(
      root,
      files.runtimeTest,
      [
        "joins exact submit run diagnostics without leaking submitRunId to consumers",
        'expect(JSON.stringify(observed)).not.toContain("submitRunId");',
        'expect(JSON.stringify(observed)).not.toContain("out.txt");',
        "keeps pre-submit seed failures uncorrelated and still observable",
        "expect(projection.failed.submitRunId).toBeUndefined();",
      ].join("\n"),
    );
    const baseline = collectFailures(root);
    if (baseline.length > 0) {
      return [`workspace-job observability positive fixture failed:\n${baseline.join("\n")}`];
    }

    writeFixture(
      root,
      files.runtimeProjection,
      [
        "projectWorkspaceJob(events, jobRunId);",
        "projectFailureDiagnostics(events, latestRunId);",
        "export type WorkspaceJobObservabilityProjection = unknown;",
      ].join("\n"),
    );
    writeFixture(root, files.carrierEvents, "projectFailureDiagnostics();");
    const rejected = collectFailures(root);
    if (
      !rejected.some((failure) => failure.includes("projection.failed.submitRunId")) ||
      !rejected.some((failure) => failure.includes("@agent-os/workspace-job carrier"))
    ) {
      return [`workspace-job observability mutation was not rejected: ${JSON.stringify(rejected)}`];
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
    ? "workspace-job observability self-test passed"
    : "workspace-job observability passed",
);
