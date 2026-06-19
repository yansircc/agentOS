#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listAlgorithmicCheckers } from "./algorithmic-checks.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

const readJson = (relativePath) =>
  JSON.parse(fs.readFileSync(path.join(repoRoot, relativePath), "utf8"));

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

const failures = [];
const fail = (message) => failures.push(message);

const coverage = readJson("tooling/agentos-cli/src/check/check-coverage.source.json");
const rulesSource = readJson("docs/agent/boundary-rules.source.json");
const cliPackage = readJson("tooling/agentos-cli/package.json");

if (coverage.schemaVersion !== 1) fail("check coverage schemaVersion must be 1");
if (!Array.isArray(coverage.entries) || coverage.entries.length === 0) {
  fail("check coverage entries must be non-empty");
}

const rules = new Map((rulesSource.rules ?? []).map((rule) => [rule.id, rule]));
const algorithmicCheckers = new Set(listAlgorithmicCheckers());
const coveredRuleIds = new Set();

for (const [index, entry] of (coverage.entries ?? []).entries()) {
  const label =
    isRecord(entry) && typeof entry.ruleId === "string" ? entry.ruleId : `entry[${index}]`;
  if (!isRecord(entry)) {
    fail(`${label}: coverage entry must be an object`);
    continue;
  }
  if (!isRecord(entry.source)) fail(`${label}: missing source`);
  if (!isRecord(entry.target)) fail(`${label}: missing target`);
  if (!Array.isArray(entry.assertions) || entry.assertions.length === 0) {
    fail(`${label}: assertions must be non-empty`);
  } else {
    for (const [assertionIndex, assertion] of entry.assertions.entries()) {
      if (!isRecord(assertion)) {
        fail(`${label}: assertions[${assertionIndex}] must be an object`);
        continue;
      }
      if (
        typeof assertion.failureCondition !== "string" ||
        assertion.failureCondition.length === 0
      ) {
        fail(`${label}: assertions[${assertionIndex}] missing failureCondition`);
      }
      if (typeof assertion.negativeWitness !== "string" || assertion.negativeWitness.length === 0) {
        fail(`${label}: assertions[${assertionIndex}] missing negativeWitness`);
      }
    }
  }

  if (typeof entry.ruleId === "string" && entry.ruleId.includes(",")) {
    for (const ruleId of entry.ruleId.split(",")) coveredRuleIds.add(ruleId);
  } else if (typeof entry.ruleId === "string") {
    coveredRuleIds.add(entry.ruleId);
  }

  if (entry.target?.kind === "algorithmic") {
    const rule = rules.get(entry.target.ruleId);
    if (!isRecord(rule)) {
      fail(`${label}: algorithmic target references unknown rule ${entry.target.ruleId}`);
    } else if (rule.acceptance?.engine !== "algorithmic") {
      fail(`${label}: algorithmic target rule must use algorithmic acceptance`);
    } else if (rule.acceptance.checker !== entry.target.checker) {
      fail(`${label}: coverage checker ${entry.target.checker} does not match rule acceptance`);
    }
    if (!algorithmicCheckers.has(entry.target.checker)) {
      fail(`${label}: missing algorithmic checker ${entry.target.checker}`);
    }
  }

  if (entry.target?.kind === "packageCommand") {
    const rule = rules.get(entry.target.ruleId);
    if (!isRecord(rule)) {
      fail(`${label}: packageCommand target references unknown rule ${entry.target.ruleId}`);
    } else if (rule.acceptance?.engine !== "packageCommand") {
      fail(`${label}: packageCommand target rule must use packageCommand acceptance`);
    }
  }

  if (entry.target?.kind === "manifestRule") {
    const rule = rules.get(entry.target.ruleId);
    if (!isRecord(rule)) {
      fail(`${label}: manifestRule target references unknown rule ${entry.target.ruleId}`);
    } else if (rule.acceptance?.engine !== entry.target.engine) {
      fail(`${label}: manifestRule target engine must match rule acceptance`);
    }
  }

  if (entry.target?.kind === "algorithmic-helper") {
    for (const checker of entry.target.checkers ?? []) {
      if (!algorithmicCheckers.has(checker))
        fail(`${label}: helper references unknown checker ${checker}`);
    }
  }
}

for (const rule of rulesSource.rules ?? []) {
  if (!coveredRuleIds.has(rule.id)) fail(`${rule.id}: rule lacks check coverage entry`);
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

const walk = (relativePath) => {
  const absolutePath = path.join(repoRoot, relativePath);
  const files = [];
  for (const entry of fs.readdirSync(absolutePath, { withFileTypes: true })) {
    const child = path.join(relativePath, entry.name);
    if (entry.isDirectory()) files.push(...walk(child));
    if (entry.isFile()) files.push(child.split(path.sep).join("/"));
  }
  return files;
};

const cliMjsFiles = walk("tooling/agentos-cli/src").filter((file) => file.endsWith(".mjs"));
const checkMjsFiles = cliMjsFiles.filter((file) =>
  file.startsWith("tooling/agentos-cli/src/check/"),
);
if (cliMjsFiles.length > 15) {
  fail(`tooling/agentos-cli/src: expected at most 15 .mjs files; observed ${cliMjsFiles.length}`);
}
if (checkMjsFiles.length > 12) {
  fail(
    `tooling/agentos-cli/src/check: expected at most 12 .mjs files; observed ${checkMjsFiles.length}`,
  );
}
for (const file of checkMjsFiles) {
  const content = fs.readFileSync(path.join(repoRoot, file), "utf8");
  const selfTestFlag = "--" + "self-test";
  if (content.includes(selfTestFlag)) fail(`${file}: per-checker self-test flag is not allowed`);
  const harnessPattern = new RegExp(
    [
      "mkd" + "te" + "mp",
      "tm" + "pdir",
      "fix" + "ture",
      "with" + "Fix" + "ture",
      "Tem" + "por" + "ary",
      "te" + "mp",
    ].join("|"),
    "i",
  );
  if (harnessPattern.test(content)) {
    fail(`${file}: per-checker ad hoc harness is not allowed`);
  }
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
    fail(`tooling/agentos-cli/package.json: removed Effect CLI dependency returned: ${dependency}`);
  }
}
if (cliPackage.dependencies?.effect === "3.21.2") {
  fail("tooling/agentos-cli/package.json: Effect v3 CLI dependency returned");
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log("guard coverage passed");
