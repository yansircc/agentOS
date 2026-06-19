import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runRuleAcceptance, validateRuleAcceptance } from "./check/manifest-rules.mjs";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const manifestPath = path.join(repoRoot, "docs/agent/boundary-rules.source.json");

export const loadBoundaryRules = () => {
  const value = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  validateBoundaryRules(value);
  return value;
};

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

const requiredRuleFields = [
  "id",
  "owner",
  "invariantId",
  "kind",
  "acceptance",
  "diagnostics",
  "paths",
  "commandGroup",
];

const validateBoundaryRules = (value) => {
  const failures = [];
  if (!isRecord(value)) failures.push("boundary rules source must be an object");
  if (value.schemaVersion !== 2) failures.push("boundary rules schemaVersion must be 2");
  if (!isRecord(value.commandGroups)) failures.push("boundary rules must define commandGroups");
  if (!Array.isArray(value.rules)) failures.push("boundary rules must define rules[]");

  const commandGroups = isRecord(value.commandGroups) ? value.commandGroups : {};
  for (const [groupId, steps] of Object.entries(commandGroups)) {
    if (!Array.isArray(steps)) {
      failures.push(`commandGroups.${groupId} must be an array`);
      continue;
    }
    for (const [index, step] of steps.entries()) {
      if (!isRecord(step)) {
        failures.push(`commandGroups.${groupId}[${index}] must be an object`);
        continue;
      }
      if (!["command", "group", "rule"].includes(step.type)) {
        failures.push(`commandGroups.${groupId}[${index}] has invalid type`);
      }
      if (step.type === "command" && typeof step.command !== "string") {
        failures.push(`commandGroups.${groupId}[${index}] command must be a string`);
      }
      if ((step.type === "group" || step.type === "rule") && typeof step.id !== "string") {
        failures.push(`commandGroups.${groupId}[${index}] id must be a string`);
      }
    }
  }

  const seenRules = new Set();
  for (const [index, rule] of (Array.isArray(value.rules) ? value.rules : []).entries()) {
    const label = isRecord(rule) && typeof rule.id === "string" ? rule.id : `rules[${index}]`;
    if (!isRecord(rule)) {
      failures.push(`${label} must be an object`);
      continue;
    }
    for (const field of requiredRuleFields) {
      if (!(field in rule)) failures.push(`${label} missing ${field}`);
    }
    if (typeof rule.id !== "string" || rule.id.length === 0) {
      failures.push(`${label} id must be non-empty`);
    } else if (seenRules.has(rule.id)) {
      failures.push(`duplicate boundary rule ${rule.id}`);
    } else {
      seenRules.add(rule.id);
    }
    validateRuleAcceptance(rule, failures);
    if (!Array.isArray(rule.diagnostics)) failures.push(`${label} diagnostics must be an array`);
    if (!Array.isArray(rule.paths)) failures.push(`${label} paths must be an array`);
    if (typeof rule.commandGroup !== "string" || !(rule.commandGroup in commandGroups)) {
      failures.push(`${label} commandGroup must reference commandGroups`);
    }
  }

  if (failures.length > 0) {
    throw new Error(failures.join("\n"));
  }
};

const ruleById = (manifest, id) => manifest.rules.find((rule) => rule.id === id);

const runShellCommand = (command) => {
  if (/\s--fix(?:\s|$)/u.test(command)) {
    throw new Error(`${command}: check commands must not run fix mode`);
  }
  console.log(`$ ${command}`);
  const result = spawnSync("sh", ["-c", command], {
    cwd: repoRoot,
    env: process.env,
    stdio: "inherit",
  });
  if (result.signal !== null) {
    throw new Error(`${command} terminated by ${result.signal}`);
  }
  if (result.status !== 0) {
    throw new Error(`${command} exited with ${result.status ?? 1}`);
  }
};

const runSteps = async (manifest, steps, stack = []) => {
  for (const step of steps) {
    if (step.type === "command") {
      runShellCommand(step.command);
      continue;
    }
    if (step.type === "group") {
      if (stack.includes(step.id)) {
        throw new Error(`cyclic command group: ${[...stack, step.id].join(" -> ")}`);
      }
      const group = manifest.commandGroups[step.id];
      if (group === undefined) throw new Error(`unknown command group ${step.id}`);
      await runSteps(manifest, group, [...stack, step.id]);
      continue;
    }
    if (step.type === "rule") {
      await runGuard(step.id, manifest);
      continue;
    }
  }
};

export const runGroup = async (id, manifest = loadBoundaryRules()) => {
  const steps = manifest.commandGroups[id];
  if (steps === undefined) throw new Error(`unknown command group ${id}`);
  await runSteps(manifest, steps, [id]);
};

export const runGuard = async (id, manifest = loadBoundaryRules()) => {
  const rule = ruleById(manifest, id);
  if (rule === undefined) throw new Error(`unknown boundary rule ${id}`);
  await runRuleAcceptance(rule);
};

export const listGuards = (manifest = loadBoundaryRules()) =>
  manifest.rules.map((rule) => rule.id).sort((left, right) => left.localeCompare(right));
