import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  algorithmicCheckerComponents,
  algorithmicCheckerSource,
  hasAlgorithmicChecker,
} from "./algorithmic-checks.mjs";
import { proofRegistryFailures } from "./proof-registry.mjs";

const defaultRepoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const ansi = /\u001b\[[0-?]*[ -/]*[@-~]/gu;
const validatedRegistries = new WeakMap();

const cleanOutput = (value) => String(value ?? "").replace(ansi, "");
const combinedOutput = (result) => `${cleanOutput(result.stdout)}${cleanOutput(result.stderr)}`;
const readJson = (root, relativePath) =>
  JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8"));
const deepFreeze = (value) => {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
};

export const runProofCommand = ({ root, command }) => {
  const [rawExecutable, ...args] = command.argv;
  const executable = rawExecutable === "node" ? process.execPath : rawExecutable;
  return spawnSync(executable, args, {
    cwd: path.join(root, command.cwd),
    encoding: "utf8",
    shell: false,
    env: {
      ...process.env,
      CI: "true",
      PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN: "false",
    },
    maxBuffer: 64 * 1024 * 1024,
  });
};

export const assertProofResult = ({ result, expected, label }) => {
  if (result.error !== undefined) throw result.error;
  if (result.status !== expected.exitCode) {
    throw new Error(
      `${label}: expected exit ${expected.exitCode}, observed ${String(result.status)}\n${combinedOutput(result)}`,
    );
  }
  const output = combinedOutput(result);
  if (expected.outputIncludes !== undefined && !output.includes(expected.outputIncludes)) {
    throw new Error(`${label}: missing diagnostic ${expected.outputIncludes}\n${output}`);
  }
  if (expected.minPassedTests !== undefined) {
    const counts = [...output.matchAll(/Tests\s+(\d+) passed/gu)].map((match) => Number(match[1]));
    if (counts.length === 0 || Math.max(...counts) < expected.minPassedTests) {
      throw new Error(`${label}: focused package test did not execute\n${output}`);
    }
  }
};

export const readValidatedProofRegistry = (root = defaultRepoRoot) => {
  const canonicalRoot = fs.realpathSync(root);
  const coverage = readJson(canonicalRoot, "packages/cli/src/check/check-coverage.source.json");
  const rulesSource = readJson(canonicalRoot, "docs/agent/boundary-rules.source.json");
  const failures = proofRegistryFailures({
    coverage,
    rulesSource,
    repoRoot: canonicalRoot,
    hasAlgorithmicChecker,
    algorithmicCheckerSource,
    algorithmicCheckerComponents,
  });
  if (failures.length > 0) throw new Error(`invalid proof registry:\n${failures.join("\n")}`);
  const registry = deepFreeze({ coverage, rulesSource });
  validatedRegistries.set(registry, canonicalRoot);
  return registry;
};

export const runPositiveProof = ({
  root,
  entry,
  label = `${entry.ruleId} positive proof`,
  writeOutput = false,
}) => {
  const result = runProofCommand({ root, command: entry.proof.command });
  assertProofResult({
    result,
    expected: {
      exitCode: entry.proof.positive.expectedExitCode,
      minPassedTests: entry.proof.positive.minPassedTests,
    },
    label,
  });
  if (writeOutput) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  }
  return result;
};

const registeredEntry = ({ registry, ruleId }) => {
  const entry = registry.coverage.entries.find((candidate) => candidate.ruleId === ruleId);
  if (entry === undefined) throw new Error(`unknown proof registry rule ${ruleId}`);
  return entry;
};

export const runRegisteredProof = ({
  root = defaultRepoRoot,
  ruleId,
  registry = readValidatedProofRegistry(root),
  execution = "direct",
  writeOutput = true,
}) => {
  const canonicalRoot = fs.realpathSync(root);
  if (validatedRegistries.get(registry) !== canonicalRoot) {
    throw new Error("proof execution requires a validated registry for the execution root");
  }
  const entry = registeredEntry({ registry, ruleId });
  if (execution === "structural" && entry.proof.kind === "packageTest") {
    return { entry, executed: false };
  }
  if (execution !== "direct" && execution !== "structural") {
    throw new Error(`unknown proof execution class ${execution}`);
  }
  return {
    entry,
    executed: true,
    result: runPositiveProof({ root: canonicalRoot, entry, writeOutput }),
  };
};
