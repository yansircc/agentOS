import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const distRoot = path.join(repoRoot, "dist", "internal-npm");
export const stagingRoot = path.join(distRoot, "packages");
export const tarballRoot = path.join(distRoot, "tarballs");
export const installManifestPath = path.join(distRoot, "install-manifest.json");
export const localChannelManifestPath = path.join(distRoot, "local-channel.json");
export const localConsumerMarkerName = ".agentos-local.json";
export const tarballHashLength = 12;
let packageVersionOverride;
const defaultLocalRegistryRoot = path.join(os.homedir(), ".agentos", "local-registry");
export const sourcePackageScope = "@agent-os";
export const publicPackageScopePlaceholder = "__AGENTOS_PUBLIC_PACKAGE_SCOPE__";

export const runtimePackageRoots = ["packages", "tooling"];
export const tarballBlocklist = [
  /(^|\/)vitest(?:\.cloudflare)?\.config\.ts$/,
  /(^|\/)tsconfig\.json$/,
  /(^|\/)test\//,
  /\.test\.ts$/,
  /(^|\/)\.eslintrc/,
  /(^|\/)\.effect-skill\.json$/,
];

export const fail = (message) => {
  throw new Error(message);
};

export const repoPath = (absolutePath) =>
  path.relative(repoRoot, absolutePath).split(path.sep).join("/");

const hasAncestorNodeModules = (dir) => {
  let current = fs.realpathSync(dir);
  while (true) {
    if (fs.existsSync(path.join(current, "node_modules"))) return true;
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
};

const fixtureTempRoot = () => {
  const configured = fs.realpathSync(os.tmpdir());
  if (!hasAncestorNodeModules(configured)) return configured;
  return fs.realpathSync("/tmp");
};

export const mkdtempFixture = (prefix) => fs.mkdtempSync(path.join(fixtureTempRoot(), prefix));

export const unpackTarballInto = (tarball, target) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentos-consumer-package-"));
  try {
    run("tar", ["-xzf", tarball, "-C", tmp], { capture: true });
    const packageDir = path.join(tmp, "package");
    if (!fs.existsSync(packageDir)) {
      fail(`${tarball}: tarball did not contain package/`);
    }
    fs.rmSync(target, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.renameSync(packageDir, target);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
};

export const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

const packageUnits = () => readJson(path.join(repoRoot, "architecture", "package-units.json"));

const packageUnitForRecord = (record) =>
  (packageUnits().packageUnits ?? []).find(
    (unit) => unit.targetSourcePackageName === record.packageJson.name,
  );

export const packageUnitOptionalPeers = (record) =>
  new Set(
    (packageUnitForRecord(record)?.publicSubpaths ?? []).flatMap((subpath) =>
      Array.isArray(subpath.optionalPeers) ? subpath.optionalPeers : [],
    ),
  );

export const projectedDependencyRange = (name, value, rootCatalog) => {
  if (isSourcePackageName(name)) return packageVersion();
  if (value === "catalog:") return rootCatalog[name];
  if (value === "workspace:*") return packageVersion();
  return value;
};

export const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
};

export const sha256File = (file) =>
  crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

export const run = (cmd, args, options = {}) => {
  const result = spawnSync(cmd, args, {
    cwd: options.cwd ?? repoRoot,
    env: options.env ?? process.env,
    encoding: "utf8",
    stdio: options.capture === true ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.status !== 0) {
    const detail = options.capture === true ? `\n${result.stdout ?? ""}${result.stderr ?? ""}` : "";
    fail(`${cmd} ${args.join(" ")} failed with exit ${result.status}${detail}`);
  }
  return result;
};

export const rootPackage = () => readJson(path.join(repoRoot, "package.json"));

export const surface = () => readJson(path.join(repoRoot, "docs", "surface.json"));

export const releaseVersion = () => {
  const version = rootPackage().agentOsRelease?.version;
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    fail("package.json agentOsRelease.version must be a semver string");
  }
  return version;
};

export const releaseConfig = () => rootPackage().agentOsRelease ?? {};

export const publishScope = () => {
  const scope = process.env.AGENTOS_NPM_SCOPE ?? releaseConfig().npmScope ?? sourcePackageScope;
  if (typeof scope !== "string" || !/^@[a-z0-9][a-z0-9._-]*$/u.test(scope)) {
    fail("agentOsRelease.npmScope or AGENTOS_NPM_SCOPE must be a valid lowercase npm scope");
  }
  return scope;
};

export const publishAccess = () => {
  const access = process.env.AGENTOS_NPM_ACCESS ?? releaseConfig().npmAccess ?? "restricted";
  if (access !== "public" && access !== "restricted") {
    fail("agentOsRelease.npmAccess or AGENTOS_NPM_ACCESS must be public or restricted");
  }
  return access;
};

export const isSourcePackageName = (name) => name.startsWith(`${sourcePackageScope}/`);

export const publicPackageName = (name) => {
  if (!isSourcePackageName(name)) return name;
  return `${publishScope()}/${name.slice(sourcePackageScope.length + 1)}`;
};

export const publicSpecifier = (specifier) => {
  if (specifier === sourcePackageScope) return publishScope();
  if (!specifier.startsWith(`${sourcePackageScope}/`)) return specifier;
  return `${publishScope()}${specifier.slice(sourcePackageScope.length)}`;
};

export const rewritePublicSpecifiers = (text) =>
  text.replaceAll(sourcePackageScope, publishScope());
export const rewritePublicScopePlaceholders = (text) =>
  text.replaceAll(publicPackageScopePlaceholder, publishScope());

export const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

export const packageVersion = () => packageVersionOverride ?? releaseVersion();

export const withPackageVersion = (version, fn) => {
  const previous = packageVersionOverride;
  packageVersionOverride = version;
  try {
    return fn();
  } finally {
    packageVersionOverride = previous;
  }
};

export const parseArgs = (args) => {
  const parsed = { _: [] };
  const booleanKeys = new Set(["skip-pack", "no-install"]);
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      parsed._.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    if (eq >= 0) {
      parsed[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const key = arg.slice(2);
    if (booleanKeys.has(key)) {
      parsed[key] = true;
      continue;
    }
    const next = args[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      parsed[key] = next;
      index++;
    } else {
      parsed[key] = true;
    }
  }
  return parsed;
};

export const positionalArgs = (args) => args._ ?? [];

export const boolArg = (args, name) => args[name] === true || args[name] === "true";

export const gitValue = (args, fallback) => {
  const result = spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) return fallback;
  const value = result.stdout.trim();
  return value.length === 0 ? fallback : value;
};

export const gitStatusShort = () => gitValue(["status", "--short"], "");

const prereleaseIdentifier = (value) =>
  value
    .toLowerCase()
    .replace(/[^0-9a-z-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 48) || "local";

const timestampIdentifier = () => {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return [
    now.getUTCFullYear(),
    pad(now.getUTCMonth() + 1),
    pad(now.getUTCDate()),
    pad(now.getUTCHours()),
    pad(now.getUTCMinutes()),
    pad(now.getUTCSeconds()),
  ].join("");
};

export const localPackageVersion = (label) => {
  const branch = prereleaseIdentifier(label ?? gitValue(["branch", "--show-current"], "local"));
  const sha = prereleaseIdentifier(gitValue(["rev-parse", "--short=12", "HEAD"], "unknown"));
  return `${releaseVersion()}-dev.${branch}.${sha}.${timestampIdentifier()}`;
};

export const localRegistryRoot = () =>
  process.env.AGENTOS_LOCAL_REGISTRY_ROOT ?? defaultLocalRegistryRoot;

export const isLoopbackRegistry = (registry) => {
  try {
    const url = new URL(registry);
    return url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1";
  } catch {
    return false;
  }
};

const registryAuthKey = (registry) => {
  const url = new URL(registry);
  return `//${url.host}${url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`}`;
};

const verdaccioToken = (registry) => {
  const code = `
const registry = process.argv[1].replace(/\\/$/u, "");
const user = "agentos-local";
const password = "agentos-local";
const response = await fetch(\`\${registry}/-/user/org.couchdb.user:\${user}\`, {
  method: "PUT",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    name: user,
    password,
    email: "agentos-local@example.invalid",
    type: "user",
  }),
});
const text = await response.text();
if (!response.ok) {
  throw new Error(\`local registry auth failed: \${response.status} \${text}\`);
}
const json = JSON.parse(text);
if (typeof json.token !== "string" || json.token.length === 0) {
  throw new Error(\`local registry auth response did not include a token: \${text}\`);
}
console.log(json.token);
`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", code, registry], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    fail(`${result.stdout ?? ""}${result.stderr ?? ""}`.trim());
  }
  return result.stdout.trim();
};

const existingLocalRegistryToken = (userconfigPath) => {
  if (!fs.existsSync(userconfigPath)) return undefined;
  const match = fs.readFileSync(userconfigPath, "utf8").match(/:_authToken=([^\n]+)/u);
  return match?.[1]?.trim();
};

export const localRegistryUserconfig = (registry) => {
  const userconfigPath = path.join(localRegistryRoot(), "npmrc");
  const token = existingLocalRegistryToken(userconfigPath) ?? verdaccioToken(registry);
  fs.mkdirSync(path.dirname(userconfigPath), { recursive: true });
  fs.writeFileSync(
    userconfigPath,
    [
      `${publishScope()}:registry=${registry}`,
      `${registryAuthKey(registry)}:_authToken=${token}`,
      "",
    ].join("\n"),
  );
  return userconfigPath;
};
