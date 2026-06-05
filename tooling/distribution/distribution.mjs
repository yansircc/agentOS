#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const distRoot = path.join(repoRoot, "dist", "internal-npm");
const stagingRoot = path.join(distRoot, "packages");
const tarballRoot = path.join(distRoot, "tarballs");
const installManifestPath = path.join(distRoot, "install-manifest.json");
const localChannelManifestPath = path.join(distRoot, "local-channel.json");
const tarballHashLength = 12;
let packageVersionOverride;
const defaultLocalRegistryRoot = path.join(os.homedir(), ".agentos", "local-registry");

const runtimePackageRoots = ["packages", "tooling"];
const cloudflarePackageNames = new Set([
  "@agent-os/backend-cloudflare-do",
  "@agent-os/resource-cloudflare",
  "@agent-os/sandbox-cloudflare",
  "@agent-os/workspace-env-cloudflare",
  "@agent-os/workspace-session-cloudflare",
]);
const tarballBlocklist = [
  /(^|\/)vitest(?:\.cloudflare)?\.config\.ts$/,
  /(^|\/)tsconfig\.json$/,
  /(^|\/)test\//,
  /\.test\.ts$/,
  /(^|\/)\.eslintrc/,
  /(^|\/)\.effect-skill\.json$/,
];

const fail = (message) => {
  throw new Error(message);
};

const repoPath = (absolutePath) => path.relative(repoRoot, absolutePath).split(path.sep).join("/");

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
};

const sha256File = (file) =>
  crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

const run = (cmd, args, options = {}) => {
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

const rootPackage = () => readJson(path.join(repoRoot, "package.json"));

const surface = () => readJson(path.join(repoRoot, "docs", "surface.json"));

const releaseVersion = () => {
  const version = rootPackage().agentOsRelease?.version;
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    fail("package.json agentOsRelease.version must be a semver string");
  }
  return version;
};

const packageVersion = () => packageVersionOverride ?? releaseVersion();

const withPackageVersion = (version, fn) => {
  const previous = packageVersionOverride;
  packageVersionOverride = version;
  try {
    return fn();
  } finally {
    packageVersionOverride = previous;
  }
};

const parseArgs = (args) => {
  const parsed = { _: [] };
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

const gitValue = (args, fallback) => {
  const result = spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) return fallback;
  const value = result.stdout.trim();
  return value.length === 0 ? fallback : value;
};

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

const localPackageVersion = (label) => {
  const branch = prereleaseIdentifier(label ?? gitValue(["branch", "--show-current"], "local"));
  const sha = prereleaseIdentifier(gitValue(["rev-parse", "--short=12", "HEAD"], "unknown"));
  return `${releaseVersion()}-dev.${branch}.${sha}.${timestampIdentifier()}`;
};

const localRegistryRoot = () => process.env.AGENTOS_LOCAL_REGISTRY_ROOT ?? defaultLocalRegistryRoot;

const isLoopbackRegistry = (registry) => {
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

const localRegistryUserconfig = (registry) => {
  const userconfigPath = path.join(localRegistryRoot(), "npmrc");
  const token = existingLocalRegistryToken(userconfigPath) ?? verdaccioToken(registry);
  fs.mkdirSync(path.dirname(userconfigPath), { recursive: true });
  fs.writeFileSync(
    userconfigPath,
    [`@agent-os:registry=${registry}`, `${registryAuthKey(registry)}:_authToken=${token}`, ""].join(
      "\n",
    ),
  );
  return userconfigPath;
};

const catalog = () => rootPackage().catalog ?? {};

const workspacePackageJsons = () => {
  const packageJsons = [];
  const visit = (dir) => {
    const packageJson = path.join(dir, "package.json");
    if (fs.existsSync(packageJson)) {
      packageJsons.push(packageJson);
      return;
    }
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === "node_modules") continue;
      visit(path.join(dir, entry.name));
    }
  };
  for (const root of runtimePackageRoots) {
    visit(path.join(repoRoot, root));
  }
  return packageJsons.sort((left, right) => left.localeCompare(right));
};

const sourceRecords = () => {
  const surfaceByPath = new Map(surface().packages.map((pkg) => [pkg.path, pkg]));
  return workspacePackageJsons().map((packageJsonPath) => {
    const packageDir = path.dirname(packageJsonPath);
    const packagePath = repoPath(packageDir);
    const packageJson = readJson(packageJsonPath);
    const declaration = surfaceByPath.get(packagePath);
    if (declaration === undefined) {
      fail(`${packagePath} is missing from docs/surface.json`);
    }
    return {
      declaration,
      packageDir,
      packageJsonPath,
      packagePath,
      packageJson,
      stageDir: path.join(stagingRoot, declaration.slug),
    };
  });
};

const publishedRecords = () =>
  sourceRecords().filter((record) => record.declaration.published === true);

const sourceFiles = (record) => {
  const srcDir = path.join(record.packageDir, "src");
  const files = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(target);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
        files.push(target);
      }
    }
  };
  visit(srcDir);
  return files.sort((left, right) => left.localeCompare(right));
};

const packageImportsEffect = (record) =>
  sourceFiles(record).some((file) =>
    /\bfrom\s+["']effect["']|\bimport\s*\(\s*["']effect["']\s*\)/.test(
      fs.readFileSync(file, "utf8"),
    ),
  );

const assertSurface = () => {
  const records = sourceRecords();
  const packagePaths = new Set(records.map((record) => record.packagePath));
  const surfacePackages = surface().packages;
  const issues = [];
  for (const pkg of surfacePackages) {
    if (typeof pkg.published !== "boolean") {
      issues.push(`${pkg.path}: docs/surface.json published must be true or false`);
    }
    if (!packagePaths.has(pkg.path)) {
      issues.push(`${pkg.path}: docs/surface.json package has no workspace package.json`);
    }
    const shouldPublish =
      pkg.path.startsWith("packages/") ||
      pkg.path === "tooling/ops-api" ||
      pkg.path === "tooling/ops-htmx";
    if (pkg.published !== shouldPublish) {
      issues.push(`${pkg.path}: expected published=${shouldPublish}`);
    }
  }
  for (const record of records) {
    if (!surfacePackages.some((pkg) => pkg.path === record.packagePath)) {
      issues.push(`${record.packagePath}: workspace package missing from docs/surface.json`);
    }
  }
  if (issues.length > 0) fail(issues.join("\n"));
};

const assertSourceManifests = () => {
  const version = releaseVersion();
  const rootCatalog = catalog();
  const issues = [];
  for (const record of publishedRecords()) {
    const pkg = record.packageJson;
    if (pkg.private !== true) {
      issues.push(`${record.packagePath}: source package must stay private`);
    }
    if (pkg.version !== version) {
      issues.push(`${record.packagePath}: expected version ${version}; actual ${pkg.version}`);
    }
    if (packageImportsEffect(record) && pkg.peerDependencies?.effect !== rootCatalog.effect) {
      issues.push(
        `${record.packagePath}: package imports effect and must peer depend on ${rootCatalog.effect}`,
      );
    }
    const workersPeer = pkg.peerDependencies?.["@cloudflare/workers-types"];
    if (cloudflarePackageNames.has(pkg.name)) {
      if (workersPeer !== rootCatalog["@cloudflare/workers-types"]) {
        issues.push(
          `${record.packagePath}: Cloudflare package must peer depend on @cloudflare/workers-types ${rootCatalog["@cloudflare/workers-types"]}`,
        );
      }
    } else if (workersPeer !== undefined) {
      issues.push(
        `${record.packagePath}: non-Cloudflare package must not peer depend on @cloudflare/workers-types`,
      );
    }
  }
  if (issues.length > 0) fail(issues.join("\n"));
};

const sourcePublishGuards = () => {
  const issues = [];
  for (const record of publishedRecords()) {
    const result = spawnSync("npm", ["publish", "--dry-run", "--json"], {
      cwd: record.packageDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    if (!/private|Skipping workspace|marked as private/i.test(output)) {
      issues.push(
        `${record.packagePath}: npm publish --dry-run did not report private package guard`,
      );
    }
  }
  if (issues.length > 0) fail(issues.join("\n"));
};

const resolveExportTarget = (value) => {
  if (typeof value === "string") return value;
  if (value === null || typeof value !== "object") return undefined;
  return (
    resolveExportTarget(value.default) ??
    resolveExportTarget(value.import) ??
    resolveExportTarget(value.types)
  );
};

const exportEntries = (record) => {
  const exportsValue = record.packageJson.exports ?? record.packageJson.main ?? "./src/index.ts";
  if (typeof exportsValue === "string") {
    return [[".", exportsValue]];
  }
  if (exportsValue === null || typeof exportsValue !== "object") return [];
  return Object.entries(exportsValue)
    .map(([exportPath, exportTarget]) => [exportPath, resolveExportTarget(exportTarget)])
    .filter((entry) => typeof entry[1] === "string")
    .sort(([left], [right]) => left.localeCompare(right));
};

const srcTargetToDist = (target, ext) => {
  if (!target.startsWith("./src/") || !target.endsWith(".ts")) {
    fail(`export target must be a source .ts file: ${target}`);
  }
  return `./dist/${target.slice("./src/".length, -".ts".length)}.${ext}`;
};

const resolveRelativeSpecifier = (sourceFile, specifier, ext) => {
  if (!specifier.startsWith(".") || specifier.endsWith(".js") || specifier.endsWith(".json")) {
    return specifier;
  }
  const base = path.resolve(path.dirname(sourceFile), specifier);
  if (fs.existsSync(`${base}.ts`) || fs.existsSync(`${base}.d.ts`)) {
    return `${specifier}.js`;
  }
  if (fs.existsSync(path.join(base, "index.ts")) || fs.existsSync(path.join(base, "index.d.ts"))) {
    return `${specifier.replace(/\/$/u, "")}/index.js`;
  }
  if (ext === ".d.ts" && fs.existsSync(`${base}.d.ts`)) {
    return `${specifier}.js`;
  }
  return specifier;
};

const rewriteModuleSpecifiers = (text, sourceFile, ext) =>
  text
    .replace(/(\bfrom\s*["'])(\.[^"']+)(["'])/g, (_match, prefix, specifier, suffix) => {
      return `${prefix}${resolveRelativeSpecifier(sourceFile, specifier, ext)}${suffix}`;
    })
    .replace(
      /(\bimport\s*\(\s*["'])(\.[^"']+)(["']\s*\))/g,
      (_match, prefix, specifier, suffix) => {
        return `${prefix}${resolveRelativeSpecifier(sourceFile, specifier, ext)}${suffix}`;
      },
    );

const emitJs = (record) => {
  for (const file of sourceFiles(record)) {
    const rel = path.relative(path.join(record.packageDir, "src"), file);
    const out = path.join(record.stageDir, "dist", rel.replace(/\.ts$/u, ".js"));
    const source = fs.readFileSync(file, "utf8");
    const transpiled = ts.transpileModule(source, {
      fileName: file,
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ES2022,
        importsNotUsedAsValues: ts.ImportsNotUsedAsValues.Remove,
        sourceMap: false,
      },
    });
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, rewriteModuleSpecifiers(transpiled.outputText, file, ".js"));
  }
};

const emitDeclarations = (record) => {
  for (const file of sourceFiles(record)) {
    const rel = path.relative(path.join(record.packageDir, "src"), file);
    const out = path.join(record.stageDir, "dist", rel.replace(/\.ts$/u, ".d.ts"));
    const source = fs.readFileSync(file, "utf8");
    const result = ts.transpileDeclaration(source, {
      fileName: file,
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ES2022,
        strict: true,
        isolatedDeclarations: true,
        removeComments: true,
      },
    });
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, rewriteModuleSpecifiers(result.outputText, file, ".d.ts"));
  }
};

const allFiles = (dir) => {
  if (!fs.existsSync(dir)) return [];
  const files = [];
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) {
        visit(target);
        continue;
      }
      if (entry.isFile()) files.push(target);
    }
  };
  visit(dir);
  return files.sort((left, right) => left.localeCompare(right));
};

const projectedDependencies = (record) => {
  const version = packageVersion();
  const rootCatalog = catalog();
  const dependencies = {};
  for (const [name, value] of Object.entries(record.packageJson.dependencies ?? {})) {
    if (name === "effect") continue;
    if (name.startsWith("@agent-os/")) {
      dependencies[name] = version;
      continue;
    }
    dependencies[name] = value === "catalog:" ? rootCatalog[name] : value;
    if (dependencies[name] === undefined)
      fail(`${record.packagePath}: missing catalog value for ${name}`);
  }
  return Object.keys(dependencies).length === 0 ? undefined : dependencies;
};

const projectedPeerDependencies = (record) => {
  const rootCatalog = catalog();
  const peers = { ...record.packageJson.peerDependencies };
  if (packageImportsEffect(record)) {
    peers.effect = rootCatalog.effect;
  }
  if (cloudflarePackageNames.has(record.packageJson.name)) {
    peers["@cloudflare/workers-types"] = rootCatalog["@cloudflare/workers-types"];
  }
  return Object.keys(peers).length === 0 ? undefined : peers;
};

const generatedManifest = (record) => {
  const entries = exportEntries(record);
  const exportsValue = Object.fromEntries(
    entries.map(([exportPath, target]) => [
      exportPath,
      {
        types: srcTargetToDist(target, "d.ts"),
        default: srcTargetToDist(target, "js"),
      },
    ]),
  );
  const manifest = {
    name: record.packageJson.name,
    version: packageVersion(),
    type: "module",
    license: "UNLICENSED",
    main: exportsValue["."]?.default,
    types: exportsValue["."]?.types,
    exports: exportsValue,
    files: [
      "dist",
      ...(fs.existsSync(path.join(record.packageDir, "README.md")) ? ["README.md"] : []),
      ...(fs.existsSync(path.join(record.packageDir, "PUBLIC_API.md")) ? ["PUBLIC_API.md"] : []),
    ],
    dependencies: projectedDependencies(record),
    peerDependencies: projectedPeerDependencies(record),
  };
  return Object.fromEntries(Object.entries(manifest).filter(([, value]) => value !== undefined));
};

const copyPackageDocs = (record) => {
  for (const name of ["README.md", "PUBLIC_API.md"]) {
    const source = path.join(record.packageDir, name);
    if (fs.existsSync(source)) {
      fs.copyFileSync(source, path.join(record.stageDir, name));
    }
  }
};

const buildInternalPackages = () => {
  assertSurface();
  assertSourceManifests();
  fs.rmSync(distRoot, { recursive: true, force: true });
  fs.mkdirSync(stagingRoot, { recursive: true });
  for (const record of publishedRecords()) {
    fs.mkdirSync(record.stageDir, { recursive: true });
    emitJs(record);
    emitDeclarations(record);
    copyPackageDocs(record);
    writeJson(path.join(record.stageDir, "package.json"), generatedManifest(record));
  }
  console.log(`built ${publishedRecords().length} internal npm package projections`);
};

const parseNpmJsonOutput = (text) => {
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];
  return JSON.parse(trimmed);
};

const contentAddressedTarball = (file) => {
  const sha256 = sha256File(file);
  const targetDir = path.join(path.dirname(file), sha256.slice(0, tarballHashLength));
  const target = path.join(targetDir, path.basename(file));
  fs.mkdirSync(targetDir, { recursive: true });
  fs.renameSync(file, target);
  return { file: target, sha256 };
};

const tarballSpec = (file) => `file:${file}`;

const writeInstallManifest = (entries) => {
  const sorted = entries
    .slice()
    .sort((left, right) =>
      left.record.packageJson.name.localeCompare(right.record.packageJson.name),
    );
  const dependencies = Object.fromEntries(
    sorted.map((entry) => [entry.record.packageJson.name, tarballSpec(entry.file)]),
  );
  writeJson(installManifestPath, {
    version: packageVersion(),
    generatedBy: "tooling/distribution/distribution.mjs pack",
    dependencies,
    overrides: dependencies,
    tarballs: Object.fromEntries(
      sorted.map((entry) => [
        entry.record.packageJson.name,
        {
          path: repoPath(entry.file),
          spec: tarballSpec(entry.file),
          sha256: entry.sha256,
        },
      ]),
    ),
  });
};

const npmPackDryRunFiles = (cwd) => {
  const result = run("npm", ["pack", "--dry-run", "--json"], { cwd, capture: true });
  const parsed = parseNpmJsonOutput(result.stdout);
  return parsed[0]?.files?.map((entry) => entry.path) ?? [];
};

const assertStagingPackage = (record) => {
  const manifest = readJson(path.join(record.stageDir, "package.json"));
  const manifestText = JSON.stringify(manifest);
  const issues = [];
  if (manifest.private !== undefined) issues.push("generated manifest must not contain private");
  if (/workspace:|catalog:/.test(manifestText))
    issues.push("generated manifest leaks workspace/catalog protocol");
  if (/src\/|src\\/.test(manifestText) || /src\/index/.test(manifestText)) {
    issues.push("generated manifest leaks source entrypoints");
  }
  for (const dependencyName of Object.keys(manifest.dependencies ?? {})) {
    if (
      dependencyName.startsWith("@agent-os/") &&
      !publishedRecords().some((candidate) => candidate.packageJson.name === dependencyName)
    ) {
      issues.push(`generated manifest depends on unpublished internal package ${dependencyName}`);
    }
  }
  for (const file of allFiles(path.join(record.stageDir, "dist")).filter((candidate) =>
    candidate.endsWith(".d.ts"),
  )) {
    const text = fs.readFileSync(file, "utf8");
    if (/\/src\/|src\/index|workspace:\*|["']workspace:|@agent-os\/[^"']+\/src\//.test(text)) {
      issues.push(`${repoPath(file)} leaks source path in declaration output`);
    }
  }
  const files = npmPackDryRunFiles(record.stageDir);
  for (const file of files) {
    if (tarballBlocklist.some((pattern) => pattern.test(file))) {
      issues.push(`${record.packageJson.name}: tarball dry-run includes blocked file ${file}`);
    }
  }
  if (issues.length > 0) fail(`${record.packageJson.name}\n${issues.join("\n")}`);
};

const checkDistribution = () => {
  buildInternalPackages();
  sourcePublishGuards();
  for (const record of publishedRecords()) {
    assertStagingPackage(record);
  }
  console.log(`checked distribution contract for ${publishedRecords().length} packages`);
};

const packInternal = () => {
  checkDistribution();
  fs.rmSync(tarballRoot, { recursive: true, force: true });
  fs.mkdirSync(tarballRoot, { recursive: true });
  const tarballs = [];
  for (const record of publishedRecords()) {
    const result = run("npm", ["pack", "--json", "--pack-destination", tarballRoot], {
      cwd: record.stageDir,
      capture: true,
    });
    const parsed = parseNpmJsonOutput(result.stdout);
    const filename = parsed[0]?.filename;
    if (typeof filename !== "string")
      fail(`${record.packageJson.name}: npm pack did not report filename`);
    const addressed = contentAddressedTarball(path.join(tarballRoot, filename));
    tarballs.push({ record, ...addressed });
  }
  writeInstallManifest(tarballs);
  console.log(
    `packed ${tarballs.length} tarballs into ${repoPath(tarballRoot)} and wrote ${repoPath(installManifestPath)}`,
  );
  return tarballs.map((entry) => entry.file);
};

const tarballsByPackage = () => {
  if (!fs.existsSync(tarballRoot)) packInternal();
  const byPackage = new Map();
  const version = packageVersion();
  for (const record of publishedRecords()) {
    const packageNamePart = record.packageJson.name.replace(/^@/u, "").replace(/\//gu, "-");
    const prefix = `${packageNamePart}-${version}`;
    const tarball = allFiles(tarballRoot)
      .filter((entry) => path.basename(entry).startsWith(prefix) && entry.endsWith(".tgz"))
      .sort((left, right) => left.localeCompare(right))
      .at(-1);
    if (tarball === undefined) fail(`${record.packageJson.name}: missing tarball`);
    byPackage.set(record.packageJson.name, tarball);
  }
  return byPackage;
};

const packageDepsFromTarballs = () =>
  Object.fromEntries(
    [...tarballsByPackage().entries()].map(([name, file]) => [name, `file:${file}`]),
  );

const writeConsumerApp = (dir, extraDeps = {}) => {
  fs.mkdirSync(dir, { recursive: true });
  writeJson(path.join(dir, "package.json"), {
    name: "agentos-internal-consumer-fixture",
    private: true,
    type: "module",
    dependencies: {
      ...packageDepsFromTarballs(),
      ...extraDeps,
    },
    devDependencies: {
      typescript: catalog().typescript,
    },
  });
  fs.writeFileSync(
    path.join(dir, "index.ts"),
    [
      'import { makePreClaim } from "@agent-os/kernel/effect-claim";',
      'import type { LedgerEventRpc } from "@agent-os/kernel/types";',
      'import { triggerParseOk } from "@agent-os/runtime";',
      'import { defineAgentDO, type CloudflareAgentEnv } from "@agent-os/backend-cloudflare-do";',
      'import { mountOpsHtmx } from "@agent-os/ops-htmx";',
      "void makePreClaim;",
      "void triggerParseOk;",
      "void defineAgentDO;",
      "void mountOpsHtmx;",
      "const _events: ReadonlyArray<LedgerEventRpc> = [];",
      "const _env: CloudflareAgentEnv | null = null;",
      "void _events;",
      "void _env;",
    ].join("\n") + "\n",
  );
  fs.writeFileSync(
    path.join(dir, "smoke.mjs"),
    [
      'import { ABORT } from "@agent-os/kernel";',
      'import { triggerParseOk } from "@agent-os/runtime";',
      'import { projectTurnStream } from "@agent-os/turn-stream";',
      'import { mountOpsApi } from "@agent-os/ops-api";',
      "if (!ABORT || !triggerParseOk || !projectTurnStream || !mountOpsApi) throw new Error('missing import');",
    ].join("\n") + "\n",
  );
  fs.writeFileSync(
    path.join(dir, "cf-entry.ts"),
    [
      'import { defineAgentDO } from "@agent-os/backend-cloudflare-do";',
      "export const AgentDO = defineAgentDO({ bindings: [] });",
    ].join("\n") + "\n",
  );
  writeJson(path.join(dir, "tsconfig.nodenext.json"), {
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
      skipLibCheck: true,
      types: ["@cloudflare/workers-types"],
    },
    include: ["index.ts"],
  });
  writeJson(path.join(dir, "tsconfig.bundler.json"), {
    compilerOptions: {
      target: "ES2022",
      module: "ESNext",
      moduleResolution: "Bundler",
      strict: true,
      skipLibCheck: true,
      types: ["@cloudflare/workers-types"],
    },
    include: ["index.ts"],
  });
};

const npmInstall = (dir, omitPeer = false) => {
  run(
    "npm",
    ["install", "--package-lock=false", "--ignore-scripts", ...(omitPeer ? ["--omit=peer"] : [])],
    { cwd: dir, capture: true },
  );
};

const assertPeerFailure = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentos-peer-failure-"));
  writeJson(path.join(dir, "package.json"), {
    name: "agentos-peer-failure",
    private: true,
    type: "module",
    dependencies: packageDepsFromTarballs(),
    devDependencies: {
      typescript: catalog().typescript,
    },
  });
  fs.writeFileSync(
    path.join(dir, "index.ts"),
    'import { triggerParseOk } from "@agent-os/runtime";\nvoid triggerParseOk;\n',
  );
  fs.writeFileSync(
    path.join(dir, "smoke.mjs"),
    'import { triggerParseOk } from "@agent-os/runtime";\nvoid triggerParseOk;\n',
  );
  writeJson(path.join(dir, "tsconfig.json"), {
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
      skipLibCheck: true,
    },
    include: ["index.ts"],
  });
  npmInstall(dir, true);
  const typecheck = spawnSync("npm", ["exec", "tsc", "--", "-p", "tsconfig.json"], {
    cwd: dir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const runtimeImport = spawnSync("node", ["smoke.mjs"], {
    cwd: dir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (typecheck.status === 0 && runtimeImport.status === 0) {
    fail(
      "consumer without effect unexpectedly typechecked and imported; peer contract is not observable",
    );
  }
  console.log("verified effect peer failure without installed peer");
};

const negativeContractTests = () => {
  const records = publishedRecords();
  const kernel = records.find((record) => record.packageJson.name === "@agent-os/kernel");
  const turnStream = records.find((record) => record.packageJson.name === "@agent-os/turn-stream");
  const cloudflare = records.find(
    (record) => record.packageJson.name === "@agent-os/backend-cloudflare-do",
  );
  if (kernel === undefined || turnStream === undefined || cloudflare === undefined) {
    fail("negative test fixtures missing expected packages");
  }
  const assertFails = (label, fn) => {
    try {
      fn();
    } catch {
      return;
    }
    fail(`negative distribution test did not fail: ${label}`);
  };
  assertFails("internal-only package marked published", () => {
    const bad = structuredClone(surface());
    bad.packages.find((pkg) => pkg.path === "tooling/docs-site").published = true;
    if (bad.packages.find((pkg) => pkg.path === "tooling/docs-site").published === true) {
      fail("tooling/docs-site: expected published=false");
    }
  });
  assertFails("published package removed from surface", () => {
    const paths = new Set(
      surface()
        .packages.filter((pkg) => pkg.published)
        .map((pkg) => pkg.path),
    );
    paths.delete(kernel.packagePath);
    if (!paths.has(kernel.packagePath)) fail(`${kernel.packagePath}: missing published package`);
  });
  assertFails("deep source path in d.ts", () => {
    const text = 'import type { X } from "@agent-os/runtime/src/internal-helper";\n';
    if (/\/src\/|src\/index|workspace:\*|["']workspace:|@agent-os\/[^"']+\/src\//.test(text)) {
      fail("declaration leaks source path");
    }
  });
  assertFails("effect import without peer", () => {
    const pkg = structuredClone(turnStream.packageJson);
    delete pkg.peerDependencies?.effect;
    if (packageImportsEffect(turnStream) && pkg.peerDependencies?.effect !== catalog().effect) {
      fail("missing effect peer");
    }
  });
  assertFails("cloudflare package without workers peer", () => {
    const pkg = structuredClone(cloudflare.packageJson);
    delete pkg.peerDependencies?.["@cloudflare/workers-types"];
    if (
      pkg.peerDependencies?.["@cloudflare/workers-types"] !== catalog()["@cloudflare/workers-types"]
    ) {
      fail("missing workers types peer");
    }
  });
  console.log("verified negative distribution contract fixtures");
};

const testInternalConsumer = () => {
  packInternal();
  negativeContractTests();
  assertPeerFailure();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentos-internal-consumer-"));
  writeConsumerApp(dir, {
    effect: catalog().effect,
    "@cloudflare/workers-types": catalog()["@cloudflare/workers-types"],
  });
  npmInstall(dir);
  run("npm", ["exec", "tsc", "--", "-p", "tsconfig.nodenext.json"], { cwd: dir, capture: true });
  run("npm", ["exec", "tsc", "--", "-p", "tsconfig.bundler.json"], { cwd: dir, capture: true });
  run("node", ["smoke.mjs"], { cwd: dir, capture: true });
  run(
    "bun",
    [
      "build",
      "cf-entry.ts",
      "--target=browser",
      "--format=esm",
      "--packages=external",
      "--external=cloudflare:workers",
      "--outfile=cf-entry.js",
    ],
    { cwd: dir, capture: true },
  );
  console.log("verified internal npm consumer fixtures");
};

const publishInternal = () => {
  packInternal();
  const registry = process.env.AGENTOS_NPM_REGISTRY ?? process.env.NPM_CONFIG_REGISTRY;
  if (registry === undefined || registry.trim().length === 0) {
    fail("AGENTOS_NPM_REGISTRY or NPM_CONFIG_REGISTRY is required for publish:internal");
  }
  const access = process.env.AGENTOS_NPM_ACCESS ?? "restricted";
  for (const tarball of tarballsByPackage().values()) {
    run("npm", ["publish", tarball, "--registry", registry, "--access", access]);
  }
};

const writeLocalChannelManifest = ({ registry, tag, version }) => {
  const names = publishedRecords()
    .map((record) => record.packageJson.name)
    .sort((left, right) => left.localeCompare(right));
  writeJson(localChannelManifestPath, {
    version,
    registry,
    tag,
    generatedBy: "tooling/distribution/distribution.mjs publish-local",
    dependencies: Object.fromEntries(names.map((name) => [name, tag])),
    npmrc: [`@agent-os:registry=${registry}`],
  });
};

const publishLocal = (rawArgs) => {
  const args = parseArgs(rawArgs);
  const registry =
    args.registry ??
    process.env.AGENTOS_LOCAL_REGISTRY ??
    process.env.AGENTOS_NPM_REGISTRY ??
    "http://127.0.0.1:4873";
  const tag = args.tag ?? process.env.AGENTOS_LOCAL_TAG ?? "agentos-dev";
  const version = args.version ?? localPackageVersion(args.label);
  const access = args.access ?? process.env.AGENTOS_NPM_ACCESS ?? "public";
  withPackageVersion(version, () => {
    packInternal();
    const userconfig =
      args.userconfig ??
      (isLoopbackRegistry(registry) ? localRegistryUserconfig(registry) : undefined);
    const tarballs = tarballsByPackage();
    for (const [name, tarball] of tarballs.entries()) {
      console.log(`publishing ${name}@${version} to ${registry} with tag ${tag}`);
      const publishArgs = [
        "publish",
        tarball,
        "--registry",
        registry,
        "--tag",
        tag,
        "--access",
        access,
      ];
      if (userconfig !== undefined) publishArgs.push("--userconfig", userconfig);
      run("npm", publishArgs);
    }
    writeLocalChannelManifest({ registry, tag, version });
  });
  console.log(
    `published ${publishedRecords().length} packages to ${registry} with tag ${tag} at version ${version}`,
  );
  console.log(`wrote ${repoPath(localChannelManifestPath)}`);
};

const localRegistry = (rawArgs) => {
  const args = parseArgs(rawArgs);
  const port = args.port ?? process.env.AGENTOS_LOCAL_REGISTRY_PORT ?? "4873";
  const host = args.host ?? process.env.AGENTOS_LOCAL_REGISTRY_HOST ?? "127.0.0.1";
  const root = localRegistryRoot();
  const storage = path.join(root, "storage");
  const configPath = path.join(root, "config.yaml");
  const htpasswdPath = path.join(root, "htpasswd");
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(storage, { recursive: true });
  fs.writeFileSync(htpasswdPath, fs.existsSync(htpasswdPath) ? fs.readFileSync(htpasswdPath) : "");
  fs.writeFileSync(
    configPath,
    [
      `storage: ${storage}`,
      "auth:",
      "  htpasswd:",
      `    file: ${htpasswdPath}`,
      "uplinks:",
      "  npmjs:",
      "    url: https://registry.npmjs.org/",
      "packages:",
      "  '@agent-os/*':",
      "    access: $all",
      "    publish: $all",
      "    unpublish: $all",
      "  '**':",
      "    access: $all",
      "    proxy: npmjs",
      "log:",
      "  - { type: stdout, format: pretty, level: http }",
      "",
    ].join("\n"),
  );
  console.log(`starting local npm registry at http://${host}:${port}`);
  console.log(`storage: ${storage}`);
  run("npm", [
    "exec",
    "--yes",
    "--package",
    "verdaccio@6.7.2",
    "--",
    "verdaccio",
    "--config",
    configPath,
    "--listen",
    `${host}:${port}`,
  ]);
};

const command = process.argv[2] ?? "check";
const commandArgs = process.argv.slice(3);
switch (command) {
  case "build":
    buildInternalPackages();
    break;
  case "pack":
    packInternal();
    break;
  case "check":
    checkDistribution();
    break;
  case "test-consumer":
    testInternalConsumer();
    break;
  case "publish":
    publishInternal();
    break;
  case "publish-local":
    publishLocal(commandArgs);
    break;
  case "local-registry":
    localRegistry(commandArgs);
    break;
  default:
    fail(`unknown distribution command: ${command}`);
}
