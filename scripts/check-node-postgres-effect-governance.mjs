#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

const packagePath = "packages/backends/node-postgres";
const sourceRoot = `${packagePath}/src`;
const terminalAdapter = {
  packagePath: "src/host.ts",
  repoPath: `${sourceRoot}/host.ts`,
  owner: "@agent-os/backend-node-postgres/psql-host-adapter",
  reasonTokens: [
    "terminal",
    "Node/Postgres",
    "psql CLI",
    "Promise",
    "child_process",
    "timeout",
    "system clock",
    "fail-fast",
  ],
  rules: ["EFF001", "EFF002", "EFF004", "EFF022", "EFF024", "EFF025", "EFF026"],
};

const rootScriptName = "test:node-postgres-effect-governance";
const rootScriptValue =
  "node scripts/check-node-postgres-effect-governance.mjs --self-test && node scripts/check-node-postgres-effect-governance.mjs";

const sourceExtensions = /\.(?:ts|tsx|mts|cts)$/u;
const ignoredDirs = new Set(["node_modules", "dist", ".git"]);

const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

const toRepoPath = (root, file) => path.relative(root, file).split(path.sep).join("/");

const lineNumber = (source, index) => source.slice(0, index).split("\n").length;

const stableJson = (value) =>
  `${JSON.stringify(value, null, 2).replace(
    /\[\n((?:\s+"(?:\\.|[^"\\])*",?\n)+)\s+\]/gu,
    (match, body) => {
      const items = body
        .trim()
        .split("\n")
        .map((line) => line.trim().replace(/,$/u, ""));
      return items.every((item) => item.startsWith('"') && item.endsWith('"'))
        ? `[${items.join(", ")}]`
        : match;
    },
  )}\n`;

const readText = (root, relativePath, failures) => {
  const file = path.join(root, relativePath);
  if (!fs.existsSync(file)) {
    failures.push(`${relativePath}: missing`);
    return null;
  }
  return fs.readFileSync(file, "utf8");
};

const readJson = (root, relativePath, failures) => {
  const source = readText(root, relativePath, failures);
  if (source === null) return null;
  try {
    return JSON.parse(source);
  } catch (cause) {
    failures.push(
      `${relativePath}: invalid JSON: ${cause instanceof Error ? cause.message : cause}`,
    );
    return null;
  }
};

const arraysEqual = (left, right) =>
  Array.isArray(left) &&
  Array.isArray(right) &&
  left.length === right.length &&
  left.every((value, index) => value === right[index]);

const jsonEqual = (left, right) => JSON.stringify(left) === JSON.stringify(right);

const sourceFiles = (root, relativeRoot) => {
  const files = [];
  const visit = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!ignoredDirs.has(entry.name)) visit(file);
        continue;
      }
      if (sourceExtensions.test(entry.name) && !entry.name.endsWith(".d.ts")) {
        files.push(file);
      }
    }
  };
  visit(path.join(root, relativeRoot));
  return files.sort((left, right) => left.localeCompare(right));
};

const expectedNodePostgresManifest = () => ({
  shape: ["library"],
  allowedAdapters: [
    {
      path: terminalAdapter.packagePath,
      owner: terminalAdapter.owner,
      reason:
        "terminal Node/Postgres psql CLI host adapter owns Promise callback bridging, child_process execution, psql timeout, system clock, and fail-fast process/JSON parse failure mapping",
      rules: terminalAdapter.rules,
    },
  ],
});

const expectedRootAdapter = () => ({
  path: terminalAdapter.repoPath,
  owner: terminalAdapter.owner,
  reason:
    "terminal Node/Postgres psql CLI host adapter owns Promise callback bridging, child_process execution, psql timeout, system clock, and fail-fast process/JSON parse failure mapping",
  rules: terminalAdapter.rules,
});

const validateAdapterDeclaration = (adapter, expected, label, failures) => {
  if (!isRecord(adapter)) {
    failures.push(`${label}: adapter declaration must be an object`);
    return;
  }
  if (adapter.path !== expected.path) {
    failures.push(`${label}: adapter path must be ${expected.path}`);
  }
  if (adapter.owner !== expected.owner) {
    failures.push(`${label}: adapter owner must be ${expected.owner}`);
  }
  if (!arraysEqual(adapter.rules, expected.rules)) {
    failures.push(`${label}: adapter rules must be ${expected.rules.join(",")}`);
  }
  const reason = typeof adapter.reason === "string" ? adapter.reason : "";
  for (const token of terminalAdapter.reasonTokens) {
    if (!reason.includes(token)) {
      failures.push(`${label}: adapter reason missing ${token}`);
    }
  }
};

const collectManifestFailures = (root, failures) => {
  const packageJson = readJson(root, "package.json", failures);
  if (
    !isRecord(packageJson) ||
    !isRecord(packageJson.scripts) ||
    packageJson.scripts[rootScriptName] !== rootScriptValue
  ) {
    failures.push(`package.json: missing exact ${rootScriptName} acceptance script`);
  }

  const effectSource = readJson(root, "docs/effect-skill.json", failures);
  if (!isRecord(effectSource)) return null;

  const rootAdapters = Array.isArray(effectSource.root?.allowedAdapters)
    ? effectSource.root.allowedAdapters
    : [];
  const nodeRootAdapters = rootAdapters.filter(
    (adapter) =>
      isRecord(adapter) && typeof adapter.path === "string" && adapter.path.startsWith(packagePath),
  );
  if (nodeRootAdapters.length !== 1) {
    failures.push(
      `docs/effect-skill.json: root scanner must declare exactly one Node/Postgres terminal adapter`,
    );
  } else {
    validateAdapterDeclaration(
      nodeRootAdapters[0],
      expectedRootAdapter(),
      "docs/effect-skill.json root allowedAdapters",
      failures,
    );
  }

  const nodeManifest = effectSource.packageManifests?.[packagePath];
  if (!isRecord(nodeManifest)) {
    failures.push(`docs/effect-skill.json: missing ${packagePath} package scanner manifest`);
    return null;
  }

  if (!arraysEqual(nodeManifest.shape, ["library"])) {
    failures.push(`docs/effect-skill.json: ${packagePath} shape must stay ["library"]`);
  }

  const adapters = Array.isArray(nodeManifest.allowedAdapters)
    ? nodeManifest.allowedAdapters
    : null;
  if (adapters === null || adapters.length !== 1) {
    failures.push(
      `docs/effect-skill.json: ${packagePath} must declare exactly one terminal adapter`,
    );
    return nodeManifest;
  }

  validateAdapterDeclaration(
    adapters[0],
    expectedNodePostgresManifest().allowedAdapters[0],
    `docs/effect-skill.json ${packagePath}`,
    failures,
  );

  const generatedManifest = readJson(root, `${packagePath}/.effect-skill.json`, failures);
  if (generatedManifest !== null && !jsonEqual(generatedManifest, nodeManifest)) {
    failures.push(`${packagePath}/.effect-skill.json: generated package scanner manifest is stale`);
  }

  return nodeManifest;
};

const requiredTerminalSignals = [
  { name: "child_process import", pattern: /from\s+["']node:child_process["']/u },
  { name: "psql ON_ERROR_STOP", pattern: /ON_ERROR_STOP=1/u },
  { name: "Promise callback bridge", pattern: /\bnew\s+Promise(?:<[^>]+>)?\s*\(/u },
  { name: "timeout", pattern: /\bsetTimeout\s*\(/u },
  { name: "timeout kill", pattern: /\.kill\s*\(\s*["']SIGTERM["']\s*\)/u },
  { name: "system clock", pattern: /\bDate\.now\s*\(/u },
  { name: "host failure mapping", pattern: /\bnew\s+SqlError\b/u },
];

const forbiddenOutsideTerminal = [
  {
    name: "child_process import",
    pattern:
      /\bfrom\s+["'](?:node:)?child_process["']|\bimport\s*\(\s*["'](?:node:)?child_process["']\s*\)/gu,
  },
  { name: "host timeout", pattern: /\b(?:setTimeout|clearTimeout)\s*\(/gu },
  { name: "host clock", pattern: /\bDate\.now\s*\(/gu },
  { name: "Promise constructor", pattern: /\bnew\s+Promise(?:<[^>]+>)?\s*\(/gu },
  { name: "process termination", pattern: /\.kill\s*\(\s*["']SIGTERM["']\s*\)/gu },
];

const collectSourceFailures = (root, failures) => {
  const oldSqlPath = `${sourceRoot}/sql.ts`;
  if (fs.existsSync(path.join(root, oldSqlPath))) {
    failures.push(
      `${oldSqlPath}: legacy host adapter path must not exist; use ${terminalAdapter.repoPath}`,
    );
  }

  const terminalSource = readText(root, terminalAdapter.repoPath, failures);
  if (terminalSource !== null) {
    for (const signal of requiredTerminalSignals) {
      if (!signal.pattern.test(terminalSource)) {
        failures.push(`${terminalAdapter.repoPath}: missing terminal ${signal.name}`);
      }
    }
  }

  const entrySource = readText(root, `${sourceRoot}/index.ts`, failures);
  if (entrySource !== null && !/from\s+["']\.\/host["']/u.test(entrySource)) {
    failures.push(
      `${sourceRoot}/index.ts: backend must consume the declared terminal host adapter`,
    );
  }

  for (const file of sourceFiles(root, sourceRoot)) {
    const repoPath = toRepoPath(root, file);
    if (repoPath === terminalAdapter.repoPath) continue;
    const source = fs.readFileSync(file, "utf8");
    for (const forbidden of forbiddenOutsideTerminal) {
      for (const match of source.matchAll(forbidden.pattern)) {
        failures.push(
          `${repoPath}:${lineNumber(source, match.index ?? 0)}: non-terminal Node/Postgres source owns ${forbidden.name}; move it behind ${terminalAdapter.repoPath}`,
        );
      }
    }
  }
};

export const collectFailures = (root = repoRoot) => {
  const failures = [];
  collectManifestFailures(root, failures);
  collectSourceFailures(root, failures);
  return failures;
};

const writeFixture = (root, relativePath, source) => {
  const file = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, source);
};

const writeJsonFixture = (root, relativePath, value) =>
  writeFixture(root, relativePath, stableJson(value));

const positiveEffectSource = () => ({
  root: { allowedAdapters: [expectedRootAdapter()] },
  packageManifests: {
    [packagePath]: expectedNodePostgresManifest(),
  },
});

const positivePackageJson = () => ({
  type: "module",
  scripts: {
    [rootScriptName]: rootScriptValue,
  },
});

const positiveHostSource = `import { spawn } from "node:child_process";
import { SqlError } from "@agent-os/kernel/errors";

export const systemTimeNow = () => Date.now();

export class PsqlCli {
  run(script) {
    return new Promise((resolve, reject) => {
      const child = spawn("psql", ["--set", "ON_ERROR_STOP=1"]);
      const timeout = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new SqlError({ cause: new Error("psql timed out") }));
      }, 30_000);
      child.on("close", () => {
        clearTimeout(timeout);
        resolve(script);
      });
    });
  }
}
`;

const positiveIndexSource = `import { PsqlCli, systemTimeNow } from "./host";

export class NodePostgresBackend {
  #now = systemTimeNow;
  #sql = new PsqlCli();
  log() {
    return { ts: this.#now(), sql: this.#sql };
  }
}
`;

const writePositiveFixture = (root) => {
  writeJsonFixture(root, "package.json", positivePackageJson());
  const effectSource = positiveEffectSource();
  writeJsonFixture(root, "docs/effect-skill.json", effectSource);
  writeJsonFixture(
    root,
    `${packagePath}/.effect-skill.json`,
    effectSource.packageManifests[packagePath],
  );
  writeFixture(root, terminalAdapter.repoPath, positiveHostSource);
  writeFixture(root, `${sourceRoot}/index.ts`, positiveIndexSource);
};

const mutateJsonFixture = (root, relativePath, mutate) => {
  const value = JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8"));
  mutate(value);
  writeJsonFixture(root, relativePath, value);
};

const collectSelfTestFailures = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentos-node-postgres-effect-"));
  try {
    writePositiveFixture(root);
    const baseline = collectFailures(root);
    if (baseline.length > 0) return [`positive fixture failed:\n${baseline.join("\n")}`];

    const cases = [
      {
        name: "missing adapter declaration",
        mutate: () =>
          mutateJsonFixture(root, "docs/effect-skill.json", (value) => {
            value.packageManifests[packagePath].allowedAdapters = [];
          }),
        expected: "must declare exactly one terminal adapter",
      },
      {
        name: "stale generated manifest",
        mutate: () =>
          writeJsonFixture(root, `${packagePath}/.effect-skill.json`, { shape: ["library"] }),
        expected: "generated package scanner manifest is stale",
      },
      {
        name: "host clock leak",
        mutate: () =>
          writeFixture(root, `${sourceRoot}/index.ts`, `${positiveIndexSource}\nDate.now();\n`),
        expected: "non-terminal Node/Postgres source owns host clock",
      },
      {
        name: "legacy sql adapter path",
        mutate: () => writeFixture(root, `${sourceRoot}/sql.ts`, "export const old = true;\n"),
        expected: "legacy host adapter path must not exist",
      },
      {
        name: "extra root-level scanner waiver",
        mutate: () =>
          mutateJsonFixture(root, "docs/effect-skill.json", (value) => {
            value.root.allowedAdapters.push({
              path: `${packagePath}/src/index.ts`,
              owner: "too-broad",
              reason: "bad root waiver",
              rules: ["EFF026"],
            });
          }),
        expected: "root scanner must declare exactly one",
      },
      {
        name: "vague terminal reason",
        mutate: () =>
          mutateJsonFixture(root, "docs/effect-skill.json", (value) => {
            value.packageManifests[packagePath].allowedAdapters[0].reason = "terminal adapter";
          }),
        expected: "adapter reason missing Node/Postgres",
      },
    ];

    const failures = [];
    for (const testCase of cases) {
      fs.rmSync(root, { recursive: true, force: true });
      fs.mkdirSync(root, { recursive: true });
      writePositiveFixture(root);
      testCase.mutate();
      const rejected = collectFailures(root);
      if (!rejected.some((failure) => failure.includes(testCase.expected))) {
        failures.push(
          `${testCase.name}: did not reject mutation; failures=${JSON.stringify(rejected)}`,
        );
      }
    }
    return failures;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
};

const failures = process.argv.includes("--self-test")
  ? collectSelfTestFailures()
  : collectFailures();

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(
  process.argv.includes("--self-test")
    ? "node-postgres Effect governance self-test passed"
    : "node-postgres Effect governance passed",
);
