import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  consumerStatusData,
  exportEquivalenceForInstallManifest,
  resolveConsumerRoot,
} from "./consumer-overlay.mjs";
import {
  createAnnotatedReleaseTag,
  releaseReceiptProjection,
  releaseTagProjection,
  runReleaseFullGate,
} from "./release-receipt.mjs";

const releaseStatusSchemaVersion = 1;

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

const sha256File = (file) =>
  crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

const parseArgs = (args) => {
  const parsed = { _: [] };
  const booleanKeys = new Set(["json", "check-npm"]);
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

const boolArg = (args, name) => args[name] === true || args[name] === "true";

const gitValue = (cwd, args) => {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) return undefined;
  const value = result.stdout.trim();
  return value.length === 0 ? undefined : value;
};

const gitSourceProjection = (sourceRoot) => {
  if (typeof sourceRoot !== "string") {
    return {
      owner: "git",
      status: "unavailable",
      reason: "source checkout identity is unavailable in this CLI installation",
    };
  }
  const branch = gitValue(sourceRoot, ["branch", "--show-current"]) ?? "unknown";
  const head = gitValue(sourceRoot, ["rev-parse", "HEAD"]) ?? "unknown";
  const statusShort = gitValue(sourceRoot, ["status", "--short"]);
  const dirty = statusShort === undefined ? undefined : statusShort.length !== 0;
  const upstreamRef = gitValue(sourceRoot, [
    "rev-parse",
    "--abbrev-ref",
    "--symbolic-full-name",
    "@{upstream}",
  ]);
  let upstream = { status: "not_configured" };
  if (upstreamRef !== undefined) {
    const counts = gitValue(sourceRoot, [
      "rev-list",
      "--left-right",
      "--count",
      `${upstreamRef}...HEAD`,
    ]);
    const [behindRaw, aheadRaw] = counts?.split(/\s+/u) ?? [];
    upstream = {
      status: "configured",
      ref: upstreamRef,
      ahead: Number(aheadRaw ?? 0),
      behind: Number(behindRaw ?? 0),
    };
  }
  return {
    owner: "git",
    status: "available",
    repoRoot: sourceRoot,
    branch,
    head,
    dirty: dirty ?? false,
    upstream,
  };
};

const releasePackagePath = (context) => {
  const sourcePackage = path.join(context.sourceRoot ?? "", "package.json");
  if (typeof context.sourceRoot === "string" && fs.existsSync(sourcePackage)) return sourcePackage;
  return path.join(context.packageRoot ?? process.cwd(), "package.json");
};

const releaseIdentityProjection = (context) => {
  const packagePath = releasePackagePath(context);
  const manifest = readJson(packagePath);
  const packageName = typeof manifest.name === "string" ? manifest.name : undefined;
  const packageScope = packageName?.startsWith("@") ? packageName.split("/")[0] : undefined;
  return {
    owner: "package.json#agentOsRelease",
    packageJson: packagePath,
    packageName,
    version:
      typeof manifest.agentOsRelease?.version === "string"
        ? manifest.agentOsRelease.version
        : manifest.version,
    npmScope:
      typeof manifest.agentOsRelease?.npmScope === "string"
        ? manifest.agentOsRelease.npmScope
        : packageScope,
    npmAccess: manifest.agentOsRelease?.npmAccess,
  };
};

const sourcePackageScope = "@agent-os";

const publicPackageName = (sourceName, npmScope) => {
  if (typeof npmScope !== "string" || !sourceName.startsWith(`${sourcePackageScope}/`)) {
    return sourceName;
  }
  return `${npmScope}/${sourceName.slice(sourcePackageScope.length + 1)}`;
};

const publishedPackagesProjection = (context, release) => {
  const surfacePath =
    typeof context.sourceRoot === "string"
      ? path.join(context.sourceRoot, "docs", "surface.json")
      : undefined;
  if (surfacePath === undefined || !fs.existsSync(surfacePath)) {
    return [];
  }
  const surface = readJson(surfacePath);
  return (surface.packages ?? [])
    .filter((pkg) => pkg?.published === true && typeof pkg.name === "string")
    .map((pkg) => ({
      sourceName: pkg.name,
      publicName: publicPackageName(pkg.name, release.npmScope),
      path: pkg.path,
      status: pkg.status,
    }))
    .sort((left, right) => left.publicName.localeCompare(right.publicName));
};

const fileSpecPath = (spec) => {
  if (typeof spec !== "string" || !spec.startsWith("file:")) return undefined;
  return spec.slice("file:".length);
};

const tarballPackageIdentity = (tarball) => {
  if (typeof tarball !== "string" || !fs.existsSync(tarball)) return undefined;
  const result = spawnSync("tar", ["-xOf", tarball, "package/package.json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) return undefined;
  try {
    const manifest = JSON.parse(result.stdout);
    return typeof manifest.name === "string" && typeof manifest.version === "string"
      ? { name: manifest.name, version: manifest.version }
      : undefined;
  } catch {
    return undefined;
  }
};

const artifactProjection = (manifestPath) => {
  const base = {
    owner: "dist/internal-npm/install-manifest.json",
    path: manifestPath,
  };
  if (typeof manifestPath !== "string") {
    return { ...base, status: "unavailable", packages: [] };
  }
  if (!fs.existsSync(manifestPath)) {
    return { ...base, status: "missing", packages: [] };
  }
  try {
    const manifest = readJson(manifestPath);
    const packages = Object.entries(manifest.tarballs ?? {})
      .map(([packageName, entry]) => {
        const tarball = fileSpecPath(entry?.spec);
        const expectedSha = typeof entry?.sha256 === "string" ? entry.sha256 : undefined;
        const exists = typeof tarball === "string" && fs.existsSync(tarball);
        const actualSha = exists ? sha256File(tarball) : undefined;
        const packageIdentity = tarballPackageIdentity(tarball);
        const status =
          tarball === undefined || expectedSha === undefined
            ? "invalid"
            : !exists
              ? "missing"
              : actualSha === expectedSha
                ? "verified"
                : "sha_mismatch";
        return {
          packageName,
          tarball,
          expectedSha256: expectedSha,
          actualSha256: actualSha,
          packageNameReadback: packageIdentity?.name,
          packageVersion: packageIdentity?.version,
          status,
        };
      })
      .sort((left, right) => left.packageName.localeCompare(right.packageName));
    const protocolOk = manifest.protocol === "agentos-install-manifest@1";
    const status =
      protocolOk && packages.length > 0 && packages.every((pkg) => pkg.status === "verified")
        ? "verified"
        : "failed";
    return {
      ...base,
      status,
      sha256: sha256File(manifestPath),
      protocol: manifest.protocol,
      version: manifest.version,
      generatedBy: manifest.generatedBy,
      packages,
    };
  } catch (error) {
    return {
      ...base,
      status: "failed",
      packages: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
};

const releaseExportEquivalenceProjection = (manifestPath, context) => {
  if (typeof manifestPath !== "string" || !fs.existsSync(manifestPath)) {
    return {
      status: "not_checked",
      packagesChecked: 0,
      packages: [],
      failures: [],
      reason: "install manifest is unavailable",
    };
  }
  try {
    const manifest = readJson(manifestPath);
    return exportEquivalenceForInstallManifest(manifest, { sourceRoot: context.sourceRoot });
  } catch (error) {
    return {
      status: "failed",
      packagesChecked: 0,
      packages: [],
      failures: [
        {
          code: "export_install_manifest_unreadable",
          comparison: "manifest",
          error: error instanceof Error ? error.message : String(error),
        },
      ],
    };
  }
};

const npmProjection = (packages, options) => {
  if (options.checkNpm !== true) {
    return {
      owner: "npm registry",
      status: "not_checked",
      reason: "pass --check-npm to observe npm dist-tags",
    };
  }
  const registry = typeof options.registry === "string" ? options.registry : undefined;
  const rows = {};
  for (const pkg of packages) {
    const args = ["view", pkg.publicName, "dist-tags", "--json"];
    if (registry !== undefined && registry.length > 0) args.push("--registry", registry);
    const result = spawnSync("npm", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.status !== 0) {
      rows[pkg.publicName] = {
        status: "unresolved",
        detail: result.stderr.trim() || result.stdout.trim(),
      };
      continue;
    }
    try {
      rows[pkg.publicName] = {
        status: "resolved",
        distTags: JSON.parse(result.stdout.trim()),
      };
    } catch (error) {
      rows[pkg.publicName] = {
        status: "invalid_json",
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }
  return {
    owner: "npm registry",
    status: "checked",
    ...(registry === undefined ? {} : { registry }),
    packages: rows,
  };
};

const issue = (code, severity, dimension, message, detail = {}) => ({
  code,
  severity,
  dimension,
  message,
  ...detail,
});

const releaseGate = (projection) => {
  const hardFailures = [];
  const signals = [];
  if (projection.receipt?.status === "failed") {
    hardFailures.push(
      issue(
        "release_receipt_failed",
        "hard",
        "release_receipt",
        "annotated release receipt disagrees with current owner facts",
        { receiptFailures: projection.receipt.failures },
      ),
    );
  }
  if (projection.artifacts.status === "failed") {
    hardFailures.push(
      issue(
        "local_artifacts_failed",
        "hard",
        "artifacts",
        "local package artifacts failed integrity checks",
      ),
    );
  } else if (projection.artifacts.status !== "verified") {
    signals.push(
      issue(
        "local_artifacts_not_verified",
        "signal",
        "artifacts",
        `local package artifacts are ${projection.artifacts.status}`,
      ),
    );
  }
  for (const failure of projection.exportEquivalence?.failures ?? []) {
    hardFailures.push(
      issue(
        failure.code,
        "hard",
        "export_equivalence",
        `release export equivalence failed: ${failure.code}`,
        { exportIssue: failure },
      ),
    );
  }
  if (projection.source.status !== "available") {
    signals.push(
      issue("source_unavailable", "signal", "source", "source checkout identity is unavailable"),
    );
  } else {
    if (projection.source.dirty === true) {
      signals.push(
        issue("source_dirty", "signal", "source", "source checkout has uncommitted changes"),
      );
    }
    if (
      projection.source.upstream?.status === "configured" &&
      projection.source.upstream.ahead > 0
    ) {
      signals.push(
        issue("source_ahead", "signal", "source", "source checkout is ahead of upstream", {
          ahead: projection.source.upstream.ahead,
          upstream: projection.source.upstream.ref,
        }),
      );
    }
    if (
      projection.source.upstream?.status === "configured" &&
      projection.source.upstream.behind > 0
    ) {
      signals.push(
        issue("source_behind", "signal", "source", "source checkout is behind upstream", {
          behind: projection.source.upstream.behind,
          upstream: projection.source.upstream.ref,
        }),
      );
    }
  }
  if (projection.npm.status === "not_checked") {
    signals.push(issue("npm_not_checked", "signal", "npm", "npm dist-tags were not checked"));
  } else if (projection.npm.status === "checked") {
    for (const [packageName, row] of Object.entries(projection.npm.packages ?? {})) {
      if (row.status !== "resolved") {
        signals.push(
          issue(
            "npm_unresolved",
            "signal",
            "npm",
            `${packageName} npm dist-tags were not resolved`,
            {
              packageName,
              status: row.status,
            },
          ),
        );
      }
    }
  }
  if (projection.consumer === undefined) {
    signals.push(
      issue("consumer_not_checked", "signal", "consumer", "no consumer root was provided"),
    );
  } else {
    for (const failure of projection.consumer.gate?.hardFailures ?? []) {
      hardFailures.push(
        issue(
          failure.code,
          "hard",
          "consumer",
          failure.message ?? `consumer gate failed: ${failure.code}`,
          { consumerIssue: failure },
        ),
      );
    }
    for (const signal of projection.consumer.gate?.signals ?? []) {
      signals.push(
        issue(
          signal.code,
          "signal",
          "consumer",
          signal.message ?? `consumer gate signal: ${signal.code}`,
          { consumerIssue: signal },
        ),
      );
    }
  }
  return {
    status: hardFailures.length > 0 ? "fail" : signals.length > 0 ? "warn" : "pass",
    hardFailures,
    signals,
  };
};

export const releaseStatusData = (input = {}) => {
  const context = input.context ?? {};
  const release = releaseIdentityProjection(context);
  const packages = publishedPackagesProjection(context, release);
  const manifestPath = input.installManifestPath ?? context.defaultInstallManifestPath;
  const facts = {
    schemaVersion: releaseStatusSchemaVersion,
    release: {
      ...release,
      packages,
    },
    source: gitSourceProjection(context.sourceRoot),
    artifacts: artifactProjection(manifestPath),
    exportEquivalence: releaseExportEquivalenceProjection(manifestPath, context),
    npm: npmProjection(packages, {
      checkNpm: input.checkNpm,
      registry: input.registry,
    }),
    ...(input.consumerRoot === undefined
      ? {}
      : {
          consumer: consumerStatusData(input.consumerRoot, {
            packageRoot: context.packageRoot,
            sourceRoot: context.sourceRoot,
            checkNpm: input.checkNpm,
            registry: input.registry,
          }),
        }),
  };
  const projection = {
    ...facts,
    tag: releaseTagProjection(context.sourceRoot, release.version),
  };
  const receipt = releaseReceiptProjection(projection);
  return {
    ...projection,
    receipt,
    gate: releaseGate({ ...projection, receipt }),
  };
};

const printReleaseStatus = (status) => {
  console.log(`release version: ${status.release.version}`);
  console.log(`npm scope: ${status.release.npmScope ?? "unknown"}`);
  console.log(`source: ${status.source.status}`);
  if (status.source.status === "available") {
    console.log(
      `source head: ${status.source.branch}@${status.source.head} dirty=${status.source.dirty}`,
    );
    if (status.source.upstream?.status === "configured") {
      console.log(
        `source upstream: ${status.source.upstream.ref} ahead=${status.source.upstream.ahead} behind=${status.source.upstream.behind}`,
      );
    }
  }
  console.log(`artifacts: ${status.artifacts.status}`);
  console.log(`export equivalence: ${status.exportEquivalence.status}`);
  console.log(`npm: ${status.npm.status}`);
  console.log(`tag: ${status.tag.status}`);
  console.log(`receipt: ${status.receipt.status}`);
  console.log(`consumer: ${status.consumer?.truthMode ?? "not_checked"}`);
  console.log(`gate: ${status.gate.status}`);
  for (const failure of status.gate.hardFailures) {
    console.log(`failure ${failure.code}: ${failure.message}`);
  }
  for (const signal of status.gate.signals) {
    console.log(`signal ${signal.code}: ${signal.message}`);
  }
};

export const releaseStatus = (rawArgs, context = {}) => {
  const args = parseArgs(rawArgs);
  const positional = args._ ?? [];
  if (positional.length > 1) {
    throw new Error("agentos release status: expected at most one consumer path");
  }
  const consumerRoot = positional[0] === undefined ? undefined : resolveConsumerRoot(positional[0]);
  const installManifestPath =
    typeof args["install-manifest"] === "string"
      ? path.resolve(process.cwd(), args["install-manifest"])
      : undefined;
  const status = releaseStatusData({
    context,
    consumerRoot,
    installManifestPath,
    checkNpm: boolArg(args, "check-npm"),
    registry: typeof args.registry === "string" ? args.registry : undefined,
  });
  if (boolArg(args, "json")) {
    console.log(JSON.stringify(status, null, 2));
  } else {
    printReleaseStatus(status);
  }
};

export const releaseTag = (rawArgs, context = {}) => {
  const args = parseArgs(rawArgs);
  const positional = args._ ?? [];
  if (positional.length > 0) throw new Error("agentos release tag: expected no positional paths");
  if (typeof context.sourceRoot !== "string") {
    throw new Error("agentos release tag: source checkout identity is unavailable");
  }
  const installManifestPath =
    typeof args["install-manifest"] === "string"
      ? path.resolve(process.cwd(), args["install-manifest"])
      : undefined;
  runReleaseFullGate(context.sourceRoot);
  const status = releaseStatusData({
    context,
    installManifestPath,
    checkNpm: true,
    registry: typeof args.registry === "string" ? args.registry : undefined,
  });
  const created = createAnnotatedReleaseTag(context.sourceRoot, status);
  if (boolArg(args, "json")) {
    console.log(JSON.stringify(created, null, 2));
  } else {
    console.log(`created annotated release tag ${created.tag.name}@${created.tag.commit}`);
  }
};
