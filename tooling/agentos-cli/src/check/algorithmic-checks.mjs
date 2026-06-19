#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { collectAgentDocsModel } from "../lib/agent-docs-model.mjs";
import {
  apiSourceMode,
  exportedNamesForPackage,
  sourceTsdocApiMarkdown,
  sourceTsdocModes,
  sourceTsdocRecordsForPackage,
  validateSourceTsdocRecords,
} from "../lib/public-api-model.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const compare = (left, right) => left.localeCompare(right);
const toRepoPath = (file) => path.relative(repoRoot, file).split(path.sep).join("/");
const read = (relativePath) => fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
const readJson = (relativePath) => JSON.parse(read(relativePath));
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

const walk = (relativePath, options = {}) => {
  const absolutePath = path.join(repoRoot, relativePath);
  if (!fs.existsSync(absolutePath)) return [];
  const stat = fs.statSync(absolutePath);
  if (stat.isFile()) return [relativePath];
  const ignored = options.ignored ?? new Set(["node_modules", "dist", ".wrangler", ".turbo"]);
  const files = [];
  for (const entry of fs.readdirSync(absolutePath, { withFileTypes: true })) {
    if (entry.isDirectory() && ignored.has(entry.name)) continue;
    const child = path.join(relativePath, entry.name);
    if (entry.isDirectory()) files.push(...walk(child, options));
    if (entry.isFile()) files.push(child.split(path.sep).join("/"));
  }
  return files.sort(compare);
};

const runCommand = (command) => {
  if (/\s--fix(?:\s|$)/u.test(command)) {
    throw new Error(`${command}: check commands must not run fix mode`);
  }
  console.log(`$ ${command}`);
  const result = spawnSync("sh", ["-c", command], {
    cwd: repoRoot,
    env: process.env,
    stdio: "inherit",
  });
  if (result.signal !== null) throw new Error(`${command} terminated by ${result.signal}`);
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status ?? 1}`);
};

const failIfAny = (label, failures) => {
  if (failures.length === 0) {
    console.log(`${label} passed`);
    return;
  }
  throw new Error(failures.join("\n"));
};

const manifestNames = (file, section) => {
  const source = fs.readFileSync(file, "utf8");
  const start = source.indexOf(`## ${section}`);
  if (start === -1) return new Set();
  const rest = source.slice(start + section.length + 3);
  const next = rest.search(/^## /mu);
  const body = next === -1 ? rest : rest.slice(0, next);
  return new Set([...body.matchAll(/`([^`:]+):([^`]+)`/gu)].map((match) => match[0].slice(1, -1)));
};

const targetPackages = () => {
  const surface = readJson("docs/surface.json");
  return surface.packages.filter((pkg) => {
    const packageJson = path.join(repoRoot, pkg.path, "package.json");
    if (!fs.existsSync(packageJson)) return false;
    const manifest = JSON.parse(fs.readFileSync(packageJson, "utf8"));
    return (
      pkg.apiSource !== undefined || (pkg.published === true && manifest.exports !== undefined)
    );
  });
};

const checkPublicApi = () => {
  const failures = [];
  for (const target of targetPackages()) {
    if (target.apiSource === undefined) {
      failures.push(
        `${target.name}: published package exports require apiSource in docs/surface.json`,
      );
      continue;
    }
    const manifest = path.join(repoRoot, target.apiSource);
    if (!fs.existsSync(manifest)) {
      failures.push(`missing public API intent source for ${target.name}: ${target.apiSource}`);
      continue;
    }

    const mode = apiSourceMode(target);
    if (sourceTsdocModes.has(mode)) {
      const records = sourceTsdocRecordsForPackage(repoRoot, target);
      failures.push(...validateSourceTsdocRecords(target, records));
      const expected = `${sourceTsdocApiMarkdown(target, records).replace(/\s+$/u, "")}\n`;
      if (fs.readFileSync(manifest, "utf8") !== expected) {
        failures.push(`${target.apiSource} is stale; run bun run docs:generate`);
      }
    } else if (mode !== "manual") {
      failures.push(`${target.name}: unsupported apiSourceMode ${mode}`);
    }

    const declaredPublic = new Set([
      ...manifestNames(manifest, "Public exports"),
      ...manifestNames(manifest, "Experimental exports"),
      ...manifestNames(manifest, "Deprecated exports"),
    ]);
    const internal = manifestNames(manifest, "Internal-only exports");
    const actual = exportedNamesForPackage(repoRoot, target)
      .map((record) => record.key)
      .sort();

    for (const name of actual) {
      if (!declaredPublic.has(name)) {
        failures.push(`${target.name}: exported but not declared in ${target.apiSource}: ${name}`);
      }
      if (internal.has(name)) {
        failures.push(`${target.name}: internal export is still exported: ${name}`);
      }
    }
    for (const name of declaredPublic) {
      if (!actual.includes(String(name))) {
        failures.push(`${target.name}: ${target.apiSource} lists missing export: ${String(name)}`);
      }
    }
  }
  failIfAny("public API projection", failures);
};

const checkEventNamespaces = () => {
  const failures = collectAgentDocsModel(repoRoot).namespaceModel.failures;
  failIfAny("event namespace projection", failures);
};

const importSpecifiers = (content) => {
  const sourceFile = ts.createSourceFile(
    "agentos-check.mjs",
    content,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const specifiers = [];
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
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return specifiers;
};

const ruleConstraints = (ruleId) => {
  const source = readJson("docs/agent/boundary-rules.source.json");
  const rule = source.rules?.find((entry) => isRecord(entry) && entry.id === ruleId);
  if (!isRecord(rule) || !isRecord(rule.constraints)) {
    throw new Error(`docs/agent/boundary-rules.source.json: ${ruleId} missing constraints`);
  }
  return rule.constraints;
};

const checkRepoToolingSurface = () => {
  const constraints = ruleConstraints("repo-tooling-surface");
  const failures = [];
  const expected = [...constraints.rootScripts].sort(compare);
  const actual = Object.keys(readJson("package.json").scripts ?? {}).sort(compare);
  for (const scriptName of expected.filter((name) => !actual.includes(name))) {
    failures.push(`package.json: missing root script ${scriptName}`);
  }
  for (const scriptName of actual.filter((name) => !expected.includes(name))) {
    failures.push(`package.json: unexpected root script ${scriptName}`);
  }
  for (const scriptName of actual) {
    if (
      /^(check|test):/u.test(scriptName) &&
      !constraints.allowedPrefixedRootScripts.includes(scriptName)
    ) {
      failures.push(`package.json: unexpected fine-grained root script ${scriptName}`);
    }
  }

  for (const file of walk("scripts")) {
    if (!constraints.scriptsDirectoryAllowPrefixes.some((prefix) => file.startsWith(prefix))) {
      failures.push(`scripts/: non-parallel-dev script remains at ${file}`);
      continue;
    }
    if (!constraints.scriptsDirectoryAllowedExtensions.includes(path.extname(file))) {
      failures.push(`scripts/: ${file} must use an allowed script extension`);
    }
  }

  const packagesRoot = path.join(repoRoot, "packages");
  for (const file of walk("tooling/agentos-cli/src").filter((entry) =>
    /\.(?:mjs|js|ts|tsx)$/u.test(entry),
  )) {
    const content = read(file);
    for (const specifier of importSpecifiers(content)) {
      if (constraints.forbiddenPackageSpecPrefixes.some((prefix) => specifier.startsWith(prefix))) {
        failures.push(`${file}: CLI must not import package specifier ${specifier}`);
      }
      if (specifier.startsWith(".")) {
        const resolved = path.resolve(path.dirname(path.join(repoRoot, file)), specifier);
        if (resolved === packagesRoot || resolved.startsWith(`${packagesRoot}${path.sep}`)) {
          failures.push(`${file}: CLI must not import packages source via ${specifier}`);
        }
      }
    }
  }

  const legacyPattern = new RegExp(constraints.forbiddenLegacyScriptReferencePattern, "u");
  for (const file of constraints.legacyReferenceScanRoots.flatMap((root) => walk(root))) {
    if (!/\.(?:json|jsonc|md|mjs|ts|tsx)$/u.test(file)) continue;
    for (const [index, line] of read(file).split("\n").entries()) {
      if (legacyPattern.test(line)) {
        failures.push(`${file}:${index + 1}: legacy scripts/ check/generate reference remains`);
      }
    }
  }
  failIfAny("repo tooling surface", failures);
};

const clientBoundaryPackages = {
  clientCore: "@agent-os/client",
  clientReact: "@agent-os/client-react",
  clientSvelte: "@agent-os/client-svelte",
  workspaceAgent: "@agent-os/workspace-agent",
  agUiReact: "@agent-os/ag-ui-react",
  agUiSvelte: "@agent-os/ag-ui-svelte",
};

const clientSourceFilePattern = /\.(?:ts|tsx|mts|cts|jsx|js|mjs|cjs|svelte|css|scss|less)$/u;
const clientTypeScriptOnlyPattern = /\.ts$/u;

const readJsonFile = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

const workspacePackageRecords = () => {
  const rootPackage = readJson("package.json");
  const workspaces = Array.isArray(rootPackage.workspaces)
    ? rootPackage.workspaces
    : Array.isArray(rootPackage.workspaces?.packages)
      ? rootPackage.workspaces.packages
      : [];
  const records = [];

  for (const workspace of workspaces) {
    if (typeof workspace !== "string") continue;
    if (workspace.endsWith("/*")) {
      const base = workspace.slice(0, -2);
      const baseDir = path.join(repoRoot, base);
      if (!fs.existsSync(baseDir)) continue;
      for (const entry of fs.readdirSync(baseDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const packagePath = `${base}/${entry.name}`;
        const packageJsonPath = path.join(repoRoot, packagePath, "package.json");
        if (!fs.existsSync(packageJsonPath)) continue;
        records.push({ name: readJsonFile(packageJsonPath).name, path: packagePath });
      }
      continue;
    }

    const packageJsonPath = path.join(repoRoot, workspace, "package.json");
    if (!fs.existsSync(packageJsonPath)) continue;
    records.push({ name: readJsonFile(packageJsonPath).name, path: workspace });
  }

  return records.sort((left, right) => left.path.localeCompare(right.path));
};

const clientImportSpecifiers = (source) => {
  const specifiers = [];
  const patterns = [
    /\b(?:import|export)\s+(?:type\s+)?(?:[^"'()]*?\s+from\s+)?["']([^"']+)["']/gu,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/gu,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specifiers.push(match[1]);
  }
  return specifiers;
};

const clientImportMatches = (specifier, packageName) =>
  specifier === packageName || specifier.startsWith(`${packageName}/`);

const packagePathMatches = (packagePath, prefix) =>
  packagePath === prefix || packagePath.startsWith(`${prefix}/`);

const packageMatchesConstraint = (record, names = [], pathPrefixes = []) =>
  names.includes(record.name) ||
  pathPrefixes.some((prefix) => packagePathMatches(record.path, prefix));

const packageFromInternalSpecifier = (recordsByName, specifier) => {
  if (!specifier.startsWith("@agent-os/")) return undefined;
  const [scope, name] = specifier.split("/");
  if (scope !== "@agent-os" || name === undefined) return undefined;
  return recordsByName.get(`${scope}/${name}`);
};

const packageSourceImportEdges = (records) => {
  const recordsByName = new Map(records.map((record) => [record.name, record]));
  const edges = [];
  for (const from of records) {
    for (const file of walk(`${from.path}/src`).filter((entry) =>
      /\.(?:ts|tsx|mts|cts|js|mjs)$/u.test(entry),
    )) {
      const source = read(file);
      for (const specifier of clientImportSpecifiers(source)) {
        const to = packageFromInternalSpecifier(recordsByName, specifier);
        if (to !== undefined && to.name !== from.name) {
          edges.push({ from, to, file, specifier });
        }
      }
    }
  }
  return edges;
};

const packageImportCycles = (records, edges) => {
  const graph = new Map(records.map((record) => [record.name, []]));
  for (const edge of edges) graph.get(edge.from.name)?.push(edge.to.name);
  for (const targets of graph.values()) targets.sort(compare);

  const visiting = new Set();
  const visited = new Set();
  const stack = [];
  const cycles = [];
  const visit = (name) => {
    if (visited.has(name)) return;
    if (visiting.has(name)) {
      const index = stack.indexOf(name);
      cycles.push([...stack.slice(index), name]);
      return;
    }
    visiting.add(name);
    stack.push(name);
    for (const target of graph.get(name) ?? []) visit(target);
    stack.pop();
    visiting.delete(name);
    visited.add(name);
  };
  for (const record of records) visit(record.name);
  return cycles;
};

const checkSubstrateImportDag = () => {
  const constraints = ruleConstraints("substrate-import-dag");
  const records = workspacePackageRecords().filter(
    (record) => typeof record.name === "string" && record.name.startsWith("@agent-os/"),
  );
  const edges = packageSourceImportEdges(records);
  const failures = [];

  for (const cycle of packageImportCycles(records, edges)) {
    failures.push(`substrate-import-dag: package cycle ${cycle.join(" -> ")}`);
  }

  for (const edge of edges) {
    for (const constraint of constraints.forbiddenEdges ?? []) {
      if (
        !packageMatchesConstraint(
          edge.from,
          constraint.fromPackageNames ?? [],
          constraint.fromPackagePathPrefixes ?? [],
        )
      ) {
        continue;
      }
      if (
        packageMatchesConstraint(
          edge.to,
          constraint.allowedTargetPackageNames ?? [],
          constraint.allowedTargetPackagePathPrefixes ?? [],
        )
      ) {
        continue;
      }
      if (
        packageMatchesConstraint(
          edge.to,
          constraint.forbiddenTargetPackageNames ?? [],
          constraint.forbiddenTargetPackagePathPrefixes ?? [],
        )
      ) {
        failures.push(
          `${edge.file}: substrate-import-dag: ${edge.from.name} must not import downstream package ${edge.specifier} (${edge.to.path})`,
        );
      }
    }
  }

  failIfAny("substrate import DAG", failures);
};

const clientSectionBody = (source, heading) => {
  const start = source.indexOf(`## ${heading}`);
  if (start === -1) return "";
  const rest = source.slice(start + heading.length + 3);
  const next = rest.search(/^## /mu);
  return next === -1 ? rest : rest.slice(0, next);
};

const clientPackageByName = (packages, name) => packages.find((record) => record.name === name);

const clientPackageSourceFiles = (record) =>
  walk(`${record.path}/src`).filter((file) => clientSourceFilePattern.test(path.basename(file)));

const checkClientTypeScriptOnlySource = ({ record, failures }) => {
  for (const file of clientPackageSourceFiles(record)) {
    if (!clientTypeScriptOnlyPattern.test(path.basename(file))) {
      failures.push(
        `${file}: client-boundary-source: client/framework packages may contain .ts source only`,
      );
    }
  }
};

const checkClientFrameworkImports = ({ record, kind, failures }) => {
  const allowedFramework =
    record.name === clientBoundaryPackages.clientReact ||
    record.name === clientBoundaryPackages.agUiReact
      ? "react"
      : record.name === clientBoundaryPackages.clientSvelte ||
          record.name === clientBoundaryPackages.agUiSvelte
        ? "svelte"
        : null;
  const frameworkPackages = ["react", "svelte", "svelte/store"];

  for (const file of clientPackageSourceFiles(record)) {
    const source = read(file);
    for (const specifier of clientImportSpecifiers(source)) {
      const frameworkImport = frameworkPackages.find((framework) =>
        clientImportMatches(specifier, framework),
      );
      if (frameworkImport === undefined) continue;
      if (allowedFramework === null) {
        failures.push(
          `${file}: client-boundary-framework-import: ${kind} package must not import ${frameworkImport}`,
        );
      } else if (!clientImportMatches(frameworkImport, allowedFramework)) {
        failures.push(
          `${file}: client-boundary-framework-import: ${record.name} must not import ${frameworkImport}`,
        );
      }
    }
  }
};

const checkClientFrameworkBridgeReadModels = ({ record, failures }) => {
  for (const file of clientPackageSourceFiles(record)) {
    const source = read(file);
    const objectExportPatterns = [
      /\bexport\s+interface\s+([A-Za-z_$][\w$]*)[^{]*\{/gu,
      /\bexport\s+type\s+([A-Za-z_$][\w$]*)[^=]*=\s*\{/gu,
    ];
    for (const pattern of objectExportPatterns) {
      for (const match of source.matchAll(pattern)) {
        failures.push(
          `${file}: client-boundary-read-model: framework bridges must not declare exported object read-model type ${match[1]}; define canonical DTOs in runtime-protocol, workspace-agent, ag-ui, or client core`,
        );
      }
    }
  }
};

const checkClientRetiredImports = ({ records, failures }) => {
  const retiredNames = [clientBoundaryPackages.agUiReact, clientBoundaryPackages.agUiSvelte];
  for (const record of records) {
    for (const file of clientPackageSourceFiles(record)) {
      const source = read(file);
      for (const specifier of clientImportSpecifiers(source)) {
        for (const retiredName of retiredNames) {
          if (record.name !== retiredName && clientImportMatches(specifier, retiredName)) {
            failures.push(
              `${file}: client-boundary-retired-import: ${record.name} imports retired framework package ${retiredName}`,
            );
          }
        }
      }
    }
  }
};

const checkClientRetiredPackageWindow = ({ surfacePackages, records, failures }) => {
  const retiredFrameworkPackages = [
    { retired: clientBoundaryPackages.agUiReact, successor: clientBoundaryPackages.clientReact },
    { retired: clientBoundaryPackages.agUiSvelte, successor: clientBoundaryPackages.clientSvelte },
  ];

  for (const item of retiredFrameworkPackages) {
    const retiredRecord = clientPackageByName(records, item.retired);
    const retiredSurface = clientPackageByName(surfacePackages, item.retired);
    const successorRecord = clientPackageByName(records, item.successor);
    const successorSurface = clientPackageByName(surfacePackages, item.successor);

    if (
      (successorRecord !== undefined || successorSurface !== undefined) &&
      retiredRecord !== undefined
    ) {
      failures.push(
        `${retiredRecord.path}: client-boundary-retired-surface: ${item.retired} must be deleted once ${item.successor} exists`,
      );
    }
    if (
      (successorRecord !== undefined || successorSurface !== undefined) &&
      retiredSurface !== undefined
    ) {
      failures.push(
        `docs/surface.json: client-boundary-retired-surface: ${item.retired} must leave the public surface once ${item.successor} exists`,
      );
    }
    if (retiredRecord === undefined && retiredSurface === undefined) continue;
    if (retiredSurface === undefined) {
      failures.push(
        `${item.retired}: client-boundary-retired-surface: retired workspace package must remain source-owned in docs/surface.json until deletion`,
      );
      continue;
    }
    if (!String(retiredSurface.status ?? "").startsWith("retired")) {
      failures.push(
        `docs/surface.json: client-boundary-retired-surface: ${item.retired} must have retired status before deletion`,
      );
    }
    if (!String(retiredSurface.apiStatus ?? "").includes("scheduled for deletion")) {
      failures.push(
        `docs/surface.json: client-boundary-retired-surface: ${item.retired} apiStatus must declare deletion, not compatibility preservation`,
      );
    }
    if (retiredSurface.apiSource !== undefined) {
      const apiSourcePath = path.join(repoRoot, retiredSurface.apiSource);
      if (fs.existsSync(apiSourcePath)) {
        const apiSource = fs.readFileSync(apiSourcePath, "utf8");
        if (clientSectionBody(apiSource, "Public exports").trim() !== "None.") {
          failures.push(
            `${retiredSurface.apiSource}: client-boundary-retired-surface: retired package must expose no active public exports`,
          );
        }
        if (!clientSectionBody(apiSource, "Deprecated exports").includes("`.:")) {
          failures.push(
            `${retiredSurface.apiSource}: client-boundary-retired-surface: retired exports must be declared as deprecated until deletion`,
          );
        }
      }
    }
  }
};

const checkClientCanonicalSurface = ({ surfacePackages, failures }) => {
  const agUi = clientPackageByName(surfacePackages, "@agent-os/ag-ui");
  if (agUi === undefined) {
    failures.push("docs/surface.json: client-boundary-canonical-surface: @agent-os/ag-ui missing");
    return;
  }
  if (!String(agUi.boundary ?? "").includes("opt-in AG-UI edge protocol projection")) {
    failures.push(
      "docs/surface.json: client-boundary-canonical-surface: @agent-os/ag-ui must be declared as opt-in wire projection",
    );
  }
  if (!String(agUi.boundary ?? "").includes("runtime-protocol Recorded vocabulary")) {
    failures.push(
      "docs/surface.json: client-boundary-canonical-surface: @agent-os/ag-ui boundary must state client state remains runtime-protocol Recorded vocabulary",
    );
  }
};

const checkClientBoundaryDoc = (failures) => {
  const boundaryPath = "tooling/refactor/a78-a94/client-app-kit-boundary.md";
  if (!fs.existsSync(path.join(repoRoot, boundaryPath))) {
    failures.push(
      `${boundaryPath}: client-boundary-contract: missing source-owned boundary freeze`,
    );
    return;
  }
  const source = read(boundaryPath);
  for (const marker of [
    "client state is a projection sink plus a command surface",
    "`@agent-os/ag-ui` is a framework-neutral opt-in wire projection",
    "`@agent-os/client-react` and `@agent-os/client-svelte` are the only framework",
    "Projection reads are replayable/read-model surfaces",
    "one driver mount",
    "projection sink configuration[]",
  ]) {
    if (!source.includes(marker)) {
      failures.push(`${boundaryPath}: client-boundary-contract: missing marker ${marker}`);
    }
  }
};

const checkClientBoundaries = () => {
  const failures = [];
  const surface = readJson("docs/surface.json");
  const surfacePackages = Array.isArray(surface.packages) ? surface.packages : [];
  const records = workspacePackageRecords();

  checkClientBoundaryDoc(failures);
  checkClientCanonicalSurface({ surfacePackages, failures });
  checkClientRetiredPackageWindow({ surfacePackages, records, failures });
  checkClientRetiredImports({ records, failures });

  const guardedNames = new Set([
    clientBoundaryPackages.clientCore,
    clientBoundaryPackages.clientReact,
    clientBoundaryPackages.clientSvelte,
    clientBoundaryPackages.workspaceAgent,
    clientBoundaryPackages.agUiReact,
    clientBoundaryPackages.agUiSvelte,
  ]);
  for (const record of records) {
    if (!guardedNames.has(record.name)) continue;
    checkClientTypeScriptOnlySource({ record, failures });
    const kind =
      record.name === clientBoundaryPackages.clientCore
        ? "client core"
        : record.name === clientBoundaryPackages.workspaceAgent
          ? "workspace app-kit"
          : "framework bridge";
    checkClientFrameworkImports({ record, kind, failures });
    if (
      record.name === clientBoundaryPackages.clientReact ||
      record.name === clientBoundaryPackages.clientSvelte ||
      record.name === clientBoundaryPackages.agUiReact ||
      record.name === clientBoundaryPackages.agUiSvelte
    ) {
      checkClientFrameworkBridgeReadModels({ record, failures });
    }
  }

  failIfAny("client boundaries", failures);
};

const checkLimitRegistry = () => {
  const failures = [];
  if (!fs.existsSync(path.join(repoRoot, "docs/limits.json"))) {
    failures.push("docs/limits.json is missing");
    failIfAny("limit registry", failures);
    return;
  }
  const registry = readJson("docs/limits.json");
  const allowedClasses = new Set(["contract", "policy", "closed"]);
  if (!Number.isInteger(registry.version) || registry.version <= 0) {
    failures.push("docs/limits.json version must be a positive integer");
  }
  if (!Array.isArray(registry.limits) || registry.limits.length === 0) {
    failures.push("docs/limits.json limits must be a non-empty array");
    failIfAny("limit registry", failures);
    return;
  }
  const seen = new Set();
  for (const [index, limit] of registry.limits.entries()) {
    const label = isRecord(limit) && typeof limit.id === "string" ? limit.id : `limits[${index}]`;
    if (!isRecord(limit)) {
      failures.push(`${label}: expected object`);
      continue;
    }
    if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u.test(limit.id ?? "")) {
      failures.push(`${label}.id: expected stable lowercase dotted identifier`);
    }
    if (seen.has(limit.id)) failures.push(`${label}.id: duplicate ${limit.id}`);
    seen.add(limit.id);
    if (!allowedClasses.has(limit.class))
      failures.push(`${label}.class: expected contract, policy, or closed`);
    for (const field of ["owner", "value", "reason"]) {
      if (typeof limit[field] !== "string" || limit[field].trim().length === 0) {
        failures.push(`${label}.${field}: required`);
      }
    }
    if (!Array.isArray(limit.sourcePaths) || limit.sourcePaths.length === 0) {
      failures.push(`${label}.sourcePaths: non-empty array required`);
    } else {
      for (const sourcePath of limit.sourcePaths) {
        const file = String(sourcePath).split("#", 1)[0];
        if (
          path.isAbsolute(file) ||
          file.includes("..") ||
          !fs.existsSync(path.join(repoRoot, file))
        ) {
          failures.push(`${label}.sourcePaths: ${sourcePath} does not point to a repo file`);
        }
      }
    }
    if (
      limit.class === "policy" &&
      (typeof limit.overrideSurface !== "string" || limit.overrideSurface.trim().length === 0)
    ) {
      failures.push(`${label}.overrideSurface: policy limits require an ordinary override surface`);
    }
    if (
      (limit.class === "contract" || limit.class === "closed") &&
      limit.overrideSurface !== undefined
    ) {
      failures.push(
        `${label}.overrideSurface: ${limit.class} limits must not expose ordinary overrides`,
      );
    }
  }
  failIfAny("limit registry", failures);
};

const packageJsonFiles = () => {
  const files = [];
  const visit = (dir) => {
    const packageJson = path.join(dir, "package.json");
    if (fs.existsSync(packageJson)) {
      files.push(packageJson);
      return;
    }
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name !== "node_modules") visit(path.join(dir, entry.name));
    }
  };
  for (const root of ["packages", "tooling"]) visit(path.join(repoRoot, root));
  return files.sort(compare);
};

const checkSourceAliases = async () => {
  const failures = [];
  const { agentOsSourceAliasSpecs } = await import(
    pathToFileURL(path.join(repoRoot, "tooling/vitest-config/source-aliases.ts")).href
  );
  const actual = new Map(
    [...agentOsSourceAliasSpecs].sort(([left], [right]) => left.localeCompare(right)),
  );
  const expected = new Map();
  for (const packageJsonPath of packageJsonFiles()) {
    const packageDir = path.dirname(packageJsonPath);
    const manifest = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
    if (!manifest.name?.startsWith("@agent-os/")) continue;
    const exportsValue =
      manifest.exports ??
      (fs.existsSync(path.join(packageDir, "src/index.ts")) ? { ".": "./src/index.ts" } : {});
    for (const [exportPath, exportTarget] of Object.entries(
      isRecord(exportsValue) ? exportsValue : { ".": exportsValue },
    )) {
      const target =
        typeof exportTarget === "string"
          ? exportTarget
          : (exportTarget?.default ?? exportTarget?.import ?? exportTarget?.types);
      if (typeof target !== "string" || !target.startsWith("./")) continue;
      const specifier =
        exportPath === "." ? manifest.name : `${manifest.name}/${exportPath.replace(/^\.\//u, "")}`;
      expected.set(specifier, toRepoPath(path.join(packageDir, target)));
    }
  }
  for (const [specifier, sourcePath] of expected) {
    if (actual.get(specifier) !== sourcePath) {
      failures.push(
        `source alias ${String(specifier)}: expected ${String(sourcePath)}; actual ${String(actual.get(specifier))}`,
      );
    }
  }
  for (const specifier of actual.keys()) {
    if (!expected.has(specifier)) failures.push(`extra source alias ${String(specifier)}`);
  }
  const tsconfig = readJson("tsconfig.source-paths.json");
  if (tsconfig.compilerOptions?.baseUrl !== undefined) {
    failures.push("tsconfig.source-paths.json must not set compilerOptions.baseUrl");
  }
  const actualPaths = tsconfig.compilerOptions?.paths ?? {};
  for (const [specifier, sourcePath] of actual) {
    const expectedPaths = [`./${String(sourcePath)}`];
    if (JSON.stringify(actualPaths[specifier]) !== JSON.stringify(expectedPaths)) {
      failures.push(
        `tsconfig.source-paths.json paths.${String(specifier)}: expected ${JSON.stringify(expectedPaths)}`,
      );
    }
  }
  for (const file of packageJsonFiles()
    .map((packageJsonPath) => path.join(path.dirname(packageJsonPath), "tsconfig.json"))
    .filter((file) => fs.existsSync(file))) {
    const tsconfigSource = readJson(toRepoPath(file));
    const expectedExtends = path
      .relative(path.dirname(file), path.join(repoRoot, "tsconfig.source-paths.json"))
      .split(path.sep)
      .join("/");
    if (tsconfigSource.extends !== expectedExtends) {
      failures.push(`${toRepoPath(file)}: expected extends ${JSON.stringify(expectedExtends)}`);
    }
    const localAgentOsPaths = Object.keys(tsconfigSource.compilerOptions?.paths ?? {}).filter(
      (specifier) => specifier.startsWith("@agent-os/"),
    );
    if (localAgentOsPaths.length > 0) {
      failures.push(
        `${toRepoPath(file)} has package-local @agent-os paths: ${localAgentOsPaths.join(", ")}`,
      );
    }
  }
  failIfAny("source aliases", failures);
};

const packageSourceFiles = () =>
  walk("packages").filter(
    (file) =>
      /\.(?:ts|tsx|mts|cts)$/u.test(file) &&
      !file.endsWith(".d.ts") &&
      file.split("/").includes("src"),
  );

const nodeLabel = (sourceFile, node) => {
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return `${toRepoPath(sourceFile.fileName)}:${position.line + 1}:${position.character + 1}`;
};

const unwrap = (node) => {
  let current = node;
  while (
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isParenthesizedExpression(current)
  ) {
    current = current.expression;
  }
  return current;
};

const callName = (expression) => {
  const unwrapped = unwrap(expression);
  if (ts.isIdentifier(unwrapped)) return unwrapped.text;
  if (ts.isPropertyAccessExpression(unwrapped)) return unwrapped.name.text;
  return undefined;
};

const checkTransactionSync = () => {
  const failures = [];
  const inspectBody = (sourceFile, body, label) => {
    const visit = (node) => {
      if (ts.isAwaitExpression(node))
        failures.push(`${nodeLabel(sourceFile, node)} ${label} must not await`);
      if (
        ts.isNewExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "Promise"
      ) {
        failures.push(`${nodeLabel(sourceFile, node)} ${label} must not create Promise`);
      }
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === "Promise"
      ) {
        failures.push(
          `${nodeLabel(sourceFile, node)} ${label} must not call Promise static helpers`,
        );
      }
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "then"
      ) {
        failures.push(`${nodeLabel(sourceFile, node)} ${label} must not call .then`);
      }
      if (
        ts.isCallExpression(node) &&
        ["setTimeout", "setInterval", "setImmediate", "queueMicrotask"].includes(
          callName(node.expression),
        )
      ) {
        failures.push(`${nodeLabel(sourceFile, node)} ${label} must not schedule async work`);
      }
      ts.forEachChild(node, visit);
    };
    visit(body);
  };
  for (const file of packageSourceFiles()) {
    const sourceFile = ts.createSourceFile(
      path.join(repoRoot, file),
      read(file),
      ts.ScriptTarget.Latest,
      true,
    );
    const visit = (node) => {
      if (ts.isCallExpression(node) && callName(node.expression) === "transactionSync") {
        const builder = unwrap(node.arguments[0]);
        if (!builder || (!ts.isArrowFunction(builder) && !ts.isFunctionExpression(builder))) {
          failures.push(
            `${nodeLabel(sourceFile, node)} transactionSync must use an inline sync builder`,
          );
        } else {
          if (builder.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)) {
            failures.push(
              `${nodeLabel(sourceFile, builder)} transactionSync builder must not be async`,
            );
          }
          inspectBody(sourceFile, builder.body, "transactionSync builder");
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  failIfAny("transactionSync sync-only projection", failures);
};

const checkBackendNeutrality = () => {
  const failures = [];
  const rootPackage = readJson("package.json");
  const status = rootPackage.agentos?.backendNeutralityStatus;
  if (!["boundary-prepared", "backend-neutral"].includes(status)) {
    failures.push("package.json must declare agentos.backendNeutralityStatus");
  }
  const backends = rootPackage.agentos?.backendNeutrality?.productionBackendPackages;
  if (!Array.isArray(backends))
    failures.push("package.json must declare agentos.backendNeutrality.productionBackendPackages");
  if (status === "backend-neutral" && Array.isArray(backends) && backends.length < 2) {
    failures.push("backend-neutral status requires at least 2 production backends");
  }
  for (const backend of backends ?? []) {
    if (!fs.existsSync(path.join(repoRoot, backend, "src")))
      failures.push(`${backend}: missing src`);
    if (!fs.existsSync(path.join(repoRoot, backend, "test/backend-protocol-contract.test.ts"))) {
      failures.push(`${backend}: missing backend protocol contract test`);
    }
  }
  failIfAny("backend neutrality", failures);
};

const checkSpikeHygiene = () => {
  const tracked = execFileSync("git", ["ls-files", "spikes"], { cwd: repoRoot, encoding: "utf8" })
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const allowed = new Set(["spikes/_active/.gitkeep"]);
  failIfAny(
    "spike hygiene",
    tracked
      .filter((file) => !allowed.has(file))
      .map((file) => `tracked spike file is not allowed: ${file}`),
  );
};

const checkConvergenceBoundary = () => {
  checkClientBoundaries();
  checkSpikeHygiene();
  console.log("convergence boundary passed");
};

const checkDocsSiteBuild = () => {
  const contentRoot = path.join(repoRoot, "tooling/docs-site/src/content/docs");
  const distRoot = path.join(repoRoot, "tooling/docs-site/dist");
  const pages = walk("tooling/docs-site/src/content/docs").filter((file) => file.endsWith(".md"));
  const failures = [];
  if (pages.length === 0) failures.push("docs-site projected content is empty");
  for (const file of pages) {
    const contentRel = path
      .relative(contentRoot, path.join(repoRoot, file))
      .split(path.sep)
      .join("/");
    const route =
      contentRel === "index.md" ? "index.html" : contentRel.replace(/\.md$/u, "/index.html");
    if (!fs.existsSync(path.join(distRoot, route)))
      failures.push(`${file} did not build tooling/docs-site/dist/${route}`);
  }
  const builtPages = walk("tooling/docs-site/dist").filter((file) => file.endsWith(".html"));
  if (builtPages.length <= 1)
    failures.push(`docs-site build emitted ${builtPages.length} HTML page(s)`);
  failIfAny("docs site build", failures);
};

const checkBoundaryProjection = () => runCommand("vp check");

const checkerById = new Map([
  ["backend-neutrality", checkBackendNeutrality],
  ["boundaries", checkBoundaryProjection],
  ["client-boundaries", checkClientBoundaries],
  ["convergence-boundary", checkConvergenceBoundary],
  ["d12-a155-substrate-absorption", checkBoundaryProjection],
  ["docs-site-build", checkDocsSiteBuild],
  ["event-namespaces", checkEventNamespaces],
  ["limit-registry", checkLimitRegistry],
  ["public-api", checkPublicApi],
  ["repo-tooling-surface", checkRepoToolingSurface],
  ["source-aliases", checkSourceAliases],
  ["spike-hygiene", checkSpikeHygiene],
  ["substrate-import-dag", checkSubstrateImportDag],
  ["transaction-sync", checkTransactionSync],
]);

export const listAlgorithmicCheckers = () => [...checkerById.keys()].sort(compare);
export const hasAlgorithmicChecker = (checkerId) => checkerById.has(checkerId);

export const runAlgorithmicChecker = async (checkerId) => {
  const checker = checkerById.get(checkerId);
  if (checker === undefined) throw new Error(`unknown algorithmic checker ${checkerId}`);
  console.log(`$ agentos algorithmic-check ${checkerId}`);
  await Promise.resolve(checker());
};

const isCli =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isCli) {
  const [checkerId, ...rest] = process.argv.slice(2);
  if (checkerId === undefined || checkerId === "--help" || checkerId === "-h") {
    console.log("usage: node tooling/agentos-cli/src/check/algorithmic-checks.mjs <checker-id>");
    process.exit(checkerId === undefined ? 1 : 0);
  }
  if (rest.length > 0) {
    console.error(`unexpected argument(s): ${rest.join(" ")}`);
    process.exit(1);
  }
  try {
    await runAlgorithmicChecker(checkerId);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
