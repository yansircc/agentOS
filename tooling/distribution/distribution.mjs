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
const localConsumerMarkerName = ".agentos-local.json";
const tarballHashLength = 12;
let packageVersionOverride;
const defaultLocalRegistryRoot = path.join(os.homedir(), ".agentos", "local-registry");
const sourcePackageScope = "@agent-os";
const publicPackageScopePlaceholder = "__AGENTOS_PUBLIC_PACKAGE_SCOPE__";

const runtimePackageRoots = ["packages", "tooling"];
const cloudflarePackageNames = new Set([
  "@agent-os/runtime",
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

const mkdtempFixture = (prefix) => fs.mkdtempSync(path.join(fixtureTempRoot(), prefix));

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

const packageUnits = () => readJson(path.join(repoRoot, "architecture", "package-units.json"));

const packageUnitForRecord = (record) =>
  (packageUnits().packageUnits ?? []).find(
    (unit) => unit.targetSourcePackageName === record.packageJson.name,
  );

const packageUnitOptionalPeers = (record) =>
  new Set(
    (packageUnitForRecord(record)?.publicSubpaths ?? []).flatMap((subpath) =>
      Array.isArray(subpath.optionalPeers) ? subpath.optionalPeers : [],
    ),
  );

const projectedDependencyRange = (name, value, rootCatalog) => {
  if (isSourcePackageName(name)) return packageVersion();
  if (value === "catalog:") return rootCatalog[name];
  if (value === "workspace:*") return packageVersion();
  return value;
};

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

const releaseConfig = () => rootPackage().agentOsRelease ?? {};

const publishScope = () => {
  const scope = process.env.AGENTOS_NPM_SCOPE ?? releaseConfig().npmScope ?? sourcePackageScope;
  if (typeof scope !== "string" || !/^@[a-z0-9][a-z0-9._-]*$/u.test(scope)) {
    fail("agentOsRelease.npmScope or AGENTOS_NPM_SCOPE must be a valid lowercase npm scope");
  }
  return scope;
};

const publishAccess = () => {
  const access = process.env.AGENTOS_NPM_ACCESS ?? releaseConfig().npmAccess ?? "restricted";
  if (access !== "public" && access !== "restricted") {
    fail("agentOsRelease.npmAccess or AGENTOS_NPM_ACCESS must be public or restricted");
  }
  return access;
};

const isSourcePackageName = (name) => name.startsWith(`${sourcePackageScope}/`);

const publicPackageName = (name) => {
  if (!isSourcePackageName(name)) return name;
  return `${publishScope()}/${name.slice(sourcePackageScope.length + 1)}`;
};

const publicSpecifier = (specifier) => {
  if (specifier === sourcePackageScope) return publishScope();
  if (!specifier.startsWith(`${sourcePackageScope}/`)) return specifier;
  return `${publishScope()}${specifier.slice(sourcePackageScope.length)}`;
};

const rewritePublicSpecifiers = (text) => text.replaceAll(sourcePackageScope, publishScope());
const rewritePublicScopePlaceholders = (text) =>
  text.replaceAll(publicPackageScopePlaceholder, publishScope());

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

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

const positionalArgs = (args) => args._ ?? [];

const boolArg = (args, name) => args[name] === true || args[name] === "true";

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

const gitStatusShort = () => gitValue(["status", "--short"], "");

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
    [
      `${publishScope()}:registry=${registry}`,
      `${registryAuthKey(registry)}:_authToken=${token}`,
      "",
    ].join("\n"),
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

const isBinTsTarget = (target) => target.startsWith("./bin/") && target.endsWith(".ts");
const isBinMjsTarget = (target) => target.startsWith("./bin/") && target.endsWith(".mjs");
const isSourceMjsTarget = (target) => target.startsWith("./src/") && target.endsWith(".mjs");
const isPackageBinSourceTarget = (target) =>
  isBinTsTarget(target) ||
  isBinMjsTarget(target) ||
  isSourceTsExportTarget(target) ||
  isSourceMjsTarget(target);

const packageBinTargets = (record) => {
  const bin = record.packageJson.bin;
  if (bin === undefined) return [];
  if (typeof bin === "string") return [bin];
  if (bin === null || typeof bin !== "object" || Array.isArray(bin)) {
    fail(`${record.packagePath}: package bin must be a string or record`);
  }
  return Object.values(bin).map((target) => {
    if (typeof target !== "string") {
      fail(`${record.packagePath}: package bin targets must be strings`);
    }
    return target;
  });
};

const binSourceFiles = (record) =>
  [
    ...new Set(
      packageBinTargets(record)
        .filter(isPackageBinSourceTarget)
        .map((target) => path.join(record.packageDir, target.slice("./".length))),
    ),
  ].sort((left, right) => left.localeCompare(right));

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
    const shouldPublish = pkg.path.startsWith("packages/");
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
    const unitOptionalPeers = packageUnitOptionalPeers(record);
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
    if (cloudflarePackageNames.has(pkg.name) && pkg.name !== "@agent-os/runtime") {
      if (workersPeer !== rootCatalog["@cloudflare/workers-types"]) {
        issues.push(
          `${record.packagePath}: Cloudflare package must peer depend on @cloudflare/workers-types ${rootCatalog["@cloudflare/workers-types"]}`,
        );
      }
    } else if (workersPeer !== undefined && !unitOptionalPeers.has("@cloudflare/workers-types")) {
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
  const exportsValue =
    record.packageJson.exports ??
    record.packageJson.main ??
    (record.packageJson.bin === undefined ? "./src/index.ts" : undefined);
  if (exportsValue === undefined) return [];
  if (typeof exportsValue === "string") {
    return [[".", exportsValue]];
  }
  if (exportsValue === null || typeof exportsValue !== "object") return [];
  return Object.entries(exportsValue)
    .map(([exportPath, exportTarget]) => [exportPath, resolveExportTarget(exportTarget)])
    .filter((entry) => typeof entry[1] === "string")
    .sort(([left], [right]) => left.localeCompare(right));
};

const isSourceTsExportTarget = (target) => target.startsWith("./src/") && target.endsWith(".ts");

const isJsonAssetExportTarget = (target) =>
  target.startsWith("./") &&
  !target.includes("..") &&
  !target.startsWith("./src/") &&
  target.endsWith(".json");

const srcTargetToDist = (target, ext) => {
  if (!target.startsWith("./src/") || !target.endsWith(".ts")) {
    fail(`export target must be a source .ts file: ${target}`);
  }
  return `./dist/${target.slice("./src/".length, -".ts".length)}.${ext}`;
};

const binTargetToDist = (target) => {
  if (isBinTsTarget(target)) {
    return `./dist/bin/${target.slice("./bin/".length, -".ts".length)}.js`;
  }
  if (isBinMjsTarget(target)) {
    return `./dist/bin/${target.slice("./bin/".length)}`;
  }
  if (isSourceMjsTarget(target)) {
    return `./dist/${target.slice("./src/".length)}`;
  }
  fail(`bin target must be a source .ts/.mjs file or bin .ts/.mjs file: ${target}`);
};

const generatedExportEntry = (target) => {
  if (isSourceTsExportTarget(target)) {
    return {
      types: srcTargetToDist(target, "d.ts"),
      default: srcTargetToDist(target, "js"),
    };
  }
  if (isJsonAssetExportTarget(target)) return { default: target };
  fail(`export target must be a source .ts module or package JSON asset: ${target}`);
};

const projectedBinTarget = (target) => {
  if (isSourceTsExportTarget(target)) return srcTargetToDist(target, "js");
  if (isBinTsTarget(target) || isBinMjsTarget(target) || isSourceMjsTarget(target)) {
    return binTargetToDist(target);
  }
  fail(`bin target must be a source .ts/.mjs file or bin .ts/.mjs file: ${target}`);
};

const projectedBin = (record) => {
  const bin = record.packageJson.bin;
  if (bin === undefined) return undefined;
  if (typeof bin === "string") return projectedBinTarget(bin);
  if (bin === null || typeof bin !== "object" || Array.isArray(bin)) {
    fail(`${record.packagePath}: package bin must be a string or record`);
  }
  return Object.fromEntries(
    Object.entries(bin)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, target]) => {
        if (typeof target !== "string") {
          fail(
            `${record.packagePath}: package bin ${name} must target a source .ts/.mjs file or bin .ts/.mjs file`,
          );
        }
        return [name, projectedBinTarget(target)];
      }),
  );
};

const distJsForSourceFile = (record, file) => {
  const srcRel = path.relative(path.join(record.packageDir, "src"), file);
  if (!srcRel.startsWith("..") && !path.isAbsolute(srcRel)) {
    return path.join(record.stageDir, "dist", srcRel.replace(/(?:\.d)?\.ts$/u, ".js"));
  }
  const binRel = path.relative(path.join(record.packageDir, "bin"), file);
  if (!binRel.startsWith("..") && !path.isAbsolute(binRel)) {
    return path.join(record.stageDir, "dist", "bin", binRel.replace(/(?:\.d)?\.ts$/u, ".js"));
  }
  return undefined;
};

const resolveRelativeTargetFile = (sourceFile, specifier, declarationOutput) => {
  if (!specifier.startsWith(".") || specifier.endsWith(".js") || specifier.endsWith(".json")) {
    return undefined;
  }
  const base = path.resolve(path.dirname(sourceFile), specifier);
  if (fs.existsSync(`${base}.ts`)) {
    return `${base}.ts`;
  }
  if (fs.existsSync(path.join(base, "index.ts"))) {
    return path.join(base, "index.ts");
  }
  if (declarationOutput && fs.existsSync(`${base}.d.ts`)) {
    return `${base}.d.ts`;
  }
  if (declarationOutput && fs.existsSync(path.join(base, "index.d.ts"))) {
    return path.join(base, "index.d.ts");
  }
  return undefined;
};

const relativeJsSpecifier = (fromOutFile, toOutFile) => {
  const relative = path.relative(path.dirname(fromOutFile), toOutFile).split(path.sep).join("/");
  return relative.startsWith(".") ? relative : `./${relative}`;
};

const resolveRelativeSpecifier = (record, sourceFile, outFile, specifier, declarationOutput) => {
  const targetFile = resolveRelativeTargetFile(sourceFile, specifier, declarationOutput);
  if (targetFile === undefined) return specifier;
  const targetOutFile = distJsForSourceFile(record, targetFile);
  if (targetOutFile === undefined) return specifier;
  return relativeJsSpecifier(outFile, targetOutFile);
};

const resolveModuleSpecifier = (record, sourceFile, outFile, specifier, declarationOutput) => {
  if (specifier.startsWith(".")) {
    return resolveRelativeSpecifier(record, sourceFile, outFile, specifier, declarationOutput);
  }
  return publicSpecifier(specifier);
};

const rewriteModuleSpecifiers = (record, text, sourceFile, outFile, declarationOutput) =>
  text
    .replace(/(\bfrom\s*["'])([^"']+)(["'])/g, (_match, prefix, specifier, suffix) => {
      return `${prefix}${resolveModuleSpecifier(
        record,
        sourceFile,
        outFile,
        specifier,
        declarationOutput,
      )}${suffix}`;
    })
    .replace(/(\bimport\s*\(\s*["'])([^"']+)(["']\s*\))/g, (_match, prefix, specifier, suffix) => {
      return `${prefix}${resolveModuleSpecifier(
        record,
        sourceFile,
        outFile,
        specifier,
        declarationOutput,
      )}${suffix}`;
    })
    .replace(/(\bimport\s*["'])([^"']+)(["'])/g, (_match, prefix, specifier, suffix) => {
      return `${prefix}${resolveModuleSpecifier(
        record,
        sourceFile,
        outFile,
        specifier,
        declarationOutput,
      )}${suffix}`;
    });

const emitJs = (record) => {
  for (const file of [...sourceFiles(record), ...binSourceFiles(record)]) {
    const out = distJsForSourceFile(record, file);
    if (out === undefined) fail(`${record.packagePath}: cannot emit ${repoPath(file)}`);
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
    fs.writeFileSync(
      out,
      rewritePublicScopePlaceholders(
        rewriteModuleSpecifiers(record, transpiled.outputText, file, out, false),
      ),
    );
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
    fs.writeFileSync(
      out,
      rewritePublicScopePlaceholders(
        rewriteModuleSpecifiers(record, result.outputText, file, out, true),
      ),
    );
  }
};

const exportedJsonAssets = (record) =>
  exportEntries(record)
    .map(([, target]) => target)
    .filter(isJsonAssetExportTarget);

const copyExportedAssets = (record) => {
  for (const target of exportedJsonAssets(record)) {
    const rel = target.slice("./".length);
    const source = path.join(record.packageDir, rel);
    const out = path.join(record.stageDir, rel);
    if (!fs.existsSync(source) || !fs.statSync(source).isFile()) {
      fail(`${record.packagePath}: exported asset does not exist: ${target}`);
    }
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.copyFileSync(source, out);
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
    if (isSourcePackageName(name)) {
      dependencies[publicPackageName(name)] = version;
      continue;
    }
    dependencies[name] = projectedDependencyRange(name, value, rootCatalog);
    if (dependencies[name] === undefined)
      fail(`${record.packagePath}: missing catalog value for ${name}`);
  }
  return Object.keys(dependencies).length === 0 ? undefined : dependencies;
};

const projectedPeerDependencies = (record) => {
  const rootCatalog = catalog();
  const peers = {};
  const sourcePeers = new Map(Object.entries(record.packageJson.peerDependencies ?? {}));
  for (const name of packageUnitOptionalPeers(record)) {
    if (!sourcePeers.has(name)) {
      sourcePeers.set(name, isSourcePackageName(name) ? "workspace:*" : "catalog:");
    }
  }
  for (const [name, value] of sourcePeers) {
    const projectedName = isSourcePackageName(name) ? publicPackageName(name) : name;
    peers[projectedName] = projectedDependencyRange(name, value, rootCatalog);
    if (peers[projectedName] === undefined)
      fail(`${record.packagePath}: missing peer projection value for ${name}`);
  }
  if (packageImportsEffect(record)) {
    peers.effect = rootCatalog.effect;
  }
  if (cloudflarePackageNames.has(record.packageJson.name)) {
    peers["@cloudflare/workers-types"] = rootCatalog["@cloudflare/workers-types"];
  }
  return Object.keys(peers).length === 0 ? undefined : peers;
};

const projectedPeerDependenciesMeta = (record) => {
  const entries = new Map(Object.entries(record.packageJson.peerDependenciesMeta ?? {}));
  for (const name of packageUnitOptionalPeers(record)) {
    if (!entries.has(name)) entries.set(name, { optional: true });
  }
  if (entries.size === 0) return undefined;
  return Object.fromEntries(
    [...entries.entries()].map(([name, value]) => [
      isSourcePackageName(name) ? publicPackageName(name) : name,
      value,
    ]),
  );
};

const generatedManifest = (record) => {
  const entries = exportEntries(record);
  const exportsValue = Object.fromEntries(
    entries.map(([exportPath, target]) => [exportPath, generatedExportEntry(target)]),
  );
  const exportedAssets = exportedJsonAssets(record).map((target) => target.slice("./".length));
  const manifest = {
    name: publicPackageName(record.packageJson.name),
    version: packageVersion(),
    type: "module",
    license: "UNLICENSED",
    publishConfig: {
      access: publishAccess(),
    },
    main: exportsValue["."]?.default,
    types: exportsValue["."]?.types,
    bin: projectedBin(record),
    exports: entries.length === 0 ? undefined : exportsValue,
    files: [
      "dist",
      ...exportedAssets,
      ...(fs.existsSync(path.join(record.packageDir, "README.md")) ? ["README.md"] : []),
      ...(fs.existsSync(path.join(record.packageDir, "PUBLIC_API.md")) ? ["PUBLIC_API.md"] : []),
    ],
    dependencies: projectedDependencies(record),
    peerDependencies: projectedPeerDependencies(record),
    peerDependenciesMeta: projectedPeerDependenciesMeta(record),
  };
  return Object.fromEntries(Object.entries(manifest).filter(([, value]) => value !== undefined));
};

const copyPackageDocs = (record) => {
  for (const name of ["README.md", "PUBLIC_API.md"]) {
    const source = path.join(record.packageDir, name);
    if (fs.existsSync(source)) {
      fs.writeFileSync(
        path.join(record.stageDir, name),
        rewritePublicSpecifiers(fs.readFileSync(source, "utf8")),
      );
    }
  }
};

const assertStagedPackageDocsUsePublicScope = () => {
  const offenders = [];
  for (const record of publishedRecords()) {
    for (const name of ["README.md", "PUBLIC_API.md"]) {
      const file = path.join(record.stageDir, name);
      if (!fs.existsSync(file)) continue;
      const text = fs.readFileSync(file, "utf8");
      if (text.includes(`${sourcePackageScope}/`)) offenders.push(path.relative(root, file));
    }
  }
  if (offenders.length > 0) {
    fail(`staged package docs contain source package scope:\n${offenders.join("\n")}`);
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
    copyExportedAssets(record);
    copyPackageDocs(record);
    writeJson(path.join(record.stageDir, "package.json"), generatedManifest(record));
  }
  assertStagedPackageDocsUsePublicScope();
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

const fileSpecPath = (spec) => {
  if (typeof spec !== "string" || !spec.startsWith("file:")) {
    fail(`expected file: tarball spec; actual ${String(spec)}`);
  }
  return spec.slice("file:".length);
};

const consumerManifestFiles = (consumerRoot) =>
  [
    "package.json",
    "bun.lock",
    "bun.lockb",
    "package-lock.json",
    "npm-shrinkwrap.json",
    "pnpm-lock.yaml",
    "yarn.lock",
  ].map((name) => path.join(consumerRoot, name));

const snapshotFiles = (files) =>
  new Map(files.map((file) => [file, fs.existsSync(file) ? fs.readFileSync(file) : undefined]));

const assertSnapshotUnchanged = (snapshot, context) => {
  const changed = [];
  for (const [file, before] of snapshot.entries()) {
    const after = fs.existsSync(file) ? fs.readFileSync(file) : undefined;
    if (
      before === undefined
        ? after !== undefined
        : after === undefined || !Buffer.from(before).equals(after)
    ) {
      changed.push(path.relative(path.dirname(file), file) || file);
    }
  }
  if (changed.length > 0) {
    fail(`${context} changed consumer manifest/lock files:\n${changed.join("\n")}`);
  }
};

const resolveConsumerRoot = (value) => {
  if (typeof value !== "string" || value.length === 0) {
    fail("consumer path is required");
  }
  const consumerRoot = path.resolve(process.cwd(), value);
  if (!fs.existsSync(path.join(consumerRoot, "package.json"))) {
    fail(`${consumerRoot}: missing package.json`);
  }
  return consumerRoot;
};

const localConsumerMarkerPath = (consumerRoot) =>
  path.join(consumerRoot, "node_modules", localConsumerMarkerName);

const nodeModulesRoot = (consumerRoot) => {
  const root = path.join(consumerRoot, "node_modules");
  if (!fs.existsSync(root)) {
    fail(`${consumerRoot}: missing node_modules; run the consumer package manager install first`);
  }
  return root;
};

const packageTargetDir = (nodeModules, packageName) =>
  path.join(nodeModules, ...packageName.split("/"));

const readInstallManifest = () => {
  if (!fs.existsSync(installManifestPath)) {
    fail(`${repoPath(installManifestPath)} is missing; run pack first`);
  }
  const manifest = readJson(installManifestPath);
  if (manifest === null || typeof manifest !== "object" || manifest.tarballs === undefined) {
    fail(`${repoPath(installManifestPath)} is not an install manifest`);
  }
  return manifest;
};

const tarballPackageEntries = (manifest) =>
  Object.entries(manifest.tarballs)
    .map(([packageName, entry]) => {
      if (entry === null || typeof entry !== "object") {
        fail(`${packageName}: invalid tarball manifest entry`);
      }
      const tarball = fileSpecPath(entry.spec);
      if (!fs.existsSync(tarball)) {
        fail(`${packageName}: tarball does not exist: ${tarball}`);
      }
      return {
        packageName,
        tarball,
        sha256: entry.sha256,
      };
    })
    .sort((left, right) => left.packageName.localeCompare(right.packageName));

const unpackTarballInto = (tarball, target) => {
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

const installConsumer = (rawArgs) => {
  const args = parseArgs(rawArgs);
  const consumerRoot = resolveConsumerRoot(positionalArgs(args)[0]);
  const snapshot = snapshotFiles(consumerManifestFiles(consumerRoot));
  if (!boolArg(args, "skip-pack")) packInternal();
  const manifest = readInstallManifest();
  const entries = tarballPackageEntries(manifest);
  const nodeModules = nodeModulesRoot(consumerRoot);
  const packages = {};
  for (const entry of entries) {
    const target = packageTargetDir(nodeModules, entry.packageName);
    unpackTarballInto(entry.tarball, target);
    packages[entry.packageName] = {
      target: path.relative(consumerRoot, target).split(path.sep).join("/"),
      tarball: entry.tarball,
      sha256: entry.sha256,
    };
  }
  writeJson(localConsumerMarkerPath(consumerRoot), {
    schemaVersion: 1,
    generatedBy: "tooling/distribution/distribution.mjs install-consumer",
    installedAt: new Date().toISOString(),
    consumerRoot,
    source: {
      repoRoot,
      branch: gitValue(["branch", "--show-current"], "unknown"),
      head: gitValue(["rev-parse", "HEAD"], "unknown"),
      dirty: gitStatusShort().length > 0,
    },
    packageVersion: manifest.version,
    packages,
  });
  assertSnapshotUnchanged(snapshot, "install-consumer");
  console.log(
    `installed ${entries.length} local agentOS packages into ${path.relative(repoRoot, consumerRoot) || consumerRoot}`,
  );
  console.log(
    `wrote ${path.relative(consumerRoot, localConsumerMarkerPath(consumerRoot)).split(path.sep).join("/")}`,
  );
};

const restoreConsumer = (rawArgs) => {
  const args = parseArgs(rawArgs);
  const consumerRoot = resolveConsumerRoot(positionalArgs(args)[0]);
  const nodeModules = nodeModulesRoot(consumerRoot);
  const markerPath = localConsumerMarkerPath(consumerRoot);
  if (!fs.existsSync(markerPath)) {
    fail(`${markerPath}: no local agentOS overlay marker`);
  }
  const marker = readJson(markerPath);
  const packageNames = Object.keys(marker.packages ?? {}).sort((left, right) =>
    left.localeCompare(right),
  );
  if (packageNames.length === 0) fail(`${markerPath}: marker does not list packages`);
  const snapshot = snapshotFiles(consumerManifestFiles(consumerRoot));
  for (const packageName of packageNames) {
    fs.rmSync(packageTargetDir(nodeModules, packageName), { recursive: true, force: true });
  }
  fs.rmSync(markerPath, { force: true });
  if (!boolArg(args, "no-install")) {
    run("bun", ["install", "--frozen-lockfile"], { cwd: consumerRoot });
  }
  assertSnapshotUnchanged(snapshot, "restore-consumer");
  console.log(`restored ${packageNames.length} local agentOS package overlays`);
};

const writeInstallManifest = (entries) => {
  const sorted = entries
    .slice()
    .sort((left, right) =>
      publicPackageName(left.record.packageJson.name).localeCompare(
        publicPackageName(right.record.packageJson.name),
      ),
    );
  const dependencies = Object.fromEntries(
    sorted.map((entry) => [
      publicPackageName(entry.record.packageJson.name),
      tarballSpec(entry.file),
    ]),
  );
  writeJson(installManifestPath, {
    version: packageVersion(),
    generatedBy: "tooling/distribution/distribution.mjs pack",
    dependencies,
    overrides: dependencies,
    tarballs: Object.fromEntries(
      sorted.map((entry) => [
        publicPackageName(entry.record.packageJson.name),
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
  if (manifestText.includes(`${sourcePackageScope}/`)) {
    issues.push(`generated manifest leaks source package scope ${sourcePackageScope}`);
  }
  const publicNames = new Set(
    publishedRecords().map((candidate) => publicPackageName(candidate.packageJson.name)),
  );
  for (const dependencyName of Object.keys(manifest.dependencies ?? {})) {
    if (isSourcePackageName(dependencyName)) {
      issues.push(`generated manifest depends on source package scope ${dependencyName}`);
    }
    if (dependencyName.startsWith(`${publishScope()}/`) && !publicNames.has(dependencyName)) {
      issues.push(`generated manifest depends on unpublished internal package ${dependencyName}`);
    }
  }
  const sourceModuleSpecifierPattern = new RegExp(
    `(?:\\bfrom\\s*["']|\\bimport\\s*\\(\\s*["']|\\bimport\\s*["'])${escapeRegExp(
      sourcePackageScope,
    )}/`,
    "u",
  );
  const publishedSourcePathPattern = new RegExp(`${escapeRegExp(publishScope())}/[^"']+/src/`, "u");
  for (const file of allFiles(path.join(record.stageDir, "dist")).filter(
    (candidate) => candidate.endsWith(".d.ts") || candidate.endsWith(".js"),
  )) {
    const text = fs.readFileSync(file, "utf8");
    if (sourceModuleSpecifierPattern.test(text)) {
      issues.push(`${repoPath(file)} leaks source package module specifier ${sourcePackageScope}`);
    }
    if (
      file.endsWith(".d.ts") &&
      (/\/src\/|src\/index|workspace:\*|["']workspace:/.test(text) ||
        publishedSourcePathPattern.test(text))
    ) {
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
    const packageName = publicPackageName(record.packageJson.name);
    const packageNamePart = packageName.replace(/^@/u, "").replace(/\//gu, "-");
    const prefix = `${packageNamePart}-${version}`;
    const tarball = allFiles(tarballRoot)
      .filter((entry) => path.basename(entry).startsWith(prefix) && entry.endsWith(".tgz"))
      .sort((left, right) => left.localeCompare(right))
      .at(-1);
    if (tarball === undefined) fail(`${packageName}: missing tarball`);
    byPackage.set(packageName, tarball);
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
      `import { compileAgentTree } from "${publicSpecifier("@agent-os/agent-authoring")}";`,
      `import { triggerParseOk } from "${publicSpecifier("@agent-os/runtime")}";`,
      `import { mountOpsApi } from "${publicSpecifier("@agent-os/runtime/cloudflare/ops-api")}";`,
      "void triggerParseOk;",
      "void mountOpsApi;",
      "const compiled = compileAgentTree({",
      "  files: [{ path: 'agent/instructions.md', kind: 'markdown', text: 'Say hello.' }],",
      "});",
      "if (!compiled.ok) throw new Error(JSON.stringify(compiled.issues));",
      "void compiled.value.manifest;",
    ].join("\n") + "\n",
  );
  fs.writeFileSync(
    path.join(dir, "smoke.mjs"),
    [
      `import { compileAgentTree } from "${publicSpecifier("@agent-os/agent-authoring")}";`,
      `import { ABORT } from "${publicSpecifier("@agent-os/core")}";`,
      `import { triggerParseOk } from "${publicSpecifier("@agent-os/runtime")}";`,
      `import { projectTurnStream } from "${publicSpecifier("@agent-os/turn-stream")}";`,
      `import { mountOpsApi } from "${publicSpecifier("@agent-os/runtime/cloudflare/ops-api")}";`,
      "if (!compileAgentTree || !ABORT || !triggerParseOk || !projectTurnStream || !mountOpsApi) throw new Error('missing import');",
    ].join("\n") + "\n",
  );
  fs.writeFileSync(
    path.join(dir, "cf-entry.ts"),
    [
      `import { compileAgentTree } from "${publicSpecifier("@agent-os/agent-authoring")}";`,
      `import { createAgentDurableObject } from "${publicSpecifier("@agent-os/runtime/cloudflare")}";`,
      `import { OpenAiCompatibleLlmTransportLive } from "${publicSpecifier("@agent-os/runtime/llm-effect-ai")}";`,
      `import { defineAgentBindings } from "${publicSpecifier("@agent-os/core/runtime-protocol")}";`,
      "const compiled = compileAgentTree({",
      "  files: [{ path: 'agent/instructions.md', kind: 'markdown', text: 'Say hello.' }],",
      "});",
      "if (!compiled.ok) throw new Error(JSON.stringify(compiled.issues));",
      "const agentBindings = defineAgentBindings<never>({ handlers: {} });",
      "export const AgentDO = createAgentDurableObject({",
      "  manifest: compiled.value.manifest,",
      "  agentBindings,",
      "  llmTransport: () => OpenAiCompatibleLlmTransportLive,",
      "});",
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
    include: ["index.ts", "cf-entry.ts"],
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
    include: ["index.ts", "cf-entry.ts"],
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
  const dir = mkdtempFixture("agentos-peer-failure-");
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
    `import { makePreClaim } from "${publicSpecifier(
      "@agent-os/core/effect-claim",
    )}";\nvoid makePreClaim;\n`,
  );
  fs.writeFileSync(
    path.join(dir, "smoke.mjs"),
    `import { makePreClaim } from "${publicSpecifier(
      "@agent-os/core/effect-claim",
    )}";\nvoid makePreClaim;\n`,
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
  const core = records.find((record) => record.packageJson.name === "@agent-os/core");
  const turnStream = records.find((record) => record.packageJson.name === "@agent-os/turn-stream");
  const cloudflare = records.find((record) => record.packageJson.name === "@agent-os/runtime");
  if (core === undefined || turnStream === undefined || cloudflare === undefined) {
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
    const text = `import type { X } from "${publicSpecifier(
      "@agent-os/runtime/src/internal-helper",
    )}";\n`;
    if (
      /\/src\/|src\/index|workspace:\*|["']workspace:/.test(text) ||
      new RegExp(`${escapeRegExp(publishScope())}/[^"']+/src/`, "u").test(text)
    ) {
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
  const dir = mkdtempFixture("agentos-internal-consumer-");
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
  const access = publishAccess();
  for (const tarball of tarballsByPackage().values()) {
    run("npm", ["publish", tarball, "--registry", registry, "--access", access]);
  }
};

const writeLocalChannelManifest = ({ registry, tag, version }) => {
  const names = publishedRecords()
    .map((record) => publicPackageName(record.packageJson.name))
    .sort((left, right) => left.localeCompare(right));
  writeJson(localChannelManifestPath, {
    version,
    registry,
    tag,
    generatedBy: "tooling/distribution/distribution.mjs publish-local",
    dependencies: Object.fromEntries(names.map((name) => [name, tag])),
    npmrc: [`${publishScope()}:registry=${registry}`],
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
  const access = args.access ?? publishAccess();
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
      `  '${publishScope()}/*':`,
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
  case "install-consumer":
    installConsumer(commandArgs);
    break;
  case "restore-consumer":
    restoreConsumer(commandArgs);
    break;
  default:
    fail(`unknown distribution command: ${command}`);
}
