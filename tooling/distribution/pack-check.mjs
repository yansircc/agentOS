import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import {
  escapeRegExp,
  fail,
  installManifestPath,
  isSourcePackageName,
  mkdtempFixture,
  packageVersion,
  publicPackageName,
  publishScope,
  readJson,
  repoPath,
  run,
  sha256File,
  sourcePackageScope,
  tarballBlocklist,
  tarballHashLength,
  tarballRoot,
  unpackTarballInto,
  writeJson,
} from "./support.mjs";
import { publishedRecords, sourcePublishGuards } from "./package-records.mjs";
import { allFiles, buildInternalPackages } from "./staging-build.mjs";

export const parseNpmJsonOutput = (text) => {
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];
  return JSON.parse(trimmed);
};

export const contentAddressedTarball = (file) => {
  const sha256 = sha256File(file);
  const targetDir = path.join(path.dirname(file), sha256.slice(0, tarballHashLength));
  const target = path.join(targetDir, path.basename(file));
  fs.mkdirSync(targetDir, { recursive: true });
  fs.renameSync(file, target);
  return { file: target, sha256 };
};

export const tarballSpec = (file) => `file:${file}`;

export const fileSpecPath = (spec) => {
  if (typeof spec !== "string" || !spec.startsWith("file:")) {
    fail(`expected file: tarball spec; actual ${String(spec)}`);
  }
  return spec.slice("file:".length);
};

export const readInstallManifest = () => {
  if (!fs.existsSync(installManifestPath)) {
    fail(`${repoPath(installManifestPath)} is missing; run pack first`);
  }
  const manifest = readJson(installManifestPath);
  if (manifest === null || typeof manifest !== "object" || manifest.tarballs === undefined) {
    fail(`${repoPath(installManifestPath)} is not an install manifest`);
  }
  return manifest;
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
      return {
        packageName,
        tarball,
        sha256: entry.sha256,
      };
    })
    .sort((left, right) => left.packageName.localeCompare(right.packageName));

export const writeInstallManifest = (entries) => {
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

export const npmPackDryRunFiles = (cwd) => {
  const result = run("npm", ["pack", "--dry-run", "--json"], { cwd, capture: true });
  const parsed = parseNpmJsonOutput(result.stdout);
  return parsed[0]?.files?.map((entry) => entry.path) ?? [];
};

export const collectPackageTargetStrings = (value, output = []) => {
  if (typeof value === "string") {
    output.push(value);
    return output;
  }
  if (value === null || typeof value !== "object") return output;
  for (const child of Object.values(value)) collectPackageTargetStrings(child, output);
  return output;
};

export const manifestFileTargets = (manifest) =>
  [
    manifest.main,
    manifest.types,
    ...collectPackageTargetStrings(manifest.bin),
    ...collectPackageTargetStrings(manifest.exports),
  ].filter((target) => typeof target === "string" && target.startsWith("./"));

export const runtimeReferenceSpecifiers = (text) => {
  const specifiers = [];
  const sourceFile = ts.createSourceFile(
    "agentos-staged-package.js",
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      specifiers.push(node.arguments[0].text);
    }
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "URL" &&
      node.arguments?.length === 2 &&
      ts.isStringLiteralLike(node.arguments[0]) &&
      node.arguments[1].getText(sourceFile) === "import.meta.url"
    ) {
      specifiers.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return specifiers;
};

export const assertStagedRuntimeClosure = (record, issues) => {
  for (const target of manifestFileTargets(readJson(path.join(record.stageDir, "package.json")))) {
    const absoluteTarget = path.join(record.stageDir, target.slice("./".length));
    if (!fs.existsSync(absoluteTarget) || !fs.statSync(absoluteTarget).isFile()) {
      issues.push(`${repoPath(absoluteTarget)} is declared by package.json but does not exist`);
    }
  }
  for (const file of allFiles(path.join(record.stageDir, "dist")).filter(
    (candidate) => candidate.endsWith(".js") || candidate.endsWith(".mjs"),
  )) {
    const text = fs.readFileSync(file, "utf8");
    for (const specifier of runtimeReferenceSpecifiers(text)) {
      if (!specifier.startsWith(".")) continue;
      const resolved = path.resolve(path.dirname(file), specifier);
      if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
        issues.push(`${repoPath(file)} references missing runtime file ${specifier}`);
      }
    }
  }
};

export const assertStagingPackage = (record) => {
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
    (candidate) =>
      candidate.endsWith(".d.ts") || candidate.endsWith(".js") || candidate.endsWith(".mjs"),
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
  assertStagedRuntimeClosure(record, issues);
  if (issues.length > 0) fail(`${record.packageJson.name}\n${issues.join("\n")}`);
};

export const checkDistribution = () => {
  buildInternalPackages();
  sourcePublishGuards();
  for (const record of publishedRecords()) {
    assertStagingPackage(record);
  }
  console.log(`checked distribution contract for ${publishedRecords().length} packages`);
};

export const assertPackedTarballManifests = (tarballs) => {
  const issues = [];
  for (const entry of tarballs) {
    const dir = mkdtempFixture("agentos-packed-manifest-");
    const target = path.join(dir, "package");
    try {
      unpackTarballInto(entry.file, target);
      const manifest = readJson(path.join(target, "package.json"));
      const manifestText = JSON.stringify(manifest);
      if (/workspace:|catalog:/u.test(manifestText)) {
        issues.push(
          `${entry.record.packageJson.name}: packed manifest leaks workspace/catalog protocol`,
        );
      }
      if (manifestText.includes(`${sourcePackageScope}/`)) {
        issues.push(
          `${entry.record.packageJson.name}: packed manifest leaks source package scope ${sourcePackageScope}`,
        );
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  if (issues.length > 0) fail(issues.join("\n"));
};

export const packInternal = () => {
  checkDistribution();
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
  assertPackedTarballManifests(tarballs);
  writeInstallManifest(tarballs);
  console.log(
    `packed ${tarballs.length} tarballs into ${repoPath(tarballRoot)} and wrote ${repoPath(installManifestPath)}`,
  );
  return tarballs.map((entry) => entry.file);
};

export const tarballsByPackage = () => {
  if (!fs.existsSync(tarballRoot)) packInternal();
  const manifest = readInstallManifest();
  return new Map(
    tarballPackageEntries(manifest).map((entry) => [entry.packageName, entry.tarball]),
  );
};

export const packageDepsFromTarballs = () =>
  Object.fromEntries(
    [...tarballsByPackage().entries()].map(([name, file]) => [name, `file:${file}`]),
  );
