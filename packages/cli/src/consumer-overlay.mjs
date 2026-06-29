import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { workspacePackagePaths } from "./lib/workspace-manifest.mjs";

export const installManifestProtocol = "agentos-install-manifest@1";
export const localConsumerMarkerName = ".agentos-local.json";

const packageRootFromModule = () => path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const fail = (message) => {
  throw new Error(message);
};

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
};

const sha256File = (file) =>
  crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

const run = (cmd, args, options = {}) => {
  const result = spawnSync(cmd, args, {
    cwd: options.cwd ?? process.cwd(),
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

const parseArgs = (args) => {
  const parsed = { _: [] };
  const booleanKeys = new Set(["skip-pack", "no-install", "json", "check-npm"]);
  for (let index = 0; index < args.length; index += 1) {
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
      index += 1;
    } else {
      parsed[key] = true;
    }
  }
  return parsed;
};

const positionalArgs = (args) => args._ ?? [];

const boolArg = (args, name) => args[name] === true || args[name] === "true";

const packageMetadata = (packageRoot = packageRootFromModule()) => {
  const manifest = readJson(path.join(packageRoot, "package.json"));
  const version =
    typeof manifest.agentOsRelease?.version === "string"
      ? manifest.agentOsRelease.version
      : manifest.version;
  if (typeof version !== "string" || version.length === 0) {
    fail(`${path.join(packageRoot, "package.json")}: package version must be a non-empty string`);
  }
  const scope = typeof manifest.name === "string" ? manifest.name.split("/")[0] : undefined;
  return {
    packageRoot,
    packageName: manifest.name,
    packageVersion: version,
    packageScope: typeof scope === "string" && scope.startsWith("@") ? scope : undefined,
  };
};

const gitValue = (cwd, args, fallback) => {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) return fallback;
  const value = result.stdout.trim();
  return value.length === 0 ? fallback : value;
};

export const sourceIdentityFor = (sourceRoot) => ({
  repoRoot: sourceRoot,
  branch: gitValue(sourceRoot, ["branch", "--show-current"], "unknown"),
  head: gitValue(sourceRoot, ["rev-parse", "HEAD"], "unknown"),
  dirty: gitValue(sourceRoot, ["status", "--short"], "").length > 0,
});

export const consumerManifestFiles = (consumerRoot) =>
  ["package.json", "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock"].map(
    (name) => path.join(consumerRoot, name),
  );

const packageNameForRoot = (consumerRoot) => {
  const file = path.join(consumerRoot, "package.json");
  if (!fs.existsSync(file)) return undefined;
  const name = readJson(file).name;
  return typeof name === "string" && name.length > 0 ? name : undefined;
};

const consumerWorkspaceLayout = (consumerRoot) => {
  const manifest = path.join(consumerRoot, "pnpm-workspace.yaml");
  const root = {
    kind: "root",
    relativePath: ".",
    consumerRoot,
    packageName: packageNameForRoot(consumerRoot),
  };
  if (!fs.existsSync(manifest)) {
    return { status: "not_workspace", roots: [root] };
  }
  try {
    const roots = [
      root,
      ...workspacePackagePaths(consumerRoot).map((relativePath) => {
        const packageRoot = path.join(consumerRoot, relativePath);
        return {
          kind: "workspace-package",
          relativePath,
          consumerRoot: packageRoot,
          packageName: packageNameForRoot(packageRoot),
        };
      }),
    ];
    return {
      status: "workspace",
      manifestPath: path.relative(consumerRoot, manifest).split(path.sep).join("/"),
      roots,
    };
  } catch (error) {
    return {
      status: "invalid",
      manifestPath: path.relative(consumerRoot, manifest).split(path.sep).join("/"),
      error: error instanceof Error ? error.message : String(error),
      roots: [root],
    };
  }
};

const consumerWorkspaceManifestFiles = (layout) =>
  [
    ...new Set(
      layout.roots.flatMap((root) => consumerManifestFiles(root.consumerRoot)),
    ),
  ].sort((left, right) => left.localeCompare(right));

export const snapshotFiles = (files) =>
  new Map(files.map((file) => [file, fs.existsSync(file) ? fs.readFileSync(file) : undefined]));

export const assertSnapshotUnchanged = (snapshot, context) => {
  const changed = [];
  for (const [file, before] of snapshot.entries()) {
    const after = fs.existsSync(file) ? fs.readFileSync(file) : undefined;
    if (
      before === undefined
        ? after !== undefined
        : after === undefined || !Buffer.from(before).equals(after)
    ) {
      changed.push(path.basename(file));
    }
  }
  if (changed.length > 0) {
    fail(`${context} changed consumer manifest/lock files:\n${changed.join("\n")}`);
  }
};

export const resolveConsumerRoot = (value) => {
  if (typeof value !== "string" || value.length === 0) {
    fail("consumer path is required");
  }
  const consumerRoot = path.resolve(process.cwd(), value);
  if (!fs.existsSync(path.join(consumerRoot, "package.json"))) {
    fail(`${consumerRoot}: missing package.json`);
  }
  return consumerRoot;
};

export const localConsumerMarkerPath = (consumerRoot) =>
  path.join(consumerRoot, "node_modules", localConsumerMarkerName);

const consumerPackageManagerName = (consumerRoot) => {
  const packageJson = readJson(path.join(consumerRoot, "package.json"));
  const packageManager =
    typeof packageJson.packageManager === "string" ? packageJson.packageManager : "";
  if (packageManager.startsWith("pnpm@")) return "pnpm";
  if (packageManager.startsWith("npm@")) return "npm";
  if (packageManager.startsWith("bun@")) return "bun";
  if (packageManager.startsWith("yarn@")) return "yarn";
  if (fs.existsSync(path.join(consumerRoot, "pnpm-lock.yaml"))) return "pnpm";
  if (fs.existsSync(path.join(consumerRoot, "package-lock.json"))) return "npm";
  if (fs.existsSync(path.join(consumerRoot, "bun.lock"))) return "bun";
  if (fs.existsSync(path.join(consumerRoot, "bun.lockb"))) return "bun";
  if (fs.existsSync(path.join(consumerRoot, "yarn.lock"))) return "yarn";
  return null;
};

export const consumerInstallCommand = (consumerRoot) => {
  const manager = consumerPackageManagerName(consumerRoot);
  switch (manager) {
    case "pnpm":
      return {
        manager,
        cmd: "pnpm",
        args: ["install", "--frozen-lockfile", "--ignore-scripts"],
        env: { ...process.env, CI: "true", COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" },
      };
    case "npm":
      return fs.existsSync(path.join(consumerRoot, "package-lock.json"))
        ? {
            manager,
            cmd: "npm",
            args: ["ci", "--ignore-scripts", "--no-audit", "--no-fund"],
            env: process.env,
          }
        : {
            manager,
            cmd: "npm",
            args: [
              "install",
              "--package-lock=false",
              "--ignore-scripts",
              "--no-audit",
              "--no-fund",
            ],
            env: process.env,
          };
    case "bun":
      return {
        manager,
        cmd: "bun",
        args: ["install", "--frozen-lockfile", "--ignore-scripts"],
        env: { ...process.env, CI: "true" },
      };
    case "yarn":
      return {
        manager,
        cmd: "yarn",
        args: ["install", "--immutable", "--ignore-scripts"],
        env: { ...process.env, CI: "true" },
      };
    default:
      return null;
  }
};

export const nodeModulesRoot = (consumerRoot, options = {}) => {
  const root = path.join(consumerRoot, "node_modules");
  if (fs.existsSync(root)) return root;
  if (options.install !== true) {
    fail(
      `${consumerRoot}: missing node_modules; run the consumer package manager install first, or rerun install without --no-install to let agentOS run a frozen install`,
    );
  }
  const installCommand = consumerInstallCommand(consumerRoot);
  if (installCommand === null) {
    fail(
      `${consumerRoot}: missing node_modules and no package manager/lockfile was detected; run the consumer install first`,
    );
  }
  console.log(
    `node_modules missing; running ${installCommand.cmd} ${installCommand.args.join(" ")} in ${consumerRoot}`,
  );
  run(installCommand.cmd, installCommand.args, {
    cwd: consumerRoot,
    capture: true,
    env: installCommand.env,
  });
  if (!fs.existsSync(root)) {
    fail(`${consumerRoot}: package manager install completed but node_modules is still missing`);
  }
  return root;
};

export const packageTargetDir = (nodeModules, packageName) =>
  path.join(nodeModules, ...packageName.split("/"));

export const unpackTarballInto = (tarball, target) => {
  const tmp = fs.mkdtempSync(path.join(fs.realpathSync("/tmp"), "agentos-consumer-package-"));
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

export const readInstallManifest = (manifestPath) => {
  if (typeof manifestPath !== "string" || manifestPath.length === 0) {
    fail("install manifest path is required");
  }
  const absolutePath = path.resolve(process.cwd(), manifestPath);
  if (!fs.existsSync(absolutePath)) {
    fail(`${absolutePath}: install manifest is missing`);
  }
  const manifest = readJson(absolutePath);
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
    fail(`${absolutePath}: install manifest must be an object`);
  }
  if (manifest.protocol !== installManifestProtocol) {
    fail(`${absolutePath}: install manifest protocol must be ${installManifestProtocol}`);
  }
  if (typeof manifest.version !== "string" || manifest.version.length === 0) {
    fail(`${absolutePath}: install manifest version must be a non-empty string`);
  }
  if (manifest.tarballs === null || typeof manifest.tarballs !== "object") {
    fail(`${absolutePath}: install manifest tarballs must be an object`);
  }
  return { path: absolutePath, manifest };
};

const fileSpecPath = (spec) => {
  if (typeof spec !== "string" || !spec.startsWith("file:")) {
    fail(`expected file: tarball spec; actual ${String(spec)}`);
  }
  return spec.slice("file:".length);
};

export const tarballPackageEntries = (manifest) =>
  Object.entries(manifest.tarballs)
    .map(([packageName, entry]) => {
      if (entry === null || typeof entry !== "object") {
        fail(`${packageName}: invalid tarball manifest entry`);
      }
      const tarball = fileSpecPath(entry.spec);
      if (!fs.existsSync(tarball)) {
        fail(`${packageName}: tarball does not exist: ${tarball}`);
      }
      if (typeof entry.sha256 !== "string" || entry.sha256.length !== 64) {
        fail(`${packageName}: tarball manifest entry sha256 must be hex64`);
      }
      return {
        packageName,
        tarball,
        sha256: entry.sha256,
      };
    })
    .sort((left, right) => left.packageName.localeCompare(right.packageName));

const markerArtifact = (manifestPath, manifest) => ({
  kind: "install-manifest-overlay",
  installManifest: {
    path: manifestPath,
    sha256: sha256File(manifestPath),
    protocol: manifest.protocol,
    version: manifest.version,
    generatedBy: manifest.generatedBy,
  },
});

const packageOverlayRows = (consumerRoot, marker) => {
  const nodeModules = path.join(consumerRoot, "node_modules");
  return Object.entries(marker.packages ?? {})
    .map(([packageName, record]) => {
      const target = packageTargetDir(nodeModules, packageName);
      const targetExists = fs.existsSync(target);
      const targetStatus = !targetExists
        ? "missing"
        : fs.lstatSync(target).isSymbolicLink()
          ? "symlink"
          : "installed";
      const tarball = typeof record.tarball === "string" ? record.tarball : "";
      const tarballExists = tarball.length > 0 && fs.existsSync(tarball);
      const expectedSha = typeof record.sha256 === "string" ? record.sha256 : undefined;
      const actualSha = tarballExists ? sha256File(tarball) : undefined;
      const requiresSha = marker.artifact?.kind === "install-manifest-overlay";
      return {
        packageName,
        target: record.target,
        installed: targetStatus === "installed",
        targetStatus,
        tarball,
        tarballStatus: tarballExists
          ? expectedSha === undefined
            ? requiresSha
              ? "sha_missing"
              : "verified"
            : expectedSha === actualSha
              ? "verified"
              : "sha_mismatch"
          : "missing",
        sha256: expectedSha,
      };
    })
    .sort((left, right) => left.packageName.localeCompare(right.packageName));
};

const overlaySourceStatus = (marker, currentSource) => {
  if (marker.source === undefined) return "not_recorded";
  if (currentSource === undefined) return "not_checked";
  if (marker.source?.repoRoot !== currentSource.repoRoot) return "foreign_source";
  if (marker.source?.head !== currentSource.head) return "stale_source";
  if (marker.source?.dirty !== currentSource.dirty) return "dirty_state_changed";
  return "current_source";
};

const truthModeFor = (marker) => {
  if (marker === undefined) return "npm_release";
  if (marker.artifact?.kind === "install-manifest-overlay") return "local_overlay";
  return "legacy_local_overlay";
};

const packageIntegrityFor = (marker, packages) => {
  if (marker === undefined) {
    return {
      status: "not_checked",
      reason: "local overlay marker is missing; consumer is using package-manager truth",
    };
  }
  const failures = [];
  if (packages.length === 0) {
    failures.push({ code: "local_overlay_packages_missing", message: "marker lists no packages" });
  }
  for (const pkg of packages) {
    if (pkg.targetStatus === "missing") {
      failures.push({
        code: "local_overlay_package_missing",
        packageName: pkg.packageName,
        targetStatus: pkg.targetStatus,
      });
    }
    if (pkg.targetStatus === "symlink") {
      failures.push({
        code: "local_overlay_package_symlink",
        packageName: pkg.packageName,
        targetStatus: pkg.targetStatus,
      });
    }
    if (pkg.tarballStatus !== "verified") {
      failures.push({
        code: "local_overlay_tarball_not_verified",
        packageName: pkg.packageName,
        tarballStatus: pkg.tarballStatus,
      });
    }
  }
  return {
    status: failures.length === 0 ? "verified" : "failed",
    packagesChecked: packages.length,
    failures,
  };
};

const sourceFreshnessFor = (marker, currentSource) => {
  const status = overlaySourceStatus(marker ?? {}, currentSource);
  return {
    status,
    checked: currentSource !== undefined,
    gate: ["current_source", "not_checked"].includes(status) ? "pass" : "fail",
    ...(status === "not_checked"
      ? { reason: "source checkout identity is unavailable in this invocation" }
      : {}),
  };
};

const packageVersionStatus = (marker, packageVersion) =>
  marker.packageVersion === packageVersion ? "release_version_match" : "release_version_mismatch";

const npmLatestNotChecked = () => ({
  status: "not_checked",
  reason: "pass --check-npm to compare against the registry",
});

const npmLatestFor = (packageNames, registry) => {
  const packages = {};
  for (const packageName of packageNames) {
    const args = ["view", packageName, "version", "--json"];
    if (typeof registry === "string" && registry.length > 0) args.push("--registry", registry);
    const result = spawnSync("npm", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    packages[packageName] =
      result.status === 0
        ? { status: "resolved", version: JSON.parse(result.stdout.trim()) }
        : { status: "unresolved", detail: result.stderr.trim() || result.stdout.trim() };
  }
  return { status: "checked", packages };
};

const consumerGateIssue = (code, severity, dimension, message, detail = {}) => ({
  code,
  severity,
  dimension,
  message,
  ...detail,
});

const consumerOverlayGate = (status) => {
  const hardFailures = [];
  const signals = [];
  if (status.workspaceOverlay?.status === "invalid") {
    hardFailures.push(
      consumerGateIssue(
        "workspace_layout_invalid",
        "hard",
        "workspace_layout",
        "consumer workspace manifest could not be projected",
        {
          manifestPath: status.workspaceOverlay.manifestPath,
          error: status.workspaceOverlay.error,
        },
      ),
    );
  }
  for (const root of status.workspaceOverlay?.roots ?? []) {
    if (root.relativePath === ".") continue;
    if (root.gate?.status !== "pass") {
      hardFailures.push(
        consumerGateIssue(
          "workspace_consumer_root_failed",
          "hard",
          "workspace_resolver",
          `workspace consumer root ${root.relativePath} does not have a passing local overlay`,
          {
            relativePath: root.relativePath,
            packageName: root.packageName,
            gate: root.gate,
          },
        ),
      );
    }
  }
  if (status.localOverlay.status === "missing") {
    hardFailures.push(
      consumerGateIssue(
        "local_overlay_missing",
        "hard",
        "truth_mode",
        "local consumer overlay marker is missing",
        { markerPath: status.markerPath },
      ),
    );
  }
  for (const failure of status.packageIntegrity.failures ?? []) {
    hardFailures.push(
      consumerGateIssue(
        failure.code,
        "hard",
        "package_integrity",
        failure.message ?? `local consumer overlay package integrity failed: ${failure.code}`,
        failure,
      ),
    );
  }
  if (status.sourceFreshness?.gate === "fail") {
    hardFailures.push(
      consumerGateIssue(
        "local_overlay_source_not_current",
        "hard",
        "source_freshness",
        `local consumer overlay source freshness is ${status.sourceFreshness.status}`,
        { sourceStatus: status.sourceFreshness.status },
      ),
    );
  }
  if (status.sourceFreshness?.status === "not_checked") {
    signals.push(
      consumerGateIssue(
        "local_overlay_source_not_checked",
        "signal",
        "source_freshness",
        "local overlay source was not checked by this packaged CLI invocation",
      ),
    );
  }
  if (
    status.packageVersion.status !== undefined &&
    status.packageVersion.status !== "release_version_match"
  ) {
    hardFailures.push(
      consumerGateIssue(
        "local_overlay_release_version_mismatch",
        "hard",
        "release_identity",
        `local consumer overlay version is ${status.packageVersion.status}`,
        { packageVersionStatus: status.packageVersion.status },
      ),
    );
  }
  if (status.npmLatest.status === "not_checked") {
    signals.push(
      consumerGateIssue(
        "npm_latest_not_checked",
        "signal",
        "registry_observation",
        "npm latest was not checked; pass --check-npm to include registry observation",
      ),
    );
  }
  if (status.npmLatest.status === "checked") {
    for (const [packageName, row] of Object.entries(status.npmLatest.packages ?? {})) {
      if (row.status !== "resolved") {
        signals.push(
          consumerGateIssue(
            "npm_latest_unresolved",
            "signal",
            "registry_observation",
            `${packageName} npm latest could not be resolved`,
            { packageName, status: row.status },
          ),
        );
      }
    }
  }
  return {
    status: hardFailures.length === 0 ? "pass" : "fail",
    hardFailures,
    signals,
  };
};

const withConsumerGate = (status) => ({
  ...status,
  gate: consumerOverlayGate(status),
});

const consumerStatusDataForRoot = (consumerRoot, options = {}) => {
  const metadata = packageMetadata(options.packageRoot);
  const markerPath = localConsumerMarkerPath(consumerRoot);
  const currentSource =
    typeof options.sourceRoot === "string" ? sourceIdentityFor(options.sourceRoot) : undefined;
  if (!fs.existsSync(markerPath)) {
    return withConsumerGate({
      schemaVersion: 1,
      consumerRoot,
      markerPath: path.relative(consumerRoot, markerPath).split(path.sep).join("/"),
      truthMode: truthModeFor(undefined),
      localOverlay: { status: "missing" },
      packageIntegrity: packageIntegrityFor(undefined, []),
      sourceFreshness: { status: "not_applicable", checked: false, gate: "pass" },
      packageVersion: { release: metadata.packageVersion },
      npmLatest:
        options.checkNpm === true ? npmLatestFor([], options.registry) : npmLatestNotChecked(),
    });
  }
  const marker = readJson(markerPath);
  const packages = packageOverlayRows(consumerRoot, marker);
  const sourceStatus = overlaySourceStatus(marker, currentSource);
  const packageIntegrity = packageIntegrityFor(marker, packages);
  const sourceFreshness = sourceFreshnessFor(marker, currentSource);
  return withConsumerGate({
    schemaVersion: 1,
    consumerRoot,
    markerPath: path.relative(consumerRoot, markerPath).split(path.sep).join("/"),
    truthMode: truthModeFor(marker),
    localOverlay: {
      status: packages.every((pkg) => pkg.installed) ? "installed" : "partial",
      sourceStatus,
      generatedBy: marker.generatedBy,
      installedAt: marker.installedAt,
      artifact: marker.artifact ?? { kind: "legacy-local-overlay" },
      packages,
    },
    packageIntegrity,
    sourceFreshness,
    source: {
      ...(currentSource === undefined ? {} : { current: currentSource }),
      overlay: marker.source,
    },
    packageVersion: {
      release: metadata.packageVersion,
      overlay: marker.packageVersion,
      status: packageVersionStatus(marker, metadata.packageVersion),
    },
    npmLatest:
      options.checkNpm === true
        ? npmLatestFor(
            packages.map((pkg) => pkg.packageName),
            options.registry,
          )
        : npmLatestNotChecked(),
  });
};

const workspaceRootStatusSummary = (root, status) => ({
  kind: root.kind,
  relativePath: root.relativePath,
  consumerRoot: root.consumerRoot,
  ...(root.packageName === undefined ? {} : { packageName: root.packageName }),
  truthMode: status.truthMode,
  localOverlay: status.localOverlay,
  packageIntegrity: status.packageIntegrity,
  sourceFreshness: status.sourceFreshness,
  packageVersion: status.packageVersion,
  gate: status.gate,
});

export const consumerStatusData = (consumerRoot, options = {}) => {
  const status = consumerStatusDataForRoot(consumerRoot, options);
  if (options.workspace === false) return status;
  const layout = consumerWorkspaceLayout(consumerRoot);
  if (layout.status === "not_workspace") return status;
  const roots =
    layout.status === "invalid"
      ? [workspaceRootStatusSummary(layout.roots[0], status)]
      : layout.roots.map((root) =>
          workspaceRootStatusSummary(
            root,
            root.relativePath === "."
              ? status
              : consumerStatusDataForRoot(root.consumerRoot, options),
          ),
        );
  const workspaceStatus =
    layout.status === "invalid"
      ? "invalid"
      : roots.every((root) => root.gate.status === "pass")
        ? "verified"
        : "failed";
  return withConsumerGate({
    ...status,
    workspaceOverlay: {
      status: workspaceStatus,
      manifestPath: layout.manifestPath,
      roots,
      ...(layout.error === undefined ? {} : { error: layout.error }),
    },
  });
};

const printConsumerStatus = (status) => {
  console.log(`consumer: ${status.consumerRoot}`);
  console.log(`marker: ${status.markerPath}`);
  console.log(`truth mode: ${status.truthMode}`);
  console.log(`local overlay: ${status.localOverlay.status}`);
  console.log(`package integrity: ${status.packageIntegrity.status}`);
  if (status.sourceFreshness !== undefined) {
    console.log(`source freshness: ${status.sourceFreshness.status}`);
  }
  if (status.localOverlay.sourceStatus !== undefined) {
    console.log(`source status: ${status.localOverlay.sourceStatus}`);
  }
  console.log(
    `package version: overlay=${status.packageVersion.overlay ?? "none"} release=${status.packageVersion.release} status=${status.packageVersion.status ?? "none"}`,
  );
  console.log(`npm latest: ${status.npmLatest.status}`);
  if (status.workspaceOverlay !== undefined) {
    console.log(`workspace overlay: ${status.workspaceOverlay.status}`);
    for (const root of status.workspaceOverlay.roots ?? []) {
      console.log(
        `workspace ${root.relativePath}: gate=${root.gate.status} overlay=${root.localOverlay.status}`,
      );
    }
  }
  console.log(`gate: ${status.gate.status}`);
  for (const pkg of status.localOverlay.packages ?? []) {
    console.log(
      `package ${pkg.packageName}: target=${pkg.targetStatus} tarball=${pkg.tarballStatus} sha256=${pkg.sha256}`,
    );
  }
  for (const failure of status.gate.hardFailures) {
    console.log(`failure ${failure.code}: ${failure.message}`);
  }
  for (const signal of status.gate.signals) {
    console.log(`signal ${signal.code}: ${signal.message}`);
  }
};

const installManifestPathForArgs = async (args, context) => {
  if (typeof args["from-manifest"] === "string") {
    return path.resolve(process.cwd(), args["from-manifest"]);
  }
  if (boolArg(args, "skip-pack")) {
    if (typeof context.defaultInstallManifestPath !== "string") {
      fail(
        "agentos consumer install --skip-pack requires --from-manifest outside a source checkout",
      );
    }
    return context.defaultInstallManifestPath;
  }
  if (typeof context.produceInstallManifest !== "function") {
    fail("agentos consumer install requires --from-manifest outside an agentOS source checkout");
  }
  return await context.produceInstallManifest();
};

export const installConsumer = async (rawArgs, context = {}) => {
  const args = parseArgs(rawArgs);
  const consumerRoot = resolveConsumerRoot(positionalArgs(args)[0]);
  const manifestPath = await installManifestPathForArgs(args, context);
  const workspaceLayout = consumerWorkspaceLayout(consumerRoot);
  if (workspaceLayout.status === "invalid") {
    fail(`${consumerRoot}: ${workspaceLayout.error}`);
  }
  const snapshot = snapshotFiles(consumerWorkspaceManifestFiles(workspaceLayout));
  const { manifest } = readInstallManifest(manifestPath);
  const entries = tarballPackageEntries(manifest);
  nodeModulesRoot(consumerRoot, { install: !boolArg(args, "no-install") });
  const source =
    typeof context.sourceRoot === "string"
      ? sourceIdentityFor(context.sourceRoot)
      : (manifest.source ?? undefined);
  const installedAt = new Date().toISOString();
  for (const root of workspaceLayout.roots) {
    const nodeModules = path.join(root.consumerRoot, "node_modules");
    const packages = {};
    for (const entry of entries) {
      const target = packageTargetDir(nodeModules, entry.packageName);
      unpackTarballInto(entry.tarball, target);
      packages[entry.packageName] = {
        target: path.relative(root.consumerRoot, target).split(path.sep).join("/"),
        tarball: entry.tarball,
        sha256: entry.sha256,
      };
    }
    writeJson(localConsumerMarkerPath(root.consumerRoot), {
      schemaVersion: 1,
      generatedBy: "agentos consumer install",
      installedAt,
      consumerRoot: root.consumerRoot,
      ...(source === undefined ? {} : { source }),
      packageVersion: manifest.version,
      artifact: markerArtifact(manifestPath, manifest),
      packages,
    });
  }
  assertSnapshotUnchanged(snapshot, "agentos consumer install");
  const status = consumerStatusData(consumerRoot, { sourceRoot: context.sourceRoot });
  if (boolArg(args, "json")) {
    console.log(JSON.stringify(status, null, 2));
  } else {
    console.log(
      `installed ${entries.length} local agentOS packages into ${workspaceLayout.roots.length} consumer root(s)`,
    );
    console.log(
      `wrote ${path.relative(consumerRoot, localConsumerMarkerPath(consumerRoot)).split(path.sep).join("/")}`,
    );
    printConsumerStatus(status);
  }
};

export const consumerStatus = (rawArgs, context = {}) => {
  const args = parseArgs(rawArgs);
  const consumerRoot = resolveConsumerRoot(positionalArgs(args)[0]);
  const status = consumerStatusData(consumerRoot, {
    packageRoot: context.packageRoot,
    sourceRoot: context.sourceRoot,
    checkNpm: boolArg(args, "check-npm"),
    registry: args.registry,
  });
  if (boolArg(args, "json")) {
    console.log(JSON.stringify(status, null, 2));
    return;
  }
  printConsumerStatus(status);
};

export const consumerCheck = (rawArgs, context = {}) => {
  const args = parseArgs(rawArgs);
  const consumerRoot = resolveConsumerRoot(positionalArgs(args)[0]);
  const status = consumerStatusData(consumerRoot, {
    packageRoot: context.packageRoot,
    sourceRoot: context.sourceRoot,
    checkNpm: boolArg(args, "check-npm"),
    registry: args.registry,
  });
  if (boolArg(args, "json")) {
    console.log(JSON.stringify(status, null, 2));
  } else {
    printConsumerStatus(status);
  }
  if (status.gate.status !== "pass") {
    process.exitCode = 1;
  }
};

export const restoreConsumer = (rawArgs) => {
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
    const installCommand = consumerInstallCommand(consumerRoot);
    if (installCommand === null) {
      fail(`${consumerRoot}: no package manager/lockfile was detected for consumer restore`);
    }
    run(installCommand.cmd, installCommand.args, {
      cwd: consumerRoot,
      env: installCommand.env,
    });
  }
  assertSnapshotUnchanged(snapshot, "agentos consumer restore");
  const result = { schemaVersion: 1, restoredPackages: packageNames };
  if (boolArg(args, "json")) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`restored ${packageNames.length} local agentOS package overlays`);
  }
};
