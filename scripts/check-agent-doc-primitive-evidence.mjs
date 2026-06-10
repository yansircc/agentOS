#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

const evidencePath = "docs/agent/primitive-evidence.source.json";
const primitivesJsonPath = "docs/agent/primitives.json";
const primitivesMdPath = "docs/agent/primitives.md";

const read = (root, file) => fs.readFileSync(path.join(root, file), "utf8");
const readJson = (root, file) => JSON.parse(read(root, file));
const exists = (root, file) => fs.existsSync(path.join(root, file));

const validate = (root = repoRoot) => {
  const failures = [];
  const evidenceSource = readJson(root, evidencePath);
  const primitivesJson = readJson(root, primitivesJsonPath);
  const primitivesMd = read(root, primitivesMdPath);
  const primitives = Array.isArray(primitivesJson.primitives) ? primitivesJson.primitives : [];
  const primitiveIds = new Set(primitives.map((primitive) => primitive.id));
  const evidence = Array.isArray(evidenceSource.evidence) ? evidenceSource.evidence : [];
  const evidenceIds = new Set();

  for (const entry of evidence) {
    if (evidenceIds.has(entry.primitive)) {
      failures.push(`${evidencePath}: duplicate evidence for ${entry.primitive}`);
    }
    evidenceIds.add(entry.primitive);
    if (!primitiveIds.has(entry.primitive)) {
      failures.push(`${evidencePath}: evidence references unknown primitive ${entry.primitive}`);
    }
    const hasTests = Array.isArray(entry.tests) && entry.tests.length > 0;
    const hasNoTestReason =
      typeof entry.noTestReason === "string" && entry.noTestReason.trim().length > 0;
    if (hasTests === hasNoTestReason) {
      failures.push(`${entry.primitive}: must have exactly one evidence kind`);
    }
    for (const test of entry.tests ?? []) {
      if (!exists(root, test)) failures.push(`${entry.primitive}: missing evidence path ${test}`);
    }
  }

  for (const primitive of primitives) {
    if (!evidenceIds.has(primitive.id)) {
      failures.push(`${primitive.id}: missing source evidence entry`);
    }
    const generated = primitive.testEvidence;
    const hasGeneratedTests = Array.isArray(generated?.tests) && generated.tests.length > 0;
    const hasGeneratedNoTestReason =
      typeof generated?.noTestReason === "string" && generated.noTestReason.trim().length > 0;
    if (hasGeneratedTests === hasGeneratedNoTestReason) {
      failures.push(`${primitive.id}: generated primitive lacks exactly one testEvidence kind`);
    }
  }

  if (!primitivesMd.includes("Test Evidence")) {
    failures.push(`${primitivesMdPath}: missing Test Evidence column`);
  }
  if (!primitivesJson.source?.includes("docs/agent/primitive-evidence.source.json")) {
    failures.push(`${primitivesJsonPath}: generated source list does not include evidence source`);
  }

  return failures;
};

const writeFixture = (root, relativePath, value) => {
  const file = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value, null, 2));
};

const collectSelfTestFailures = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentos-agent-doc-evidence-"));
  try {
    writeFixture(root, "test/a.test.ts", "");
    writeFixture(root, evidencePath, {
      schemaVersion: 1,
      evidence: [{ primitive: "primitive.test", tests: ["test/a.test.ts"] }],
    });
    writeFixture(root, primitivesJsonPath, {
      source: ["docs/agent/primitive-evidence.source.json"],
      primitives: [{ id: "primitive.test", testEvidence: { tests: ["test/a.test.ts"] } }],
    });
    writeFixture(root, primitivesMdPath, "| Primitive | Test Evidence |\n| --- | --- |\n");
    const baseline = validate(root);
    if (baseline.length > 0) {
      return [`agent primitive evidence positive fixture failed:\n${baseline.join("\n")}`];
    }

    writeFixture(root, evidencePath, { schemaVersion: 1, evidence: [] });
    const rejected = validate(root);
    if (!rejected.some((failure) => failure.includes("missing source evidence entry"))) {
      return [
        `agent primitive evidence mutation fixture was not rejected: ${JSON.stringify(rejected)}`,
      ];
    }
    return [];
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
};

const failures = process.argv.includes("--self-test") ? collectSelfTestFailures() : validate();

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(
  process.argv.includes("--self-test")
    ? "agent doc primitive evidence self-test passed"
    : "agent doc primitive evidence passed",
);
