#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const allowedClasses = new Set(["contract", "policy", "closed"]);

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

const hasText = (value) => typeof value === "string" && value.trim().length > 0;

const sourceFileOf = (sourcePath) => sourcePath.split("#", 1)[0];

export const collectLimitRegistryFailures = (root = repoRoot) => {
  const failures = [];
  const registryPath = path.join(root, "docs/limits.json");
  if (!fs.existsSync(registryPath)) {
    return ["docs/limits.json is missing"];
  }

  const registry = readJson(registryPath);
  if (!Number.isInteger(registry.version) || registry.version <= 0) {
    failures.push("docs/limits.json version must be a positive integer");
  }
  if (!Array.isArray(registry.limits) || registry.limits.length === 0) {
    failures.push("docs/limits.json limits must be a non-empty array");
    return failures;
  }

  const seen = new Set();
  for (const [index, limit] of registry.limits.entries()) {
    const prefix = `limits[${index}]`;
    if (limit === null || typeof limit !== "object" || Array.isArray(limit)) {
      failures.push(`${prefix}: expected object`);
      continue;
    }

    const id = limit.id;
    if (!hasText(id)) {
      failures.push(`${prefix}.id: required`);
    } else {
      if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u.test(id)) {
        failures.push(`${prefix}.id: expected stable lowercase dotted identifier`);
      }
      if (seen.has(id)) failures.push(`${prefix}.id: duplicate ${id}`);
      seen.add(id);
    }

    const kind = limit.class;
    if (!allowedClasses.has(kind)) {
      failures.push(`${id ?? prefix}.class: expected contract, policy, or closed`);
    }

    for (const field of ["owner", "value", "reason"]) {
      if (!hasText(limit[field])) failures.push(`${id ?? prefix}.${field}: required`);
    }

    if (!Array.isArray(limit.sourcePaths) || limit.sourcePaths.length === 0) {
      failures.push(`${id ?? prefix}.sourcePaths: non-empty array required`);
    } else {
      for (const sourcePath of limit.sourcePaths) {
        if (!hasText(sourcePath)) {
          failures.push(`${id ?? prefix}.sourcePaths: entries must be non-empty strings`);
          continue;
        }
        if (path.isAbsolute(sourcePath) || sourcePath.includes("..")) {
          failures.push(`${id ?? prefix}.sourcePaths: ${sourcePath} must be repo-relative`);
          continue;
        }
        const file = path.join(root, sourceFileOf(sourcePath));
        if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
          failures.push(`${id ?? prefix}.sourcePaths: ${sourcePath} does not point to a file`);
        }
      }
    }

    if (kind === "policy" && !hasText(limit.overrideSurface)) {
      failures.push(
        `${id ?? prefix}.overrideSurface: policy limits require an ordinary override surface`,
      );
    }
    if ((kind === "contract" || kind === "closed") && limit.overrideSurface !== undefined) {
      failures.push(
        `${id ?? prefix}.overrideSurface: ${kind} limits must not expose ordinary overrides`,
      );
    }
    if (kind !== "closed" && limit.capabilityGate !== undefined) {
      failures.push(
        `${id ?? prefix}.capabilityGate: only closed limits may declare capability gates`,
      );
    }
    if (kind === "closed" && limit.capabilityGate !== undefined && !hasText(limit.capabilityGate)) {
      failures.push(`${id ?? prefix}.capabilityGate: must be non-empty when present`);
    }
  }

  return failures;
};

const writeFixture = (root, limits) => {
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src/source.ts"), "export const value = 1;\n");
  fs.writeFileSync(
    path.join(root, "docs/limits.json"),
    JSON.stringify({ version: 1, limits }, null, 2) + "\n",
  );
};

const collectSelfTestFailures = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentos-limit-registry-"));
  try {
    const valid = [
      {
        id: "schema.contract",
        class: "contract",
        owner: "schema",
        sourcePaths: ["src/source.ts"],
        value: "closed vocabulary",
        reason: "schema owns legal input space",
      },
      {
        id: "runtime.policy",
        class: "policy",
        owner: "runtime",
        sourcePaths: ["src/source.ts"],
        value: "default 1",
        overrideSurface: "SubmitSpec.policy",
        reason: "per-run quality knob",
      },
      {
        id: "sandbox.closed",
        class: "closed",
        owner: "sandbox",
        sourcePaths: ["src/source.ts"],
        value: "network disabled",
        capabilityGate: "host allowlist",
        reason: "security boundary",
      },
    ];
    writeFixture(root, valid);
    const baseline = collectLimitRegistryFailures(root);
    if (baseline.length > 0) {
      return [`limit registry self-test positive fixture failed:\n${baseline.join("\n")}`];
    }

    const failures = [];

    writeFixture(
      root,
      valid.map((entry) =>
        entry.id === "runtime.policy" ? { ...entry, overrideSurface: "" } : entry,
      ),
    );
    const missingOverride = collectLimitRegistryFailures(root);
    if (!missingOverride.some((failure) => failure.includes("policy limits require"))) {
      failures.push(
        `missing policy override mutation was not rejected: ${JSON.stringify(missingOverride)}`,
      );
    }

    writeFixture(
      root,
      valid.map((entry) =>
        entry.id === "sandbox.closed" ? { ...entry, overrideSurface: "SubmitSpec.closed" } : entry,
      ),
    );
    const closedOverride = collectLimitRegistryFailures(root);
    if (!closedOverride.some((failure) => failure.includes("must not expose ordinary overrides"))) {
      failures.push(`closed override mutation was not rejected: ${JSON.stringify(closedOverride)}`);
    }

    writeFixture(
      root,
      valid.map((entry) =>
        entry.id === "schema.contract" ? { ...entry, class: "default" } : entry,
      ),
    );
    const invalidClass = collectLimitRegistryFailures(root);
    if (!invalidClass.some((failure) => failure.includes("expected contract, policy, or closed"))) {
      failures.push(`invalid class mutation was not rejected: ${JSON.stringify(invalidClass)}`);
    }

    writeFixture(
      root,
      valid.map((entry) =>
        entry.id === "schema.contract" ? { ...entry, sourcePaths: ["src/missing.ts"] } : entry,
      ),
    );
    const missingSource = collectLimitRegistryFailures(root);
    if (!missingSource.some((failure) => failure.includes("does not point to a file"))) {
      failures.push(`missing source mutation was not rejected: ${JSON.stringify(missingSource)}`);
    }

    return failures;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
};

const failures = process.argv.includes("--self-test")
  ? collectSelfTestFailures()
  : collectLimitRegistryFailures(repoRoot);

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(
  process.argv.includes("--self-test")
    ? "limit registry self-test passed"
    : "limit registry passed",
);
