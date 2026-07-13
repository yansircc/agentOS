import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { buildSync } from "esbuild";
import { releaseTagAdmissionFailures } from "../src/release-receipt.mjs";
import { releaseStatusData } from "../src/release-status.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const cli = path.join(repoRoot, "packages/cli/src/main.mjs");
const repoGitValue = (args) =>
  spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" }).stdout.trim();
const repoSourceIdentity = () => ({
  repoRoot,
  branch: repoGitValue(["branch", "--show-current"]),
  head: repoGitValue(["rev-parse", "HEAD"]),
  dirty: repoGitValue(["status", "--short"]).length > 0,
});
const agentOsReleaseVersion = () => {
  const manifest = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  return manifest.agentOsRelease?.version;
};
const sha256File = (file) => crypto.createHash("sha256").update(readFileSync(file)).digest("hex");
const workspaceDefaultToolNames = ["bash", "glob", "grep", "read_file", "write_file"];

const staticRelativeImportSpecifiers = (source) =>
  [...source.matchAll(/^\s*import\s+(?:[^'"]+\s+from\s+)?["'](\.[^"']+)["'];?/gmu)].map(
    (match) => match[1],
  );

const staticRelativeImportClosure = (entry) => {
  const visited = new Set();
  const visit = (file) => {
    if (visited.has(file)) return;
    visited.add(file);
    const source = readFileSync(file, "utf8");
    for (const specifier of staticRelativeImportSpecifiers(source)) {
      visit(path.resolve(path.dirname(file), specifier));
    }
  };
  visit(entry);
  return [...visited].sort();
};

const repoRelative = (file) => path.relative(repoRoot, file).split(path.sep).join("/");

const sourceNameForPublicPackage = (packageName) => {
  const release = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  const publicScope = release.agentOsRelease?.npmScope;
  if (typeof publicScope === "string" && packageName.startsWith(`${publicScope}/`)) {
    return `@agent-os/${packageName.slice(publicScope.length + 1)}`;
  }
  return packageName.startsWith("@agent-os/") ? packageName : undefined;
};

const distTargetForSource = (target, ext) =>
  target.startsWith("./src/") && target.endsWith(".ts")
    ? `./dist/${target.slice("./src/".length, -".ts".length)}.${ext}`
    : target;

const projectedPackedExportsFor = (packageName) => {
  const sourceName = sourceNameForPublicPackage(packageName);
  if (sourceName === undefined) return undefined;
  const packageDir = sourceName.split("/")[1];
  const manifestPath = path.join(repoRoot, "packages", packageDir, "package.json");
  if (!existsSync(manifestPath)) return undefined;
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.exports === undefined || manifest.exports === null) return undefined;
  if (typeof manifest.exports === "string") {
    return {
      ".": {
        types: distTargetForSource(manifest.exports, "d.ts"),
        default: distTargetForSource(manifest.exports, "js"),
      },
    };
  }
  return Object.fromEntries(
    Object.entries(manifest.exports).map(([subpath, target]) => {
      const sourceTarget =
        typeof target === "string" ? target : (target.default ?? target.import ?? target.types);
      return [
        subpath,
        {
          types: distTargetForSource(sourceTarget, "d.ts"),
          default: distTargetForSource(sourceTarget, "js"),
        },
      ];
    }),
  );
};

const writePackedPackageTarball = (root, packageName, options = {}) => {
  const src = path.join(root, "tarball-src");
  const packageDir = path.join(src, "package");
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(
    path.join(packageDir, "package.json"),
    JSON.stringify(
      {
        name: packageName,
        version: agentOsReleaseVersion(),
        type: "module",
        exports:
          options.exports === undefined ? projectedPackedExportsFor(packageName) : options.exports,
      },
      null,
      2,
    ),
  );
  const tarball = path.join(root, `${packageName.replace(/[^a-z0-9]+/giu, "-")}.tgz`);
  const result = spawnSync("tar", ["-czf", tarball, "-C", src, "package"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  rmSync(src, { recursive: true, force: true });
  return { tarball, sha256: sha256File(tarball) };
};

const runTypeScript = (source, { cwd = repoRoot, resolveDir = repoRoot } = {}) => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "agentos-ts-eval-"));
  try {
    const outfile = path.join(tempDir, "entry.mjs");
    buildSync({
      stdin: {
        contents: source,
        loader: "ts",
        resolveDir,
        sourcefile: "entry.ts",
      },
      outfile,
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node22",
      external: ["cloudflare:*"],
      logLevel: "silent",
    });
    return spawnSync(process.execPath, [outfile], { cwd, encoding: "utf8" });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
};

const writeWorkspaceProductFixture = (root, overrides = {}) => {
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ type: "module" }, null, 2));
  mkdirSync(path.join(root, "agent"), { recursive: true });
  writeFileSync(path.join(root, "agent/instructions.md"), "Operate locally.");
  writeFileSync(
    path.join(root, "agent/agent.json"),
    JSON.stringify(
      {
        agentId: "node-local-agent",
        kind: "workspace",
        ...overrides,
      },
      null,
      2,
    ),
  );
};

const nodeDeploymentIntent = (overrides = {}) => ({
  kind: "deployment",
  release: { id: "node-local-deployment", version: "0.1.0" },
  target: { kind: "node" },
  transport: "direct",
  providers: {
    default: {
      protocol: "openai-chat-compatible",
      endpointRef: "openrouter",
      credentialRef: "openrouter-key",
      modelRef: "openrouter-default-text-model",
    },
  },
  workspace: { binding: "Sandbox", root: "/workspace" },
  ...overrides,
});

const writeDeploymentIntentFixture = (root, intent = nodeDeploymentIntent()) => {
  writeFileSync(
    path.join(root, "agentos.deployment.jsonc"),
    `${JSON.stringify(intent, null, 2)}\n`,
  );
};

const runCli = (args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: options.cwd ?? repoRoot,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (status, signal) => {
      resolve({ status, signal, stdout, stderr });
    });
  });

void test("agentos --version derives from the release source fact", () => {
  const rootPackage = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  const result = spawnSync(process.execPath, [cli, "--version"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), rootPackage.agentOsRelease.version);
});

void test("agentos non-check startup import graph excludes repo-check modules and typescript", () => {
  const closure = staticRelativeImportClosure(cli);
  const forbiddenStartupModules = closure
    .map(repoRelative)
    .filter(
      (file) =>
        file.startsWith("packages/cli/src/check/") ||
        file.startsWith("packages/cli/src/generate/") ||
        file === "packages/cli/src/runner.mjs",
    );
  assert.deepEqual(forbiddenStartupModules, []);

  const typescriptImporters = closure
    .filter((file) => /\bfrom\s+["']typescript["']/.test(readFileSync(file, "utf8")))
    .map(repoRelative);
  assert.deepEqual(typescriptImporters, []);
});

void test("agentos consumer help is a successful lightweight startup path", async () => {
  const result = await runCli(["consumer", "--help"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /agentos consumer status/);
  assert.match(result.stdout, /agentos consumer doctor/);
});

void test("agentos consumer status and check share one overlay gate projection", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "agentos-consumer-cli-"));
  try {
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ name: "agentos-consumer-cli", private: true, type: "module" }, null, 2),
    );

    const status = await runCli(["consumer", "status", root, "--json"]);
    assert.equal(status.status, 0, status.stderr);
    const statusProjection = JSON.parse(status.stdout);
    assert.equal(statusProjection.truthMode, "npm_release");
    assert.equal(statusProjection.localOverlay.status, "missing");
    assert.deepEqual(statusProjection.packageIntegrity, {
      status: "not_checked",
      reason: "local overlay marker is missing; consumer is using package-manager truth",
    });
    assert.deepEqual(statusProjection.sourceFreshness, {
      status: "not_applicable",
      checked: false,
      gate: "pass",
    });
    assert.equal(statusProjection.gate.status, "fail");
    assert.deepEqual(
      statusProjection.gate.hardFailures.map((failure) => ({
        code: failure.code,
        dimension: failure.dimension,
      })),
      [{ code: "local_overlay_missing", dimension: "truth_mode" }],
    );

    const check = await runCli(["consumer", "check", root, "--json"]);
    assert.equal(check.status, 1);
    assert.equal(check.stderr, "");
    const checkProjection = JSON.parse(check.stdout);
    assert.equal(checkProjection.localOverlay.status, statusProjection.localOverlay.status);
    assert.deepEqual(checkProjection.gate, statusProjection.gate);

    const doctor = await runCli(["consumer", "doctor", root, "--json"]);
    assert.equal(doctor.status, 0, doctor.stderr);
    const doctorProjection = JSON.parse(doctor.stdout);
    assert.equal(doctorProjection.schemaVersion, 1);
    assert.equal(doctorProjection.consumerRoot, root);
    assert.equal(doctorProjection.release.release.version, agentOsReleaseVersion());
    assert.equal(doctorProjection.consumer.truthMode, "npm_release");
    assert.equal(doctorProjection.projections.workspaceOverlay, undefined);
    assert.equal(doctorProjection.projections.privateImports.status, "not_checked");
    assert.equal(
      doctorProjection.projections.privateImports.owner,
      "installed package.json#exports",
    );
    assert.equal(doctorProjection.gate.status, "fail");
    assert.deepEqual(
      doctorProjection.gate.hardFailures.map((failure) => ({
        code: failure.code,
        dimension: failure.dimension,
      })),
      [{ code: "local_overlay_missing", dimension: "consumer" }],
    );
    assert.equal(existsSync(path.join(root, ".agentos-doctor.json")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test("agentos consumer check fails from packageIntegrity failures", async () => {
  const emptyOverlayRoot = mkdtempSync(path.join(os.tmpdir(), "agentos-consumer-empty-"));
  const missingShaRoot = mkdtempSync(path.join(os.tmpdir(), "agentos-consumer-sha-"));
  try {
    for (const root of [emptyOverlayRoot, missingShaRoot]) {
      writeFileSync(
        path.join(root, "package.json"),
        JSON.stringify({ name: "agentos-consumer-cli", private: true, type: "module" }, null, 2),
      );
      mkdirSync(path.join(root, "node_modules"), { recursive: true });
    }

    const baseMarker = {
      schemaVersion: 1,
      generatedBy: "agentos consumer test",
      installedAt: new Date().toISOString(),
      source: repoSourceIdentity(),
      packageVersion: agentOsReleaseVersion(),
      artifact: { kind: "install-manifest-overlay" },
    };

    writeFileSync(
      path.join(emptyOverlayRoot, "node_modules", ".agentos-local.json"),
      JSON.stringify({ ...baseMarker, consumerRoot: emptyOverlayRoot, packages: {} }, null, 2),
    );

    const missingShaPackageRoot = path.join(missingShaRoot, "node_modules", "@example", "runtime");
    mkdirSync(missingShaPackageRoot, { recursive: true });
    writeFileSync(
      path.join(missingShaPackageRoot, "package.json"),
      JSON.stringify({ name: "@example/runtime" }, null, 2),
    );
    const packed = writePackedPackageTarball(missingShaRoot, "@example/runtime");
    writeFileSync(
      path.join(missingShaRoot, "node_modules", ".agentos-local.json"),
      JSON.stringify(
        {
          ...baseMarker,
          consumerRoot: missingShaRoot,
          packages: {
            "@example/runtime": {
              target: "node_modules/@example/runtime",
              tarball: packed.tarball,
            },
          },
        },
        null,
        2,
      ),
    );

    const emptyCheck = await runCli(["consumer", "check", emptyOverlayRoot, "--json"]);
    assert.equal(emptyCheck.status, 1);
    const emptyProjection = JSON.parse(emptyCheck.stdout);
    assert.equal(emptyProjection.packageIntegrity.status, "failed");
    assert.deepEqual(
      emptyProjection.gate.hardFailures.map((failure) => failure.code),
      ["local_overlay_packages_missing"],
    );

    const missingShaCheck = await runCli(["consumer", "check", missingShaRoot, "--json"]);
    assert.equal(missingShaCheck.status, 1);
    const missingShaProjection = JSON.parse(missingShaCheck.stdout);
    assert.equal(missingShaProjection.localOverlay.packages[0]?.tarballStatus, "sha_missing");
    assert.equal(missingShaProjection.packageIntegrity.status, "failed");
    assert.deepEqual(
      missingShaProjection.gate.hardFailures.map((failure) => [
        failure.code,
        failure.tarballStatus,
      ]),
      [["local_overlay_tarball_not_verified", "sha_missing"]],
    );
  } finally {
    rmSync(emptyOverlayRoot, { recursive: true, force: true });
    rmSync(missingShaRoot, { recursive: true, force: true });
  }
});

void test("agentos consumer integrity requires a current marker and exact tarball sha", async () => {
  const scenarios = [
    {
      name: "legacy marker without sha",
      artifact: undefined,
      sha256: undefined,
      expectedStatus: 1,
      expectedTruthMode: "legacy_local_overlay",
      expectedTarballStatus: "legacy_marker_unverified",
      expectedIntegrity: "failed",
      expectedGate: "fail",
    },
    {
      name: "current marker with exact sha",
      artifact: { kind: "install-manifest-overlay" },
      sha256: "exact",
      expectedStatus: 0,
      expectedTruthMode: "local_overlay",
      expectedTarballStatus: "verified",
      expectedIntegrity: "verified",
      expectedGate: "pass",
    },
    {
      name: "current marker with mismatched sha",
      artifact: { kind: "install-manifest-overlay" },
      sha256: "mismatch",
      expectedStatus: 1,
      expectedTruthMode: "local_overlay",
      expectedTarballStatus: "sha_mismatch",
      expectedIntegrity: "failed",
      expectedGate: "fail",
    },
  ];

  for (const scenario of scenarios) {
    const root = mkdtempSync(path.join(os.tmpdir(), "agentos-consumer-integrity-"));
    try {
      const packageName = "@example/runtime";
      const packageRoot = path.join(root, "node_modules", "@example", "runtime");
      mkdirSync(packageRoot, { recursive: true });
      writeFileSync(
        path.join(root, "package.json"),
        JSON.stringify(
          { name: "agentos-consumer-integrity", private: true, type: "module" },
          null,
          2,
        ),
      );
      writeFileSync(
        path.join(packageRoot, "package.json"),
        JSON.stringify(
          { name: packageName, version: agentOsReleaseVersion(), type: "module" },
          null,
          2,
        ),
      );
      const packed = writePackedPackageTarball(root, packageName);
      const packageRecord = {
        target: "node_modules/@example/runtime",
        tarball: packed.tarball,
        ...(scenario.sha256 === undefined
          ? {}
          : { sha256: scenario.sha256 === "exact" ? packed.sha256 : "0".repeat(64) }),
      };
      writeFileSync(
        path.join(root, "node_modules", ".agentos-local.json"),
        JSON.stringify(
          {
            schemaVersion: 1,
            generatedBy: "agentos consumer integrity test",
            installedAt: new Date().toISOString(),
            source: repoSourceIdentity(),
            packageVersion: agentOsReleaseVersion(),
            ...(scenario.artifact === undefined ? {} : { artifact: scenario.artifact }),
            consumerRoot: root,
            packages: { [packageName]: packageRecord },
          },
          null,
          2,
        ),
      );

      const checked = await runCli(["consumer", "check", root, "--json"]);
      assert.equal(checked.status, scenario.expectedStatus, `${scenario.name}: ${checked.stderr}`);
      const projection = JSON.parse(checked.stdout);
      assert.equal(projection.truthMode, scenario.expectedTruthMode, scenario.name);
      assert.equal(
        projection.localOverlay.packages[0]?.tarballStatus,
        scenario.expectedTarballStatus,
        scenario.name,
      );
      assert.equal(projection.packageIntegrity.status, scenario.expectedIntegrity, scenario.name);
      assert.equal(projection.gate.status, scenario.expectedGate, scenario.name);
      assert.deepEqual(
        projection.gate.hardFailures
          .filter((failure) => failure.dimension === "package_integrity")
          .map((failure) => [failure.code, failure.tarballStatus]),
        scenario.expectedGate === "pass"
          ? []
          : [["local_overlay_tarball_not_verified", scenario.expectedTarballStatus]],
        scenario.name,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

void test("agentos consumer check fails when a workspace package overlay is missing", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "agentos-consumer-workspace-"));
  try {
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify(
        { name: "agentos-consumer-workspace", private: true, packageManager: "pnpm@10.0.0" },
        null,
        2,
      ),
    );
    writeFileSync(path.join(root, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n");
    mkdirSync(path.join(root, "apps", "product-loop"), { recursive: true });
    writeFileSync(
      path.join(root, "apps", "product-loop", "package.json"),
      JSON.stringify({ name: "product-loop", private: true }, null, 2),
    );
    mkdirSync(path.join(root, "node_modules", "@yansirplus", "runtime"), { recursive: true });
    const runtimeExports = projectedPackedExportsFor("@yansirplus/runtime");
    writeFileSync(
      path.join(root, "node_modules", "@yansirplus", "runtime", "package.json"),
      JSON.stringify(
        { name: "@yansirplus/runtime", version: agentOsReleaseVersion(), exports: runtimeExports },
        null,
        2,
      ),
    );
    const packed = writePackedPackageTarball(root, "@yansirplus/runtime", {
      exports: runtimeExports,
    });
    writeFileSync(
      path.join(root, "node_modules", ".agentos-local.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          generatedBy: "agentos consumer test",
          installedAt: new Date().toISOString(),
          source: repoSourceIdentity(),
          packageVersion: agentOsReleaseVersion(),
          artifact: { kind: "install-manifest-overlay" },
          consumerRoot: root,
          packages: {
            "@yansirplus/runtime": {
              target: "node_modules/@yansirplus/runtime",
              tarball: packed.tarball,
              sha256: packed.sha256,
            },
          },
        },
        null,
        2,
      ),
    );

    const check = await runCli(["consumer", "check", root, "--json"]);
    assert.equal(check.status, 1);
    const projection = JSON.parse(check.stdout);
    assert.equal(projection.packageIntegrity.status, "verified");
    assert.equal(projection.workspaceOverlay.status, "failed");
    assert.deepEqual(
      projection.workspaceOverlay.roots.map((entry) => [entry.relativePath, entry.gate.status]),
      [
        [".", "pass"],
        ["apps/product-loop", "fail"],
      ],
    );
    assert.ok(
      projection.gate.hardFailures.some(
        (failure) =>
          failure.code === "workspace_consumer_root_failed" &&
          failure.relativePath === "apps/product-loop",
      ),
    );

    const doctor = await runCli(["consumer", "doctor", root, "--json"]);
    assert.equal(doctor.status, 0, doctor.stderr);
    const doctorProjection = JSON.parse(doctor.stdout);
    assert.equal(doctorProjection.projections.workspaceOverlay.status, "failed");
    assert.deepEqual(
      doctorProjection.projections.workspaceOverlay.roots.map((entry) => [
        entry.relativePath,
        entry.gate.status,
      ]),
      [
        [".", "pass"],
        ["apps/product-loop", "fail"],
      ],
    );
    assert.ok(
      doctorProjection.gate.hardFailures.some(
        (failure) =>
          failure.code === "workspace_consumer_root_failed" && failure.dimension === "consumer",
      ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test("agentos consumer install overlays discovered workspace package resolver roots", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "agentos-consumer-workspace-install-"));
  try {
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify(
        {
          name: "agentos-consumer-workspace-install",
          private: true,
          packageManager: "pnpm@10.0.0",
        },
        null,
        2,
      ),
    );
    writeFileSync(path.join(root, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n");
    mkdirSync(path.join(root, "apps", "product-loop"), { recursive: true });
    writeFileSync(
      path.join(root, "apps", "product-loop", "package.json"),
      JSON.stringify({ name: "product-loop", private: true }, null, 2),
    );
    mkdirSync(path.join(root, "node_modules"), { recursive: true });
    const packed = writePackedPackageTarball(root, "@yansirplus/runtime");
    const manifestPath = path.join(root, "install-manifest.json");
    writeFileSync(
      manifestPath,
      JSON.stringify(
        {
          protocol: "agentos-install-manifest@1",
          version: agentOsReleaseVersion(),
          generatedBy: "agentos consumer workspace install test",
          tarballs: {
            "@yansirplus/runtime": {
              spec: `file:${packed.tarball}`,
              sha256: packed.sha256,
            },
          },
        },
        null,
        2,
      ),
    );

    const install = await runCli([
      "consumer",
      "install",
      root,
      "--from-manifest",
      manifestPath,
      "--no-install",
      "--json",
    ]);

    assert.equal(install.status, 0, install.stderr);
    const projection = JSON.parse(install.stdout);
    assert.equal(projection.workspaceOverlay.status, "verified");
    assert.deepEqual(
      projection.workspaceOverlay.roots.map((entry) => [entry.relativePath, entry.gate.status]),
      [
        [".", "pass"],
        ["apps/product-loop", "pass"],
      ],
    );
    assert.equal(
      existsSync(path.join(root, "apps", "product-loop", "node_modules", ".agentos-local.json")),
      true,
    );
    assert.equal(
      existsSync(
        path.join(
          root,
          "apps",
          "product-loop",
          "node_modules",
          "@yansirplus",
          "runtime",
          "package.json",
        ),
      ),
      true,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test("agentos consumer check fails on packed-vs-installed export drift", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "agentos-consumer-export-drift-"));
  try {
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ name: "agentos-consumer-export-drift", private: true }, null, 2),
    );
    const packedExports = {
      ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
      "./extra": { types: "./dist/extra.d.ts", default: "./dist/extra.js" },
    };
    const installedExports = {
      ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
    };
    const packageRoot = path.join(root, "node_modules", "@example", "runtime");
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(
      path.join(packageRoot, "package.json"),
      JSON.stringify(
        { name: "@example/runtime", version: agentOsReleaseVersion(), exports: installedExports },
        null,
        2,
      ),
    );
    const packed = writePackedPackageTarball(root, "@example/runtime", { exports: packedExports });
    writeFileSync(
      path.join(root, "node_modules", ".agentos-local.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          generatedBy: "agentos consumer export drift test",
          installedAt: new Date().toISOString(),
          source: repoSourceIdentity(),
          packageVersion: agentOsReleaseVersion(),
          artifact: { kind: "install-manifest-overlay" },
          consumerRoot: root,
          packages: {
            "@example/runtime": {
              target: "node_modules/@example/runtime",
              tarball: packed.tarball,
              sha256: packed.sha256,
            },
          },
        },
        null,
        2,
      ),
    );

    const check = await runCli(["consumer", "check", root, "--json"]);
    assert.equal(check.status, 1);
    const projection = JSON.parse(check.stdout);
    assert.equal(projection.packageIntegrity.status, "verified");
    assert.equal(projection.exportEquivalence.status, "failed");
    assert.ok(
      projection.gate.hardFailures.some(
        (failure) =>
          failure.code === "export_packed_installed_subpath_drift" &&
          failure.dimension === "export_equivalence" &&
          failure.packageName === "@example/runtime" &&
          failure.missingSubpaths.includes("./extra"),
      ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test("agentos consumer restore uses the consumer package manager", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "agentos-consumer-restore-"));
  const fakeBin = mkdtempSync(path.join(os.tmpdir(), "agentos-fake-pm-"));
  try {
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify(
        { name: "agentos-consumer-restore", private: true, packageManager: "pnpm@10.0.0" },
        null,
        2,
      ),
    );
    writeFileSync(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");

    const packageRoot = path.join(root, "node_modules", "@agent-os", "runtime");
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(
      path.join(packageRoot, "package.json"),
      JSON.stringify({ name: "@agent-os/runtime" }, null, 2),
    );
    writeFileSync(
      path.join(root, "node_modules", ".agentos-local.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          packages: {
            "@agent-os/runtime": {
              target: "node_modules/@agent-os/runtime",
              tarball: "/tmp/agentos-runtime.tgz",
              sha256: "0".repeat(64),
            },
          },
        },
        null,
        2,
      ),
    );

    const fakePnpm = path.join(fakeBin, "pnpm");
    const sentinel = path.join(root, "pnpm-restore-args.txt");
    writeFileSync(fakePnpm, '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$AGENTOS_PNPM_SENTINEL"\n');
    chmodSync(fakePnpm, 0o755);

    const restored = await runCli(["consumer", "restore", root, "--json"], {
      env: {
        ...process.env,
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
        AGENTOS_PNPM_SENTINEL: sentinel,
      },
    });

    assert.equal(restored.status, 0, restored.stderr);
    assert.deepEqual(JSON.parse(restored.stdout).restoredPackages, ["@agent-os/runtime"]);
    assert.equal(existsSync(path.join(root, "package-lock.json")), false);
    assert.deepEqual(readFileSync(sentinel, "utf8").trim().split("\n"), [
      "install",
      "--frozen-lockfile",
      "--ignore-scripts",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(fakeBin, { recursive: true, force: true });
  }
});

void test("agentos release status reports source, artifacts, and npm without writes", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "agentos-release-status-"));
  const fakeBin = mkdtempSync(path.join(os.tmpdir(), "agentos-release-npm-"));
  try {
    const packed = writePackedPackageTarball(root, "@yansirplus/core");
    const manifestPath = path.join(root, "install-manifest.json");
    writeFileSync(
      manifestPath,
      JSON.stringify(
        {
          protocol: "agentos-install-manifest@1",
          version: agentOsReleaseVersion(),
          generatedBy: "agentos release status test",
          tarballs: {
            "@yansirplus/core": {
              spec: `file:${packed.tarball}`,
              sha256: packed.sha256,
            },
          },
        },
        null,
        2,
      ),
    );

    const fakeNpm = path.join(fakeBin, "npm");
    writeFileSync(
      fakeNpm,
      '#!/bin/sh\nprintf \'%s\\n\' \'{"latest":"0.5.18","agentos-dev":"0.5.18-dev.0"}\'\n',
    );
    chmodSync(fakeNpm, 0o755);

    const before = readFileSync(manifestPath, "utf8");
    const result = await runCli(
      ["release", "status", "--json", "--install-manifest", manifestPath, "--check-npm"],
      {
        env: {
          ...process.env,
          PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
        },
      },
    );

    assert.equal(result.status, 0, result.stderr);
    const status = JSON.parse(result.stdout);
    assert.equal(status.schemaVersion, 1);
    assert.equal(status.release.owner, "package.json#agentOsRelease");
    assert.equal(status.release.version, agentOsReleaseVersion());
    assert.equal(status.source.owner, "git");
    assert.equal(status.artifacts.owner, "dist/internal-npm/install-manifest.json");
    assert.equal(status.artifacts.status, "verified");
    assert.equal(status.artifacts.packages[0]?.status, "verified");
    assert.equal(status.artifacts.packages[0]?.packageNameReadback, "@yansirplus/core");
    assert.equal(status.artifacts.packages[0]?.packageVersion, agentOsReleaseVersion());
    assert.equal(status.npm.owner, "npm registry");
    assert.equal(status.npm.status, "checked");
    assert.equal(status.tag.name, `v${agentOsReleaseVersion()}`);
    assert.equal(status.tag.status, "missing");
    assert.equal(status.receipt.status, "not_issued");
    assert.equal(status.consumer, undefined);
    assert.equal(readFileSync(manifestPath, "utf8"), before);
    assert.equal(existsSync(path.join(root, ".agentos-release-truth.json")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(fakeBin, { recursive: true, force: true });
  }
});

void test("release status has no package.json version fallback", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "agentos-release-owner-"));
  try {
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ name: "agentos-owner-negative", version: "9.9.9" }, null, 2),
    );
    const status = releaseStatusData({ context: { sourceRoot: root } });
    assert.equal(status.release.owner, "package.json#agentOsRelease");
    assert.equal(status.release.version, undefined);
    assert.equal(status.receipt.expected.version, undefined);
    assert.ok(releaseTagAdmissionFailures(status).includes("release_version_missing"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test("agentos release status fails on source-vs-packed export drift", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "agentos-release-export-drift-"));
  try {
    const packed = writePackedPackageTarball(root, "@yansirplus/runtime", {
      exports: {
        ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
      },
    });
    const manifestPath = path.join(root, "install-manifest.json");
    writeFileSync(
      manifestPath,
      JSON.stringify(
        {
          protocol: "agentos-install-manifest@1",
          version: agentOsReleaseVersion(),
          generatedBy: "agentos release export drift test",
          tarballs: {
            "@yansirplus/runtime": {
              spec: `file:${packed.tarball}`,
              sha256: packed.sha256,
            },
          },
        },
        null,
        2,
      ),
    );

    const result = await runCli([
      "release",
      "status",
      "--json",
      "--install-manifest",
      manifestPath,
    ]);

    assert.equal(result.status, 0, result.stderr);
    const status = JSON.parse(result.stdout);
    assert.equal(status.artifacts.status, "verified");
    assert.equal(status.exportEquivalence.status, "failed");
    assert.equal(status.gate.status, "fail");
    assert.ok(
      status.gate.hardFailures.some(
        (failure) =>
          failure.code === "export_source_packed_subpath_drift" &&
          failure.dimension === "export_equivalence" &&
          failure.exportIssue.packageName === "@yansirplus/runtime" &&
          failure.exportIssue.missingSubpaths.includes("./external-effect"),
      ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test("agentos release status composes consumer projection without mutating consumer", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "agentos-release-consumer-"));
  try {
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ name: "agentos-release-consumer", private: true, type: "module" }, null, 2),
    );
    mkdirSync(path.join(root, "node_modules", "@yansirplus", "runtime"), { recursive: true });
    const runtimeExports = projectedPackedExportsFor("@yansirplus/runtime");
    writeFileSync(
      path.join(root, "node_modules", "@yansirplus", "runtime", "package.json"),
      JSON.stringify(
        { name: "@yansirplus/runtime", version: agentOsReleaseVersion(), exports: runtimeExports },
        null,
        2,
      ),
    );
    const packed = writePackedPackageTarball(root, "@yansirplus/runtime", {
      exports: runtimeExports,
    });
    writeFileSync(
      path.join(root, "node_modules", ".agentos-local.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          generatedBy: "agentos release status test",
          installedAt: new Date().toISOString(),
          source: repoSourceIdentity(),
          packageVersion: agentOsReleaseVersion(),
          artifact: { kind: "install-manifest-overlay" },
          consumerRoot: root,
          packages: {
            "@yansirplus/runtime": {
              target: "node_modules/@yansirplus/runtime",
              tarball: packed.tarball,
              sha256: packed.sha256,
            },
          },
        },
        null,
        2,
      ),
    );

    const packageBefore = readFileSync(path.join(root, "package.json"), "utf8");
    const consumerStatusResult = await runCli(["consumer", "status", root, "--json"]);
    const releaseStatusResult = await runCli(["release", "status", root, "--json"]);

    assert.equal(consumerStatusResult.status, 0, consumerStatusResult.stderr);
    assert.equal(releaseStatusResult.status, 0, releaseStatusResult.stderr);
    const consumerStatus = JSON.parse(consumerStatusResult.stdout);
    const releaseStatus = JSON.parse(releaseStatusResult.stdout);
    assert.deepEqual(releaseStatus.consumer.gate, consumerStatus.gate);
    assert.deepEqual(releaseStatus.consumer.packageIntegrity, consumerStatus.packageIntegrity);
    assert.equal(readFileSync(path.join(root, "package.json"), "utf8"), packageBefore);
    assert.equal(existsSync(path.join(root, "package-lock.json")), false);
    assert.equal(existsSync(path.join(root, ".agentos-release-truth.json")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test("agentos preflight llm reads explicit deployment provider bindings without leaking values", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "agentos-preflight-llm-"));
  const secret = "sk-agentos-preflight-secret";
  const endpoint = "https://llm.example.test/v1";
  const model = "agentos-test-model";
  const childEnv = { PATH: process.env.PATH ?? "" };
  try {
    writeWorkspaceProductFixture(root);
    writeDeploymentIntentFixture(root);
    writeFileSync(
      path.join(root, ".dev.vars"),
      [
        `AGENTOS_ENDPOINT_OPENROUTER=${endpoint}`,
        `AGENTOS_CREDENTIAL_OPENROUTER_KEY=${secret}`,
        `AGENTOS_MODEL_OPENROUTER_DEFAULT_TEXT_MODEL=${model}`,
        "",
      ].join("\n"),
    );

    const passing = await runCli(
      ["preflight", "llm", "--cwd", root, "--deployment", "agentos.deployment.jsonc", "--json"],
      { env: childEnv },
    );
    assert.equal(passing.status, 0, passing.stderr);
    assert.doesNotMatch(passing.stdout, new RegExp(secret));
    assert.doesNotMatch(passing.stdout, new RegExp(endpoint.replaceAll(".", "\\.")));
    assert.doesNotMatch(passing.stdout, new RegExp(model));
    const projection = JSON.parse(passing.stdout);
    assert.equal(projection.protocol, "agentos-preflight-llm@1");
    assert.equal(projection.ok, true);
    assert.deepEqual(projection.route, {
      bindingRef: "default",
      status: "present",
      kind: "openai-chat-compatible",
    });
    assert.deepEqual(
      projection.materials.map((row) => ({
        kind: row.kind,
        ref: row.ref,
        envName: row.envName,
        source: row.source,
        status: row.status,
      })),
      [
        {
          kind: "endpoint",
          ref: "openrouter",
          envName: "AGENTOS_ENDPOINT_OPENROUTER",
          source: ".dev.vars",
          status: "present",
        },
        {
          kind: "credential",
          ref: "openrouter-key",
          envName: "AGENTOS_CREDENTIAL_OPENROUTER_KEY",
          source: ".dev.vars",
          status: "present",
        },
        {
          kind: "model",
          ref: "openrouter-default-text-model",
          envName: "AGENTOS_MODEL_OPENROUTER_DEFAULT_TEXT_MODEL",
          source: ".dev.vars",
          status: "present",
        },
      ],
    );

    writeFileSync(
      path.join(root, ".dev.vars"),
      [
        `AGENTOS_ENDPOINT_OPENROUTER=${endpoint}`,
        `AGENTOS_MODEL_OPENROUTER_DEFAULT_TEXT_MODEL=${model}`,
        "",
      ].join("\n"),
    );
    const missingCredential = await runCli(
      ["preflight", "llm", "--cwd", root, "--deployment", "agentos.deployment.jsonc", "--json"],
      { env: childEnv },
    );
    assert.equal(missingCredential.status, 1);
    assert.equal(missingCredential.stderr, "");
    assert.doesNotMatch(missingCredential.stdout, new RegExp(endpoint.replaceAll(".", "\\.")));
    assert.doesNotMatch(missingCredential.stdout, new RegExp(model));
    const failedProjection = JSON.parse(missingCredential.stdout);
    assert.equal(failedProjection.ok, false);
    assert.equal(
      failedProjection.materials.find((row) => row.kind === "credential")?.status,
      "missing",
    );

    const wrongRoute = await runCli(
      [
        "preflight",
        "llm",
        "--cwd",
        root,
        "--deployment",
        "agentos.deployment.jsonc",
        "--route",
        "product_loop",
        "--json",
      ],
      { env: childEnv },
    );
    assert.equal(wrongRoute.status, 1);
    const wrongRouteProjection = JSON.parse(wrongRoute.stdout);
    assert.equal(wrongRouteProjection.route.status, "missing");
    assert.deepEqual(wrongRouteProjection.route.available, ["default"]);

    const namedSecret = "sk-agentos-product-loop-secret";
    const namedEndpoint = "https://product-loop.example.test/v1";
    const namedModel = "product-loop-test-model";
    writeDeploymentIntentFixture(
      root,
      nodeDeploymentIntent({
        providers: {
          ...nodeDeploymentIntent().providers,
          product_loop: {
            protocol: "openai-chat-compatible",
            endpointRef: "product-loop",
            credentialRef: "product-loop-key",
            modelRef: "product-loop-model",
          },
        },
      }),
    );
    writeFileSync(
      path.join(root, ".dev.vars"),
      [
        `AGENTOS_ENDPOINT_OPENROUTER=${endpoint}`,
        `AGENTOS_CREDENTIAL_OPENROUTER_KEY=${secret}`,
        `AGENTOS_MODEL_OPENROUTER_DEFAULT_TEXT_MODEL=${model}`,
        `AGENTOS_ENDPOINT_PRODUCT_LOOP=${namedEndpoint}`,
        `AGENTOS_CREDENTIAL_PRODUCT_LOOP_KEY=${namedSecret}`,
        `AGENTOS_MODEL_PRODUCT_LOOP_MODEL=${namedModel}`,
        "",
      ].join("\n"),
    );
    const namedRoute = await runCli(
      [
        "preflight",
        "llm",
        "--cwd",
        root,
        "--deployment",
        "agentos.deployment.jsonc",
        "--route",
        "product_loop",
        "--json",
      ],
      { env: childEnv },
    );
    assert.equal(namedRoute.status, 0, namedRoute.stderr);
    for (const value of [namedSecret, namedEndpoint, namedModel]) {
      assert.doesNotMatch(namedRoute.stdout, new RegExp(value.replaceAll(".", "\\.")));
    }
    const namedProjection = JSON.parse(namedRoute.stdout);
    assert.equal(namedProjection.ok, true);
    assert.deepEqual(namedProjection.route, {
      bindingRef: "product_loop",
      status: "present",
      kind: "openai-chat-compatible",
    });
    assert.deepEqual(
      namedProjection.materials.map((row) => ({
        kind: row.kind,
        ref: row.ref,
        envName: row.envName,
        source: row.source,
        status: row.status,
      })),
      [
        {
          kind: "endpoint",
          ref: "product-loop",
          envName: "AGENTOS_ENDPOINT_PRODUCT_LOOP",
          source: ".dev.vars",
          status: "present",
        },
        {
          kind: "credential",
          ref: "product-loop-key",
          envName: "AGENTOS_CREDENTIAL_PRODUCT_LOOP_KEY",
          source: ".dev.vars",
          status: "present",
        },
        {
          kind: "model",
          ref: "product-loop-model",
          envName: "AGENTOS_MODEL_PRODUCT_LOOP_MODEL",
          source: ".dev.vars",
          status: "present",
        },
      ],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test("ProductPlan binds independently to local and deployment hosts", () => {
  const result = runTypeScript(`
import {
  bindStaticTargetPlan,
  compileProductPlan,
  linkStaticTarget,
  localHost,
  renderStaticTargetPlan,
} from "./packages/cli/src/build/agent-authoring.ts";

const product = (agentId: string, kind: "chat" | "workspace") =>
  compileProductPlan({
    files: [
      {
        path: "agent/instructions.md",
        kind: "markdown" as const,
        text: "Answer from product-owned instructions.\\n",
      },
      {
        path: "agent/agent.json",
        kind: "json" as const,
        value: { agentId, kind, model: "primary" },
      },
    ],
  });

const workspace = product("workspace-product", "workspace");
const chat = product("chat-product", "chat");
if (!workspace.ok || !chat.ok) {
  console.log(JSON.stringify({ workspace, chat }));
  process.exit(0);
}

const summarize = (linked: ReturnType<typeof linkStaticTarget>) => {
  if (!linked.ok) return linked;
  const file = (path: string) => linked.value.files.find((candidate) => candidate.path === path);
  const local = file(".agentos/generated/local.ts")?.text;
  const target = file(".agentos/generated/target.ts")?.text;
  return {
    ok: true as const,
    paths: linked.value.files.map((candidate) => candidate.path),
    canonical: linked.value.canonicalDeployment,
    mount: linked.value.mount,
    manifest: JSON.parse(file(".agentos/generated/manifest.json")?.text ?? "null"),
    deployment: JSON.parse(file(".agentos/generated/deployment.json")?.text ?? "null"),
    modules: linked.value.moduleGraph.map((entry) => entry.source),
    local:
      local === undefined
        ? null
        : {
            sessionFacade: local.includes("const session = createAgentSession"),
            exportedApp: local.includes("export const createLocalAgentApp"),
          },
    target:
      target === undefined
        ? null
        : {
            lifecycleInstaller: /installCloudflareWorkspace(?:OperationProvider|JobProfile)/u.test(
              target,
            ),
          },
  };
};

const workspaceHost = localHost("ask", "/tmp/agentos-workspace-product", {});
const workspacePlan = bindStaticTargetPlan(workspace.value, workspaceHost, {
  packageScope: "@product-test",
});
const workspaceLink = linkStaticTarget(workspace.value, workspaceHost, {
  packageScope: "@product-test",
});
const chatLink = linkStaticTarget(
  chat.value,
  localHost("dev", "/tmp/agentos-chat-product", {}),
  { packageScope: "@product-test" },
);

const cloudflareDeployment = {
  kind: "deployment",
  release: { id: "cloud-product", version: "1.0.0" },
  target: {
    kind: "cloudflare-do",
    className: "AgentOS",
    binding: "AGENT_OS",
    materialResolver: "agent/material-resolver.ts",
  },
  transport: "svelte-kit-remote",
  providers: {
    primary: {
      protocol: "openai-chat-compatible",
      endpointRef: "provider-endpoint",
      credentialRef: "provider-credential",
      modelRef: "provider-model",
    },
  },
  workspace: { binding: "Sandbox", root: "/workspace" },
} as const;
const cloudLink = linkStaticTarget(workspace.value, cloudflareDeployment, {
  packageScope: "@product-test",
});
const unsupportedNodeSvelte = bindStaticTargetPlan(
  workspace.value,
  {
    ...cloudflareDeployment,
    target: { kind: "node" },
  },
  { packageScope: "@product-test" },
);
const { workspace: _workspace, ...deploymentWithoutWorkspace } = cloudflareDeployment;
const missingWorkspace = linkStaticTarget(workspace.value, deploymentWithoutWorkspace);
const unboundModel = linkStaticTarget(chat.value, {
  ...deploymentWithoutWorkspace,
  providers: {
    default: {
      protocol: "openai-chat-compatible",
      endpointRef: "provider-endpoint",
      credentialRef: "provider-credential",
      modelRef: "provider-model",
    },
  },
});
const digestMismatch = linkStaticTarget(
  { ...chat.value, agent: { ...chat.value.agent, id: "tampered" } },
  localHost("ask", "/tmp/agentos-chat-product", {}),
);

console.log(
  JSON.stringify({
    product: {
      workspace: workspace.value,
      chat: chat.value,
    },
    workspaceLocal: summarize(workspaceLink),
    chatLocal: summarize(chatLink),
    cloud: summarize(cloudLink),
    unsupportedNodeSvelte,
    planRendersLink:
      workspacePlan.ok &&
      workspaceLink.ok &&
      JSON.stringify(renderStaticTargetPlan(workspacePlan.value)) ===
        JSON.stringify(workspaceLink.value),
    missingWorkspace,
    unboundModel,
    digestMismatch,
  }),
);
`);

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.product.workspace.agent.kind, "workspace");
  assert.equal(output.product.chat.agent.kind, "chat");
  assert.deepEqual(output.product.workspace.symbolicRequirements, [
    { kind: "model" },
    { kind: "workspace" },
  ]);
  assert.equal(output.planRendersLink, true);

  assert.equal(output.workspaceLocal.ok, true, JSON.stringify(output.workspaceLocal));
  assert.equal(output.workspaceLocal.canonical.target, "node@1");
  assert.equal(output.workspaceLocal.canonical.client, "direct");
  assert.equal(output.workspaceLocal.mount.driver.kind, "local-node");
  assert.ok(output.workspaceLocal.mount.projectionSinks.includes("workspace.files"));
  assert.ok(output.workspaceLocal.paths.includes(".agentos/generated/local.ts"));
  assert.equal(output.workspaceLocal.local.sessionFacade, true);
  assert.equal(output.workspaceLocal.local.exportedApp, true);
  assert.equal(output.workspaceLocal.deployment.workspace.root, "/tmp/agentos-workspace-product");

  assert.equal(output.chatLocal.ok, true, JSON.stringify(output.chatLocal));
  assert.equal(output.chatLocal.canonical.target, "node@1");
  assert.equal(output.chatLocal.local.sessionFacade, true);
  assert.equal("workspace" in output.chatLocal.deployment, false);
  assert.equal(output.chatLocal.mount.projectionSinks.includes("workspace.files"), false);

  assert.equal(output.cloud.ok, true, JSON.stringify(output.cloud));
  assert.equal(output.cloud.canonical.target, "cloudflare-do@1");
  assert.equal(output.cloud.canonical.client, "svelte-kit-remote");
  assert.ok(output.cloud.paths.includes(".agentos/generated/target.ts"));
  assert.ok(output.cloud.paths.includes(".agentos/generated/wrangler.jsonc"));
  assert.equal(output.cloud.target.lifecycleInstaller, false);
  assert.ok(output.cloud.modules.includes("../../agent/material-resolver"));

  assert.deepEqual(output.unsupportedNodeSvelte, {
    ok: false,
    issues: [
      {
        kind: "unsupported_static_combination",
        profile: "workspace",
        target: "node@1",
        client: "svelte-kit-remote",
      },
    ],
  });

  assert.deepEqual(output.missingWorkspace, {
    ok: false,
    issues: [{ kind: "workspace_binding_required", host: "deployment" }],
  });
  assert.deepEqual(output.unboundModel, {
    ok: false,
    issues: [{ kind: "model_provider_unbound", logicalId: "primary" }],
  });
  assert.deepEqual(output.digestMismatch, {
    ok: false,
    issues: [{ kind: "product_digest_mismatch" }],
  });
});

void test("compileProductPlan enforces packaged skill identity and resource bounds", () => {
  const result = runTypeScript(`
import { compileProductPlan } from "./packages/cli/src/build/agent-authoring.ts";

const utf8 = (text: string) => new TextEncoder().encode(text);
const base = [
  {
    path: "agent/instructions.md",
    kind: "markdown" as const,
    text: "Use only validated product assets.\\n",
  },
  {
    path: "agent/agent.json",
    kind: "json" as const,
    value: { agentId: "skill-product", kind: "chat" },
  },
];
const packaged = {
  path: "agent/skills/review/SKILL.md",
  kind: "markdown" as const,
  text: "---\\nname: review\\ndescription: Review facts.\\n---\\nReview carefully.\\n",
};
const compile = (...files: ReadonlyArray<unknown>) =>
  compileProductPlan({ files: [...base, ...files] as never });

const results = {
  validBinary: compile(
    packaged,
    {
      path: "agent/skills/review/assets/icon.bin",
      kind: "resource" as const,
      bytes: new Uint8Array([0, 255, 1]),
    },
  ),
  identityMismatch: compile({
    path: "agent/skills/echo.md",
    kind: "markdown" as const,
    text: "---\\nname: other\\ndescription: Echo facts.\\n---\\nEcho.\\n",
  }),
  supportWithoutPackage: compile({
    path: "agent/skills/echo/references/ref.md",
    kind: "resource" as const,
    bytes: utf8("reference"),
  }),
  nonNormalizedPath: compile({
    path: "agent/skills/review/references/../secret.md",
    kind: "resource" as const,
    bytes: utf8("secret"),
  }),
  symlink: compile(
    packaged,
    {
      path: "agent/skills/review/references/ref.md",
      kind: "resource" as const,
      bytes: new Uint8Array(),
      sourceKind: "symlink" as const,
    },
  ),
  oversized: compile(
    packaged,
    {
      path: "agent/skills/review/references/ref.md",
      kind: "resource" as const,
      bytes: utf8("x".repeat(65_537)),
    },
  ),
  duplicate: compile(
    {
      path: "agent/skills/echo.md",
      kind: "markdown" as const,
      text: "---\\nname: echo\\ndescription: Echo one.\\n---\\nOne.\\n",
    },
    {
      path: "agent/skills/echo/SKILL.md",
      kind: "markdown" as const,
      text: "---\\nname: echo\\ndescription: Echo two.\\n---\\nTwo.\\n",
    },
  ),
  reservedTool: compile({
    path: "agent/tools/load_skill.ts",
    kind: "tool" as const,
    declaration: {},
  }),
};
console.log(JSON.stringify(results));
`);

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.validBinary.ok, true, JSON.stringify(output.validBinary));
  assert.deepEqual(output.validBinary.value.assets.skills[0].files, [
    {
      path: "assets/icon.bin",
      digest: "fnv1a32:f38f4273:3",
      bytes: 3,
      contentBase64: "AP8B",
    },
  ]);

  const issue = (name, kind, reason) => {
    assert.equal(output[name].ok, false, name);
    assert.ok(
      output[name].issues.some(
        (candidate) =>
          candidate.kind === kind && (reason === undefined || candidate.reason === reason),
      ),
      `${name}: ${JSON.stringify(output[name].issues)}`,
    );
  };
  issue("identityMismatch", "skill_identity_mismatch");
  issue("supportWithoutPackage", "unsupported_path", "skill_support_requires_packaged_skill");
  issue("nonNormalizedPath", "unsupported_path", "path_not_normalized");
  issue("symlink", "unsupported_path", "symlink_forbidden");
  issue("oversized", "invalid_authored_value", "skill_file_too_large");
  issue("duplicate", "duplicate_skill");
  issue("reservedTool", "reserved_tool_name");
});

void test("linkStaticTarget lowers product assets into one deterministic generated module graph", () => {
  const result = runTypeScript(`
import {
  compileProductPlan,
  linkStaticTarget,
  localHost,
} from "./packages/cli/src/build/agent-authoring.ts";

const compiled = compileProductPlan({
  files: [
    {
      path: "agent/instructions.md",
      kind: "markdown" as const,
      text: "Use the authored product assets.\\n",
    },
    {
      path: "agent/agent.json",
      kind: "json" as const,
      value: { agentId: "asset-product", kind: "workspace", tools: ["echo"] },
    },
    { path: "agent/tools/echo.ts", kind: "tool" as const, declaration: {} },
    {
      path: "agent/skills/review/SKILL.md",
      kind: "markdown" as const,
      text: "---\\nname: review\\ndescription: Review facts.\\n---\\nReview carefully.\\n",
    },
    {
      path: "agent/instructions/tone.md",
      kind: "markdown" as const,
      text: "Use a terse tone.\\n",
    },
    {
      path: "agent/skills/session.dynamic.ts",
      kind: "dynamic" as const,
      declaration: { outputs: { skills: ["review"] } },
    },
    { path: "agent/channels/github.ts", kind: "channel" as const },
    { path: "workflows/report.ts", kind: "workflow" as const },
    {
      path: "agent/schedules/daily.ts",
      kind: "schedule" as const,
      declaration: { cron: "0 9 * * *", handler: () => undefined },
    },
  ],
});
const linked = compiled.ok
  ? linkStaticTarget(compiled.value, localHost("dev", "/tmp/asset-product", {}), {
      packageScope: "@asset-test",
    })
  : compiled;
if (!linked.ok) {
  console.log(JSON.stringify(linked));
  process.exit(0);
}
const files = Object.fromEntries(linked.value.files.map((file) => [file.path, file.text]));
const sourceCounts = Object.fromEntries(
  [...new Set(linked.value.moduleGraph.map((entry) => entry.source))].map((source) => [
    source,
    linked.value.moduleGraph.filter((entry) => entry.source === source).length,
  ]),
);
console.log(
  JSON.stringify({
    ok: true,
    paths: Object.keys(files),
    sources: linked.value.moduleGraph.map((entry) => entry.source),
    sourceCounts,
    skills: JSON.parse(files[".agentos/generated/skill-resources.json"]),
    markers: {
      customTool: files[".agentos/generated/local.ts"].includes("../../agent/tools/echo"),
      loadSkill: files[".agentos/generated/local.ts"].includes("load_skill"),
      readSkillFile: files[".agentos/generated/local.ts"].includes("read_skill_file"),
      skillCatalog: files[".agentos/generated/local.ts"].includes('"name":"review"'),
      dynamicResolver: files[".agentos/generated/local.ts"].includes(
        "../../agent/skills/session.dynamic",
      ),
      channel: files[".agentos/generated/channels.ts"].includes(
        "../../agent/channels/github",
      ),
      schedule: files[".agentos/generated/schedules.ts"].includes(
        "../../agent/schedules/daily",
      ),
    },
  }),
);
`);

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, true, JSON.stringify(output));
  for (const generated of [
    ".agentos/generated/skill-resources.json",
    ".agentos/generated/channels.ts",
    ".agentos/generated/schedules.ts",
    ".agentos/generated/local.ts",
  ]) {
    assert.ok(output.paths.includes(generated), generated);
  }
  assert.deepEqual(output.markers, {
    customTool: true,
    loadSkill: true,
    readSkillFile: true,
    skillCatalog: true,
    dynamicResolver: true,
    channel: true,
    schedule: true,
  });
  assert.deepEqual(output.skills, {});
  for (const authoredSource of [
    "../../agent/tools/echo",
    "../../agent/skills/session.dynamic",
    "../../agent/channels/github",
    "../../agent/schedules/daily",
  ]) {
    assert.equal(output.sourceCounts[authoredSource], 1, authoredSource);
  }
});

void test("agentos build compiles two-file product intent against an explicit deployment", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "agentos-product-build-"));
  try {
    writeWorkspaceProductFixture(root);
    writeDeploymentIntentFixture(root);

    const missingDeployment = await runCli(["build", "--cwd", root]);
    assert.equal(missingDeployment.status, 1);
    assert.match(missingDeployment.stderr, /--deployment is required/u);
    assert.equal(existsSync(path.join(root, ".agentos/generated")), false);

    const args = [
      "build",
      "--cwd",
      root,
      "--deployment",
      "agentos.deployment.jsonc",
      "--package-scope",
      "@product-test",
    ];
    const built = await runCli(args);
    assert.equal(built.status, 0, built.stderr);
    assert.match(built.stdout, /^generated \d+ agentOS files\s*$/u);

    const generated = path.join(root, ".agentos/generated");
    const expectedPaths = [
      "deployment.json",
      "fingerprints.json",
      "local.ts",
      "manifest.json",
      "provenance.json",
    ];
    for (const relative of expectedPaths) {
      assert.equal(existsSync(path.join(generated, relative)), true, relative);
    }

    const manifest = JSON.parse(readFileSync(path.join(generated, "manifest.json"), "utf8"));
    const deployment = JSON.parse(readFileSync(path.join(generated, "deployment.json"), "utf8"));
    const local = readFileSync(path.join(generated, "local.ts"), "utf8");
    assert.equal(manifest.agentId, "node-local-agent");
    assert.equal(manifest.scope.stableScopeId, "node-local-agent");
    assert.deepEqual(Object.keys(manifest.tools).sort(), workspaceDefaultToolNames);
    assert.equal(deployment.deploymentId, "node-local-deployment");
    assert.equal(deployment.backend, "node");
    assert.equal(deployment.adapter, "node@1");
    assert.equal(deployment.workspace.root, "/workspace");
    assert.match(local, /const session = createAgentSession/u);
    assert.match(local, /export const createLocalAgentApp/u);

    const first = Object.fromEntries(
      expectedPaths.map((relative) => [
        relative,
        readFileSync(path.join(generated, relative), "utf8"),
      ]),
    );
    const rebuilt = await runCli(args);
    assert.equal(rebuilt.status, 0, rebuilt.stderr);
    const second = Object.fromEntries(
      expectedPaths.map((relative) => [
        relative,
        readFileSync(path.join(generated, relative), "utf8"),
      ]),
    );
    assert.deepEqual(second, first);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test("agentos info binds either LocalHost or DeploymentIntent without writing generated files", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "agentos-product-info-"));
  try {
    writeWorkspaceProductFixture(root);
    writeDeploymentIntentFixture(root);

    const local = await runCli(["info", "--cwd", root, "--json"]);
    assert.equal(local.status, 0, local.stderr);
    const localInfo = JSON.parse(local.stdout);
    assert.deepEqual(localInfo.compile.agent, {
      id: "node-local-agent",
      kind: "workspace",
    });
    assert.equal(localInfo.compile.deployment.kind, "local");
    assert.equal(localInfo.compile.deployment.id, "local-node-local-agent");
    assert.equal(localInfo.compile.generated.canonicalDeployment.target, "node@1");
    assert.equal(localInfo.compile.generated.canonicalDeployment.client, "direct");
    assert.equal(existsSync(path.join(root, ".agentos/generated")), false);

    const deployed = await runCli([
      "info",
      "--cwd",
      root,
      "--deployment",
      "agentos.deployment.jsonc",
      "--json",
    ]);
    assert.equal(deployed.status, 0, deployed.stderr);
    const deployedInfo = JSON.parse(deployed.stdout);
    assert.deepEqual(deployedInfo.compile.agent, localInfo.compile.agent);
    assert.equal(deployedInfo.compile.deployment.kind, "deployment");
    assert.equal(deployedInfo.compile.deployment.id, "node-local-deployment");
    assert.equal(deployedInfo.compile.generated.canonicalDeployment.target, "node@1");
    assert.equal(existsSync(path.join(root, ".agentos/generated")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
