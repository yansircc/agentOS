#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptPath), "../../..");
const manifestPath = path.join(repoRoot, "dist", "internal-npm", "install-manifest.json");

const usage = () => {
  console.log(`Usage:
  node skills/agentos-release/scripts/bump-and-publish.mjs [options]

Options:
  --version <semver>      Bump root agentOsRelease.version and workspace package versions
  --registry <url>        npm registry, defaults to AGENTOS_NPM_REGISTRY, NPM_CONFIG_REGISTRY, then npmjs
  --access <value>        npm access, defaults to package.json agentOsRelease.npmAccess
  --otp <code>            npm one-time password; NPM_CONFIG_OTP is also honored
  --skip-gates            Do not run bun run check:full
  --skip-pack             Reuse existing dist/internal-npm/install-manifest.json
  --verify-only           Only verify that manifest packages exist at target version
  --dry-run               Print publish commands and use npm publish --dry-run
  --help                  Show this help
`);
};

const fail = (message) => {
  console.error(message);
  process.exit(1);
};

const parseArgs = (argv) => {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      args.help = true;
      continue;
    }
    if (
      arg === "--skip-gates" ||
      arg === "--skip-pack" ||
      arg === "--verify-only" ||
      arg === "--dry-run"
    ) {
      args[arg.slice(2)] = true;
      continue;
    }
    if (
      arg === "--version" ||
      arg === "--registry" ||
      arg === "--access" ||
      arg === "--otp"
    ) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) fail(`${arg} requires a value`);
      args[arg.slice(2)] = value;
      index += 1;
      continue;
    }
    fail(`unknown argument: ${arg}`);
  }
  return args;
};

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

const writeJson = (file, value) => {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
};

const run = (cmd, args, options = {}) => {
  if (options.dryRun === true) {
    console.log(`[dry-run] ${cmd} ${args.map(shellQuote).join(" ")}`);
    return { stdout: "", stderr: "", status: 0 };
  }
  const result = spawnSync(cmd, args, {
    cwd: options.cwd ?? repoRoot,
    env: options.env ?? process.env,
    encoding: "utf8",
    stdio: options.capture === true ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.status !== 0 && options.allowFailure !== true) {
    const detail = options.capture === true ? `\n${result.stdout ?? ""}${result.stderr ?? ""}` : "";
    fail(`${cmd} ${args.join(" ")} failed with exit ${result.status}${detail}`);
  }
  return result;
};

const shellQuote = (value) => {
  if (/^[A-Za-z0-9_./:=@+-]+$/u.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
};

const rootPackagePath = path.join(repoRoot, "package.json");
const rootPackage = () => readJson(rootPackagePath);

const assertSemver = (version) => {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) {
    fail(`invalid semver: ${version}`);
  }
};

const expandWorkspacePattern = (pattern) => {
  if (!pattern.includes("*")) return [path.join(repoRoot, pattern)];
  const segments = pattern.split("/");
  const results = [];
  const walk = (base, rest) => {
    if (rest.length === 0) {
      results.push(base);
      return;
    }
    const [segment, ...tail] = rest;
    if (segment === "*") {
      if (!fs.existsSync(base)) return;
      for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
        if (entry.isDirectory()) walk(path.join(base, entry.name), tail);
      }
      return;
    }
    walk(path.join(base, segment), tail);
  };
  walk(repoRoot, segments);
  return results;
};

const workspacePackageJsonPaths = () => {
  const pkg = rootPackage();
  const workspaces = Array.isArray(pkg.workspaces) ? pkg.workspaces : [];
  const files = [];
  for (const workspace of workspaces) {
    for (const dir of expandWorkspacePattern(workspace)) {
      const file = path.join(dir, "package.json");
      if (fs.existsSync(file)) files.push(file);
    }
  }
  return [...new Set(files)].sort((left, right) => left.localeCompare(right));
};

const bumpVersions = (version) => {
  assertSemver(version);
  const root = rootPackage();
  root.agentOsRelease = { ...(root.agentOsRelease ?? {}), version };
  writeJson(rootPackagePath, root);

  let changed = 1;
  for (const file of workspacePackageJsonPaths()) {
    const pkg = readJson(file);
    if (typeof pkg.version !== "string") continue;
    pkg.version = version;
    writeJson(file, pkg);
    changed += 1;
  }
  console.log(`bumped ${changed} package manifests to ${version}`);
};

const releaseVersion = () => {
  const version = rootPackage().agentOsRelease?.version;
  if (typeof version !== "string") fail("package.json agentOsRelease.version is missing");
  assertSemver(version);
  return version;
};

const releaseAccess = (override) => {
  const access = override ?? rootPackage().agentOsRelease?.npmAccess ?? "restricted";
  if (access !== "public" && access !== "restricted") fail(`invalid npm access: ${access}`);
  return access;
};

const registryUrl = (override) =>
  override ??
  process.env.AGENTOS_NPM_REGISTRY ??
  process.env.NPM_CONFIG_REGISTRY ??
  "https://registry.npmjs.org/";

const packDistribution = () => {
  run("node", ["tooling/distribution/distribution.mjs", "pack"]);
};

const manifest = () => {
  if (!fs.existsSync(manifestPath)) {
    fail("dist/internal-npm/install-manifest.json is missing; run without --skip-pack");
  }
  return readJson(manifestPath);
};

const packageEntries = (expectedVersion) => {
  const data = manifest();
  if (data.version !== expectedVersion) {
    fail(`manifest version ${data.version} does not match target ${expectedVersion}`);
  }
  if (data.tarballs === undefined || typeof data.tarballs !== "object") {
    fail("manifest tarballs map is missing");
  }
  return Object.entries(data.tarballs)
    .map(([name, info]) => {
      const relativePath = info?.path;
      if (typeof relativePath !== "string") fail(`manifest tarball path missing for ${name}`);
      const tarball = path.join(repoRoot, relativePath);
      if (!fs.existsSync(tarball)) fail(`tarball missing for ${name}: ${relativePath}`);
      return { name, tarball };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
};

const npmViewVersion = ({ name, version, registry }) => {
  const result = run(
    "npm",
    ["view", `${name}@${version}`, "version", "--registry", registry, "--json"],
    { capture: true, allowFailure: true },
  );
  if (result.status === 0) {
    const text = result.stdout.trim();
    return text.length === 0 ? undefined : JSON.parse(text);
  }
  const stderr = result.stderr ?? "";
  if (stderr.includes("E404") || stderr.includes("404 Not Found")) return undefined;
  fail(`npm view failed for ${name}@${version}\n${stderr}`);
};

const npmViewLatest = ({ name, registry }) => {
  const result = run("npm", ["view", name, "version", "--registry", registry, "--json"], {
    capture: true,
  });
  const text = result.stdout.trim();
  return text.length === 0 ? undefined : JSON.parse(text);
};

const publishMissing = ({ entries, version, registry, access, otp, dryRun }) => {
  for (const entry of entries) {
    const published = npmViewVersion({ name: entry.name, version, registry });
    if (published === version) {
      console.log(`skip ${entry.name}@${version}: already published`);
      continue;
    }

    console.log(`publish ${entry.name}@${version}`);
    const publishArgs = ["publish", entry.tarball, "--registry", registry, "--access", access];
    if (otp !== undefined && otp.trim().length > 0) publishArgs.push("--otp", otp);
    if (dryRun === true) publishArgs.push("--dry-run");
    run("npm", publishArgs, { dryRun });
  }
};

const verifyPublished = ({ entries, version, registry }) => {
  for (const entry of entries) {
    const exact = npmViewVersion({ name: entry.name, version, registry });
    if (exact !== version) fail(`${entry.name}@${version} is not published`);
    const latest = npmViewLatest({ name: entry.name, registry });
    if (latest !== version) fail(`${entry.name} latest is ${latest}, expected ${version}`);
  }
  console.log(`verified ${entries.length} packages at ${version}`);
};

const main = () => {
  const args = parseArgs(process.argv.slice(2));
  if (args.help === true) {
    usage();
    return;
  }

  if (args.version !== undefined) bumpVersions(args.version);

  const version = releaseVersion();
  const registry = registryUrl(args.registry);
  const access = releaseAccess(args.access);
  const otp = args.otp ?? process.env.NPM_CONFIG_OTP;

  if (args["verify-only"] !== true && args["skip-gates"] !== true) {
    run("bun", ["run", "check:full"]);
  }

  if (args["skip-pack"] !== true && args["verify-only"] !== true) {
    packDistribution();
  }

  const entries = packageEntries(version);

  if (args["verify-only"] !== true) {
    publishMissing({ entries, version, registry, access, otp, dryRun: args["dry-run"] === true });
  }

  if (args["dry-run"] !== true) {
    verifyPublished({ entries, version, registry });
  }
};

main();
