import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  boolArg,
  escapeRegExp,
  fail,
  gitStatusShort,
  gitValue,
  installManifestPath,
  localConsumerMarkerName,
  mkdtempFixture,
  parseArgs,
  positionalArgs,
  publicPackageName,
  publicSpecifier,
  publishScope,
  readJson,
  releaseVersion,
  repoRoot,
  sha256File,
  run,
  sourcePackageScope,
  surface,
  unpackTarballInto,
  writeJson,
} from "./support.mjs";
import { catalog, packageImportsEffect, publishedRecords } from "./package-records.mjs";
import { agentCatalogProvenance, allFiles } from "./staging-build.mjs";
import {
  packageDepsFromTarballs,
  packInternal,
  readInstallManifest,
  tarballPackageEntries,
  tarballsByPackage,
} from "./pack-check.mjs";

const packageProtocolStringPattern = /(["'])workspace:\*\1|(["'])catalog:[^"']*\2/u;

export const consumerManifestFiles = (consumerRoot) =>
  ["package.json", "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock"].map(
    (name) => path.join(consumerRoot, name),
  );

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
      changed.push(path.relative(path.dirname(file), file) || file);
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
      `${consumerRoot}: missing node_modules; run the consumer package manager install first, or rerun install-consumer without --no-install to let agentOS run a frozen install`,
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

const relativeFileSet = (root) =>
  new Set(allFiles(root).map((file) => path.relative(root, file).split(path.sep).join("/")));

export const assertInstalledAgentCatalog = (dir) => {
  const { catalogRoot, sourcePackage } = agentCatalogProvenance();
  const sourceRoot = path.join(repoRoot, catalogRoot);
  const sourceFiles = relativeFileSet(sourceRoot);
  const ownerPackage = publicPackageName(sourcePackage);
  const nodeModules = path.join(dir, "node_modules");

  for (const record of publishedRecords()) {
    const packageName = publicPackageName(record.packageJson.name);
    const installedCatalogRoot = path.join(packageTargetDir(nodeModules, packageName), catalogRoot);
    if (packageName !== ownerPackage) {
      if (fs.existsSync(installedCatalogRoot)) {
        fail(`${packageName}: installed package must not contain ${catalogRoot}`);
      }
      continue;
    }

    if (!fs.existsSync(installedCatalogRoot)) {
      fail(`${packageName}: installed package is missing ${catalogRoot}`);
    }
    const installedFiles = relativeFileSet(installedCatalogRoot);
    for (const file of sourceFiles) {
      const source = path.join(sourceRoot, file);
      const installed = path.join(installedCatalogRoot, file);
      if (!installedFiles.has(file)) {
        fail(`${packageName}: installed catalog missing ${catalogRoot}/${file}`);
      }
      if (sha256File(source) !== sha256File(installed)) {
        fail(`${packageName}: installed catalog drifted ${catalogRoot}/${file}`);
      }
    }
    for (const file of installedFiles) {
      if (!sourceFiles.has(file)) {
        fail(`${packageName}: installed catalog has extra ${catalogRoot}/${file}`);
      }
    }
    const provenance = readJson(path.join(installedCatalogRoot, "references", "provenance.json"));
    if (provenance.package?.publicPackage !== ownerPackage) {
      fail(`${packageName}: installed catalog provenance public package mismatch`);
    }
  }
};

const currentSourceIdentity = () => ({
  repoRoot,
  branch: gitValue(["branch", "--show-current"], "unknown"),
  head: gitValue(["rev-parse", "HEAD"], "unknown"),
  dirty: gitStatusShort().length > 0,
});

const markerArtifact = (manifest) => ({
  kind: "local-tarball-overlay",
  packageScope: publishScope(),
  installManifest: {
    path: path.relative(repoRoot, installManifestPath).split(path.sep).join("/"),
    sha256: sha256File(installManifestPath),
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
      return {
        packageName,
        target: record.target,
        installed: targetStatus === "installed",
        targetStatus,
        tarball,
        tarballStatus: tarballExists
          ? expectedSha === undefined || expectedSha === actualSha
            ? "verified"
            : "sha_mismatch"
          : "missing",
        sha256: expectedSha,
      };
    })
    .sort((left, right) => left.packageName.localeCompare(right.packageName));
};

const overlaySourceStatus = (marker, currentSource) => {
  if (marker.source?.repoRoot !== repoRoot) return "foreign_source";
  if (marker.source?.head !== currentSource.head) return "stale_source";
  if (marker.source?.dirty !== currentSource.dirty) return "dirty_state_changed";
  return "current_source";
};

const packageVersionStatus = (marker) =>
  marker.packageVersion === releaseVersion() ? "release_version_match" : "release_version_mismatch";

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
      cwd: repoRoot,
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

const consumerGateIssue = (code, severity, message, detail = {}) => ({
  code,
  severity,
  message,
  ...detail,
});

const consumerOverlayGate = (status) => {
  const hardFailures = [];
  const signals = [];
  if (status.localOverlay.status === "missing") {
    hardFailures.push(
      consumerGateIssue(
        "local_overlay_missing",
        "hard",
        "local consumer overlay marker is missing",
        { markerPath: status.markerPath },
      ),
    );
  }
  if (status.localOverlay.status === "partial") {
    hardFailures.push(
      consumerGateIssue("local_overlay_partial", "hard", "local consumer overlay is partial"),
    );
  }
  if (
    status.localOverlay.sourceStatus !== undefined &&
    status.localOverlay.sourceStatus !== "current_source"
  ) {
    hardFailures.push(
      consumerGateIssue(
        "local_overlay_source_not_current",
        "hard",
        `local consumer overlay source is ${status.localOverlay.sourceStatus}`,
        { sourceStatus: status.localOverlay.sourceStatus },
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
        `local consumer overlay version is ${status.packageVersion.status}`,
        { packageVersionStatus: status.packageVersion.status },
      ),
    );
  }
  for (const pkg of status.localOverlay.packages ?? []) {
    if (pkg.targetStatus === "missing") {
      hardFailures.push(
        consumerGateIssue(
          "local_overlay_package_missing",
          "hard",
          `${pkg.packageName} is missing from the consumer overlay`,
          { packageName: pkg.packageName },
        ),
      );
    }
    if (pkg.targetStatus === "symlink") {
      hardFailures.push(
        consumerGateIssue(
          "local_overlay_package_symlink",
          "hard",
          `${pkg.packageName} is a symlink, not packed package content`,
          { packageName: pkg.packageName },
        ),
      );
    }
    if (pkg.tarballStatus !== "verified") {
      hardFailures.push(
        consumerGateIssue(
          "local_overlay_tarball_not_verified",
          "hard",
          `${pkg.packageName} tarball status is ${pkg.tarballStatus}`,
          { packageName: pkg.packageName, tarballStatus: pkg.tarballStatus },
        ),
      );
    }
  }
  if (status.npmLatest.status === "not_checked") {
    signals.push(
      consumerGateIssue(
        "npm_latest_not_checked",
        "signal",
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

export const consumerStatusData = (consumerRoot, options = {}) => {
  const markerPath = localConsumerMarkerPath(consumerRoot);
  const currentSource = currentSourceIdentity();
  if (!fs.existsSync(markerPath)) {
    return withConsumerGate({
      schemaVersion: 1,
      consumerRoot,
      markerPath: path.relative(consumerRoot, markerPath).split(path.sep).join("/"),
      localOverlay: { status: "missing" },
      source: { current: currentSource },
      packageVersion: { release: releaseVersion() },
      npmLatest:
        options.checkNpm === true ? npmLatestFor([], options.registry) : npmLatestNotChecked(),
    });
  }
  const marker = readJson(markerPath);
  const packages = packageOverlayRows(consumerRoot, marker);
  const sourceStatus = overlaySourceStatus(marker, currentSource);
  return withConsumerGate({
    schemaVersion: 1,
    consumerRoot,
    markerPath: path.relative(consumerRoot, markerPath).split(path.sep).join("/"),
    localOverlay: {
      status: packages.every((pkg) => pkg.installed) ? "installed" : "partial",
      sourceStatus,
      generatedBy: marker.generatedBy,
      installedAt: marker.installedAt,
      artifact: marker.artifact ?? { kind: "legacy-local-overlay" },
      packages,
    },
    source: {
      current: currentSource,
      overlay: marker.source,
    },
    packageVersion: {
      release: releaseVersion(),
      overlay: marker.packageVersion,
      status: packageVersionStatus(marker),
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

const printConsumerStatus = (status) => {
  console.log(`consumer: ${status.consumerRoot}`);
  console.log(`marker: ${status.markerPath}`);
  console.log(`local overlay: ${status.localOverlay.status}`);
  if (status.localOverlay.sourceStatus !== undefined) {
    console.log(`source status: ${status.localOverlay.sourceStatus}`);
  }
  console.log(
    `package version: overlay=${status.packageVersion.overlay ?? "none"} release=${status.packageVersion.release} status=${status.packageVersion.status ?? "none"}`,
  );
  console.log(`npm latest: ${status.npmLatest.status}`);
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

export const consumerStatus = (rawArgs) => {
  const args = parseArgs(rawArgs);
  const consumerRoot = resolveConsumerRoot(positionalArgs(args)[0]);
  const status = consumerStatusData(consumerRoot, {
    checkNpm: boolArg(args, "check-npm"),
    registry: args.registry,
  });
  if (boolArg(args, "json")) {
    console.log(JSON.stringify(status, null, 2));
    return;
  }
  printConsumerStatus(status);
};

export const consumerCheck = (rawArgs) => {
  const args = parseArgs(rawArgs);
  const consumerRoot = resolveConsumerRoot(positionalArgs(args)[0]);
  const status = consumerStatusData(consumerRoot, {
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

export const installConsumer = (rawArgs) => {
  const args = parseArgs(rawArgs);
  const consumerRoot = resolveConsumerRoot(positionalArgs(args)[0]);
  const snapshot = snapshotFiles(consumerManifestFiles(consumerRoot));
  if (!boolArg(args, "skip-pack")) packInternal();
  const manifest = readInstallManifest();
  const entries = tarballPackageEntries(manifest);
  const nodeModules = nodeModulesRoot(consumerRoot, { install: !boolArg(args, "no-install") });
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
    generatedBy: "agentos consumer install",
    installedAt: new Date().toISOString(),
    consumerRoot,
    source: currentSourceIdentity(),
    packageVersion: manifest.version,
    artifact: markerArtifact(manifest),
    packages,
  });
  assertSnapshotUnchanged(snapshot, "install-consumer");
  const status = consumerStatusData(consumerRoot);
  if (boolArg(args, "json")) {
    console.log(JSON.stringify(status, null, 2));
  } else {
    console.log(
      `installed ${entries.length} local agentOS packages into ${path.relative(repoRoot, consumerRoot) || consumerRoot}`,
    );
    console.log(
      `wrote ${path.relative(consumerRoot, localConsumerMarkerPath(consumerRoot)).split(path.sep).join("/")}`,
    );
    printConsumerStatus(status);
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
    run("npm", ["install"], { cwd: consumerRoot });
  }
  assertSnapshotUnchanged(snapshot, "restore-consumer");
  const result = { schemaVersion: 1, restoredPackages: packageNames };
  if (boolArg(args, "json")) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`restored ${packageNames.length} local agentOS package overlays`);
  }
};

export const writeConsumerApp = (dir, extraDeps = {}) => {
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
      esbuild: catalog().esbuild,
      typescript: catalog().typescript,
    },
  });
  fs.writeFileSync(
    path.join(dir, "index.ts"),
    [
      `import { compileAgentTree } from "${publicSpecifier("@agent-os/cli")}";`,
      `import { Effect } from "effect";`,
      `import { triggerParseOk } from "${publicSpecifier("@agent-os/runtime")}";`,
      `import { bindWorkspaceToolsForRuntime } from "${publicSpecifier("@agent-os/runtime/workspace-binding")}";`,
      `import { createLocalAgentRuntime } from "${publicSpecifier("@agent-os/runtime/local")}";`,
      `import { createInMemoryWorkspaceEnv } from "${publicSpecifier("@agent-os/runtime/testing")}";`,
      `import { deterministicToolExecution } from "${publicSpecifier("@agent-os/core/tools")}";`,
      `import { LlmTransport, type LlmTransportRouteDescriptor } from "${publicSpecifier("@agent-os/core/llm-protocol")}";`,
      `import type { SubmitRunInput } from "${publicSpecifier("@agent-os/core/runtime-protocol")}";`,
      `import { createCloudflareWorkspaceJobResponse, makeCloudflareWorkspaceEnv } from "${publicSpecifier("@agent-os/runtime/cloudflare")}";`,
      `import { mountOpsApi } from "${publicSpecifier("@agent-os/runtime/cloudflare/ops-api")}";`,
      "void triggerParseOk;",
      "void bindWorkspaceToolsForRuntime;",
      "void createLocalAgentRuntime;",
      "void createInMemoryWorkspaceEnv;",
      "void deterministicToolExecution;",
      "type _SubmitRunInput = SubmitRunInput;",
      "void createCloudflareWorkspaceJobResponse;",
      "void makeCloudflareWorkspaceEnv;",
      "void mountOpsApi;",
      "const llmTransportConsumerProgram = Effect.gen(function* () {",
      "  const transport = yield* LlmTransport;",
      "  const descriptor: LlmTransportRouteDescriptor = yield* transport.resolveRoute({",
      "    kind: 'openai-chat-compatible',",
      "  });",
      "  return descriptor.transportAdapterId;",
      "});",
      "void llmTransportConsumerProgram;",
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
      `import { compileAgentTree } from "${publicSpecifier("@agent-os/cli")}";`,
      `import { ABORT } from "${publicSpecifier("@agent-os/core")}";`,
      `import { triggerParseOk } from "${publicSpecifier("@agent-os/runtime")}";`,
      `import { AG_UI_WIRE_COMPATIBILITY } from "${publicSpecifier("@agent-os/runtime/ag-ui")}";`,
      `import { workspaceEnvMaterialRef } from "${publicSpecifier("@agent-os/runtime/workspace-binding")}";`,
      `import { createInMemoryWorkspaceEnv } from "${publicSpecifier("@agent-os/runtime/testing")}";`,
      `import { deterministicToolExecution } from "${publicSpecifier("@agent-os/core/tools")}";`,
      `import { mountOpsApi } from "${publicSpecifier("@agent-os/runtime/cloudflare/ops-api")}";`,
      "const testingEnv = createInMemoryWorkspaceEnv({",
      "  files: { 'packed.txt': 'testing surface' },",
      "  scripts: { 'pnpm test': { stdout: 'ok' } },",
      "});",
      "if (await testingEnv.readFile('packed.txt') !== 'testing surface') throw new Error('missing testing workspace file');",
      "const testingExec = await testingEnv.exec('pnpm test', { timeoutMs: 1000 });",
      "if (testingExec.stdout !== 'ok') throw new Error('missing testing workspace exec');",
      "if (!compileAgentTree || !ABORT || !triggerParseOk || !AG_UI_WIRE_COMPATIBILITY || !workspaceEnvMaterialRef || !createInMemoryWorkspaceEnv || !deterministicToolExecution || !mountOpsApi) throw new Error('missing import');",
    ].join("\n") + "\n",
  );
  fs.writeFileSync(
    path.join(dir, "local-smoke.mjs"),
    [
      "import { mkdtemp, readFile, rm } from 'node:fs/promises';",
      "import { tmpdir } from 'node:os';",
      "import path from 'node:path';",
      `import { createLocalAgentRuntime } from "${publicSpecifier("@agent-os/runtime/local")}";`,
      `import { WORKSPACE_OP_FACT_OWNER, WORKSPACE_OP_KIND, WORKSPACE_OP_PROJECTION_KIND } from "${publicSpecifier("@agent-os/runtime")}";`,
      "const root = await mkdtemp(path.join(tmpdir(), 'agentos-packed-local-'));",
      "try {",
      "  const runtime = await createLocalAgentRuntime({",
      "    identity: 'packed-local-runtime',",
      "    cwd: root,",
      "    llm: {",
      "      responses: [{",
      "        items: [{",
      "          type: 'tool_call',",
      "          call: {",
      "            id: 'call-1',",
      "            type: 'function',",
      "            function: {",
      "              name: 'write_file',",
      "              arguments: JSON.stringify({ path: 'packed.txt', content: 'packed local write' }),",
      "            },",
      "          },",
      "        }],",
      "        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },",
      "      }],",
      "    },",
      "  });",
      "  const initialInspection = runtime.inspect();",
      "  if (initialInspection.compile.status !== 'available' || initialInspection.compile.target !== 'local@1') {",
      "    throw new Error(`packed local inspect lost local target ${JSON.stringify(initialInspection.compile)}`);",
      "  }",
      "  if (!initialInspection.compile.manifest.capabilities.includes(WORKSPACE_OP_FACT_OWNER)) {",
      "    throw new Error(`packed local inspect lost workspace capability ${JSON.stringify(initialInspection.compile.manifest)}`);",
      "  }",
      "  if (initialInspection.resolve.status !== 'available') {",
      "    throw new Error(`packed local inspect lost resolve facts ${JSON.stringify(initialInspection.resolve)}`);",
      "  }",
      "  if (!initialInspection.resolve.graph.handlers.some((row) => row.kind === WORKSPACE_OP_KIND.REQUESTED && row.capabilityId === WORKSPACE_OP_FACT_OWNER)) {",
      "    throw new Error(`packed local inspect lost workspace handler ${JSON.stringify(initialInspection.resolve.graph.handlers)}`);",
      "  }",
      "  if (!initialInspection.resolve.graph.projections.some((row) => row.kind === WORKSPACE_OP_PROJECTION_KIND && row.capabilityId === WORKSPACE_OP_FACT_OWNER)) {",
      "    throw new Error(`packed local inspect lost workspace projection ${JSON.stringify(initialInspection.resolve.graph.projections)}`);",
      "  }",
      "  const writeFileBinding = initialInspection.resolve.bindings.tools.find((tool) => tool.name === 'write_file');",
      "  if (writeFileBinding?.receiptBackedIntentKinds[0] !== WORKSPACE_OP_KIND.REQUESTED) {",
      "    throw new Error(`packed local inspect lost write_file authority ${JSON.stringify(writeFileBinding)}`);",
      "  }",
      "  const result = await runtime.submit({",
      "    intent: 'write locally',",
      "    toolPolicy: {",
      "      completeAfterToolsExecuted: {",
      "        toolNames: ['write_file'],",
      "        finalMessage: 'packed local write complete',",
      "      },",
      "    },",
      "  });",
      "  if (!result.ok || result.final !== 'packed local write complete') {",
      "    throw new Error(`unexpected local result ${JSON.stringify(result)}`);",
      "  }",
      "  const text = await readFile(path.join(root, 'packed.txt'), 'utf8');",
      "  if (text !== 'packed local write') throw new Error(`unexpected local file ${text}`);",
      "  const toolEvent = runtime.events().find((event) => event.kind === 'tool.executed');",
      "  if (toolEvent?.payload?.result?.kind !== 'write_file') {",
      "    throw new Error('local submit did not execute write_file');",
      "  }",
      "  if (toolEvent?.payload?.claim?.anchorRef?.anchorKind !== 'external_receipt') {",
      "    throw new Error('local submit did not complete a receipt-backed workspace write');",
      "  }",
      "  const postInspection = runtime.inspect();",
      "  if (postInspection.runtime.status !== 'available') {",
      "    throw new Error(`packed local inspect lost runtime facts ${JSON.stringify(postInspection.runtime)}`);",
      "  }",
      "  const workspaceRows = postInspection.runtime.events.filter((event) => event.factOwnerRef === WORKSPACE_OP_FACT_OWNER);",
      "  const lastWorkspaceRow = workspaceRows.at(-1);",
      "  if (lastWorkspaceRow?.kind !== WORKSPACE_OP_KIND.COMPLETED || lastWorkspaceRow.payload?.toolName !== 'write_file') {",
      "    throw new Error(`packed local inspect lost last workspace_op row ${JSON.stringify(lastWorkspaceRow)}`);",
      "  }",
      "} finally {",
      "  await rm(root, { recursive: true, force: true });",
      "}",
    ].join("\n") + "\n",
  );
  fs.writeFileSync(
    path.join(dir, "openai-compatible-smoke.mjs"),
    [
      `import { OpenAiCompatibleLlmTransportLive, preflightOpenAiCompatibleProviderMaterial } from "${publicSpecifier("@agent-os/runtime/llm-effect-ai/openai-compatible")}";`,
      "if (!OpenAiCompatibleLlmTransportLive) throw new Error('missing OpenAI-compatible transport');",
      "const diagnostics = preflightOpenAiCompatibleProviderMaterial({",
      "  route: {",
      "    kind: 'openai-chat-compatible',",
      "    endpointRef: 'openai',",
      "    credentialRef: 'openai-key',",
      "    modelId: 'gpt-test',",
      "  },",
      "  refResolver: {",
      "    material: (ref) => ref.kind === 'endpoint' ? 'https://openai.example/v1' : 'sk-test',",
      "  },",
      "  routeBindingRef: 'default',",
      "});",
      "if (diagnostics.length !== 0) {",
      "  throw new Error(`unexpected OpenAI-compatible preflight diagnostics ${JSON.stringify(diagnostics)}`);",
      "}",
    ].join("\n") + "\n",
  );
  fs.writeFileSync(
    path.join(dir, "cf-entry.ts"),
    [
      `import { compileAgentTree } from "${publicSpecifier("@agent-os/cli")}";`,
      `import { createAgentDurableObject, createCloudflareWorkspaceJobResponse, makeCloudflareWorkspaceEnv } from "${publicSpecifier("@agent-os/runtime/cloudflare")}";`,
      `import { OpenAiCompatibleLlmTransportLive } from "${publicSpecifier("@agent-os/runtime/llm-effect-ai/openai-compatible")}";`,
      `import { defineAgentBindings } from "${publicSpecifier("@agent-os/core")}";`,
      "void createCloudflareWorkspaceJobResponse;",
      "void makeCloudflareWorkspaceEnv;",
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

const writeChannelConsumerFixture = (dir, scopeId) => {
  fs.mkdirSync(path.join(dir, "agent", "channels"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "agent", "channels", "intake.ts"),
    [
      `import { defineChannel, post } from "${publicSpecifier("@agent-os/runtime/channel")}";`,
      "",
      "export default defineChannel({",
      '  verify: async (request) => ({ authority: "consumer.signature", subject: request.request.headers.get("x-principal") ?? "missing-principal" }),',
      "  routes: [",
      '    post("/events/:eventId", async (request, context) => {',
      "      const raw = await request.request.text();",
      '      const submitResult = await context.submit({ intent: "channel", context: { eventId: request.params.eventId } });',
      "      const dispatchResult = await context.dispatch({",
      `        target: { bindingRef: { kind: "binding", provider: "test", bindingKind: "queue", ref: "outbound" }, scopeRef: { kind: "session", scopeId: ${JSON.stringify(scopeId)} }, effectAuthorityRef: { authorityClass: "channel", authorityId: context.principal.authority } },`,
      '        event: "channel.received",',
      "        data: { eventId: request.params.eventId },",
      "        idempotencyKey: request.params.eventId,",
      "      });",
      "      return Response.json({",
      "        raw,",
      "        eventId: request.params.eventId,",
      "        path: request.path,",
      "        principal: context.principal,",
      "        contextKeys: Object.keys(context).sort(),",
      "        submitStatus: submitResult.status,",
      "        outboundEventId: dispatchResult.outboundEventId,",
      "      });",
      "    }),",
      "  ],",
      "});",
      "",
    ].join("\n"),
  );
};

const writeScheduleConsumerFixture = (dir) => {
  fs.mkdirSync(path.join(dir, "agent", "schedules"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "agent", "schedules", "daily-session.ts"),
    [
      `import { defineSchedule } from "${publicSpecifier("@agent-os/runtime/schedule")}";`,
      "",
      "export default defineSchedule({",
      '  cron: "0 9 * * *",',
      "  handler: (context) => context.sessions.submitTurn({",
      '    sessionRef: "session:scheduled",',
      "    turnRef: context.fireId,",
      '    intent: "scheduled session",',
      "    context: { scheduledAt: context.scheduledAt },",
      "  }),",
      "});",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(dir, "agent", "schedules", "daily-workflow.ts"),
    [
      `import { defineSchedule } from "${publicSpecifier("@agent-os/runtime/schedule")}";`,
      "",
      "export default defineSchedule({",
      '  cron: "15 9 * * *",',
      "  handler: (context) => context.workflows.run({",
      '    workflowId: "scheduled-workflow",',
      "    workflowRunId: context.fireId,",
      '    intent: "scheduled workflow",',
      "    inputDigest: context.scheduledAt,",
      "    context: { scheduledAt: context.scheduledAt },",
      "  }),",
      "});",
      "",
    ].join("\n"),
  );
};

const channelDispatchSmokeSource = ({ importLine, dispatchExpression, scopeId }) =>
  [
    importLine,
    "",
    "const calls = [];",
    "const runtime = Object.freeze({",
    "  submit: async (input) => {",
    '    calls.push(["submit", input]);',
    '    return { ok: true, status: "delivered", runId: 1, final: "ok", eventCount: 1, tokensUsed: 0 };',
    "  },",
    "  dispatch: async (spec) => {",
    '    calls.push(["dispatch", spec]);',
    "    return { outboundEventId: 17 };",
    "  },",
    "});",
    'const request = new Request("http://agent.test/channels/intake/events/evt_123", {',
    '  method: "POST",',
    '  headers: { "x-principal": "installation:42", "authorization": "secret-token" },',
    '  body: "raw-provider-body",',
    "});",
    `const response = await ${dispatchExpression};`,
    "if (response === null) throw new Error('generated channel dispatch returned null');",
    "const body = await response.json();",
    "const expectedBody = {",
    '  raw: "raw-provider-body",',
    '  eventId: "evt_123",',
    '  path: "/channels/intake/events/evt_123",',
    '  principal: { authority: "consumer.signature", subject: "installation:42" },',
    '  contextKeys: ["dispatch", "principal", "submit"],',
    '  submitStatus: "delivered",',
    "  outboundEventId: 17,",
    "};",
    "const expectedCalls = [",
    '  ["submit", { intent: "channel", context: { eventId: "evt_123" } }],',
    "  [",
    '    "dispatch",',
    "    {",
    "      target: {",
    '        bindingRef: { kind: "binding", provider: "test", bindingKind: "queue", ref: "outbound" },',
    `        scopeRef: { kind: "session", scopeId: ${JSON.stringify(scopeId)} },`,
    '        effectAuthorityRef: { authorityClass: "channel", authorityId: "consumer.signature" },',
    "      },",
    '      event: "channel.received",',
    '      data: { eventId: "evt_123" },',
    '      idempotencyKey: "evt_123",',
    "    },",
    "  ],",
    "];",
    "const actual = JSON.stringify({ body, calls });",
    "const expected = JSON.stringify({ body: expectedBody, calls: expectedCalls });",
    "if (actual !== expected) throw new Error(`unexpected generated channel dispatch ${actual}`);",
    "if (actual.includes('secret-token')) throw new Error('generated channel dispatch leaked raw provider token');",
    "",
  ].join("\n") + "\n";

export const writeGeneratedTargetConsumerApp = (dir) => {
  fs.mkdirSync(path.join(dir, "agent"), { recursive: true });
  fs.mkdirSync(path.join(dir, "agent", "skills", "review", "references"), { recursive: true });
  fs.mkdirSync(path.join(dir, "agent", "skills", "review", "scripts"), { recursive: true });
  writeJson(path.join(dir, "package.json"), {
    name: "agentos-generated-target-consumer-fixture",
    private: true,
    type: "module",
    dependencies: {
      ...packageDepsFromTarballs(),
      "@cloudflare/sandbox": "^0.12.1",
      effect: catalog().effect,
      "@cloudflare/workers-types": catalog()["@cloudflare/workers-types"],
    },
  });
  fs.writeFileSync(path.join(dir, "Dockerfile"), 'FROM alpine:3.20\nCMD ["sleep", "infinity"]\n');
  fs.writeFileSync(path.join(dir, "agent", "instructions.md"), "Operate on the workspace.\n");
  writeChannelConsumerFixture(dir, "generated-target-consumer");
  writeScheduleConsumerFixture(dir);
  fs.writeFileSync(
    path.join(dir, "agent", "skills", "review", "SKILL.md"),
    [
      "---",
      "name: review",
      "description: Review generated consumer output",
      "---",
      "REVIEW_BODY_MARKER_659",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(dir, "agent", "skills", "review", "references", "checklist.md"),
    "REVIEW_REFERENCE_MARKER_659",
  );
  fs.writeFileSync(
    path.join(dir, "agent", "skills", "review", "scripts", "audit.sh"),
    "REVIEW_SCRIPT_MARKER_659",
  );
  writeJson(path.join(dir, "agent", "agent.json"), {
    agentId: "generated-target-consumer",
    scope: {
      kind: "session",
      idSource: "manifest",
      stableScopeId: "generated-target-consumer",
    },
    effectAuthorityRef: {
      authorityClass: "effect",
      authorityId: "generated-target-consumer",
    },
    materials: {
      workspace: {
        kind: "external_resource",
        provider: "agent-os",
        resourceKind: "workspace-env",
        ref: "cloudflare-sandbox:generated-target-consumer",
      },
    },
    executionDomains: {
      workspace: { bindingRef: "workspace" },
    },
  });
  fs.writeFileSync(
    path.join(dir, "agentos.config.jsonc"),
    [
      "{",
      '  "profile": "workspace@1",',
      '  "agent": "./agent",',
      '  "deployment": { "id": "generated-target-consumer", "version": "0.1.0" },',
      '  "target": {',
      '    "kind": "cloudflare-do@1",',
      '    "durableObject": { "className": "AgentOS", "binding": "AGENT_OS" }',
      "  },",
      '  "client": { "kind": "svelte-kit-remote@1" },',
      '  "llm": {',
      '    "route": "openai-chat-compatible",',
      '    "endpointRef": "openrouter",',
      '    "credentialRef": "openrouter-key",',
      '    "modelRef": "openrouter-default-text-model"',
      "  },",
      '  "workspace": { "binding": "Sandbox", "root": "/workspace" }',
      "}",
      "",
    ].join("\n"),
  );
  npmInstall(dir);
  run(
    "node",
    [
      path.join(repoRoot, "packages", "cli", "src", "main.mjs"),
      "build",
      "--cwd",
      dir,
      "--package-scope",
      publishScope(),
    ],
    { capture: true },
  );
  const manifest = JSON.parse(
    fs.readFileSync(path.join(dir, ".agentos", "generated", "manifest.json"), "utf8"),
  );
  if (Object.hasOwn(manifest, "skills")) {
    fail("generated target consumer leaked skills into manifest.json");
  }
  const manifestToolNames = Object.keys(manifest.tools ?? {});
  for (const forbiddenToolName of ["load_skill", "read_skill_file", "audit", "audit.sh"]) {
    if (manifestToolNames.includes(forbiddenToolName)) {
      fail(`generated target consumer leaked generated/script tool ${forbiddenToolName}`);
    }
  }
  const generatedFiles = allFiles(path.join(dir, ".agentos", "generated")).filter((file) =>
    /\.(?:ts|json|jsonc)$/u.test(file),
  );
  const generatedText = generatedFiles.map((file) => fs.readFileSync(file, "utf8")).join("\n");
  const requiredGeneratedSpecifiers = [
    `${publishScope()}/runtime/capability`,
    `${publishScope()}/runtime/cloudflare`,
    `${publishScope()}/runtime/llm-effect-ai/openai-compatible`,
    `${publishScope()}/runtime/workspace-agent`,
    `${publishScope()}/runtime/sse-http`,
    `${publishScope()}/runtime/channel`,
    `${publishScope()}/runtime/schedule`,
    `${publishScope()}/core/runtime-protocol`,
    `${publishScope()}/core/tools`,
    `${publishScope()}/client`,
    `${publishScope()}/client/svelte`,
  ];
  for (const specifier of requiredGeneratedSpecifiers) {
    if (!generatedText.includes(specifier)) {
      fail(`generated target consumer missing canonical public import ${specifier}`);
    }
  }
  if (
    new RegExp(`from\\s+["']${escapeRegExp(`${publishScope()}/runtime`)}["']`, "u").test(
      generatedText,
    )
  ) {
    fail("generated target consumer imported runtime root instead of canonical subpaths");
  }
  const sourcePackageImportPattern = new RegExp(
    `(?:from\\s+|import\\s*\\(\\s*)["']${escapeRegExp(sourcePackageScope)}/`,
    "u",
  );
  if (sourcePackageImportPattern.test(generatedText)) {
    fail(`generated target consumer leaked source package scope ${sourcePackageScope}`);
  }
  if (packageProtocolStringPattern.test(generatedText)) {
    fail("generated target consumer leaked workspace/catalog protocol");
  }
  for (const token of removedCloudflareLifecycleValueExports) {
    if (generatedText.includes(token)) {
      fail(`generated target consumer leaked cloudflare lifecycle helper ${token}`);
    }
  }
  for (const specifier of removedCloudflareLifecycleImportSpecifiers) {
    if (generatedText.includes(specifier)) {
      fail(`generated target consumer leaked cloudflare lifecycle import ${specifier}`);
    }
  }
  for (const fragment of [
    "../../agent/channels/intake",
    "dispatchGeneratedChannelRequest",
    "generatedChannelRuntimeFor(env)",
  ]) {
    if (!generatedText.includes(fragment)) {
      fail(`generated target consumer missing channel fragment ${fragment}`);
    }
  }
  for (const fragment of [
    "../../agent/schedules/daily-session",
    "../../agent/schedules/daily-workflow",
    "generatedSchedules",
    "dispatchGeneratedSchedule",
    "generatedScheduleRuntimeFor(this)",
    "scheduled(controller: ScheduledController",
    "entry.cron === controller.cron",
    "ctx.waitUntil(runtime.dispatchSchedule(input))",
  ]) {
    if (!generatedText.includes(fragment)) {
      fail(`generated target consumer missing schedule fragment ${fragment}`);
    }
  }
  for (const forbiddenFragment of [
    "installScheduleProvider",
    "cron-runner",
    "cronRunner",
    "submitAgentEffect",
  ]) {
    if (generatedText.includes(forbiddenFragment)) {
      fail(`generated target consumer leaked schedule helper ${forbiddenFragment}`);
    }
  }
  const requiredSkillFragments = [
    'name: "load_skill"',
    'name: "read_skill_file"',
    "Review generated consumer output",
    "REVIEW_BODY_MARKER_659",
    "references/checklist.md",
    "REVIEW_REFERENCE_MARKER_659",
    "scripts/audit.sh",
    "REVIEW_SCRIPT_MARKER_659",
    "generatedLoadedSkill",
    "generatedSkillFilePathCatalog",
    "${skill.name}: ${skill.description}",
  ];
  for (const fragment of requiredSkillFragments) {
    if (!generatedText.includes(fragment)) {
      fail(`generated target consumer missing packaged skill fragment ${fragment}`);
    }
  }
  for (const forbiddenFragment of [
    "to load ${skill.path}",
    "execFile",
    "spawn(",
    "chmod",
    "SCRIPT_MARKER_CAPABILITY",
  ]) {
    if (generatedText.includes(forbiddenFragment)) {
      fail(
        `generated target consumer exposed executable or legacy skill fragment ${forbiddenFragment}`,
      );
    }
  }
  fs.writeFileSync(
    path.join(dir, "channel-dispatch-smoke.ts"),
    channelDispatchSmokeSource({
      importLine:
        'import { dispatchGeneratedChannelRequest } from "./.agentos/generated/channels";',
      dispatchExpression: "dispatchGeneratedChannelRequest(request, runtime)",
      scopeId: "generated-target-consumer",
    }),
  );
};

export const writeGeneratedLocalTargetConsumerApp = (dir) => {
  fs.mkdirSync(path.join(dir, "agent"), { recursive: true });
  fs.mkdirSync(path.join(dir, "agent", "instructions"), { recursive: true });
  fs.mkdirSync(path.join(dir, "agent", "skills", "review"), { recursive: true });
  writeJson(path.join(dir, "package.json"), {
    name: "agentos-generated-local-target-consumer-fixture",
    private: true,
    type: "module",
    dependencies: {
      ...packageDepsFromTarballs(),
      effect: catalog().effect,
    },
    devDependencies: {
      esbuild: catalog().esbuild,
      typescript: catalog().typescript,
    },
  });
  fs.writeFileSync(path.join(dir, "agent", "instructions.md"), "Operate on the local workspace.\n");
  fs.writeFileSync(path.join(dir, "agent", "instructions", "tone.md"), "DYNAMIC_TONE_MARKER_108\n");
  fs.writeFileSync(
    path.join(dir, "agent", "skills", "review", "SKILL.md"),
    [
      "---",
      "name: review",
      "description: Review generated local dynamic output",
      "---",
      "REVIEW_LOCAL_DYNAMIC_MARKER_108",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(dir, "agent", "skills", "session.dynamic.ts"),
    [
      'export const declaration = { outputs: { skills: ["review"] } };',
      "export default (context) =>",
      '  context.event.sessionRef === "session:principal-a"',
      '    ? { skills: { allow: ["review"] } }',
      '    : { skills: { deny: ["review"] } };',
      "",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(dir, "agent", "instructions", "session.dynamic.ts"),
    [
      'export const declaration = { outputs: { instructions: ["tone"] } };',
      "export default (context) =>",
      '  context.event.turnRef === "turn:principal-a:visible"',
      '    ? { instructions: { allow: ["tone"] } }',
      '    : { instructions: { deny: ["tone"] } };',
      "",
    ].join("\n"),
  );
  writeChannelConsumerFixture(dir, "generated-local-target-consumer");
  writeScheduleConsumerFixture(dir);
  writeJson(path.join(dir, "agent", "agent.json"), {
    agentId: "generated-local-target-consumer",
    scope: {
      kind: "session",
      idSource: "manifest",
      stableScopeId: "generated-local-target-consumer",
    },
    effectAuthorityRef: {
      authorityClass: "effect",
      authorityId: "generated-local-target-consumer",
    },
    tools: {
      write_file: { interaction: "never" },
    },
  });
  fs.writeFileSync(
    path.join(dir, "agentos.config.jsonc"),
    [
      "{",
      '  "profile": "workspace@1",',
      '  "agent": "./agent",',
      '  "deployment": { "id": "generated-local-target-consumer", "version": "0.1.0" },',
      '  "target": { "kind": "node@1" },',
      '  "client": { "kind": "browser-direct@1" },',
      '  "llm": {',
      '    "route": "openai-chat-compatible",',
      '    "endpointRef": "openrouter",',
      '    "credentialRef": "openrouter-key",',
      '    "modelRef": "openrouter-default-text-model"',
      "  },",
      '  "workspace": { "binding": "Sandbox", "root": "/workspace" }',
      "}",
      "",
    ].join("\n"),
  );
  npmInstall(dir);
  run(
    "node",
    [
      path.join(repoRoot, "packages", "cli", "src", "main.mjs"),
      "build",
      "--cwd",
      dir,
      "--package-scope",
      publishScope(),
    ],
    { capture: true },
  );
  const manifest = JSON.parse(
    fs.readFileSync(path.join(dir, ".agentos", "generated", "manifest.json"), "utf8"),
  );
  for (const forbiddenManifestFact of ["dynamicResolvers", "instructionFragments", "skills"]) {
    if (Object.hasOwn(manifest, forbiddenManifestFact)) {
      fail(`generated local target consumer leaked ${forbiddenManifestFact} into manifest.json`);
    }
  }
  const generatedFiles = allFiles(path.join(dir, ".agentos", "generated")).filter((file) =>
    /\.(?:ts|json|jsonc)$/u.test(file),
  );
  const generatedText = generatedFiles.map((file) => fs.readFileSync(file, "utf8")).join("\n");
  const requiredGeneratedSpecifiers = [
    `${publishScope()}/runtime/local`,
    `${publishScope()}/runtime/channel`,
    `${publishScope()}/runtime/schedule`,
    `${publishScope()}/runtime/llm-effect-ai/openai-compatible`,
    `${publishScope()}/core/runtime-protocol`,
  ];
  for (const specifier of requiredGeneratedSpecifiers) {
    if (!generatedText.includes(specifier)) {
      fail(`generated local target consumer missing canonical public import ${specifier}`);
    }
  }
  for (const fragment of ["export const createLocalAgentApp", 'target: "node@1"']) {
    if (!generatedText.includes(fragment)) {
      fail(`generated local target consumer missing generated LocalAgentApp fragment ${fragment}`);
    }
  }
  for (const fragment of [
    "../../agent/skills/session.dynamic",
    "../../agent/instructions/session.dynamic",
    "runDynamicCapabilityResolvers",
    "generatedDynamicCapabilityCatalog",
    "generatedDynamicCapabilityResolvers",
    "generatedDynamicSubmitBindingsFor",
    "generatedFrameworkToolsFor(dynamicCapabilityProjection)",
    "generatedSystemPrompt(input.system, dynamicCapabilityProjection)",
    "dynamicCapabilityProjection",
    "instructionFragments",
    'name: "load_skill"',
    'name: "read_skill_file"',
    "Review generated local dynamic output",
    "REVIEW_LOCAL_DYNAMIC_MARKER_108",
    "DYNAMIC_TONE_MARKER_108",
  ]) {
    if (!generatedText.includes(fragment)) {
      fail(`generated local target consumer missing dynamic capability fragment ${fragment}`);
    }
  }
  for (const fragment of [
    "../../agent/channels/intake",
    "dispatchGeneratedChannelRequest",
    "handleLocalAgentChannelRequest",
  ]) {
    if (!generatedText.includes(fragment)) {
      fail(`generated local target consumer missing channel fragment ${fragment}`);
    }
  }
  for (const fragment of [
    "../../agent/schedules/daily-session",
    "../../agent/schedules/daily-workflow",
    "generatedScheduleDefinitions",
    "generatedScheduleIds",
    "dispatchGeneratedSchedule",
    "projectScheduleFireHistory",
    "trigger: triggerSchedule",
    "history: scheduleHistory",
  ]) {
    if (!generatedText.includes(fragment)) {
      fail(`generated local target consumer missing schedule fragment ${fragment}`);
    }
  }
  const forbiddenText = [
    "cloudflare:workers",
    "@effect/ai-anthropic",
    "installLocalWorkspaceOperationProvider",
    "createInMemoryBackendState",
    "createInMemoryRuntimeBackend",
    "createAgentDurableObject",
    "@cloudflare/sandbox",
    "getSandbox",
    "createCloudflareSandboxWorkspaceEnvResolver",
    "target--node",
    "blueprints/",
    "Provider Material Binding",
    "SandboxLifecycle",
    "just-bash",
    "wrangler",
    "installScheduleProvider",
    "cron-runner",
    "cronRunner",
    "submitAgentEffect",
  ];
  for (const token of forbiddenText) {
    if (generatedText.includes(token)) {
      fail(`generated local target consumer leaked forbidden token ${token}`);
    }
  }
  if (
    new RegExp(`from\\s+["']${escapeRegExp(`${publishScope()}/runtime`)}["']`, "u").test(
      generatedText,
    )
  ) {
    fail("generated local target consumer imported runtime root instead of canonical subpaths");
  }
  const sourcePackageImportPattern = new RegExp(
    `(?:from\\s+|import\\s*\\(\\s*)["']${escapeRegExp(sourcePackageScope)}/`,
    "u",
  );
  if (sourcePackageImportPattern.test(generatedText)) {
    fail(`generated local target consumer leaked source package scope ${sourcePackageScope}`);
  }
  if (packageProtocolStringPattern.test(generatedText)) {
    fail("generated local target consumer leaked workspace/catalog protocol");
  }
  fs.writeFileSync(
    path.join(dir, "local-generated-smoke.ts"),
    [
      "import { mkdtemp, readFile, rm } from 'node:fs/promises';",
      "import { tmpdir } from 'node:os';",
      "import path from 'node:path';",
      "import { createLocalAgentApp } from './.agentos/generated/local';",
      `import { WORKSPACE_OP_FACT_OWNER, WORKSPACE_OP_KIND, WORKSPACE_OP_PROJECTION_KIND } from "${publicSpecifier("@agent-os/runtime")}";`,
      "const root = await mkdtemp(path.join(tmpdir(), 'agentos-generated-local-'));",
      "try {",
      "  const providerApp = await createLocalAgentApp({",
      "    cwd: root,",
      "    env: {",
      "      AGENTOS_ENDPOINT_OPENROUTER: 'https://openrouter.example/v1',",
      "      AGENTOS_CREDENTIAL_OPENROUTER_KEY: 'smoke-secret',",
      "      AGENTOS_MODEL_OPENROUTER_DEFAULT_TEXT_MODEL: 'openai/gpt-test',",
      "    },",
      "  });",
      "  const providerInspection = providerApp.runtime.inspect();",
      "  if (providerInspection.compile.status !== 'available' || providerInspection.compile.target !== 'node@1') {",
      "    throw new Error(`generated local provider inspect lost node target ${JSON.stringify(providerInspection.compile)}`);",
      "  }",
      "  if (providerApp.runtime.diagnostics().length !== 0) {",
      "    throw new Error(`generated local provider app emitted diagnostics ${JSON.stringify(providerApp.runtime.diagnostics())}`);",
      "  }",
      "  const llmRequests = [];",
      "  const scriptedResponses = [{",
      "    items: [{",
      "      type: 'tool_call',",
      "      call: {",
      "        id: 'call-1',",
      "        type: 'function',",
      "        function: {",
      "          name: 'write_file',",
      "          arguments: JSON.stringify({",
      "            path: 'generated-local.txt',",
      "            content: 'generated local write',",
      "          }),",
      "        },",
      "      },",
      "    }],",
      "    usage: { promptTokens: 3, completionTokens: 4, totalTokens: 7 },",
      "  }, {",
      "    items: [{ type: 'message', text: 'session second complete' }],",
      "    usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 },",
      "  }, {",
      "    items: [{",
      "      type: 'tool_call',",
      "      call: {",
      "        id: 'call-hidden-load-skill',",
      "        type: 'function',",
      "        function: {",
      "          name: 'load_skill',",
      "          arguments: JSON.stringify({ name: 'review' }),",
      "        },",
      "      },",
      "    }],",
      "    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },",
      "  }, {",
      "    items: [{ type: 'message', text: 'workflow one complete' }],",
      "    usage: { promptTokens: 4, completionTokens: 5, totalTokens: 9 },",
      "  }, {",
      "    items: [{ type: 'message', text: 'workflow two complete' }],",
      "    usage: { promptTokens: 6, completionTokens: 7, totalTokens: 13 },",
      "  }, {",
      "    items: [{ type: 'message', text: 'scheduled session complete' }],",
      "    usage: { promptTokens: 8, completionTokens: 9, totalTokens: 17 },",
      "  }, {",
      "    items: [{ type: 'message', text: 'scheduled workflow complete' }],",
      "    usage: { promptTokens: 10, completionTokens: 11, totalTokens: 21 },",
      "  }];",
      "  const app = await createLocalAgentApp({",
      "    cwd: root,",
      "    llm: {",
      "      handler: (request) => {",
      "        llmRequests.push(request);",
      "        const next = scriptedResponses.shift();",
      "        if (next === undefined) throw new Error('generated local LLM fixture exhausted');",
      "        return next;",
      "      },",
      "    },",
      "  });",
      "  const initialInspection = app.runtime.inspect();",
      "  if (initialInspection.compile.status !== 'available' || initialInspection.compile.target !== 'node@1') {",
      "    throw new Error(`generated local inspect lost node target ${JSON.stringify(initialInspection.compile)}`);",
      "  }",
      "  if (!initialInspection.compile.manifest.capabilities.includes(WORKSPACE_OP_FACT_OWNER)) {",
      "    throw new Error(`generated local inspect lost workspace capability ${JSON.stringify(initialInspection.compile.manifest)}`);",
      "  }",
      "  if (initialInspection.resolve.status !== 'available') {",
      "    throw new Error(`generated local inspect lost resolve facts ${JSON.stringify(initialInspection.resolve)}`);",
      "  }",
      "  if (!initialInspection.resolve.graph.handlers.some((row) => row.kind === WORKSPACE_OP_KIND.REQUESTED && row.capabilityId === WORKSPACE_OP_FACT_OWNER)) {",
      "    throw new Error(`generated local inspect lost workspace handler ${JSON.stringify(initialInspection.resolve.graph.handlers)}`);",
      "  }",
      "  if (!initialInspection.resolve.graph.projections.some((row) => row.kind === WORKSPACE_OP_PROJECTION_KIND && row.capabilityId === WORKSPACE_OP_FACT_OWNER)) {",
      "    throw new Error(`generated local inspect lost workspace projection ${JSON.stringify(initialInspection.resolve.graph.projections)}`);",
      "  }",
      "  const writeFileBinding = initialInspection.resolve.bindings.tools.find((tool) => tool.name === 'write_file');",
      "  if (writeFileBinding?.receiptBackedIntentKinds[0] !== WORKSPACE_OP_KIND.REQUESTED) {",
      "    throw new Error(`generated local inspect lost write_file authority ${JSON.stringify(writeFileBinding)}`);",
      "  }",
      "  const toolNamesFor = (index) => (llmRequests[index]?.tools ?? []).map((tool) => tool.function.name).sort();",
      "  const systemTextFor = (index) => llmRequests[index]?.messages?.[0]?.content ?? '';",
      "  const sessionRef = 'session:principal-a';",
      "  const firstTurn = await app.sessions.submitTurn({",
      "    sessionRef,",
      "    turnRef: 'turn:principal-a:visible',",
      "    intent: 'write through generated local app',",
      "    toolPolicy: {",
      "      completeAfterToolsExecuted: {",
      "        toolNames: ['write_file'],",
      "        finalMessage: 'generated local write complete',",
      "      },",
      "    },",
      "  });",
      "  if (!firstTurn.ok || firstTurn.final !== 'generated local write complete') {",
      "    throw new Error(`unexpected generated local session turn result ${JSON.stringify(firstTurn)}`);",
      "  }",
      "  const text = await readFile(path.join(root, 'generated-local.txt'), 'utf8');",
      "  if (text !== 'generated local write') throw new Error(`unexpected generated local file ${text}`);",
      "  const secondTurn = await app.sessions.submitTurn({",
      "    sessionRef,",
      "    turnRef: 'turn:principal-a:hidden',",
      "    intent: 'continue generated local session',",
      "  });",
      "  if (!secondTurn.ok || secondTurn.final !== 'session second complete') {",
      "    throw new Error(`unexpected generated local second session turn ${JSON.stringify(secondTurn)}`);",
      "  }",
      "  const firstToolNames = toolNamesFor(0);",
      "  if (!firstToolNames.includes('load_skill') || !firstToolNames.includes('read_skill_file') || !firstToolNames.includes('write_file')) {",
      "    throw new Error(`principal-a visible turn lost dynamic tools ${JSON.stringify(firstToolNames)}`);",
      "  }",
      "  const firstSystem = systemTextFor(0);",
      "  if (!firstSystem.includes('Review generated local dynamic output') || !firstSystem.includes('DYNAMIC_TONE_MARKER_108')) {",
      "    throw new Error(`principal-a visible turn lost dynamic skill/instruction prompt ${JSON.stringify(firstSystem)}`);",
      "  }",
      "  const secondToolNames = toolNamesFor(1);",
      "  if (!secondToolNames.includes('load_skill') || !secondToolNames.includes('read_skill_file') || !secondToolNames.includes('write_file')) {",
      "    throw new Error(`principal-a hidden-context turn lost session-level dynamic tools ${JSON.stringify(secondToolNames)}`);",
      "  }",
      "  const secondSystem = systemTextFor(1);",
      "  if (!secondSystem.includes('Review generated local dynamic output') || secondSystem.includes('DYNAMIC_TONE_MARKER_108')) {",
      "    throw new Error(`turn-level dynamic instruction visibility did not change ${JSON.stringify(secondSystem)}`);",
      "  }",
      "  const hiddenTurn = await app.sessions.submitTurn({",
      "    sessionRef: 'session:principal-b',",
      "    turnRef: 'turn:principal-b:visible',",
      "    intent: 'attempt hidden skill load',",
      "  });",
      "  if (hiddenTurn.ok || hiddenTurn.reason !== 'tool_error') {",
      "    throw new Error(`hidden principal direct tool call was not rejected ${JSON.stringify(hiddenTurn)}`);",
      "  }",
      "  const hiddenToolNames = toolNamesFor(2);",
      "  if (hiddenToolNames.includes('load_skill') || hiddenToolNames.includes('read_skill_file')) {",
      "    throw new Error(`principal-b saw hidden dynamic tools ${JSON.stringify(hiddenToolNames)}`);",
      "  }",
      "  const hiddenSystem = systemTextFor(2);",
      "  if (hiddenSystem.includes('Review generated local dynamic output') || hiddenSystem.includes('DYNAMIC_TONE_MARKER_108')) {",
      "    throw new Error(`principal-b saw hidden dynamic skill/instruction prompt ${JSON.stringify(hiddenSystem)}`);",
      "  }",
      "  if (app.runtime.events().some((event) => event.kind === 'tool.executed' && event.payload?.toolCallId === 'call-hidden-load-skill')) {",
      "    throw new Error('hidden load_skill call executed despite dynamic visibility denial');",
      "  }",
      "  const session = app.sessions.inspect(sessionRef);",
      "  if (session.status !== 'idle' || 'output' in session || 'outputKind' in session) {",
      "    throw new Error(`generated local session projection pretended to be terminal ${JSON.stringify(session)}`);",
      "  }",
      "  const [firstProjectedTurn, secondProjectedTurn] = session.turns;",
      "  if (session.turns.length !== 2 || firstProjectedTurn?.turnRef !== 'turn:principal-a:visible' || firstProjectedTurn.runtimeRunId !== firstTurn.runId || firstProjectedTurn.status.kind !== 'delivered' || secondProjectedTurn?.turnRef !== 'turn:principal-a:hidden' || secondProjectedTurn.runtimeRunId !== secondTurn.runId || secondProjectedTurn.status.kind !== 'delivered') {",
      "    throw new Error(`generated local session did not keep ordered turn history ${JSON.stringify(session)}`);",
      "  }",
      "  const sessionList = app.sessions.list();",
      "  if (!sessionList.sessions.some((row) => row.sessionRef === sessionRef && row.turns.length === 2 && row.status === 'idle')) {",
      "    throw new Error(`generated local session list lost session history ${JSON.stringify(sessionList)}`);",
      "  }",
      "  const firstWorkflow = await app.workflows.run({",
      "    workflowId: 'summarize',",
      "    workflowRunId: 'workflow-run:generated-local:1',",
      "    idempotencyKey: 'idem:generated-local:workflow:1',",
      "    inputDigest: 'sha256:generated-local-workflow-1',",
      "    intent: 'run generated local workflow one',",
      "  });",
      "  if (!firstWorkflow.ok || firstWorkflow.final !== 'workflow one complete') {",
      "    throw new Error(`unexpected generated local first workflow result ${JSON.stringify(firstWorkflow)}`);",
      "  }",
      "  const secondWorkflow = await app.workflows.run({",
      "    workflowId: 'summarize',",
      "    workflowRunId: 'workflow-run:generated-local:2',",
      "    intent: 'run generated local workflow two',",
      "  });",
      "  if (!secondWorkflow.ok || secondWorkflow.final !== 'workflow two complete') {",
      "    throw new Error(`unexpected generated local second workflow result ${JSON.stringify(secondWorkflow)}`);",
      "  }",
      "  if (firstWorkflow.runId === secondWorkflow.runId) {",
      "    throw new Error(`generated local workflows shared runtime run id ${firstWorkflow.runId}`);",
      "  }",
      "  const firstWorkflowProjection = app.workflows.inspectRun('summarize', 'workflow-run:generated-local:1');",
      "  if (firstWorkflowProjection?.status !== 'succeeded' || firstWorkflowProjection.runtimeRunId !== firstWorkflow.runId || firstWorkflowProjection.output !== 'workflow one complete' || firstWorkflowProjection.outputKind !== 'text' || firstWorkflowProjection.idempotencyKey !== 'idem:generated-local:workflow:1' || firstWorkflowProjection.inputDigest !== 'sha256:generated-local-workflow-1') {",
      "    throw new Error(`generated local workflow projection lost terminal/idempotency facts ${JSON.stringify(firstWorkflowProjection)}`);",
      "  }",
      "  const secondWorkflowProjection = app.workflows.inspectRun('summarize', 'workflow-run:generated-local:2');",
      "  if (secondWorkflowProjection?.status !== 'succeeded' || secondWorkflowProjection.runtimeRunId !== secondWorkflow.runId || secondWorkflowProjection.output !== 'workflow two complete' || secondWorkflowProjection.outputKind !== 'text') {",
      "    throw new Error(`generated local second workflow projection lost terminal facts ${JSON.stringify(secondWorkflowProjection)}`);",
      "  }",
      "  const workflowList = app.workflows.listRuns('summarize');",
      "  if (workflowList.runs.length !== 2 || workflowList.runs[0]?.workflowRunId !== 'workflow-run:generated-local:1' || workflowList.runs[1]?.workflowRunId !== 'workflow-run:generated-local:2') {",
      "    throw new Error(`generated local workflow list lost independent runs ${JSON.stringify(workflowList)}`);",
      "  }",
      "  if (JSON.stringify(app.schedules.ids) !== JSON.stringify(['daily-session', 'daily-workflow'])) {",
      "    throw new Error(`generated local schedules lost ids ${JSON.stringify(app.schedules.ids)}`);",
      "  }",
      "  const listedSchedules = app.schedules.list();",
      "  if (JSON.stringify(listedSchedules.map((row) => [row.scheduleId, row.path, row.cron])) !== JSON.stringify([['daily-session', 'agent/schedules/daily-session.ts', '0 9 * * *'], ['daily-workflow', 'agent/schedules/daily-workflow.ts', '15 9 * * *']])) {",
      "    throw new Error(`generated local schedules list lost definitions ${JSON.stringify(listedSchedules)}`);",
      "  }",
      "  const schedulePrincipal = { authority: 'consumer.app', subject: 'generated-local-target-consumer' };",
      "  const scheduledSession = await app.schedules.trigger({",
      "    scheduleId: 'daily-session',",
      "    scheduledAt: '2026-06-26T09:00:42.000Z',",
      "    appPrincipal: schedulePrincipal,",
      "  });",
      "  if (scheduledSession.status !== 'dispatched' || scheduledSession.product.kind !== 'session_turn' || scheduledSession.product.link.sessionRef !== 'session:scheduled' || scheduledSession.product.link.idempotencyKey !== scheduledSession.fireId || scheduledSession.product.turn?.status.kind !== 'delivered') {",
      "    throw new Error(`generated local scheduled session did not project linked turn ${JSON.stringify(scheduledSession)}`);",
      "  }",
      "  const scheduledWorkflow = await app.schedules.trigger({",
      "    scheduleId: 'daily-workflow',",
      "    scheduledAt: '2026-06-26T09:15:42.000Z',",
      "    appPrincipal: schedulePrincipal,",
      "  });",
      "  if (scheduledWorkflow.status !== 'dispatched' || scheduledWorkflow.product.kind !== 'workflow_run' || scheduledWorkflow.product.link.workflowId !== 'scheduled-workflow' || scheduledWorkflow.product.link.idempotencyKey !== scheduledWorkflow.fireId || scheduledWorkflow.product.workflowRun?.status !== 'succeeded' || scheduledWorkflow.product.workflowRun.output !== 'scheduled workflow complete') {",
      "    throw new Error(`generated local scheduled workflow did not project linked workflow ${JSON.stringify(scheduledWorkflow)}`);",
      "  }",
      "  const sessionScheduleHistory = app.schedules.history({ scheduleId: 'daily-session' });",
      "  if (sessionScheduleHistory.fires.length !== 1 || sessionScheduleHistory.fires[0]?.fireId !== scheduledSession.fireId || sessionScheduleHistory.fires[0].status !== 'dispatched') {",
      "    throw new Error(`generated local schedule history lost session fire ${JSON.stringify(sessionScheduleHistory)}`);",
      "  }",
      "  const allScheduleHistory = app.schedules.history();",
      "  if (allScheduleHistory.fires.length !== 2 || !allScheduleHistory.fires.some((fire) => fire.fireId === scheduledSession.fireId) || !allScheduleHistory.fires.some((fire) => fire.fireId === scheduledWorkflow.fireId)) {",
      "    throw new Error(`generated local schedule history lost fires ${JSON.stringify(allScheduleHistory)}`);",
      "  }",
      "  const scheduleEvents = app.runtime.events().filter((event) => event.kind.startsWith('schedule.fire_'));",
      "  if (JSON.stringify(scheduleEvents.map((event) => event.kind)) !== JSON.stringify(['schedule.fire_requested', 'schedule.fire_dispatched', 'schedule.fire_requested', 'schedule.fire_dispatched'])) {",
      "    throw new Error(`generated local schedule trigger wrote wrong handoff facts ${JSON.stringify(scheduleEvents)}`);",
      "  }",
      "  const toolEvent = app.runtime.events().find((event) => event.kind === 'tool.executed');",
      "  if (toolEvent?.payload?.result?.kind !== 'write_file') {",
      "    throw new Error('generated local app did not execute write_file');",
      "  }",
      "  const anchor = toolEvent?.payload?.claim?.anchorRef;",
      "  if (anchor?.anchorKind !== 'external_receipt') {",
      "    throw new Error('generated local app did not complete a receipt-backed workspace write');",
      "  }",
      "  if (anchor?.carrierRef !== 'workspace_op:carrier:workspace-op') {",
      "    throw new Error(`generated local app did not use workspace_op carrier ${JSON.stringify(anchor)}`);",
      "  }",
      "  if (app.runtime.diagnostics().length !== 0) {",
      "    throw new Error(`generated local runtime emitted diagnostics ${JSON.stringify(app.runtime.diagnostics())}`);",
      "  }",
      "  const postInspection = app.runtime.inspect();",
      "  if (postInspection.runtime.status !== 'available') {",
      "    throw new Error(`generated local inspect lost runtime facts ${JSON.stringify(postInspection.runtime)}`);",
      "  }",
      "  const workspaceRows = postInspection.runtime.events.filter((event) => event.factOwnerRef === WORKSPACE_OP_FACT_OWNER);",
      "  const lastWorkspaceRow = workspaceRows.at(-1);",
      "  if (lastWorkspaceRow?.kind !== WORKSPACE_OP_KIND.COMPLETED || lastWorkspaceRow.payload?.toolName !== 'write_file') {",
      "    throw new Error(`generated local inspect lost last workspace_op row ${JSON.stringify(lastWorkspaceRow)}`);",
      "  }",
      "} finally {",
      "  await rm(root, { recursive: true, force: true });",
      "}",
    ].join("\n") + "\n",
  );
  fs.writeFileSync(
    path.join(dir, "local-channel-smoke.ts"),
    channelDispatchSmokeSource({
      importLine: 'import { handleLocalAgentChannelRequest } from "./.agentos/generated/local";',
      dispatchExpression: "handleLocalAgentChannelRequest(request, runtime)",
      scopeId: "generated-local-target-consumer",
    }),
  );
};

export const assertNoAgentOsSymlinkPackages = (dir) => {
  for (const packageName of tarballsByPackage().keys()) {
    const target = packageTargetDir(path.join(dir, "node_modules"), packageName);
    if (!fs.existsSync(target)) fail(`${packageName}: missing installed consumer package`);
    if (fs.lstatSync(target).isSymbolicLink()) {
      fail(`${packageName}: consumer package must be installed package content, not a symlink`);
    }
  }
};

export const assertPackageNotInstalled = (dir, packageName) => {
  const target = packageTargetDir(path.join(dir, "node_modules"), packageName);
  if (fs.existsSync(target)) fail(`${packageName}: unexpected installed package`);
};

const removedCloudflareLifecycleValueExports = [
  "createCloudflareWorkspaceEnvResolver",
  "createCloudflareSandboxWorkspaceEnvResolver",
  "installCloudflareWorkspaceOperationProvider",
  "installCloudflareWorkspaceJobProfile",
];

const removedCloudflareLifecyclePackedFiles = [
  "dist/cloudflare/workspace-env.d.ts",
  "dist/cloudflare/workspace-env.js",
  "dist/cloudflare/workspace-op.d.ts",
  "dist/cloudflare/workspace-op.js",
  "dist/cloudflare/workspace-job-profile.d.ts",
  "dist/cloudflare/workspace-job-profile.js",
];

const removedCloudflareLifecycleImportSpecifiers = [
  `${publishScope()}/runtime/cloudflare/workspace-env`,
  `${publishScope()}/runtime/cloudflare/workspace-op`,
  `${publishScope()}/runtime/cloudflare/workspace-job-profile`,
];

export const npmInstall = (dir, omitPeer = false) => {
  run(
    "npm",
    [
      "install",
      "--package-lock=false",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--prefer-offline",
      ...(omitPeer ? ["--omit=peer", "--legacy-peer-deps"] : []),
    ],
    { cwd: dir, capture: true },
  );
};

export const assertPeerFailure = () => {
  const dir = mkdtempFixture("agentos-peer-failure-");
  const corePublicName = publicSpecifier("@agent-os/core");
  const coreTarball = tarballsByPackage().get(corePublicName);
  if (coreTarball === undefined) fail(`${corePublicName}: missing tarball for peer failure test`);
  writeJson(path.join(dir, "package.json"), {
    name: "agentos-peer-failure",
    private: true,
    type: "module",
    dependencies: {
      [corePublicName]: `file:${coreTarball}`,
    },
    devDependencies: {
      typescript: catalog().typescript,
    },
  });
  fs.writeFileSync(
    path.join(dir, "index.ts"),
    `import { makePreClaim } from "${publicSpecifier("@agent-os/core")}";\nvoid makePreClaim;\n`,
  );
  fs.writeFileSync(
    path.join(dir, "smoke.mjs"),
    `import { makePreClaim } from "${publicSpecifier("@agent-os/core")}";\nvoid makePreClaim;\n`,
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

export const negativeContractTests = () => {
  const records = publishedRecords();
  const core = records.find((record) => record.packageJson.name === "@agent-os/core");
  const cloudflare = records.find((record) => record.packageJson.name === "@agent-os/runtime");
  if (core === undefined || cloudflare === undefined) {
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
    const text = `import type { X } from "${publishScope()}/runtime/src/internal-helper";\n`;
    if (
      /\/src\/|src\/index|workspace:\*|["']workspace:/.test(text) ||
      new RegExp(`${escapeRegExp(publishScope())}/[^"']+/src/`, "u").test(text)
    ) {
      fail("declaration leaks source path");
    }
  });
  assertFails("effect import without peer", () => {
    const pkg = structuredClone(core.packageJson);
    delete pkg.peerDependencies?.effect;
    if (packageImportsEffect(core) && pkg.peerDependencies?.effect !== "catalog:") {
      fail("missing effect peer");
    }
  });
  assertFails("cloudflare package without workers peer", () => {
    const pkg = structuredClone(cloudflare.packageJson);
    delete pkg.peerDependencies?.["@cloudflare/workers-types"];
    if (pkg.peerDependencies?.["@cloudflare/workers-types"] !== "catalog:") {
      fail("missing workers types peer");
    }
  });
  console.log("verified negative distribution contract fixtures");
};

export const assertGeneratedTargetConsumer = () => {
  const dir = mkdtempFixture("agentos-generated-target-consumer-");
  writeGeneratedTargetConsumerApp(dir);
  assertNoAgentOsSymlinkPackages(dir);
  assertPackageNotInstalled(dir, "@effect/ai-anthropic");
  run(
    "npm",
    [
      "exec",
      "esbuild",
      "--",
      ".agentos/generated/worker.ts",
      "--bundle",
      "--platform=browser",
      "--format=esm",
      "--packages=external",
      "--external:cloudflare:workers",
      "--outfile=.agentos/generated/worker.bundle.js",
    ],
    { cwd: dir, capture: true },
  );
  run(
    "npm",
    [
      "exec",
      "esbuild",
      "--",
      "channel-dispatch-smoke.ts",
      "--bundle",
      "--platform=node",
      "--format=esm",
      "--packages=external",
      "--outfile=channel-dispatch-smoke.mjs",
    ],
    { cwd: dir, capture: true },
  );
  run("node", ["channel-dispatch-smoke.mjs"], { cwd: dir, capture: true });
  console.log(
    "verified generated target consumer uses public package imports and channel dispatch without symlinks",
  );
};

export const assertGeneratedLocalTargetConsumer = () => {
  const dir = mkdtempFixture("agentos-generated-local-target-consumer-");
  writeGeneratedLocalTargetConsumerApp(dir);
  assertNoAgentOsSymlinkPackages(dir);
  assertPackageNotInstalled(dir, "@effect/ai-anthropic");
  assertPackageNotInstalled(dir, "@cloudflare/sandbox");
  const localGeneratedSmokeText = fs.readFileSync(
    path.join(dir, "local-generated-smoke.ts"),
    "utf8",
  );
  for (const fragment of [
    "app.sessions.submitTurn",
    "app.sessions.inspect",
    "app.sessions.list",
    "app.workflows.run",
    "app.workflows.inspectRun",
    "app.workflows.listRuns",
    "app.schedules.ids",
    "app.schedules.list",
    "app.schedules.trigger",
    "app.schedules.history",
  ]) {
    if (!localGeneratedSmokeText.includes(fragment)) {
      fail(`generated local target consumer smoke missing product API fragment ${fragment}`);
    }
  }
  if (localGeneratedSmokeText.includes("SubmitRunInput")) {
    fail("generated local target consumer product proof depends on direct SubmitRunInput");
  }
  run(
    "npm",
    [
      "exec",
      "esbuild",
      "--",
      "local-generated-smoke.ts",
      "--bundle",
      "--platform=node",
      "--format=esm",
      "--packages=external",
      "--outfile=local-generated-smoke.mjs",
    ],
    { cwd: dir, capture: true },
  );
  run(
    "npm",
    [
      "exec",
      "esbuild",
      "--",
      "local-channel-smoke.ts",
      "--bundle",
      "--platform=node",
      "--format=esm",
      "--packages=external",
      "--outfile=local-channel-smoke.mjs",
    ],
    { cwd: dir, capture: true },
  );
  const bundleText = fs.readFileSync(path.join(dir, "local-generated-smoke.mjs"), "utf8");
  const forbiddenBundleText = [
    "cloudflare:workers",
    "@effect/ai-anthropic",
    "installLocalWorkspaceOperationProvider",
    "createInMemoryBackendState",
    "createInMemoryRuntimeBackend",
    "createAgentDurableObject",
    "@cloudflare/sandbox",
    "getSandbox",
    "createCloudflareSandboxWorkspaceEnvResolver",
    "SandboxLifecycle",
    "just-bash",
    "wrangler",
  ];
  for (const token of forbiddenBundleText) {
    if (bundleText.includes(token)) {
      fail(`generated local target bundle leaked forbidden token ${token}`);
    }
  }
  run("node", ["local-generated-smoke.mjs"], { cwd: dir, capture: true });
  run("node", ["local-channel-smoke.mjs"], { cwd: dir, capture: true });
  console.log(
    "verified generated local target consumer executes workspace operations and channel dispatch",
  );
};

export const assertPackedRootInternalSymbolsAbsent = (dir) => {
  const runtimeSpecifier = publicSpecifier("@agent-os/runtime");
  const removedRootTypeSymbols = ["InternalSubmitSpec"];
  const removedRootValueSymbols = [
    "DEFAULT_LLM_CALL_TIMEOUT_MS",
    "buildInitialMessages",
    "internalSubmitSpec",
    "submitAgentEffect",
    "turnRefOf",
  ];
  fs.writeFileSync(
    path.join(dir, "negative-internal-root.ts"),
    [
      `import { ${removedRootValueSymbols.join(", ")} } from "${runtimeSpecifier}";`,
      `import type { ${removedRootTypeSymbols.join(", ")} } from "${runtimeSpecifier}";`,
      `void [${removedRootValueSymbols.join(", ")}];`,
      `type _RemovedRootType = ${removedRootTypeSymbols.join(" | ")};`,
      "",
    ].join("\n"),
  );
  writeJson(path.join(dir, "tsconfig.negative.json"), {
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
      skipLibCheck: true,
    },
    include: ["negative-internal-root.ts"],
  });
  const typecheck = spawnSync("npm", ["exec", "tsc", "--", "-p", "tsconfig.negative.json"], {
    cwd: dir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (typecheck.status === 0) {
    fail("packed runtime root unexpectedly typechecked removed internal submit symbols");
  }
  const typecheckOutput = `${typecheck.stdout}\n${typecheck.stderr}`;
  for (const symbol of [...removedRootTypeSymbols, ...removedRootValueSymbols]) {
    if (!typecheckOutput.includes(symbol)) {
      fail(`packed runtime root negative typecheck did not mention removed symbol ${symbol}`);
    }
  }

  fs.writeFileSync(
    path.join(dir, "negative-internal-root.mjs"),
    [
      `const runtime = await import(${JSON.stringify(runtimeSpecifier)});`,
      `const forbidden = ${JSON.stringify(removedRootValueSymbols)};`,
      "const leaked = forbidden.filter((symbol) => symbol in runtime);",
      "if (leaked.length > 0) throw new Error(`packed runtime root leaked ${leaked.join(', ')}`);",
      "",
    ].join("\n"),
  );
  run("node", ["negative-internal-root.mjs"], { cwd: dir, capture: true });
  console.log("verified packed runtime root hides internal submit symbols");
};

export const assertPackedCloudflareLifecycleHelpersAbsent = (dir) => {
  const cloudflareSpecifier = publicSpecifier("@agent-os/runtime/cloudflare");
  fs.writeFileSync(
    path.join(dir, "negative-cloudflare-lifecycle.ts"),
    [
      `import { ${removedCloudflareLifecycleValueExports.join(", ")} } from "${cloudflareSpecifier}";`,
      `void [${removedCloudflareLifecycleValueExports.join(", ")}];`,
      "",
    ].join("\n"),
  );
  writeJson(path.join(dir, "tsconfig.negative-cloudflare-lifecycle.json"), {
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
      skipLibCheck: true,
      types: ["@cloudflare/workers-types"],
    },
    include: ["negative-cloudflare-lifecycle.ts"],
  });
  const typecheck = spawnSync(
    "npm",
    ["exec", "tsc", "--", "-p", "tsconfig.negative-cloudflare-lifecycle.json"],
    {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (typecheck.status === 0) {
    fail("packed cloudflare lifecycle helper fixture unexpectedly typechecked");
  }
  const typecheckOutput = `${typecheck.stdout}\n${typecheck.stderr}`;
  for (const symbol of removedCloudflareLifecycleValueExports) {
    if (!typecheckOutput.includes(symbol)) {
      fail(`packed cloudflare lifecycle negative typecheck did not mention ${symbol}`);
    }
  }

  const runtimeDir = packageTargetDir(
    path.join(dir, "node_modules"),
    publicSpecifier("@agent-os/runtime"),
  );
  const packageFiles = allFiles(runtimeDir);
  const packedFileSet = new Set(
    packageFiles.map((file) => path.relative(runtimeDir, file).split(path.sep).join("/")),
  );
  for (const file of removedCloudflareLifecyclePackedFiles) {
    if (packedFileSet.has(file)) {
      fail(`packed runtime includes removed cloudflare lifecycle file ${file}`);
    }
  }
  for (const file of packageFiles.filter(
    (candidate) => candidate.endsWith(".d.ts") || candidate.endsWith(".js"),
  )) {
    const text = fs.readFileSync(file, "utf8");
    for (const symbol of removedCloudflareLifecycleValueExports) {
      if (text.includes(symbol)) {
        fail(
          `${path.relative(runtimeDir, file)} leaks removed cloudflare lifecycle symbol ${symbol}`,
        );
      }
    }
    for (const specifier of removedCloudflareLifecycleImportSpecifiers) {
      if (text.includes(specifier)) {
        fail(
          `${path.relative(runtimeDir, file)} leaks removed cloudflare lifecycle import ${specifier}`,
        );
      }
    }
  }
  console.log("verified packed cloudflare lifecycle helpers are absent");
};

export const assertPackedPublicAssemblyEscapesAbsent = (dir) => {
  const inMemorySpecifier = publicSpecifier("@agent-os/runtime/in-memory");
  const localSpecifier = publicSpecifier("@agent-os/runtime/local");
  const forbiddenExports = ["createInMemoryBackendState", "installLocalWorkspaceOperationProvider"];
  fs.writeFileSync(
    path.join(dir, "negative-public-assembly.ts"),
    [
      `import { createInMemoryRuntimeBackend, createInMemoryBackendState } from "${inMemorySpecifier}";`,
      `import { installLocalWorkspaceOperationProvider } from "${localSpecifier}";`,
      "const looseHalfRegistrationShape = {",
      "  identity: {} as Parameters<typeof createInMemoryRuntimeBackend>[0]['identity'],",
      "  handlers: [],",
      "  projections: [],",
      "  triggers: [],",
      "  streams: [],",
      "};",
      "createInMemoryRuntimeBackend(looseHalfRegistrationShape);",
      "void createInMemoryBackendState;",
      "void installLocalWorkspaceOperationProvider;",
      "",
    ].join("\n"),
  );
  writeJson(path.join(dir, "tsconfig.negative-public-assembly.json"), {
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
      skipLibCheck: true,
    },
    include: ["negative-public-assembly.ts"],
  });
  const typecheck = spawnSync(
    "npm",
    ["exec", "tsc", "--", "-p", "tsconfig.negative-public-assembly.json"],
    {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (typecheck.status === 0) {
    fail("packed public assembly escape fixture unexpectedly typechecked");
  }
  const typecheckOutput = `${typecheck.stdout}\n${typecheck.stderr}`;
  for (const symbol of forbiddenExports) {
    if (!typecheckOutput.includes(symbol)) {
      fail(`packed public assembly negative typecheck did not mention ${symbol}`);
    }
  }
  if (!typecheckOutput.includes("createInMemoryRuntimeBackend")) {
    fail("packed public assembly negative typecheck did not reject raw backend graph input");
  }

  fs.writeFileSync(
    path.join(dir, "negative-public-assembly.mjs"),
    [
      `const inMemory = await import(${JSON.stringify(inMemorySpecifier)});`,
      `const local = await import(${JSON.stringify(localSpecifier)});`,
      `const leaked = ${JSON.stringify(forbiddenExports)}.filter((symbol) => symbol in inMemory || symbol in local);`,
      "if (leaked.length > 0) throw new Error(`packed public surface leaked ${leaked.join(', ')}`);",
      "",
    ].join("\n"),
  );
  run("node", ["negative-public-assembly.mjs"], { cwd: dir, capture: true });
  console.log("verified packed public assembly escape hatches are absent");
};

export const assertConsumerOverlayStatus = () => {
  const dir = mkdtempFixture("agentos-consumer-overlay-status-");
  writeConsumerApp(dir, {
    effect: catalog().effect,
    "@cloudflare/workers-types": catalog()["@cloudflare/workers-types"],
  });
  npmInstall(dir);
  installConsumer(["--skip-pack", dir]);
  const markerPath = localConsumerMarkerPath(dir);
  const marker = readJson(markerPath);
  if (marker.generatedBy !== "agentos consumer install") {
    fail(`install-consumer marker did not record public command identity: ${marker.generatedBy}`);
  }
  if (marker.artifact?.kind !== "local-tarball-overlay") {
    fail("install-consumer marker did not record local-tarball-overlay artifact identity");
  }
  if (marker.artifact.installManifest?.sha256 !== sha256File(installManifestPath)) {
    fail("install-consumer marker did not record install manifest digest");
  }
  const status = consumerStatusData(dir);
  if (status.localOverlay.status !== "installed") {
    fail(`consumer status did not report installed overlay: ${status.localOverlay.status}`);
  }
  if (status.localOverlay.sourceStatus !== "current_source") {
    fail(`consumer status did not report current source: ${status.localOverlay.sourceStatus}`);
  }
  if (status.packageVersion.status !== "release_version_match") {
    fail(`consumer status did not report release version match: ${status.packageVersion.status}`);
  }
  if (!status.localOverlay.packages.every((pkg) => pkg.tarballStatus === "verified")) {
    fail("consumer status did not verify every local tarball digest");
  }
  if (status.gate.status !== "pass") {
    fail(`consumer status gate did not pass for current overlay: ${status.gate.status}`);
  }
  writeJson(markerPath, {
    ...marker,
    source: {
      ...marker.source,
      head: "0000000000000000000000000000000000000000",
    },
  });
  const staleStatus = consumerStatusData(dir);
  if (staleStatus.localOverlay.sourceStatus !== "stale_source") {
    fail(
      `consumer status did not expose stale source overlay: ${staleStatus.localOverlay.sourceStatus}`,
    );
  }
  if (
    staleStatus.gate.status !== "fail" ||
    !staleStatus.gate.hardFailures.some(
      (failure) => failure.code === "local_overlay_source_not_current",
    )
  ) {
    fail(`consumer status gate did not fail stale source: ${JSON.stringify(staleStatus.gate)}`);
  }
  fs.rmSync(path.join(dir, "node_modules"), { recursive: true, force: true });
  let missingNodeModulesFailed = false;
  try {
    installConsumer(["--skip-pack", "--no-install", dir]);
  } catch (error) {
    if (!String(error?.message ?? error).includes("missing node_modules")) {
      throw error;
    }
    missingNodeModulesFailed = true;
  }
  if (!missingNodeModulesFailed) {
    fail("install-consumer --no-install did not fail on missing node_modules");
  }
  const pnpmDir = mkdtempFixture("agentos-pnpm-install-command-");
  writeJson(path.join(pnpmDir, "package.json"), {
    name: "agentos-pnpm-install-command",
    private: true,
    packageManager: "pnpm@11.9.0",
    dependencies: {},
  });
  const pnpmCommand = consumerInstallCommand(pnpmDir);
  if (
    pnpmCommand?.cmd !== "pnpm" ||
    !pnpmCommand.args.includes("--frozen-lockfile") ||
    pnpmCommand.env.CI !== "true"
  ) {
    fail("pnpm consumer install command is not frozen non-interactive install");
  }
  console.log("verified local consumer overlay status and install hardening");
};

export const testInternalConsumer = () => {
  packInternal();
  negativeContractTests();
  assertPeerFailure();
  assertConsumerOverlayStatus();
  const dir = mkdtempFixture("agentos-internal-consumer-");
  writeConsumerApp(dir, {
    effect: catalog().effect,
    "@cloudflare/workers-types": catalog()["@cloudflare/workers-types"],
  });
  npmInstall(dir);
  assertPackageNotInstalled(dir, "@effect/ai-anthropic");
  assertInstalledAgentCatalog(dir);
  assertPackedRootInternalSymbolsAbsent(dir);
  assertPackedPublicAssemblyEscapesAbsent(dir);
  assertPackedCloudflareLifecycleHelpersAbsent(dir);
  run("npm", ["exec", "tsc", "--", "-p", "tsconfig.nodenext.json"], { cwd: dir, capture: true });
  run("npm", ["exec", "tsc", "--", "-p", "tsconfig.bundler.json"], { cwd: dir, capture: true });
  run("node", ["smoke.mjs"], { cwd: dir, capture: true });
  run("node", ["local-smoke.mjs"], { cwd: dir, capture: true });
  run("node", ["openai-compatible-smoke.mjs"], { cwd: dir, capture: true });
  run(
    "npm",
    [
      "exec",
      "esbuild",
      "--",
      "local-smoke.mjs",
      "--bundle",
      "--platform=node",
      "--format=esm",
      "--outfile=local-smoke.bundle.mjs",
    ],
    { cwd: dir, capture: true },
  );
  run(
    "npm",
    [
      "exec",
      "esbuild",
      "--",
      "cf-entry.ts",
      "--bundle",
      "--platform=browser",
      "--format=esm",
      "--packages=external",
      "--external:cloudflare:workers",
      "--outfile=cf-entry.js",
    ],
    { cwd: dir, capture: true },
  );
  assertGeneratedTargetConsumer();
  assertGeneratedLocalTargetConsumer();
  console.log("verified internal npm consumer fixtures");
};
