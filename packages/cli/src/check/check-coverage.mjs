#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  algorithmicCheckerComponents,
  algorithmicCheckerSource,
  hasAlgorithmicChecker,
} from "./algorithmic-checks.mjs";
import { proofRegistryFailures } from "./proof-registry.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

const readJson = (relativePath) =>
  JSON.parse(fs.readFileSync(path.join(repoRoot, relativePath), "utf8"));

const failures = [];
const fail = (message) => failures.push(message);

const coverage = readJson("packages/cli/src/check/check-coverage.source.json");
const rulesSource = readJson("docs/agent/boundary-rules.source.json");
const cliPackage = readJson("packages/cli/package.json");

if (!Array.isArray(coverage.entries) || coverage.entries.length === 0) {
  fail("check coverage entries must be non-empty");
}

const sourceText = fs.readFileSync(
  path.join(repoRoot, "docs/agent/boundary-rules.source.json"),
  "utf8",
);
if (sourceText.includes("positiveAcceptance")) {
  fail("docs/agent/boundary-rules.source.json: positiveAcceptance is no longer allowed");
}
if (/\s--fix(?:\s|")/u.test(sourceText)) {
  fail("docs/agent/boundary-rules.source.json: check commands must not include --fix");
}

const cliDependencies = Object.keys(cliPackage.dependencies ?? {});
for (const dependency of cliDependencies) {
  if (
    dependency === "@effect/cli" ||
    dependency === "@effect/platform-node" ||
    dependency === "@effect/printer" ||
    dependency === "@effect/printer-ansi" ||
    dependency === "@effect/typeclass"
  ) {
    fail(`packages/cli/package.json: removed Effect CLI dependency returned: ${dependency}`);
  }
}
if (cliPackage.dependencies?.effect === "3.21.2") {
  fail("packages/cli/package.json: Effect v3 CLI dependency returned");
}

failures.push(
  ...proofRegistryFailures({
    coverage,
    rulesSource,
    repoRoot,
    hasAlgorithmicChecker,
    algorithmicCheckerSource,
    algorithmicCheckerComponents,
  }),
);

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log("guard coverage passed");
