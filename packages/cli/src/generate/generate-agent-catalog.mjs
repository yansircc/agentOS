#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { walkRepoSourceFiles } from "../lib/repo-source-files.mjs";

const repoRoot = process.cwd();
const catalogRoot = path.join(repoRoot, "agent-catalog", "agentOS");
const check = process.argv.includes("--check");
const sourcePackageScope = "@agent-os";

const fail = (message) => {
  console.error(message);
  process.exit(1);
};

const toPosix = (value) => value.split(path.sep).join("/");
const repoPath = (file) => toPosix(path.relative(repoRoot, file));
const abs = (file) => path.join(repoRoot, file);

const read = (file) => fs.readFileSync(abs(file), "utf8");
const readJson = (file) => JSON.parse(read(file));
const sha256 = (text) => crypto.createHash("sha256").update(text).digest("hex");

const rootPackage = readJson("package.json");
const releaseLine = (() => {
  const version = rootPackage.agentOsRelease?.version;
  return typeof version === "string" && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)
    ? `${version.split(".").slice(0, 2).join(".")}.x`
    : undefined;
})();
const expandReleaseTokens = (value) => {
  if (typeof value === "string") {
    return releaseLine === undefined ? value : value.replaceAll("{releaseLine}", releaseLine);
  }
  if (Array.isArray(value)) return value.map(expandReleaseTokens);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, expandReleaseTokens(entry)]),
    );
  }
  return value;
};
const surface = expandReleaseTokens(readJson("docs/surface.json"));

const releaseVersion = () => {
  const version = rootPackage.agentOsRelease?.version;
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) {
    fail("package.json agentOsRelease.version must be a semver string");
  }
  return version;
};

const publishScope = () => {
  const scope =
    process.env.AGENTOS_NPM_SCOPE ?? rootPackage.agentOsRelease?.npmScope ?? sourcePackageScope;
  if (typeof scope !== "string" || !/^@[a-z0-9][a-z0-9._-]*$/u.test(scope)) {
    fail("package.json agentOsRelease.npmScope or AGENTOS_NPM_SCOPE must be a valid npm scope");
  }
  return scope;
};

const publicPackageName = (name) => {
  if (!name.startsWith(`${sourcePackageScope}/`)) return name;
  return `${publishScope()}/${name.slice(sourcePackageScope.length + 1)}`;
};

const publicSpecifier = (specifier) => {
  if (specifier === sourcePackageScope) return publishScope();
  if (!specifier.startsWith(`${sourcePackageScope}/`)) return specifier;
  return `${publishScope()}${specifier.slice(sourcePackageScope.length)}`;
};

const rewritePublicSpecifiers = (text) => text.replaceAll(sourcePackageScope, publishScope());

const uniqueSorted = (values) =>
  [...new Set(values)].sort((left, right) => left.localeCompare(right));

const walkAbsoluteFiles = (dir, predicate) => {
  if (!fs.existsSync(dir)) return [];
  const files = [];
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) {
        visit(target);
        continue;
      }
      if (entry.isFile() && predicate(target)) files.push(target);
    }
  };
  visit(dir);
  return files.sort((left, right) => left.localeCompare(right));
};

const mdTable = (headers, rows) => {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index].length)),
  );
  const line = (row) =>
    `| ${row.map((cell, index) => `${cell}${" ".repeat(widths[index] - cell.length)}`).join(" | ")} |`;
  return [
    line(headers),
    `| ${widths.map((width) => "-".repeat(width)).join(" | ")} |`,
    ...rows.map(line),
  ].join("\n");
};

const runGit = (args) => {
  const result = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
  if (result.status !== 0) return undefined;
  return result.stdout.trim();
};

const existingGeneratedAt = () => {
  const file = path.join(catalogRoot, "references", "provenance.json");
  if (!fs.existsSync(file)) return undefined;
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return typeof value.generatedAt === "string" && value.generatedAt.length > 0
      ? {
          value: value.generatedAt,
          source:
            typeof value.generatedAtSource === "string" && value.generatedAtSource.length > 0
              ? value.generatedAtSource
              : "existing-provenance",
        }
      : undefined;
  } catch {
    return undefined;
  }
};

const deterministicGeneratedAt = () => {
  const existing = existingGeneratedAt();
  if (existing !== undefined) {
    return existing;
  }
  const epoch = process.env.SOURCE_DATE_EPOCH;
  if (epoch !== undefined && /^\d+$/u.test(epoch)) {
    return { value: new Date(Number(epoch) * 1000).toISOString(), source: "SOURCE_DATE_EPOCH" };
  }
  const commitTime = runGit(["show", "-s", "--format=%cI", "HEAD"]);
  if (commitTime !== undefined && commitTime.length > 0) {
    return { value: new Date(commitTime).toISOString(), source: "git-head-commit-time" };
  }
  return { value: "unavailable", source: "unavailable" };
};

const gitIdentity = () => {
  const sha = runGit(["rev-parse", "HEAD"]);
  return {
    available: false,
    reason:
      sha === undefined || sha.length === 0
        ? "git rev-parse HEAD unavailable"
        : "catalog is generated before the commit that records it; inputFiles and outputFiles carry the stable content hashes",
  };
};

const packageRows = () =>
  surface.packages
    .filter((pkg) => pkg.published === true)
    .map((pkg) => {
      const manifest = readJson(`${pkg.path}/package.json`);
      return {
        slug: pkg.slug,
        sourcePackage: manifest.name,
        publicPackage: publicPackageName(manifest.name),
        path: pkg.path,
        status: pkg.status,
        role: pkg.role,
        apiSource: pkg.apiSource,
        entrypoints: Array.isArray(pkg.entrypoints) ? pkg.entrypoints : [],
      };
    })
    .sort((left, right) => left.slug.localeCompare(right.slug));

const renderPackageMap = () => {
  const packages = packageRows();
  const entrypoints = packages.flatMap((pkg) =>
    pkg.entrypoints.map((entry) => ({
      import: `${publicPackageName(pkg.sourcePackage)}${entry.subpath === "." ? "" : entry.subpath.slice(1)}`,
      audience: (entry.audiences ?? []).join(", "),
      capability: entry.capability,
      owner: publicPackageName(pkg.sourcePackage),
    })),
  );
  return [
    "# agentOS Package Map",
    "",
    `Release version: \`${releaseVersion()}\``,
    `Published scope: \`${publishScope()}\``,
    "",
    "## Packages",
    "",
    mdTable(
      ["Source Package", "Published Package", "Path", "Status", "Role"],
      packages.map((pkg) => [
        `\`${pkg.sourcePackage}\``,
        `\`${pkg.publicPackage}\``,
        `\`${pkg.path}\``,
        pkg.status,
        pkg.role,
      ]),
    ),
    "",
    "## Entrypoints",
    "",
    mdTable(
      ["Import", "Audience", "Capability", "Owner"],
      entrypoints.map((entry) => [
        `\`${entry.import}\``,
        entry.audience,
        entry.capability,
        `\`${entry.owner}\``,
      ]),
    ),
    "",
  ].join("\n");
};

const renderSkill = () =>
  [
    "---",
    "name: agentOS",
    `description: Generated installed catalog for agentOS ${releaseVersion()} public packages, API intent, agent navigation, invariants, errors, and provenance.`,
    "---",
    "",
    "# agentOS",
    "",
    `This catalog is generated for \`${publicPackageName("@agent-os/cli")}\` ${releaseVersion()}. Treat files under \`references/\` as installed-version facts; do not infer future API from chat context, archived CST events, or source checkouts.`,
    "",
    "## Routes",
    "",
    "- Package ownership and entrypoints: `references/package-map.md`",
    "- Exact public API intent: `references/public-api/*.md`",
    "- Agent route from intent to primitive: `references/agent/start-here.md`",
    "- Machine-readable recipes, primitives, decision graph, errors, and invariants: `references/agent/*.json`",
    "- Source and output hashes: `references/provenance.json`",
    "",
    "## Boundaries",
    "",
    "- `SKILL.md` is only a router; large facts live in `references/`.",
    "- `catalog.source.json` is not a valid source of truth.",
    "- Channel, schedule, lifecycle, package, API, error, and invariant facts come from the referenced generated projections and source manifests listed in provenance.",
    "",
  ].join("\n");

const rewriteStartHere = (text) =>
  rewritePublicSpecifiers(text)
    .replaceAll("docs/agent/", "")
    .replaceAll("(agent/", "(")
    .replaceAll("primitives.md](primitives.md)", "primitives.json](primitives.json)")
    .replaceAll(
      "decision-graph.md](decision-graph.md)",
      "decision-graph.json](decision-graph.json)",
    )
    .replaceAll("errors.md](errors.md)", "errors.json](errors.json)")
    .replaceAll(
      "invariant-matrix.md](invariant-matrix.md)",
      "invariant-matrix.json](invariant-matrix.json)",
    )
    .replace(/\[([^\]]+)\]\(((?:guides|tutorials)\/[^)]+)\)/gu, "$1 (`$2`)")
    .replaceAll("../packages/", "../source-docs/packages/");

const baseInputPaths = () => [
  "package.json",
  "docs/surface.json",
  "docs/runtime-packages.md",
  "docs/start-here.md",
  "docs/api/core.md",
  "docs/api/runtime.md",
  "docs/api/client.md",
  "docs/api/cli.md",
  "docs/agent/recipes.json",
  "docs/agent/primitives.json",
  "docs/agent/decision-graph.json",
  "docs/agent/errors.json",
  "docs/agent/invariant-matrix.json",
  ...surface.packages.map((pkg) => `${pkg.path}/package.json`),
  ...walkRepoSourceFiles(repoRoot, "docs/agent").filter((file) =>
    /\.source\.json$|schemas\/.+\.schema\.json$/u.test(file),
  ),
];

const inputRecords = () =>
  uniqueSorted(baseInputPaths()).map((file) => {
    const text = read(file);
    return { path: file, sha256: sha256(text), byteSize: Buffer.byteLength(text) };
  });

const assertNoCatalogSource = () => {
  const offenders = walkRepoSourceFiles(repoRoot, ".").filter(
    (file) => path.basename(file) === "catalog.source.json",
  );
  if (offenders.length > 0) {
    fail(`catalog.source.json is not an allowed source fact:\n${offenders.join("\n")}`);
  }
};

const jsonOutput = (value) => `${JSON.stringify(value, null, 2)}\n`;

const buildNonProvenanceOutputs = () =>
  new Map([
    ["SKILL.md", renderSkill()],
    ["references/package-map.md", renderPackageMap()],
    ["references/public-api/core.md", rewritePublicSpecifiers(read("docs/api/core.md"))],
    ["references/public-api/runtime.md", rewritePublicSpecifiers(read("docs/api/runtime.md"))],
    ["references/public-api/client.md", rewritePublicSpecifiers(read("docs/api/client.md"))],
    ["references/public-api/cli.md", rewritePublicSpecifiers(read("docs/api/cli.md"))],
    ["references/agent/start-here.md", rewriteStartHere(read("docs/start-here.md"))],
    ["references/agent/recipes.json", read("docs/agent/recipes.json")],
    ["references/agent/primitives.json", read("docs/agent/primitives.json")],
    ["references/agent/decision-graph.json", read("docs/agent/decision-graph.json")],
    ["references/agent/errors.json", read("docs/agent/errors.json")],
    ["references/agent/invariant-matrix.json", read("docs/agent/invariant-matrix.json")],
  ]);

const formatCatalogOutputs = (outputs) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-catalog-"));
  try {
    for (const [file, text] of outputs) {
      const target = path.join(tmpDir, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, `${text.replace(/\s+$/u, "")}\n`);
    }
    const result = spawnSync("vp", ["fmt", tmpDir, "--write"], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    if (result.status !== 0) {
      fail(`agent catalog formatting failed: ${result.stderr || result.stdout || result.status}`);
    }
    return new Map(
      [...outputs.keys()].map((file) => [file, fs.readFileSync(path.join(tmpDir, file), "utf8")]),
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
};

const buildOutputs = () => {
  const outputs = formatCatalogOutputs(buildNonProvenanceOutputs());
  const generatedAt = deterministicGeneratedAt();
  const outputRecords = [...outputs.entries()].map(([file, text]) => ({
    path: `agent-catalog/agentOS/${file}`,
    sha256: sha256(text),
    byteSize: Buffer.byteLength(text),
  }));
  const provenance = {
    schemaVersion: 1,
    generatedBy: {
      id: "packages/cli/src/generate/generate-agent-catalog.mjs",
      version: 1,
    },
    generatedAt: generatedAt.value,
    generatedAtSource: generatedAt.source,
    package: {
      sourcePackage: "@agent-os/cli",
      publicPackage: publicPackageName("@agent-os/cli"),
      version: releaseVersion(),
      publicScope: publishScope(),
      catalogRoot: "agent-catalog/agentOS",
    },
    git: gitIdentity(),
    inputFiles: inputRecords(),
    outputFiles: outputRecords,
    outputHashScope:
      "all generated files except references/provenance.json to avoid a self-referential hash",
    prohibitedSources: [
      "catalog.source.json",
      "archived CST events",
      "network/npm registry reads",
      "runtime imports",
    ],
  };
  outputs.set("references/provenance.json", jsonOutput(provenance));
  return outputs;
};

const allCatalogFiles = () =>
  walkAbsoluteFiles(catalogRoot, () => true).map((file) =>
    toPosix(path.relative(catalogRoot, file)),
  );

const markdownLinks = (text) =>
  [...text.matchAll(/\[[^\]]+\]\(([^)]+)\)/gu)]
    .map((match) => match[1])
    .filter(
      (href) =>
        typeof href === "string" &&
        href.length > 0 &&
        !href.startsWith("#") &&
        !/^[a-z][a-z0-9+.-]*:/iu.test(href),
    );

const catalogMarkdownLinkFailures = (outputs) => {
  const outputFiles = new Set(outputs.keys());
  const failures = [];
  for (const [file, text] of outputs.entries()) {
    if (!file.endsWith(".md")) continue;
    for (const href of markdownLinks(text)) {
      const [target] = href.split("#");
      if (target === undefined || target.length === 0) continue;
      const resolved = toPosix(path.normalize(path.join(path.dirname(file), target)));
      if (resolved.startsWith("../") || path.isAbsolute(resolved) || !outputFiles.has(resolved)) {
        failures.push(`${file}: broken catalog link ${href}`);
      }
    }
  }
  return failures;
};

const checkOutputs = (outputs) => {
  const failures = [];
  for (const [file, expected] of outputs.entries()) {
    const target = path.join(catalogRoot, file);
    if (!fs.existsSync(target)) {
      failures.push(`${file} is missing`);
      continue;
    }
    const actual = fs.readFileSync(target, "utf8");
    if (actual !== expected) failures.push(`${file} is stale`);
  }
  const expectedFiles = new Set(outputs.keys());
  for (const file of allCatalogFiles()) {
    if (!expectedFiles.has(file)) failures.push(`${file} is extra`);
  }
  failures.push(...catalogMarkdownLinkFailures(outputs));
  if (failures.length > 0) {
    fail(`agent catalog is stale:\n${failures.join("\n")}`);
  }
  console.log(`agent catalog is current (${outputs.size} files)`);
};

const writeOutputs = (outputs) => {
  fs.rmSync(catalogRoot, { recursive: true, force: true });
  for (const [file, text] of outputs.entries()) {
    const target = path.join(catalogRoot, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
  }
  console.log(`generated agent catalog (${outputs.size} files)`);
};

assertNoCatalogSource();
const outputs = buildOutputs();
if (check) {
  checkOutputs(outputs);
} else {
  writeOutputs(outputs);
}
