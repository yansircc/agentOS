#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

const files = {
  definition: "packages/carriers/workspace-job/src/definition.ts",
  events: "packages/carriers/workspace-job/src/events.ts",
  test: "packages/carriers/workspace-job/test/workspace-job.test.ts",
};

const read = (root, file) => fs.readFileSync(path.join(root, file), "utf8");

const hasJsonKeyNegativeAssertion = (source, key) =>
  source.includes(`not.toContain('"${key}"')`) || source.includes(`not.toContain("\\"${key}\\"")`);

const blockAfter = (source, marker) => {
  const start = source.indexOf(marker);
  if (start < 0) return "";
  const end = source.indexOf("});", start);
  return end < 0 ? "" : source.slice(start, end);
};

const collectFailures = (root = repoRoot) => {
  const failures = [];
  const definition = read(root, files.definition);
  const events = read(root, files.events);
  const test = read(root, files.test);
  const failureSchema = blockAfter(definition, "const FailureSchema = Schema.Struct");
  const failedSchema = blockAfter(definition, "const FailedSchema = Schema.Struct");

  if (!failureSchema.includes("reason: NonEmptyString")) {
    failures.push(`${files.definition}: WorkspaceJobFailure must carry symbolic reason`);
  }
  for (const forbidden of [
    "class:",
    "message:",
    "diagnostics",
    "category",
    "owner",
    "publicMessage",
  ]) {
    if (failureSchema.includes(forbidden)) {
      failures.push(`${files.definition}: FailureSchema must not contain ${forbidden}`);
    }
  }
  if (!failedSchema.includes("submitRunId: Schema.optional(Schema.Number)")) {
    failures.push(`${files.definition}: FailedSchema must carry optional submitRunId join key`);
  }
  if (!events.includes("readonly submitRunId?: number")) {
    failures.push(`${files.events}: failed payload builder must accept optional submitRunId`);
  }
  if (!events.includes('stringField(value, "reason")')) {
    failures.push(`${files.events}: raw failed projection must parse reason`);
  }
  for (const forbidden of ["diagnostics", "category", "owner", "publicMessage"]) {
    if (!test.includes(`not.toContain("${forbidden}")`)) {
      failures.push(`${files.test}: missing negative assertion for ${forbidden}`);
    }
  }
  for (const forbidden of ["class", "message"]) {
    if (!hasJsonKeyNegativeAssertion(test, forbidden)) {
      failures.push(`${files.test}: missing negative assertion for JSON key ${forbidden}`);
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentos-workspace-job-vocabulary-"));
  try {
    writeFixture(
      root,
      files.definition,
      [
        "const FailureSchema = Schema.Struct({",
        "  phase: Schema.Literal('submit'),",
        "  code: NonEmptyString,",
        "  reason: NonEmptyString,",
        "});",
        "const FailedSchema = Schema.Struct({",
        "  submitRunId: Schema.optional(Schema.Number),",
        "});",
      ].join("\n"),
    );
    writeFixture(
      root,
      files.events,
      [
        "export const workspaceJobFailedPayload = (spec: { readonly submitRunId?: number }) => spec;",
        'const reason = stringField(value, "reason");',
      ].join("\n"),
    );
    writeFixture(
      root,
      files.test,
      [
        'expect(failedPayload).not.toContain("diagnostics");',
        'expect(failedPayload).not.toContain("category");',
        'expect(failedPayload).not.toContain("owner");',
        'expect(failedPayload).not.toContain("publicMessage");',
        "expect(failedPayload).not.toContain('\"class\"');",
        "expect(failedPayload).not.toContain('\"message\"');",
      ].join("\n"),
    );
    const baseline = collectFailures(root);
    if (baseline.length > 0) {
      return [`workspace-job vocabulary positive fixture failed:\n${baseline.join("\n")}`];
    }

    writeFixture(
      root,
      files.definition,
      [
        "const FailureSchema = Schema.Struct({",
        "  phase: Schema.Literal('submit'),",
        "  class: Schema.Literal('provider'),",
        "  code: NonEmptyString,",
        "  message: NonEmptyString,",
        "});",
        "const FailedSchema = Schema.Struct({});",
      ].join("\n"),
    );
    const rejected = collectFailures(root);
    if (
      !rejected.some((failure) => failure.includes("symbolic reason")) ||
      !rejected.some((failure) => failure.includes("class:")) ||
      !rejected.some((failure) => failure.includes("submitRunId"))
    ) {
      return [`workspace-job vocabulary mutation was not rejected: ${JSON.stringify(rejected)}`];
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
    ? "workspace-job failure vocabulary self-test passed"
    : "workspace-job failure vocabulary passed",
);
