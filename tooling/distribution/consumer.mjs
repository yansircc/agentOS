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
import { allFiles } from "./staging-build.mjs";
import {
  packageDepsFromTarballs,
  packInternal,
  readInstallManifest,
  tarballPackageEntries,
  tarballsByPackage,
} from "./pack-check.mjs";

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
      const tarball = typeof record.tarball === "string" ? record.tarball : "";
      const tarballExists = tarball.length > 0 && fs.existsSync(tarball);
      const expectedSha = typeof record.sha256 === "string" ? record.sha256 : undefined;
      const actualSha = tarballExists ? sha256File(tarball) : undefined;
      return {
        packageName,
        target: record.target,
        installed: fs.existsSync(target),
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

export const consumerStatusData = (consumerRoot, options = {}) => {
  const markerPath = localConsumerMarkerPath(consumerRoot);
  const currentSource = currentSourceIdentity();
  if (!fs.existsSync(markerPath)) {
    return {
      schemaVersion: 1,
      consumerRoot,
      markerPath: path.relative(consumerRoot, markerPath).split(path.sep).join("/"),
      localOverlay: { status: "missing" },
      source: { current: currentSource },
      packageVersion: { release: releaseVersion() },
      npmLatest: options.checkNpm === true ? npmLatestFor([], options.registry) : npmLatestNotChecked(),
    };
  }
  const marker = readJson(markerPath);
  const packages = packageOverlayRows(consumerRoot, marker);
  const sourceStatus = overlaySourceStatus(marker, currentSource);
  return {
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
        ? npmLatestFor(packages.map((pkg) => pkg.packageName), options.registry)
        : npmLatestNotChecked(),
  };
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
  for (const pkg of status.localOverlay.packages ?? []) {
    console.log(
      `package ${pkg.packageName}: installed=${pkg.installed} tarball=${pkg.tarballStatus} sha256=${pkg.sha256}`,
    );
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
    generatedBy: "tooling/distribution/distribution.mjs install-consumer",
    installedAt: new Date().toISOString(),
    consumerRoot,
    source: currentSourceIdentity(),
    packageVersion: manifest.version,
    artifact: markerArtifact(manifest),
    packages,
  });
  assertSnapshotUnchanged(snapshot, "install-consumer");
  console.log(
    `installed ${entries.length} local agentOS packages into ${path.relative(repoRoot, consumerRoot) || consumerRoot}`,
  );
  console.log(
    `wrote ${path.relative(consumerRoot, localConsumerMarkerPath(consumerRoot)).split(path.sep).join("/")}`,
  );
  printConsumerStatus(consumerStatusData(consumerRoot));
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
  console.log(`restored ${packageNames.length} local agentOS package overlays`);
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
      `import { triggerParseOk } from "${publicSpecifier("@agent-os/runtime")}";`,
      `import { bindWorkspaceToolsForRuntime } from "${publicSpecifier("@agent-os/runtime/workspace-binding")}";`,
      `import { createLocalAgentRuntime } from "${publicSpecifier("@agent-os/runtime/local")}";`,
      `import { deterministicToolExecution } from "${publicSpecifier("@agent-os/core/tools")}";`,
      `import type { SubmitRunInput } from "${publicSpecifier("@agent-os/core/runtime-protocol")}";`,
      `import { mountOpsApi } from "${publicSpecifier("@agent-os/runtime/cloudflare/ops-api")}";`,
      "void triggerParseOk;",
      "void bindWorkspaceToolsForRuntime;",
      "void createLocalAgentRuntime;",
      "void deterministicToolExecution;",
      "type _SubmitRunInput = SubmitRunInput;",
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
      `import { compileAgentTree } from "${publicSpecifier("@agent-os/cli")}";`,
      `import { ABORT } from "${publicSpecifier("@agent-os/core")}";`,
      `import { triggerParseOk } from "${publicSpecifier("@agent-os/runtime")}";`,
      `import { AG_UI_WIRE_COMPATIBILITY } from "${publicSpecifier("@agent-os/runtime/ag-ui")}";`,
      `import { workspaceEnvMaterialRef } from "${publicSpecifier("@agent-os/runtime/workspace-binding")}";`,
      `import { deterministicToolExecution } from "${publicSpecifier("@agent-os/core/tools")}";`,
      `import { mountOpsApi } from "${publicSpecifier("@agent-os/runtime/cloudflare/ops-api")}";`,
      "if (!compileAgentTree || !ABORT || !triggerParseOk || !AG_UI_WIRE_COMPATIBILITY || !workspaceEnvMaterialRef || !deterministicToolExecution || !mountOpsApi) throw new Error('missing import');",
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
    path.join(dir, "cf-entry.ts"),
    [
      `import { compileAgentTree } from "${publicSpecifier("@agent-os/cli")}";`,
      `import { createAgentDurableObject } from "${publicSpecifier("@agent-os/runtime/cloudflare")}";`,
      `import { OpenAiCompatibleLlmTransportLive } from "${publicSpecifier("@agent-os/runtime/llm-effect-ai/openai-compatible")}";`,
      `import { defineAgentBindings } from "${publicSpecifier("@agent-os/core")}";`,
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
  if (/workspace:\*|catalog:/u.test(generatedText)) {
    fail("generated target consumer leaked workspace/catalog protocol");
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
};

export const writeGeneratedLocalTargetConsumerApp = (dir) => {
  fs.mkdirSync(path.join(dir, "agent"), { recursive: true });
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
  const generatedFiles = allFiles(path.join(dir, ".agentos", "generated")).filter((file) =>
    /\.(?:ts|json|jsonc)$/u.test(file),
  );
  const generatedText = generatedFiles.map((file) => fs.readFileSync(file, "utf8")).join("\n");
  const requiredGeneratedSpecifiers = [
    `${publishScope()}/runtime/local`,
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
  const forbiddenText = [
    "cloudflare:workers",
    "@effect/ai-anthropic",
    "installLocalWorkspaceOperationProvider",
    "createInMemoryBackendState",
    "createInMemoryRuntimeBackend",
    "createAgentDurableObject",
    "target--node",
    "blueprints/",
    "Provider Material Binding",
    "wrangler",
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
  if (/workspace:\*|catalog:/u.test(generatedText)) {
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
      "  const app = await createLocalAgentApp({",
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
      "              arguments: JSON.stringify({",
      "                path: 'generated-local.txt',",
      "                content: 'generated local write',",
      "              }),",
      "            },",
      "          },",
      "        }],",
      "        usage: { promptTokens: 3, completionTokens: 4, totalTokens: 7 },",
      "      }],",
      "    },",
      "  });",
      "  const initialInspection = app.inspect();",
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
      "  const result = await app.submit({",
      "    intent: 'write through generated local app',",
      "    toolPolicy: {",
      "      completeAfterToolsExecuted: {",
      "        toolNames: ['write_file'],",
      "        finalMessage: 'generated local write complete',",
      "      },",
      "    },",
      "  });",
      "  if (!result.ok || result.final !== 'generated local write complete') {",
      "    throw new Error(`unexpected generated local result ${JSON.stringify(result)}`);",
      "  }",
      "  const text = await readFile(path.join(root, 'generated-local.txt'), 'utf8');",
      "  if (text !== 'generated local write') throw new Error(`unexpected generated local file ${text}`);",
      "  const toolEvent = app.events().find((event) => event.kind === 'tool.executed');",
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
      "  if (app.diagnostics().length !== 0) {",
      "    throw new Error(`generated local app emitted diagnostics ${JSON.stringify(app.diagnostics())}`);",
      "  }",
      "  const postInspection = app.inspect();",
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
  npmInstall(dir);
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
  console.log("verified generated target consumer uses public package imports without symlinks");
};

export const assertGeneratedLocalTargetConsumer = () => {
  const dir = mkdtempFixture("agentos-generated-local-target-consumer-");
  writeGeneratedLocalTargetConsumerApp(dir);
  npmInstall(dir);
  assertNoAgentOsSymlinkPackages(dir);
  assertPackageNotInstalled(dir, "@effect/ai-anthropic");
  assertPackageNotInstalled(dir, "@cloudflare/sandbox");
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
  const bundleText = fs.readFileSync(path.join(dir, "local-generated-smoke.mjs"), "utf8");
  const forbiddenBundleText = [
    "cloudflare:workers",
    "@effect/ai-anthropic",
    "installLocalWorkspaceOperationProvider",
    "createInMemoryBackendState",
    "createInMemoryRuntimeBackend",
    "createAgentDurableObject",
    "wrangler",
  ];
  for (const token of forbiddenBundleText) {
    if (bundleText.includes(token)) {
      fail(`generated local target bundle leaked forbidden token ${token}`);
    }
  }
  run("node", ["local-generated-smoke.mjs"], { cwd: dir, capture: true });
  console.log("verified generated local target consumer executes workspace operations");
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
  writeJson(markerPath, {
    ...marker,
    source: {
      ...marker.source,
      head: "0000000000000000000000000000000000000000",
    },
  });
  const staleStatus = consumerStatusData(dir);
  if (staleStatus.localOverlay.sourceStatus !== "stale_source") {
    fail(`consumer status did not expose stale source overlay: ${staleStatus.localOverlay.sourceStatus}`);
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
  assertPackedRootInternalSymbolsAbsent(dir);
  assertPackedPublicAssemblyEscapesAbsent(dir);
  run("npm", ["exec", "tsc", "--", "-p", "tsconfig.nodenext.json"], { cwd: dir, capture: true });
  run("npm", ["exec", "tsc", "--", "-p", "tsconfig.bundler.json"], { cwd: dir, capture: true });
  run("node", ["smoke.mjs"], { cwd: dir, capture: true });
  run("node", ["local-smoke.mjs"], { cwd: dir, capture: true });
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
