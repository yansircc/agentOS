import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

const parseArgs = (rawArgs, defaultRepoRoot) => {
  const args = {
    repo: defaultRepoRoot,
    evidence: path.join(os.tmpdir(), "agentos-effect-scan"),
    scanner: "effect-skill-scan",
  };
  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    switch (arg) {
      case "--repo":
        if (rawArgs[index + 1] === undefined) throw new Error("--repo requires a path");
        args.repo = rawArgs[index + 1];
        index += 1;
        break;
      case "--evidence":
        if (rawArgs[index + 1] === undefined) throw new Error("--evidence requires a path");
        args.evidence = rawArgs[index + 1];
        index += 1;
        break;
      case "--scanner":
        if (rawArgs[index + 1] === undefined) throw new Error("--scanner requires a command");
        args.scanner = rawArgs[index + 1];
        index += 1;
        break;
      default:
        throw new Error(`unexpected argument ${arg}`);
    }
  }
  return {
    repo: path.resolve(args.repo),
    evidence: path.resolve(args.evidence),
    scanner: args.scanner,
  };
};

export const validateEffectScanGateJson = (value) => {
  const failures = [];
  if (!isRecord(value)) return ["effect scan gate-json must be an object"];
  if (value.schemaVersion !== 1) failures.push("effect scan gate-json schemaVersion must be 1");
  if (typeof value.ok !== "boolean") failures.push("effect scan gate-json ok must be boolean");
  if (!isRecord(value.tiers)) {
    failures.push("effect scan gate-json tiers object is required");
    return failures;
  }
  if (!Array.isArray(value.tiers.block)) {
    failures.push("effect scan gate-json tiers.block array is required");
  }
  if (!Array.isArray(value.tiers.report)) {
    failures.push("effect scan gate-json tiers.report array is required");
  }
  if (!isRecord(value.tiers.review)) {
    failures.push("effect scan gate-json tiers.review object is required");
  }
  return failures;
};

const effectScanBlockCount = (value) =>
  isRecord(value) && isRecord(value.tiers) && Array.isArray(value.tiers.block)
    ? value.tiers.block.length
    : 0;

export const effectScanGateFailures = (value, processExitCode) => {
  const validationFailures = validateEffectScanGateJson(value);
  if (validationFailures.length > 0) return validationFailures;
  const failures = [];
  const blockCount = effectScanBlockCount(value);
  if (value.ok !== true) {
    failures.push("effect scan gate-json ok is false");
  }
  if (blockCount > 0) {
    failures.push(`effect scan gate-json contains ${blockCount} scanner-owned block finding(s)`);
  }
  if (processExitCode !== 0 && value.ok === true && blockCount === 0) {
    failures.push(
      `effect scan process exited ${processExitCode} while gate-json reported no block findings`,
    );
  }
  return failures;
};

const parseGateJson = (stdout) => {
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(
      `effect scan did not emit parseable gate-json: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

export const runEffectScanGate = (rawArgs, options) => {
  const args = parseArgs(rawArgs, options.defaultRepoRoot);
  fs.rmSync(args.evidence, { recursive: true, force: true });
  fs.mkdirSync(args.evidence, { recursive: true });
  const result = spawnSync(
    args.scanner,
    [args.repo, "--strict", "--output", "gate-json", "--evidence", args.evidence],
    {
      cwd: args.repo,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  if (result.error !== undefined) {
    throw new Error(`effect scan failed to start: ${result.error.message}`);
  }
  const projection = parseGateJson(result.stdout);
  process.stdout.write(`${JSON.stringify(projection, null, 2)}\n`);
  if (result.stderr.length > 0) process.stderr.write(result.stderr);
  const failures = effectScanGateFailures(projection, result.status ?? 1);
  if (failures.length > 0) {
    throw new Error(`agentos check effect-scan: ${failures.join("; ")}`);
  }
};
