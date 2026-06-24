import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  boolArg,
  escapeRegExp,
  fail,
  gitStatusShort,
  gitValue,
  localConsumerMarkerName,
  mkdtempFixture,
  parseArgs,
  positionalArgs,
  publicSpecifier,
  publishScope,
  readJson,
  repoRoot,
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

export const nodeModulesRoot = (consumerRoot) => {
  const root = path.join(consumerRoot, "node_modules");
  if (!fs.existsSync(root)) {
    fail(`${consumerRoot}: missing node_modules; run the consumer package manager install first`);
  }
  return root;
};

export const packageTargetDir = (nodeModules, packageName) =>
  path.join(nodeModules, ...packageName.split("/"));

export const installConsumer = (rawArgs) => {
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

export const testInternalConsumer = () => {
  packInternal();
  negativeContractTests();
  assertPeerFailure();
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
  console.log("verified internal npm consumer fixtures");
};
