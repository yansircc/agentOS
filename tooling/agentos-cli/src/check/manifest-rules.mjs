import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runAlgorithmicChecker } from "./algorithmic-checks.mjs";
import { runCommand } from "./command-runner.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

const allowedEngines = new Set([
  "text",
  "json",
  "importBoundary",
  "generatedProjection",
  "proofClass",
  "algorithmic",
]);

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const stringArray = (value) =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

const read = (relativePath) => fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
const readJson = (relativePath) => JSON.parse(read(relativePath));

const walkFiles = (relativePath) => {
  const absolutePath = path.join(repoRoot, relativePath);
  if (!fs.existsSync(absolutePath)) return [];
  const stat = fs.statSync(absolutePath);
  if (stat.isFile()) return [relativePath];
  const files = [];
  for (const entry of fs.readdirSync(absolutePath, { withFileTypes: true })) {
    const child = path.join(relativePath, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(child));
    if (entry.isFile()) files.push(child);
  }
  return files.map((file) => file.split(path.sep).join("/"));
};

const getJsonPointer = (value, pointer) => {
  if (pointer === "" || pointer === "/") return value;
  return pointer
    .split("/")
    .slice(1)
    .reduce((current, segment) => {
      if (current === undefined || current === null) return undefined;
      const key = segment.replaceAll("~1", "/").replaceAll("~0", "~");
      return current[key];
    }, value);
};

const assertProofClasses = (ruleId, proofClasses) => {
  if (!stringArray(proofClasses) || proofClasses.length === 0) {
    throw new Error(`${ruleId}: proofClass acceptance requires non-empty proofClasses`);
  }
};

const collectTextFailures = (rule) => {
  const failures = [];
  for (const assertion of rule.acceptance.assertions ?? []) {
    const content = read(assertion.path);
    for (const token of assertion.contains ?? []) {
      if (!content.includes(token))
        failures.push(`${assertion.path}: missing ${JSON.stringify(token)}`);
    }
    for (const token of assertion.notContains ?? []) {
      if (content.includes(token))
        failures.push(`${assertion.path}: forbidden ${JSON.stringify(token)}`);
    }
    for (const pattern of assertion.matches ?? []) {
      if (!new RegExp(pattern, "u").test(content)) {
        failures.push(`${assertion.path}: missing pattern ${pattern}`);
      }
    }
    for (const pattern of assertion.notMatches ?? []) {
      if (new RegExp(pattern, "u").test(content)) {
        failures.push(`${assertion.path}: forbidden pattern ${pattern}`);
      }
    }
  }
  return failures;
};

const collectJsonFailures = (rule) => {
  const failures = [];
  for (const assertion of rule.acceptance.assertions ?? []) {
    const value = getJsonPointer(readJson(assertion.path), assertion.pointer ?? "/");
    if ("equals" in assertion && JSON.stringify(value) !== JSON.stringify(assertion.equals)) {
      failures.push(
        `${assertion.path}${assertion.pointer ?? ""}: expected ${JSON.stringify(assertion.equals)}`,
      );
    }
    if (assertion.keysExactly !== undefined) {
      const actual = isRecord(value)
        ? Object.keys(value).sort((left, right) => left.localeCompare(right))
        : [];
      const expected = [...assertion.keysExactly].sort((left, right) => left.localeCompare(right));
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        failures.push(
          `${assertion.path}${assertion.pointer ?? ""}: keys must be exactly ${expected.join(", ")}`,
        );
      }
    }
    if (assertion.requiredKeys !== undefined) {
      const actual = isRecord(value) ? new Set(Object.keys(value)) : new Set();
      for (const key of assertion.requiredKeys) {
        if (!actual.has(key))
          failures.push(`${assertion.path}${assertion.pointer ?? ""}: missing key ${key}`);
      }
    }
  }
  return failures;
};

const importSpecifiers = (source) => {
  const specifiers = [];
  const regex =
    /\b(?:import|export)\s+(?:[^"'`]*?\s+from\s+)?["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)/gu;
  for (const match of source.matchAll(regex)) specifiers.push(match[1] ?? match[2]);
  return specifiers;
};

const collectImportBoundaryFailures = (rule) => {
  const failures = [];
  const roots = rule.acceptance.roots ?? [];
  const forbiddenSpecPrefixes = rule.acceptance.forbiddenSpecPrefixes ?? [];
  const forbiddenRelativeRoots = (rule.acceptance.forbiddenRelativeRoots ?? []).map((entry) =>
    path.resolve(repoRoot, entry),
  );
  for (const root of roots) {
    for (const file of walkFiles(root).filter((entry) => /\.(?:mjs|js|ts|tsx)$/u.test(entry))) {
      const source = read(file);
      for (const specifier of importSpecifiers(source)) {
        if (forbiddenSpecPrefixes.some((prefix) => specifier.startsWith(prefix))) {
          failures.push(`${file}: forbidden package import ${specifier}`);
        }
        if (specifier.startsWith(".")) {
          const resolved = path.resolve(path.dirname(path.join(repoRoot, file)), specifier);
          if (
            forbiddenRelativeRoots.some(
              (rootPath) => resolved === rootPath || resolved.startsWith(`${rootPath}${path.sep}`),
            )
          ) {
            failures.push(`${file}: forbidden relative import ${specifier}`);
          }
        }
      }
    }
  }
  return failures;
};

export const validateRuleAcceptance = (rule, failures) => {
  if (!isRecord(rule.acceptance)) {
    failures.push(`${rule.id}: missing acceptance`);
    return;
  }
  if (!allowedEngines.has(rule.acceptance.engine)) {
    failures.push(`${rule.id}: acceptance.engine must be one of ${[...allowedEngines].join(", ")}`);
  }
  if (rule.acceptance.engine === "proofClass") {
    try {
      assertProofClasses(rule.id, rule.acceptance.proofClasses);
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (rule.acceptance.engine === "algorithmic") {
    if (typeof rule.acceptance.checker !== "string" || rule.acceptance.checker.length === 0) {
      failures.push(`${rule.id}: algorithmic acceptance requires checker`);
    }
    if (typeof rule.acceptance.reason !== "string" || rule.acceptance.reason.length === 0) {
      failures.push(`${rule.id}: algorithmic acceptance requires reason`);
    }
    if (rule.acceptance.packageCommands !== undefined) {
      failures.push(`${rule.id}: algorithmic acceptance must not execute packageCommands`);
    }
  }
  if (rule.acceptance.engine === "generatedProjection") {
    if (
      typeof rule.acceptance.command !== "string" ||
      !/\s--check(?:\s|$)/u.test(rule.acceptance.command)
    ) {
      failures.push(`${rule.id}: generatedProjection acceptance requires a --check command`);
    }
  }
};

export const runRuleAcceptance = async (rule) => {
  switch (rule.acceptance.engine) {
    case "proofClass":
      assertProofClasses(rule.id, rule.acceptance.proofClasses);
      return;
    case "algorithmic":
      await runAlgorithmicChecker(rule.acceptance.checker);
      return;
    case "text": {
      const failures = collectTextFailures(rule);
      if (failures.length > 0) throw new Error(failures.join("\n"));
      return;
    }
    case "json": {
      const failures = collectJsonFailures(rule);
      if (failures.length > 0) throw new Error(failures.join("\n"));
      return;
    }
    case "importBoundary": {
      const failures = collectImportBoundaryFailures(rule);
      if (failures.length > 0) throw new Error(failures.join("\n"));
      return;
    }
    case "generatedProjection":
      if (
        typeof rule.acceptance.command !== "string" ||
        !/\s--check(?:\s|$)/u.test(rule.acceptance.command)
      ) {
        throw new Error(`${rule.id}: generatedProjection acceptance requires a --check command`);
      }
      runCommand(rule.acceptance.command, { cwd: repoRoot });
      return;
    default:
      throw new Error(`${rule.id}: unsupported acceptance engine ${rule.acceptance.engine}`);
  }
};
