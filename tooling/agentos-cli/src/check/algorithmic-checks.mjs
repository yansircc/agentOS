#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { runCommand } from "./command-runner.mjs";
import {
  importSpecifierRecords,
  packageImportCycles as graphPackageImportCycles,
  packageManifestDependencyEdges,
  packageSourceImportEdges as graphPackageSourceImportEdges,
  moduleGraphOracleFailures,
  sourceModuleGraph,
  tsconfigReferenceEdges,
  workspacePackageRecords as graphWorkspacePackageRecords,
} from "./package-graph.mjs";
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

const failIfAny = (label, failures) => {
  if (failures.length === 0) {
    console.log(`${label} passed`);
    return;
  }
  throw new Error(failures.join("\n"));
};

const manifestEntries = (file, section) => {
  const source = fs.readFileSync(file, "utf8");
  const start = source.indexOf(`## ${section}`);
  if (start === -1) return [];
  const rest = source.slice(start + section.length + 3);
  const next = rest.search(/^## /mu);
  const body = next === -1 ? rest : rest.slice(0, next);
  return [...body.matchAll(/`([^`:]+):([^`]+)`/gu)].map((match) => ({
    name: match[0].slice(1, -1),
    section,
    line: source.slice(0, start + section.length + 3 + match.index).split("\n").length,
  }));
};

const manifestNames = (file, section) =>
  new Set(manifestEntries(file, section).map((entry) => entry.name));

const duplicateManifestEntries = (file, sections) => {
  const entries = sections.flatMap((section) => manifestEntries(file, section));
  const byName = new Map();
  for (const entry of entries) {
    byName.set(entry.name, [...(byName.get(entry.name) ?? []), entry]);
  }
  return [...byName.entries()]
    .filter(([, occurrences]) => occurrences.length > 1)
    .map(([name, occurrences]) => ({ name, occurrences }));
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

    const publicSections = ["Public exports", "Experimental exports", "Deprecated exports"];
    for (const duplicate of duplicateManifestEntries(manifest, [
      ...publicSections,
      "Internal-only exports",
    ])) {
      const refs = duplicate.occurrences
        .map((entry) => `${entry.section}:${entry.line}`)
        .join(", ");
      failures.push(
        `${target.name}: ${target.apiSource} declares duplicate API entry ${duplicate.name} at ${refs}`,
      );
    }

    const declaredPublic = new Set(
      publicSections.flatMap((section) => [...manifestNames(manifest, section)]),
    );
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

const checkForbiddenPackageEdges = ({ ruleId, constraints, edges, failures }) => {
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
          `${edge.file}: ${ruleId}: ${edge.from.name} must not import downstream package ${edge.specifier} (${edge.to.path})`,
        );
      }
    }
  }
};

const convergenceRoleForPackage = (record, failures) => {
  const rules = Array.isArray(convergenceRoleManifest().packageRoleRules)
    ? convergenceRoleManifest().packageRoleRules
    : [];
  const matchingRules = rules.filter((rule) => roleSurvivalPackageMatches(record, rule));
  if (matchingRules.length !== 1) {
    failures.push(
      `${record.path}: expected exactly one convergence role for import DAG, matched ${matchingRules.length}`,
    );
    return undefined;
  }
  const role = matchingRules[0].role;
  if (!convergenceRoleIds.has(role)) {
    failures.push(`${record.path}: invalid convergence role ${role}`);
    return undefined;
  }
  return role;
};

const checkRoleImportEdges = ({ ruleId, constraints, records, edges, failures }) => {
  const roleByPackageName = new Map();
  for (const record of records) {
    const role = convergenceRoleForPackage(record, failures);
    if (role !== undefined) roleByPackageName.set(record.name, role);
  }

  const allowedTargetRolesByFromRole = new Map();
  for (const [index, edge] of (constraints.roleEdges ?? []).entries()) {
    const label = `${ruleId}.constraints.roleEdges[${index}]`;
    if (!isRecord(edge)) {
      failures.push(`${label} must be an object`);
      continue;
    }
    if (!convergenceRoleIds.has(edge.fromRole)) {
      failures.push(`${label}: invalid fromRole ${edge.fromRole}`);
      continue;
    }
    if (!Array.isArray(edge.allowedTargetRoles)) {
      failures.push(`${label}: allowedTargetRoles must be an array`);
      continue;
    }
    const allowed = new Set();
    for (const role of edge.allowedTargetRoles) {
      if (!convergenceRoleIds.has(role)) {
        failures.push(`${label}: invalid allowed target role ${role}`);
        continue;
      }
      allowed.add(role);
    }
    allowedTargetRolesByFromRole.set(edge.fromRole, allowed);
  }

  for (const role of convergenceRoleIds) {
    if (!allowedTargetRolesByFromRole.has(role)) {
      failures.push(`${ruleId}.constraints.roleEdges: missing fromRole ${role}`);
    }
  }

  for (const edge of edges) {
    const fromRole = roleByPackageName.get(edge.from.name);
    const toRole = roleByPackageName.get(edge.to.name);
    if (fromRole === undefined || toRole === undefined) continue;
    const allowed = allowedTargetRolesByFromRole.get(fromRole);
    if (allowed === undefined || allowed.has(toRole)) continue;
    failures.push(
      `${edge.file}: ${ruleId}: ${edge.from.name} (${fromRole}) must not import ${edge.specifier} (${edge.to.name}; ${toRole})`,
    );
  }
};

const checkPackageImportDag = ({ ruleId, label }) => {
  const constraints = ruleConstraints(ruleId);
  const records = graphWorkspacePackageRecords(repoRoot).filter(
    (record) => typeof record.name === "string" && record.name.startsWith("@agent-os/"),
  );
  const edges = graphPackageSourceImportEdges(repoRoot, records);
  const failures = [];

  for (const cycle of graphPackageImportCycles(records, edges)) {
    failures.push(`${ruleId}: package cycle ${cycle.join(" -> ")}`);
  }

  checkForbiddenPackageEdges({ ruleId, constraints, edges, failures });
  if (constraints.roleEdges !== undefined) {
    checkRoleImportEdges({ ruleId, constraints, records, edges, failures });
  }

  failIfAny(label, failures);
};

const checkSubstrateImportDag = () =>
  checkPackageImportDag({ ruleId: "substrate-import-dag", label: "substrate import DAG" });

const checkConvergenceImportDag = () =>
  checkPackageImportDag({
    ruleId: "convergence-import-dag",
    label: "convergence import DAG",
  });

const checkModuleGraphOracle = () => {
  const records = graphWorkspacePackageRecords(repoRoot).filter(
    (record) => typeof record.name === "string" && record.name.startsWith("@agent-os/"),
  );
  const graph = sourceModuleGraph(repoRoot, records);
  const failures = moduleGraphOracleFailures(repoRoot, records);
  failIfAny("module graph oracle", failures);
  console.log(
    `module graph oracle covered ${graph.files.length} source files and ${graph.edges.length} internal module edges`,
  );
};

const ownerCouplingSinkProperties = new Set([
  "boundaryOwner",
  "boundaryOwnerId",
  "boundaryPackageId",
  "claimedBy",
  "factOwnerRef",
  "owner",
  "packageId",
  "settlementId",
]);
const ownerIdentityBoundarySinkProperties = new Set([
  "boundaryOwner",
  "boundaryOwnerId",
  "boundaryPackageId",
  "claimedBy",
  "factOwnerRef",
  "owner",
  "settlementId",
]);
const packageMetadataNames = new Set(["packageId", "sourcePackageName", "publicPackageName"]);

const publicNameForSourcePackage = (name) => name.replace(/^@agent-os\//u, "@yansirplus/");

const ownerCouplingPackageNames = () => {
  const sourcePackageNames = new Set(
    graphWorkspacePackageRecords(repoRoot)
      .map((record) => record.name)
      .filter((name) => typeof name === "string" && name.startsWith("@agent-os/")),
  );
  const publicPackageNames = new Set([...sourcePackageNames].map(publicNameForSourcePackage));
  return { sourcePackageNames, publicPackageNames };
};

const ownerCouplingPropertyName = (name) => {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return undefined;
};

const ownerCouplingPosition = (sourceFile, node) => {
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return { line: position.line + 1, column: position.character + 1 };
};

const packageMetadataSource = (expression, packageNames) => {
  const unwrapped = unwrap(expression);
  if (ts.isStringLiteralLike(unwrapped)) {
    if (packageNames.sourcePackageNames.has(unwrapped.text)) return "sourcePackageNameLiteral";
    if (packageNames.publicPackageNames.has(unwrapped.text)) return "publicPackageNameLiteral";
    return undefined;
  }
  if (ts.isIdentifier(unwrapped) && packageMetadataNames.has(unwrapped.text)) {
    return unwrapped.text;
  }
  if (ts.isPropertyAccessExpression(unwrapped) && packageMetadataNames.has(unwrapped.name.text)) {
    return unwrapped.name.text;
  }
  if (ts.isCallExpression(unwrapped) && callName(unwrapped.expression) === "publicPackageName") {
    return "publicPackageName";
  }
  if (ts.isTemplateExpression(unwrapped)) {
    for (const span of unwrapped.templateSpans) {
      const source = packageMetadataSource(span.expression, packageNames);
      if (source !== undefined) return source;
    }
  }
  if (ts.isBinaryExpression(unwrapped)) {
    return (
      packageMetadataSource(unwrapped.left, packageNames) ??
      packageMetadataSource(unwrapped.right, packageNames)
    );
  }
  if (ts.isConditionalExpression(unwrapped)) {
    return (
      packageMetadataSource(unwrapped.whenTrue, packageNames) ??
      packageMetadataSource(unwrapped.whenFalse, packageNames)
    );
  }
  return undefined;
};

const packageMetadataFindingsForSource = (content, file, packageNames, sinkProperties) => {
  const sourceFile = ts.createSourceFile(
    file,
    content,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const findings = [];
  const record = (node, sink, source) => {
    const position = ownerCouplingPosition(sourceFile, node);
    findings.push({
      file,
      line: position.line,
      column: position.column,
      sink,
      source,
      expression: node.getText(sourceFile),
    });
  };

  const visit = (node) => {
    if (ts.isPropertyAssignment(node)) {
      const sink = ownerCouplingPropertyName(node.name);
      const source = packageMetadataSource(node.initializer, packageNames);
      if (sink !== undefined && source !== undefined && sinkProperties.has(sink)) {
        record(node.initializer, sink, source);
      }
    }

    if (ts.isBinaryExpression(node)) {
      const leftText = node.left.getText(sourceFile);
      const rightText = node.right.getText(sourceFile);
      const leftSource = packageMetadataSource(node.left, packageNames);
      const rightSource = packageMetadataSource(node.right, packageNames);
      if (leftText.includes("factOwnerRef") && rightSource !== undefined) {
        record(node.right, "factOwnerRef", rightSource);
      }
      if (rightText.includes("factOwnerRef") && leftSource !== undefined) {
        record(node.left, "factOwnerRef", leftSource);
      }
    }

    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return findings;
};

export const ownerCouplingFindingsForSource = (content, file, packageNames) =>
  packageMetadataFindingsForSource(content, file, packageNames, ownerCouplingSinkProperties);

export const ownerIdentityBoundaryFindingsForSource = (content, file, packageNames) =>
  packageMetadataFindingsForSource(
    content,
    file,
    packageNames,
    ownerIdentityBoundarySinkProperties,
  );

const ownerIdentityBoundaryNegativeFixtures = [
  {
    name: "fact owner from contract package id",
    content: ["const event = {", "  factOwnerRef: contract.packageId,", "};", ""],
    expected: [["factOwnerRef", "packageId"]],
  },
  {
    name: "fact owner from source package name",
    content: ["const event = {", "  factOwnerRef: contract.sourcePackageName,", "};", ""],
    expected: [["factOwnerRef", "sourcePackageName"]],
  },
  {
    name: "fact owner from public package projection",
    content: [
      "const event = {",
      "  factOwnerRef: publicPackageName(contract.packageId),",
      "};",
      "",
    ],
    expected: [["factOwnerRef", "publicPackageName"]],
  },
  {
    name: "fact owner from public package literal",
    content: ["const event = {", '  factOwnerRef: "@yansirplus/runtime",', "};", ""],
    expected: [["factOwnerRef", "publicPackageNameLiteral"]],
  },
  {
    name: "settlement id from package metadata",
    content: [
      "const settlement = defineSettlementContract({",
      "  settlementId: spec.sourcePackageName,",
      "});",
      "",
    ],
    expected: [["settlementId", "sourcePackageName"]],
  },
  {
    name: "extension conflict owner from package metadata",
    content: ["const conflict = {", "  claimedBy: declaration.packageId,", "};", ""],
    expected: [["claimedBy", "packageId"]],
  },
  {
    name: "namespace owner from package metadata",
    content: ["const namespace = {", "  owner: namespace.sourcePackageName,", "};", ""],
    expected: [["owner", "sourcePackageName"]],
  },
  {
    name: "boundary owner from package metadata",
    content: ["const intent = {", "  boundaryOwnerId: boundaryPackage.packageId,", "};", ""],
    expected: [["boundaryOwnerId", "packageId"]],
  },
  {
    name: "legacy boundary package field from package metadata",
    content: ["const intent = {", "  boundaryPackageId: boundaryPackage.packageId,", "};", ""],
    expected: [["boundaryPackageId", "packageId"]],
  },
  {
    name: "ledger identity comparison from package metadata",
    content: ["if (committed.factOwnerRef !== contract.packageId) {}", ""],
    expected: [["factOwnerRef", "packageId"]],
  },
];

const findingPairs = (findings) => findings.map((finding) => [finding.sink, finding.source]);

export const ownerIdentityBoundaryNegativeFixtureFailures = (packageNames) => {
  const failures = [];
  for (const fixture of ownerIdentityBoundaryNegativeFixtures) {
    const findings = ownerIdentityBoundaryFindingsForSource(
      fixture.content.join("\n"),
      `negative-fixtures/${fixture.name}.ts`,
      packageNames,
    );
    const actual = findingPairs(findings);
    for (const expected of fixture.expected) {
      if (!actual.some(([sink, source]) => sink === expected[0] && source === expected[1])) {
        failures.push(
          `${fixture.name}: expected ${expected[0]} from ${expected[1]}, got ${JSON.stringify(
            actual,
          )}`,
        );
      }
    }
  }
  return failures;
};

const ownerCouplingScanFiles = () =>
  [
    ...walk("packages").filter((file) => /\.(?:ts|tsx|mts|cts)$/u.test(file)),
    ...walk("tooling/agentos-cli/src").filter((file) => /\.(?:mjs|ts)$/u.test(file)),
    ...walk("tooling/distribution").filter((file) => /\.(?:mjs|ts)$/u.test(file)),
  ].sort(compare);

const checkOwnerCoupling = (args = []) => {
  const reportOnly = args.length === 1 && args[0] === "--report-only";
  if (!reportOnly && args.length > 0) {
    throw new Error(`owner-coupling: unexpected argument(s): ${args.join(" ")}`);
  }
  const packageNames = ownerCouplingPackageNames();
  const findings = ownerCouplingScanFiles().flatMap((file) =>
    ownerCouplingFindingsForSource(read(file), file, packageNames),
  );
  const lines = findings.map(
    (finding) =>
      `${finding.file}:${finding.line}:${finding.column}: owner-coupling: ${finding.sink} reads ${finding.source} via ${finding.expression}`,
  );
  if (reportOnly) {
    console.log(`owner coupling report-only: ${findings.length} finding(s)`);
    for (const line of lines) console.log(line);
    return;
  }
  failIfAny("owner coupling", lines);
};

const checkOwnerIdentityBoundary = (args = []) => {
  const negativeFixtures = args.length === 1 && args[0] === "--negative-fixtures";
  if (!negativeFixtures && args.length > 0) {
    throw new Error(`owner-identity-boundary: unexpected argument(s): ${args.join(" ")}`);
  }
  const packageNames = ownerCouplingPackageNames();
  if (negativeFixtures) {
    failIfAny(
      "owner identity boundary negative fixtures",
      ownerIdentityBoundaryNegativeFixtureFailures(packageNames),
    );
    return;
  }
  const findings = ownerCouplingScanFiles().flatMap((file) =>
    ownerIdentityBoundaryFindingsForSource(read(file), file, packageNames),
  );
  failIfAny(
    "owner identity boundary",
    findings.map(
      (finding) =>
        `${finding.file}:${finding.line}:${finding.column}: owner-identity-boundary: ${finding.sink} reads ${finding.source} via ${finding.expression}`,
    ),
  );
};

const ownerIdRegistryPath = "architecture/owner-ids.json";

const ownerIdRegistry = () => readJson(ownerIdRegistryPath);

const ownerIdValue = (expression, constStrings) => {
  const unwrapped = unwrap(expression);
  if (ts.isStringLiteralLike(unwrapped)) return unwrapped.text;
  if (ts.isIdentifier(unwrapped)) return constStrings.get(unwrapped.text);
  return undefined;
};

const ownerIdConstStrings = (sourceFile) => {
  const out = new Map();
  const visit = (node) => {
    if (ts.isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || declaration.initializer === undefined) continue;
        const value = ownerIdValue(declaration.initializer, out);
        if (value !== undefined) out.set(declaration.name.text, value);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return out;
};

const ownerIdObjectProperty = (objectLiteral, name) => {
  for (const property of objectLiteral.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const propertyName = ownerCouplingPropertyName(property.name);
    if (propertyName === name) return property.initializer;
  }
  return undefined;
};

export const ownerIdDeclarationFindingsForSource = ({
  content,
  file,
  registeredOwners,
  workspacePackageNames,
}) => {
  const sourceFile = ts.createSourceFile(
    file,
    content,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const constStrings = ownerIdConstStrings(sourceFile);
  const findings = [];
  const declarationCalls = new Set(["defineCarrier", "defineBoundaryContract", "eventNamespace"]);
  const record = (node, message) => {
    const position = ownerCouplingPosition(sourceFile, node);
    findings.push(`${file}:${position.line}:${position.column}: owner-ids: ${message}`);
  };

  const visit = (node) => {
    if (ts.isCallExpression(node) && declarationCalls.has(callName(node.expression))) {
      const [firstArg] = node.arguments;
      if (firstArg === undefined || !ts.isObjectLiteralExpression(unwrap(firstArg))) {
        record(node, `${callName(node.expression)} declaration must use an object literal`);
      } else {
        const objectLiteral = unwrap(firstArg);
        const ownerNode = ownerIdObjectProperty(objectLiteral, "ownerId");
        const sourceNode = ownerIdObjectProperty(objectLiteral, "sourcePackageName");
        const packageNode = ownerIdObjectProperty(objectLiteral, "packageId");
        if (packageNode !== undefined) {
          record(
            packageNode,
            `${callName(node.expression)} declaration must not declare packageId`,
          );
        }
        const ownerId = ownerNode === undefined ? undefined : ownerIdValue(ownerNode, constStrings);
        const sourcePackageName =
          sourceNode === undefined ? undefined : ownerIdValue(sourceNode, constStrings);
        if (ownerId === undefined) {
          record(node, `${callName(node.expression)} declaration requires literal ownerId`);
        } else if (!registeredOwners.has(ownerId)) {
          record(
            ownerNode ?? node,
            `ownerId ${ownerId} is not registered in ${ownerIdRegistryPath}`,
          );
        }
        if (sourcePackageName === undefined) {
          record(
            node,
            `${callName(node.expression)} declaration requires literal sourcePackageName`,
          );
        } else if (!workspacePackageNames.has(sourcePackageName)) {
          record(
            sourceNode ?? node,
            `sourcePackageName ${sourcePackageName} is not a workspace package`,
          );
        } else if (ownerId !== undefined && registeredOwners.has(ownerId)) {
          const owner = registeredOwners.get(ownerId);
          const sources = new Set(owner.sourcePackageNames);
          if (!sources.has(sourcePackageName)) {
            record(
              sourceNode ?? node,
              `sourcePackageName ${sourcePackageName} is not registered for ownerId ${ownerId}`,
            );
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return findings;
};

export const ownerIdRegistryFindings = ({ registry, workspacePackageNames }) => {
  const findings = [];
  if (!isRecord(registry)) {
    return [`${ownerIdRegistryPath}: owner registry must be a JSON object`];
  }
  if (registry.schemaVersion !== 1) {
    findings.push(`${ownerIdRegistryPath}: schemaVersion must be 1`);
  }
  if (!isRecord(registry.policy)) {
    findings.push(`${ownerIdRegistryPath}: policy object is required`);
  } else {
    if (registry.policy.allocation !== "append-only") {
      findings.push(`${ownerIdRegistryPath}: policy.allocation must be append-only`);
    }
    for (const key of ["retirement", "namespaceSplit"]) {
      if (typeof registry.policy[key] !== "string" || registry.policy[key].length === 0) {
        findings.push(`${ownerIdRegistryPath}: policy.${key} must be a non-empty string`);
      }
    }
  }
  if (!Array.isArray(registry.owners) || registry.owners.length === 0) {
    findings.push(`${ownerIdRegistryPath}: owners must be a non-empty array`);
    return findings;
  }
  const seenOwnerIds = new Set();
  for (const [index, owner] of registry.owners.entries()) {
    const label = `${ownerIdRegistryPath}:owners[${index}]`;
    if (!isRecord(owner)) {
      findings.push(`${label}: owner must be an object`);
      continue;
    }
    if (typeof owner.ownerId !== "string" || owner.ownerId.length === 0) {
      findings.push(`${label}: ownerId must be a non-empty string`);
    } else if (seenOwnerIds.has(owner.ownerId)) {
      findings.push(`${label}: duplicate ownerId ${owner.ownerId}`);
    } else {
      seenOwnerIds.add(owner.ownerId);
    }
    if (owner.status !== "active" && owner.status !== "retired") {
      findings.push(`${label}: status must be active or retired`);
    }
    if (
      !Array.isArray(owner.sourcePackageNames) ||
      owner.sourcePackageNames.length === 0 ||
      !owner.sourcePackageNames.every((name) => typeof name === "string" && name.length > 0)
    ) {
      findings.push(`${label}: sourcePackageNames must be a non-empty string array`);
      continue;
    }
    for (const sourcePackageName of owner.sourcePackageNames) {
      if (!workspacePackageNames.has(sourcePackageName)) {
        findings.push(
          `${label}: sourcePackageName ${sourcePackageName} is not a workspace package`,
        );
      }
    }
  }
  return findings;
};

const checkOwnerIds = () => {
  const workspacePackageNames = new Set(
    graphWorkspacePackageRecords(repoRoot)
      .map((record) => record.name)
      .filter((name) => typeof name === "string" && name.startsWith("@agent-os/")),
  );
  const registry = ownerIdRegistry();
  const registryFindings = ownerIdRegistryFindings({ registry, workspacePackageNames });
  const registeredOwners = new Map(
    (Array.isArray(registry.owners) ? registry.owners : [])
      .filter((owner) => isRecord(owner) && typeof owner.ownerId === "string")
      .map((owner) => [owner.ownerId, owner]),
  );
  const declarationFindings = packageSourceFiles().flatMap((file) =>
    ownerIdDeclarationFindingsForSource({
      content: read(file),
      file,
      registeredOwners,
      workspacePackageNames,
    }),
  );
  failIfAny("owner ids", [...registryFindings, ...declarationFindings]);
};

const moduleBucketRegistryPath = "architecture/module-buckets.json";
let moduleBucketRegistryCache;
const moduleBucketRegistry = () => {
  moduleBucketRegistryCache ??= readJson(moduleBucketRegistryPath);
  return moduleBucketRegistryCache;
};

const pathRuleMatches = (file, rule) => {
  if (!isRecord(rule) || typeof rule.match !== "string") return false;
  if (rule.match === "all") return true;
  if (typeof rule.value !== "string") return false;
  if (rule.match === "prefix") return file.startsWith(rule.value);
  if (rule.match === "contains") return file.includes(rule.value);
  if (rule.match === "suffix") return file.endsWith(rule.value);
  if (rule.match === "regex") return new RegExp(rule.value, "u").test(file);
  return false;
};

const specifierRuleMatches = (specifier, rule) => {
  if (!isRecord(rule) || typeof rule.match !== "string" || typeof rule.value !== "string") {
    return false;
  }
  if (rule.match === "specifier") return specifier === rule.value;
  if (rule.match === "prefix") return specifier.startsWith(rule.value);
  if (rule.match === "specifier-or-subpath") {
    return specifier === rule.value || specifier.startsWith(`${rule.value}/`);
  }
  return false;
};

const moduleRuleClassification = (file, rules, property) => {
  for (const rule of rules) {
    if (pathRuleMatches(file, rule)) return rule[property];
  }
  throw new Error(`${moduleBucketRegistryPath}: no ${property} rule matches ${file}`);
};

export const moduleBucketForPath = (file) =>
  moduleRuleClassification(file, moduleBucketRegistry().bucketRules, "bucket");

export const moduleAmbientForPath = (file) =>
  moduleRuleClassification(file, moduleBucketRegistry().ambientRules, "ambient");

const moduleBucketRank = () =>
  new Map(moduleBucketRegistry().buckets.map((bucket) => [bucket.id, bucket.rank]));

const allowedAmbientImports = () =>
  new Map(
    moduleBucketRegistry().ambients.map((ambient) => [ambient.id, new Set(ambient.allowedImports)]),
  );

const ejectionBuckets = () =>
  new Set(
    moduleBucketRegistry()
      .buckets.filter((bucket) => bucket.ejection === true)
      .map((bucket) => bucket.id),
  );

const externalAmbientForSpecifier = (specifier) => {
  for (const rule of moduleBucketRegistry().externalAmbients) {
    if (specifierRuleMatches(specifier, rule)) return rule.ambient;
  }
  return undefined;
};

const modulePathRuleMatchKinds = new Set(["all", "prefix", "contains", "suffix", "regex"]);
const moduleSpecifierRuleMatchKinds = new Set(["specifier", "prefix", "specifier-or-subpath"]);
const moduleBucketFindingKinds = new Set([
  "bucket-dag",
  "ambient-dag",
  "external-ambient",
  "product-ejection",
]);

const stringArray = (value) =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry.length > 0);

const validateModulePathRules = ({ label, rules, property, allowedValues, findings }) => {
  if (!Array.isArray(rules) || rules.length === 0) {
    findings.push(`${moduleBucketRegistryPath}:${label}: must be a non-empty array`);
    return;
  }
  const seen = new Set();
  let hasCatchAll = false;
  for (const [index, rule] of rules.entries()) {
    const ruleLabel = `${moduleBucketRegistryPath}:${label}[${index}]`;
    if (!isRecord(rule)) {
      findings.push(`${ruleLabel}: rule must be an object`);
      continue;
    }
    if (typeof rule.id !== "string" || rule.id.length === 0) {
      findings.push(`${ruleLabel}: id must be a non-empty string`);
    } else if (seen.has(rule.id)) {
      findings.push(`${ruleLabel}: duplicate id ${rule.id}`);
    } else {
      seen.add(rule.id);
    }
    if (!modulePathRuleMatchKinds.has(rule.match)) {
      findings.push(
        `${ruleLabel}: match must be one of ${[...modulePathRuleMatchKinds].join(", ")}`,
      );
    }
    if (rule.match === "all") {
      hasCatchAll = true;
    } else if (typeof rule.value !== "string" || rule.value.length === 0) {
      findings.push(`${ruleLabel}: value must be a non-empty string`);
    }
    if (rule.match === "regex" && typeof rule.value === "string") {
      try {
        new RegExp(rule.value, "u");
      } catch (error) {
        findings.push(`${ruleLabel}: regex is invalid: ${error.message}`);
      }
    }
    if (typeof rule[property] !== "string" || !allowedValues.has(rule[property])) {
      findings.push(`${ruleLabel}: ${property} must reference a declared ${property}`);
    }
  }
  if (!hasCatchAll) {
    findings.push(`${moduleBucketRegistryPath}:${label}: final catch-all rule is required`);
  }
};

export const moduleBucketRegistryFindings = (registry) => {
  const findings = [];
  if (!isRecord(registry)) return [`${moduleBucketRegistryPath}: registry must be a JSON object`];
  if (registry.schemaVersion !== 1) {
    findings.push(`${moduleBucketRegistryPath}: schemaVersion must be 1`);
  }
  if (!isRecord(registry.policy)) {
    findings.push(`${moduleBucketRegistryPath}: policy object is required`);
  } else {
    for (const key of ["classification", "ambientIsolation", "productBucket"]) {
      if (typeof registry.policy[key] !== "string" || registry.policy[key].length === 0) {
        findings.push(`${moduleBucketRegistryPath}: policy.${key} must be a non-empty string`);
      }
    }
  }

  const bucketIds = new Set();
  if (!Array.isArray(registry.buckets) || registry.buckets.length === 0) {
    findings.push(`${moduleBucketRegistryPath}: buckets must be a non-empty array`);
  } else {
    const ranks = new Set();
    for (const [index, bucket] of registry.buckets.entries()) {
      const label = `${moduleBucketRegistryPath}:buckets[${index}]`;
      if (!isRecord(bucket)) {
        findings.push(`${label}: bucket must be an object`);
        continue;
      }
      if (typeof bucket.id !== "string" || bucket.id.length === 0) {
        findings.push(`${label}: id must be a non-empty string`);
      } else if (bucketIds.has(bucket.id)) {
        findings.push(`${label}: duplicate id ${bucket.id}`);
      } else {
        bucketIds.add(bucket.id);
      }
      if (!Number.isInteger(bucket.rank) || bucket.rank < 0) {
        findings.push(`${label}: rank must be a non-negative integer`);
      } else if (ranks.has(bucket.rank)) {
        findings.push(`${label}: duplicate rank ${bucket.rank}`);
      } else {
        ranks.add(bucket.rank);
      }
      if (typeof bucket.description !== "string" || bucket.description.length === 0) {
        findings.push(`${label}: description must be a non-empty string`);
      }
      if ("ejection" in bucket && typeof bucket.ejection !== "boolean") {
        findings.push(`${label}: ejection must be boolean when present`);
      }
    }
  }

  const ambientIds = new Set();
  if (!Array.isArray(registry.ambients) || registry.ambients.length === 0) {
    findings.push(`${moduleBucketRegistryPath}: ambients must be a non-empty array`);
  } else {
    for (const [index, ambient] of registry.ambients.entries()) {
      const label = `${moduleBucketRegistryPath}:ambients[${index}]`;
      if (!isRecord(ambient)) {
        findings.push(`${label}: ambient must be an object`);
        continue;
      }
      if (typeof ambient.id !== "string" || ambient.id.length === 0) {
        findings.push(`${label}: id must be a non-empty string`);
      } else if (ambientIds.has(ambient.id)) {
        findings.push(`${label}: duplicate id ${ambient.id}`);
      } else {
        ambientIds.add(ambient.id);
      }
      if (!stringArray(ambient.allowedImports)) {
        findings.push(`${label}: allowedImports must be a non-empty string array`);
      }
    }
    for (const [index, ambient] of registry.ambients.entries()) {
      if (!isRecord(ambient) || !Array.isArray(ambient.allowedImports)) continue;
      for (const target of ambient.allowedImports) {
        if (!ambientIds.has(target)) {
          findings.push(
            `${moduleBucketRegistryPath}:ambients[${index}]: allowedImports references unknown ambient ${target}`,
          );
        }
      }
    }
  }

  validateModulePathRules({
    label: "bucketRules",
    rules: registry.bucketRules,
    property: "bucket",
    allowedValues: bucketIds,
    findings,
  });
  validateModulePathRules({
    label: "ambientRules",
    rules: registry.ambientRules,
    property: "ambient",
    allowedValues: ambientIds,
    findings,
  });

  if (!Array.isArray(registry.externalAmbients)) {
    findings.push(`${moduleBucketRegistryPath}: externalAmbients must be an array`);
  } else {
    const seen = new Set();
    for (const [index, rule] of registry.externalAmbients.entries()) {
      const label = `${moduleBucketRegistryPath}:externalAmbients[${index}]`;
      if (!isRecord(rule)) {
        findings.push(`${label}: rule must be an object`);
        continue;
      }
      if (typeof rule.id !== "string" || rule.id.length === 0) {
        findings.push(`${label}: id must be a non-empty string`);
      } else if (seen.has(rule.id)) {
        findings.push(`${label}: duplicate id ${rule.id}`);
      } else {
        seen.add(rule.id);
      }
      if (!moduleSpecifierRuleMatchKinds.has(rule.match)) {
        findings.push(
          `${label}: match must be one of ${[...moduleSpecifierRuleMatchKinds].join(", ")}`,
        );
      }
      if (typeof rule.value !== "string" || rule.value.length === 0) {
        findings.push(`${label}: value must be a non-empty string`);
      }
      if (typeof rule.ambient !== "string" || !ambientIds.has(rule.ambient)) {
        findings.push(`${label}: ambient must reference a declared ambient`);
      }
    }
  }

  if (!isRecord(registry.reportMode)) {
    findings.push(`${moduleBucketRegistryPath}: reportMode object is required`);
  } else {
    if (
      typeof registry.reportMode.enforcement !== "string" ||
      registry.reportMode.enforcement.length === 0
    ) {
      findings.push(
        `${moduleBucketRegistryPath}: reportMode.enforcement must be a non-empty string`,
      );
    }
    if (!stringArray(registry.reportMode.findingKinds)) {
      findings.push(
        `${moduleBucketRegistryPath}: reportMode.findingKinds must be a non-empty string array`,
      );
    } else {
      for (const kind of registry.reportMode.findingKinds) {
        if (!moduleBucketFindingKinds.has(kind)) {
          findings.push(
            `${moduleBucketRegistryPath}: reportMode.findingKinds contains unknown kind ${kind}`,
          );
        }
      }
    }
  }
  return findings;
};

const distributionRootsRegistryPath = "architecture/distribution-roots.json";
const packageUnitsRegistryPath = "architecture/package-units.json";

const architectureStringRecordArray = (value) =>
  Array.isArray(value) && value.every((entry) => isRecord(entry));

const validateStringRefs = ({ label, values, allowed, noun, findings }) => {
  if (!stringArray(values)) {
    findings.push(`${label}: must be a non-empty string array`);
    return;
  }
  for (const value of values) {
    if (!allowed.has(value)) findings.push(`${label}: unknown ${noun} ${value}`);
  }
};

const validatePeerEntries = ({ label, peers, findings }) => {
  if (!Array.isArray(peers)) {
    findings.push(`${label}: requiredPeers must be an array`);
    return;
  }
  for (const [index, peer] of peers.entries()) {
    const peerLabel = `${label}.requiredPeers[${index}]`;
    if (!isRecord(peer)) {
      findings.push(`${peerLabel}: peer must be an object`);
      continue;
    }
    if (typeof peer.name !== "string" || peer.name.length === 0) {
      findings.push(`${peerLabel}: name must be a non-empty string`);
    }
    if (typeof peer.range !== "string" || peer.range.length === 0) {
      findings.push(`${peerLabel}: range must be a non-empty string`);
    }
  }
};

export const packageUnitsRegistryFindings = ({
  registry,
  bucketIds,
  ambientIds,
  targetProfileIds = new Set(),
}) => {
  const findings = [];
  if (!isRecord(registry)) return [`${packageUnitsRegistryPath}: registry must be a JSON object`];
  if (registry.schemaVersion !== 1) {
    findings.push(`${packageUnitsRegistryPath}: schemaVersion must be 1`);
  }
  if (!isRecord(registry.policy)) {
    findings.push(`${packageUnitsRegistryPath}: policy object is required`);
  } else {
    for (const key of ["packageBoundary", "namespaceSplit", "effectPeer"]) {
      if (typeof registry.policy[key] !== "string" || registry.policy[key].length === 0) {
        findings.push(`${packageUnitsRegistryPath}: policy.${key} must be a non-empty string`);
      }
    }
  }
  if (!architectureStringRecordArray(registry.packageUnits) || registry.packageUnits.length === 0) {
    findings.push(`${packageUnitsRegistryPath}: packageUnits must be a non-empty object array`);
    return findings;
  }
  const ids = new Set();
  const publicNames = new Set();
  for (const [index, unit] of registry.packageUnits.entries()) {
    const label = `${packageUnitsRegistryPath}:packageUnits[${index}]`;
    if (typeof unit.id !== "string" || unit.id.length === 0) {
      findings.push(`${label}: id must be a non-empty string`);
    } else if (ids.has(unit.id)) {
      findings.push(`${label}: duplicate id ${unit.id}`);
    } else {
      ids.add(unit.id);
    }
    if (
      typeof unit.targetSourcePackageName !== "string" ||
      !unit.targetSourcePackageName.startsWith("@agent-os/")
    ) {
      findings.push(`${label}: targetSourcePackageName must be an @agent-os/* string`);
    }
    if (
      typeof unit.publicPackageName !== "string" ||
      !unit.publicPackageName.startsWith("@yansirplus/")
    ) {
      findings.push(`${label}: publicPackageName must be an @yansirplus/* string`);
    } else if (publicNames.has(unit.publicPackageName)) {
      findings.push(`${label}: duplicate publicPackageName ${unit.publicPackageName}`);
    } else {
      publicNames.add(unit.publicPackageName);
    }
    if (typeof unit.status !== "string" || unit.status.length === 0) {
      findings.push(`${label}: status must be a non-empty string`);
    }

    if (!isRecord(unit.hardInstallEnvelope)) {
      findings.push(`${label}: hardInstallEnvelope object is required`);
    } else {
      for (const key of [
        "dependencies",
        "installScripts",
        "nativeArtifacts",
        "packageWideMetadata",
      ]) {
        if (!Array.isArray(unit.hardInstallEnvelope[key])) {
          findings.push(`${label}: hardInstallEnvelope.${key} must be an array`);
        }
      }
      validatePeerEntries({
        label: `${label}:hardInstallEnvelope`,
        peers: unit.hardInstallEnvelope.requiredPeers,
        findings,
      });
    }

    validateStringRefs({
      label: `${label}: runtimeConditions`,
      values: unit.runtimeConditions,
      allowed: ambientIds,
      noun: "ambient",
      findings,
    });
    if (targetProfileIds.size > 0) {
      validateStringRefs({
        label: `${label}: targetProfiles`,
        values: unit.targetProfiles,
        allowed: targetProfileIds,
        noun: "targetProfile",
        findings,
      });
    } else if (!stringArray(unit.targetProfiles)) {
      findings.push(`${label}: targetProfiles must be a non-empty string array`);
    }

    if (!architectureStringRecordArray(unit.publicSubpaths) || unit.publicSubpaths.length === 0) {
      findings.push(`${label}: publicSubpaths must be a non-empty object array`);
      continue;
    }
    const subpaths = new Set();
    for (const [subpathIndex, subpath] of unit.publicSubpaths.entries()) {
      const subpathLabel = `${label}:publicSubpaths[${subpathIndex}]`;
      if (
        typeof subpath.subpath !== "string" ||
        (subpath.subpath !== "." && !subpath.subpath.startsWith("./"))
      ) {
        findings.push(`${subpathLabel}: subpath must be . or ./name`);
      } else if (subpaths.has(subpath.subpath)) {
        findings.push(`${subpathLabel}: duplicate subpath ${subpath.subpath}`);
      } else {
        subpaths.add(subpath.subpath);
      }
      validateStringRefs({
        label: `${subpathLabel}: moduleBuckets`,
        values: subpath.moduleBuckets,
        allowed: bucketIds,
        noun: "bucket",
        findings,
      });
      if (!Array.isArray(subpath.optionalPeers)) {
        findings.push(`${subpathLabel}: optionalPeers must be an array`);
      } else if (
        !subpath.optionalPeers.every((peer) => typeof peer === "string" && peer.length > 0)
      ) {
        findings.push(`${subpathLabel}: optionalPeers entries must be non-empty strings`);
      }
    }
  }
  return findings;
};

export const distributionRootsRegistryFindings = ({ registry, packageUnitIds, ambientIds }) => {
  const findings = [];
  if (!isRecord(registry)) {
    return [`${distributionRootsRegistryPath}: registry must be a JSON object`];
  }
  if (registry.schemaVersion !== 1) {
    findings.push(`${distributionRootsRegistryPath}: schemaVersion must be 1`);
  }
  if (!isRecord(registry.policy)) {
    findings.push(`${distributionRootsRegistryPath}: policy object is required`);
  } else {
    for (const key of ["rootTruth", "dogfoodWitness", "targetSelection"]) {
      if (typeof registry.policy[key] !== "string" || registry.policy[key].length === 0) {
        findings.push(`${distributionRootsRegistryPath}: policy.${key} must be a non-empty string`);
      }
    }
  }

  if (!architectureStringRecordArray(registry.roots) || registry.roots.length === 0) {
    findings.push(`${distributionRootsRegistryPath}: roots must be a non-empty object array`);
  } else {
    const ids = new Set();
    for (const [index, root] of registry.roots.entries()) {
      const label = `${distributionRootsRegistryPath}:roots[${index}]`;
      if (typeof root.id !== "string" || root.id.length === 0) {
        findings.push(`${label}: id must be a non-empty string`);
      } else if (ids.has(root.id)) {
        findings.push(`${label}: duplicate id ${root.id}`);
      } else {
        ids.add(root.id);
      }
      if (root.kind !== "public-package") {
        findings.push(`${label}: kind must be public-package`);
      }
      if (typeof root.packageUnit !== "string" || !packageUnitIds.has(root.packageUnit)) {
        findings.push(`${label}: packageUnit must reference a package unit`);
      }
      if (
        typeof root.publicPackageName !== "string" ||
        !root.publicPackageName.startsWith("@yansirplus/")
      ) {
        findings.push(`${label}: publicPackageName must be an @yansirplus/* string`);
      }
      if (typeof root.consumerRoot !== "string" || root.consumerRoot.length === 0) {
        findings.push(`${label}: consumerRoot must be a non-empty string`);
      }
    }
  }

  if (
    !architectureStringRecordArray(registry.targetProfiles) ||
    registry.targetProfiles.length === 0
  ) {
    findings.push(
      `${distributionRootsRegistryPath}: targetProfiles must be a non-empty object array`,
    );
  } else {
    const ids = new Set();
    for (const [index, profile] of registry.targetProfiles.entries()) {
      const label = `${distributionRootsRegistryPath}:targetProfiles[${index}]`;
      if (typeof profile.id !== "string" || profile.id.length === 0) {
        findings.push(`${label}: id must be a non-empty string`);
      } else if (ids.has(profile.id)) {
        findings.push(`${label}: duplicate id ${profile.id}`);
      } else {
        ids.add(profile.id);
      }
      if (typeof profile.ambient !== "string" || !ambientIds.has(profile.ambient)) {
        findings.push(`${label}: ambient must reference a module ambient`);
      }
      validateStringRefs({
        label: `${label}: packageUnits`,
        values: profile.packageUnits,
        allowed: packageUnitIds,
        noun: "packageUnit",
        findings,
      });
      if (!stringArray(profile.selectedSubpaths)) {
        findings.push(`${label}: selectedSubpaths must be a non-empty string array`);
      }
      if (!Array.isArray(profile.forbiddenSpecifiers)) {
        findings.push(`${label}: forbiddenSpecifiers must be an array`);
      } else if (
        !profile.forbiddenSpecifiers.every(
          (specifier) => typeof specifier === "string" && specifier.length > 0,
        )
      ) {
        findings.push(`${label}: forbiddenSpecifiers entries must be non-empty strings`);
      }
    }
  }

  if (!architectureStringRecordArray(registry.dogfoodRoots) || registry.dogfoodRoots.length === 0) {
    findings.push(
      `${distributionRootsRegistryPath}: dogfoodRoots must be a non-empty object array`,
    );
  } else {
    for (const [index, root] of registry.dogfoodRoots.entries()) {
      const label = `${distributionRootsRegistryPath}:dogfoodRoots[${index}]`;
      for (const key of ["id", "kind", "path", "witnessLevel", "gate"]) {
        if (typeof root[key] !== "string" || root[key].length === 0) {
          findings.push(`${label}: ${key} must be a non-empty string`);
        }
      }
      if (!stringArray(root.requiredCapabilities)) {
        findings.push(`${label}: requiredCapabilities must be a non-empty string array`);
      }
    }
  }
  return findings;
};

export const moduleBucketFindingsForEdges = (edges) => {
  const findings = [];
  const rankByBucket = moduleBucketRank();
  const importsByAmbient = allowedAmbientImports();
  for (const edge of edges) {
    const fromBucket = moduleBucketForPath(edge.fromFile);
    const toBucket = moduleBucketForPath(edge.toFile);
    const fromRank = rankByBucket.get(fromBucket);
    const toRank = rankByBucket.get(toBucket);
    if (fromRank !== undefined && toRank !== undefined && fromRank < toRank) {
      findings.push({
        kind: "bucket-dag",
        file: edge.fromFile,
        target: edge.toFile,
        specifier: edge.specifier,
        message: `${fromBucket} module imports downstream ${toBucket} module`,
      });
    }

    const fromAmbient = moduleAmbientForPath(edge.fromFile);
    const toAmbient = moduleAmbientForPath(edge.toFile);
    if (!(importsByAmbient.get(fromAmbient) ?? new Set()).has(toAmbient)) {
      findings.push({
        kind: "ambient-dag",
        file: edge.fromFile,
        target: edge.toFile,
        specifier: edge.specifier,
        message: `${fromAmbient} module imports ${toAmbient} module`,
      });
    }
  }
  return findings;
};

const moduleBucketExternalFindings = (records) => {
  const findings = [];
  const importsByAmbient = allowedAmbientImports();
  for (const record of records) {
    for (const file of walk(`${record.path}/src`).filter((entry) =>
      /\.(?:ts|tsx|mts|cts)$/u.test(entry),
    )) {
      const source = read(file);
      const ambient = moduleAmbientForPath(file);
      for (const importRecord of importSpecifierRecords(source, file)) {
        const targetAmbient = externalAmbientForSpecifier(importRecord.specifier);
        if (targetAmbient === undefined) continue;
        if ((importsByAmbient.get(ambient) ?? new Set()).has(targetAmbient)) continue;
        findings.push({
          kind: "external-ambient",
          file,
          target: targetAmbient,
          specifier: importRecord.specifier,
          message: `${ambient} module imports ${targetAmbient} external specifier`,
        });
      }
    }
  }
  return findings;
};

const moduleProductFindings = (graph) => {
  const ejection = ejectionBuckets();
  return graph.files
    .filter((entry) => ejection.has(moduleBucketForPath(entry.file)))
    .map((entry) => ({
      kind: "product-ejection",
      file: entry.file,
      target: "consumer",
      specifier: entry.package.name,
      message: "product bucket module must be ejected from final substrate",
    }));
};

const checkModuleBuckets = (args = []) => {
  const reportOnly = args.length === 1 && args[0] === "--report-only";
  if (!reportOnly && args.length > 0) {
    throw new Error(`module-buckets: unexpected argument(s): ${args.join(" ")}`);
  }
  const records = graphWorkspacePackageRecords(repoRoot).filter(
    (record) => typeof record.name === "string" && record.name.startsWith("@agent-os/"),
  );
  const graph = sourceModuleGraph(repoRoot, records);
  const rawFindings = [
    ...moduleBucketFindingsForEdges(graph.edges),
    ...moduleBucketExternalFindings(records),
    ...moduleProductFindings(graph),
  ];
  const seenFindings = new Set();
  const findings = rawFindings
    .filter((finding) => {
      const key = `${finding.kind}\0${finding.file}\0${finding.target}\0${finding.specifier}\0${finding.message}`;
      if (seenFindings.has(key)) return false;
      seenFindings.add(key);
      return true;
    })
    .sort(
      (left, right) =>
        compare(left.kind, right.kind) ||
        compare(left.file, right.file) ||
        compare(left.specifier, right.specifier),
    );
  const bucketCounts = new Map();
  const ambientCounts = new Map();
  for (const entry of graph.files) {
    const bucket = moduleBucketForPath(entry.file);
    const ambient = moduleAmbientForPath(entry.file);
    bucketCounts.set(bucket, (bucketCounts.get(bucket) ?? 0) + 1);
    ambientCounts.set(ambient, (ambientCounts.get(ambient) ?? 0) + 1);
  }
  const sortedEntries = (counts) =>
    [...counts.entries()].sort(([left], [right]) => compare(left, right));
  const summary = `module buckets report-only: ${findings.length} finding(s); buckets ${JSON.stringify(Object.fromEntries(sortedEntries(bucketCounts)))}; ambients ${JSON.stringify(Object.fromEntries(sortedEntries(ambientCounts)))}`;
  const lines = findings.map(
    (finding) =>
      `${finding.file}: module-buckets:${finding.kind}: ${finding.message} via ${finding.specifier} -> ${finding.target}`,
  );
  if (reportOnly) {
    console.log(summary);
    for (const line of lines) console.log(line);
    return;
  }
  failIfAny("module buckets", lines);
};

const architectureSourceFindings = () => {
  const workspacePackageNames = new Set(
    graphWorkspacePackageRecords(repoRoot)
      .map((record) => record.name)
      .filter((name) => typeof name === "string" && name.startsWith("@agent-os/")),
  );
  const moduleBuckets = moduleBucketRegistry();
  const packageUnits = readJson(packageUnitsRegistryPath);
  const distributionRoots = readJson(distributionRootsRegistryPath);
  const bucketIds = new Set(
    Array.isArray(moduleBuckets.buckets) ? moduleBuckets.buckets.map((bucket) => bucket.id) : [],
  );
  const ambientIds = new Set(
    Array.isArray(moduleBuckets.ambients)
      ? moduleBuckets.ambients.map((ambient) => ambient.id)
      : [],
  );
  const packageUnitIds = new Set(
    Array.isArray(packageUnits.packageUnits)
      ? packageUnits.packageUnits.map((unit) => unit.id)
      : [],
  );
  const targetProfileIds = new Set(
    Array.isArray(distributionRoots.targetProfiles)
      ? distributionRoots.targetProfiles.map((profile) => profile.id)
      : [],
  );
  return [
    ...ownerIdRegistryFindings({ registry: ownerIdRegistry(), workspacePackageNames }),
    ...moduleBucketRegistryFindings(moduleBuckets),
    ...packageUnitsRegistryFindings({
      registry: packageUnits,
      bucketIds,
      ambientIds,
      targetProfileIds,
    }),
    ...distributionRootsRegistryFindings({
      registry: distributionRoots,
      packageUnitIds,
      ambientIds,
    }),
  ];
};

const checkArchitectureSources = () => {
  failIfAny("architecture sources", architectureSourceFindings());
};

const distributionInstallScriptNames = new Set(["install", "postinstall", "preinstall", "prepare"]);
const distributionPackageWideMetadataFields = ["engines", "os", "cpu", "libc"];
const distributionNativeToolPattern =
  /\b(?:node-gyp|prebuild(?:ify|-install)?|cmake-js|node-pre-gyp)\b/u;
const distributionNativeFilePattern = /(?:^|\/)(?:binding\.gyp|CMakeLists\.txt)$|\.node$/u;
const distributionSourcePattern = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|d\.ts)$/u;

const distributionFinding = ({
  kind,
  severity = "splitter",
  file,
  packageName,
  message,
  specifier,
  target,
  line,
  column,
}) => ({
  kind,
  severity,
  file,
  packageName,
  message,
  specifier,
  target,
  line,
  column,
});

const manifestSectionEntries = (manifest, section) =>
  Object.entries(isRecord(manifest[section]) ? manifest[section] : {}).sort(([left], [right]) =>
    compare(left, right),
  );

const isInternalPackageDependency = (name) => name.startsWith("@agent-os/");

const optionalPeerNames = (manifest) =>
  new Set(
    manifestSectionEntries(manifest, "peerDependencies")
      .filter(([name]) => manifest.peerDependenciesMeta?.[name]?.optional === true)
      .map(([name]) => name),
  );

const peerSpecifierMatches = (specifier, peerName) =>
  specifier === peerName || specifier.startsWith(`${peerName}/`);

export const distributionManifestFindings = (record, manifest, packageFiles = []) => {
  const findings = [];
  const packageJson = `${record.path}/package.json`;

  for (const [scriptName, scriptValue] of manifestSectionEntries(manifest, "scripts")) {
    if (!distributionInstallScriptNames.has(scriptName)) continue;
    findings.push(
      distributionFinding({
        kind: "package-install-script",
        file: packageJson,
        packageName: record.name,
        message: `package-wide ${scriptName} script executes during install lifecycle`,
        target: scriptValue,
      }),
    );
  }

  if (manifest.gypfile !== undefined) {
    findings.push(
      distributionFinding({
        kind: "native-marker",
        file: packageJson,
        packageName: record.name,
        message: "package manifest declares gypfile native build metadata",
        target: String(manifest.gypfile),
      }),
    );
  }
  for (const file of packageFiles.filter((entry) => distributionNativeFilePattern.test(entry))) {
    findings.push(
      distributionFinding({
        kind: "native-marker",
        file,
        packageName: record.name,
        message: "package contains native build or native artifact marker",
        target: path.basename(file),
      }),
    );
  }
  for (const section of ["dependencies", "optionalDependencies", "devDependencies"]) {
    for (const [name, version] of manifestSectionEntries(manifest, section)) {
      if (!distributionNativeToolPattern.test(`${name} ${String(version)}`)) continue;
      findings.push(
        distributionFinding({
          kind: "native-tool-dependency",
          severity: section === "devDependencies" ? "info" : "splitter",
          file: packageJson,
          packageName: record.name,
          message: `${section}.${name} carries native build tooling`,
          specifier: name,
          target: version,
        }),
      );
    }
  }

  for (const field of distributionPackageWideMetadataFields) {
    if (manifest[field] === undefined) continue;
    findings.push(
      distributionFinding({
        kind: "package-wide-metadata",
        file: packageJson,
        packageName: record.name,
        message: `${field} is a package-wide install constraint and cannot be subpath-localized`,
        target: JSON.stringify(manifest[field]),
      }),
    );
  }

  for (const section of ["dependencies", "optionalDependencies"]) {
    for (const [name, version] of manifestSectionEntries(manifest, section)) {
      if (isInternalPackageDependency(name)) continue;
      findings.push(
        distributionFinding({
          kind: "hard-dependency",
          file: packageJson,
          packageName: record.name,
          message: `${section}.${name} is installed for every consumer of the package`,
          specifier: name,
          target: version,
        }),
      );
    }
  }

  for (const [name, version] of manifestSectionEntries(manifest, "peerDependencies")) {
    const optional = manifest.peerDependenciesMeta?.[name]?.optional === true;
    findings.push(
      distributionFinding({
        kind: optional ? "optional-peer" : "required-peer",
        severity: optional ? "info" : "splitter",
        file: packageJson,
        packageName: record.name,
        message: optional
          ? `${name} is localizable when every import remains behind explicit subpath exports`
          : `${name} is a package-wide peer obligation`,
        specifier: name,
        target: version,
      }),
    );
  }

  return findings;
};

const distributionScriptKindForFile = (file) => {
  if (file.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (file.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (file.endsWith(".js") || file.endsWith(".mjs") || file.endsWith(".cjs")) {
    return ts.ScriptKind.JS;
  }
  return ts.ScriptKind.TS;
};

const distributionNodePosition = (sourceFile, node) => {
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return { line: position.line + 1, column: position.character + 1 };
};

const distributionExpressionText = (sourceFile, node) =>
  node.getText(sourceFile).replace(/\s+/gu, " ").slice(0, 160);

const distributionExpressionName = (expression) => {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return undefined;
};

const distributionRootIdentifier = (node) => {
  let current = node;
  while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    current = current.expression;
  }
  return ts.isIdentifier(current) ? current.text : undefined;
};

const distributionTouchesAmbientGlobal = (node) => {
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    const root = distributionRootIdentifier(node);
    const text = node.getText();
    if (root === "globalThis" || root === "window" || root === "document") return true;
    if (root === "process" && text.startsWith("process.env")) return true;
  }
  let found = false;
  ts.forEachChild(node, (child) => {
    if (!found && distributionTouchesAmbientGlobal(child)) found = true;
  });
  return found;
};

const distributionContainsLoadSideEffect = (node) => {
  if (
    ts.isArrowFunction(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isClassExpression(node)
  ) {
    return false;
  }
  if (ts.isBinaryExpression(node) && distributionTouchesAmbientGlobal(node.left)) return true;
  if (
    (ts.isPostfixUnaryExpression(node) || ts.isPrefixUnaryExpression(node)) &&
    distributionTouchesAmbientGlobal(node.operand)
  ) {
    return true;
  }
  if (
    ts.isCallExpression(node) &&
    [
      "exec",
      "execFile",
      "fork",
      "mkdirSync",
      "rmSync",
      "spawn",
      "spawnSync",
      "writeFileSync",
    ].includes(distributionExpressionName(node.expression) ?? "")
  ) {
    return true;
  }
  if (
    ts.isNewExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "Worker"
  ) {
    return true;
  }
  let found = false;
  ts.forEachChild(node, (child) => {
    if (!found && distributionContainsLoadSideEffect(child)) found = true;
  });
  return found;
};

export const distributionSourceProbeFindingsForSource = (content, file, packageName) => {
  const sourceFile = ts.createSourceFile(
    file,
    content,
    ts.ScriptTarget.Latest,
    true,
    distributionScriptKindForFile(file),
  );
  const findings = [];
  const recordNode = (kind, node, message) => {
    const position = distributionNodePosition(sourceFile, node);
    findings.push(
      distributionFinding({
        kind,
        file,
        packageName,
        message,
        target: distributionExpressionText(sourceFile, node),
        line: position.line,
        column: position.column,
      }),
    );
  };
  const visitAugmentation = (node) => {
    if (ts.isModuleDeclaration(node)) {
      if (node.name.kind === ts.SyntaxKind.GlobalKeyword) {
        recordNode("global-type-augmentation", node, "source declares global type augmentation");
      } else if (ts.isStringLiteralLike(node.name)) {
        recordNode("module-type-augmentation", node, "source declares module type augmentation");
      } else if (ts.isIdentifier(node.name) && node.name.text === "NodeJS") {
        recordNode("global-type-augmentation", node, "source augments NodeJS namespace types");
      }
    }
    if (
      ts.isInterfaceDeclaration(node) &&
      ["Document", "ImportMeta", "ProcessEnv", "Window"].includes(node.name.text)
    ) {
      recordNode("global-type-augmentation", node, `source declares ambient ${node.name.text}`);
    }
    ts.forEachChild(node, visitAugmentation);
  };
  visitAugmentation(sourceFile);

  for (const statement of sourceFile.statements) {
    if (
      (ts.isExpressionStatement(statement) &&
        distributionContainsLoadSideEffect(statement.expression)) ||
      (ts.isVariableStatement(statement) && distributionContainsLoadSideEffect(statement))
    ) {
      recordNode(
        "package-load-side-effect",
        statement,
        "top-level source touches ambient process/global state or host execution",
      );
    }
  }
  return findings;
};

const distributionExportTargets = (target) => {
  if (typeof target === "string") return [target];
  if (!isRecord(target)) return [];
  return Object.values(target).flatMap((value) => distributionExportTargets(value));
};

const distributionExportEntries = (record, manifest) => {
  const exportsValue = manifest.exports;
  if (exportsValue === undefined) {
    return fs.existsSync(path.join(repoRoot, record.path, "src/index.ts"))
      ? [{ subpath: ".", targets: [`${record.path}/src/index.ts`] }]
      : [];
  }
  const entries = isRecord(exportsValue) ? Object.entries(exportsValue) : [[".", exportsValue]];
  return entries
    .map(([subpath, target]) => ({
      subpath,
      targets: distributionExportTargets(target)
        .filter((entry) => entry.startsWith("./"))
        .map((entry) => path.join(record.path, entry).split(path.sep).join("/"))
        .filter((entry) => distributionSourcePattern.test(entry)),
    }))
    .filter((entry) => entry.targets.length > 0)
    .sort((left, right) => compare(left.subpath, right.subpath));
};

const distributionClosureForRoots = (roots, edges) => {
  const byFrom = new Map();
  for (const edge of edges) {
    byFrom.set(edge.fromFile, [...(byFrom.get(edge.fromFile) ?? []), edge.toFile]);
  }
  const visited = new Set();
  const pending = [...roots].sort(compare);
  while (pending.length > 0) {
    const file = pending.shift();
    if (file === undefined || visited.has(file)) continue;
    visited.add(file);
    for (const target of byFrom.get(file) ?? []) {
      if (!visited.has(target)) pending.push(target);
    }
    pending.sort(compare);
  }
  return visited;
};

const distributionPeerImportsInFiles = (sourceByFile, files, peerNames) => {
  const imports = [];
  for (const file of [...files].sort(compare)) {
    const source = sourceByFile.get(file);
    if (source === undefined) continue;
    for (const importRecord of importSpecifierRecords(source, file)) {
      for (const peerName of peerNames) {
        if (!peerSpecifierMatches(importRecord.specifier, peerName)) continue;
        imports.push({ file, peerName, ...importRecord });
      }
    }
  }
  return imports;
};

export const distributionSubpathFindings = ({ record, manifest, sourceByFile, edges }) => {
  const optionalPeers = optionalPeerNames(manifest);
  if (optionalPeers.size === 0) return [];
  const exportEntries = distributionExportEntries(record, manifest);
  const samePackageEdges = edges.filter(
    (edge) => edge.from.name === record.name && edge.to.name === record.name,
  );
  const findings = [];
  const rootEntry = exportEntries.find((entry) => entry.subpath === ".");
  const rootClosure =
    rootEntry === undefined
      ? new Set()
      : distributionClosureForRoots(rootEntry.targets, samePackageEdges);
  for (const importRecord of distributionPeerImportsInFiles(
    sourceByFile,
    rootClosure,
    optionalPeers,
  )) {
    const typeOnly =
      importRecord.importKind === "type" ||
      importRecord.syntaxKind === "import-type" ||
      importRecord.syntaxKind === "export";
    findings.push(
      distributionFinding({
        kind: typeOnly ? "root-dts-peer-type-leak" : "root-subpath-peer-leak",
        file: importRecord.file,
        packageName: record.name,
        message: `package root closure reaches optional peer ${importRecord.peerName}; move it behind an explicit subpath`,
        specifier: importRecord.specifier,
        target: rootEntry?.subpath ?? ".",
        line: importRecord.line,
        column: importRecord.column,
      }),
    );
  }

  for (const peerName of [...optionalPeers].sort(compare)) {
    const subpaths = [];
    for (const entry of exportEntries.filter((candidate) => candidate.subpath !== ".")) {
      const closure = distributionClosureForRoots(entry.targets, samePackageEdges);
      const imports = distributionPeerImportsInFiles(sourceByFile, closure, new Set([peerName]));
      if (imports.length > 0) subpaths.push(entry.subpath);
    }
    if (subpaths.length === 0) continue;
    findings.push(
      distributionFinding({
        kind: "optional-peer-locality",
        severity: "info",
        file: `${record.path}/package.json`,
        packageName: record.name,
        message: `${peerName} is only needed by explicit subpath closure(s)`,
        specifier: peerName,
        target: subpaths.join(", "),
      }),
    );
  }

  return findings;
};

export const distributionFindingsForPackage = ({
  record,
  manifest,
  packageFiles = [],
  sourceByFile = new Map(),
  edges = [],
}) => [
  ...distributionManifestFindings(record, manifest, packageFiles),
  ...[...sourceByFile.entries()].flatMap(([file, source]) =>
    distributionSourceProbeFindingsForSource(source, file, record.name),
  ),
  ...distributionSubpathFindings({ record, manifest, sourceByFile, edges }),
];

export const distributionEffectPeerFindings = (records) => {
  const ranges = new Map();
  const findings = [];
  for (const { record, manifest } of records) {
    const range = manifest.peerDependencies?.effect;
    if (typeof range !== "string") continue;
    ranges.set(range, [...(ranges.get(range) ?? []), record]);
  }
  if (ranges.size <= 1) return findings;
  const expected = [...ranges.keys()].sort(compare)[0];
  for (const [range, rangeRecords] of [...ranges.entries()].sort(([left], [right]) =>
    compare(left, right),
  )) {
    if (range === expected) continue;
    for (const record of rangeRecords) {
      findings.push(
        distributionFinding({
          kind: "effect-peer-invariant",
          file: `${record.path}/package.json`,
          packageName: record.name,
          message: `effect peer range ${range} differs from single-source range ${expected}`,
          specifier: "effect",
          target: range,
        }),
      );
    }
  }
  return findings;
};

const formatDistributionFinding = (finding) => {
  const location =
    finding.line === undefined
      ? finding.file
      : `${finding.file}:${finding.line}:${finding.column ?? 1}`;
  const target = finding.target === undefined ? "" : ` -> ${finding.target}`;
  const specifier = finding.specifier === undefined ? "" : ` via ${finding.specifier}`;
  return `${location}: distribution-units:${finding.severity}:${finding.kind}: ${finding.message}${specifier}${target}`;
};

const checkDistributionUnits = (args = []) => {
  const reportOnly = args.length === 1 && args[0] === "--report-only";
  if (!reportOnly && args.length > 0) {
    throw new Error(`distribution-units: unexpected argument(s): ${args.join(" ")}`);
  }
  const records = graphWorkspacePackageRecords(repoRoot).filter(
    (record) => typeof record.name === "string" && record.name.startsWith("@agent-os/"),
  );
  const graph = sourceModuleGraph(repoRoot, records);
  const sourceByFile = new Map(
    graph.files.map((entry) => [
      entry.file,
      fs.readFileSync(path.join(repoRoot, entry.file), "utf8"),
    ]),
  );
  const recordsWithManifests = records.map((record) => ({
    record,
    manifest: readJson(`${record.path}/package.json`),
  }));
  const findings = [
    ...recordsWithManifests.flatMap(({ record, manifest }) => {
      const packageSourceByFile = new Map(
        [...sourceByFile.entries()].filter(([file]) => file.startsWith(`${record.path}/`)),
      );
      return distributionFindingsForPackage({
        record,
        manifest,
        packageFiles: walk(record.path),
        sourceByFile: packageSourceByFile,
        edges: graph.edges,
      });
    }),
    ...distributionEffectPeerFindings(recordsWithManifests),
  ].sort(
    (left, right) =>
      compare(left.severity, right.severity) ||
      compare(left.kind, right.kind) ||
      compare(left.file, right.file) ||
      compare(left.specifier ?? "", right.specifier ?? ""),
  );
  const splitterCount = findings.filter((finding) => finding.severity !== "info").length;
  const infoCount = findings.length - splitterCount;
  const lines = findings.map(formatDistributionFinding);
  if (reportOnly) {
    console.log(
      `distribution units report-only: ${findings.length} finding(s); ${splitterCount} package-wide obligation(s); ${infoCount} localizable observation(s)`,
    );
    for (const line of lines) console.log(line);
    return;
  }
  failIfAny(
    "distribution units",
    findings.filter((finding) => finding.severity !== "info").map(formatDistributionFinding),
  );
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
  const boundaryPath = "tooling/agentos-cli/src/check/sources/client-workspace-host-boundary.md";
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
          ? "workspace host"
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
    if (
      !fs.existsSync(path.join(repoRoot, backend, "test/backend-protocol-contract.test.ts")) &&
      !fs.existsSync(path.join(repoRoot, backend, "test/backend-protocol-contract.runtime.test.ts"))
    ) {
      failures.push(`${backend}: missing backend protocol contract test`);
    }
  }
  failIfAny("backend neutrality", failures);
};

const checkGateTierGovernance = () => {
  const failures = [];
  const gates = readJson("docs/agent/gates.source.json");
  const records = graphWorkspacePackageRecords(repoRoot).filter((record) =>
    record.name?.startsWith("@agent-os/"),
  );
  const proofClassIds = new Set(Object.keys(gates.proofClasses ?? {}));
  for (const required of ["structural", "typecheck", "test", "runtime", "distribution"]) {
    if (!proofClassIds.has(required))
      failures.push(`gates.source.json: missing ${required} proof class`);
  }
  for (const proofClass of gates.expensiveProofClasses ?? []) {
    if (!proofClassIds.has(proofClass))
      failures.push(`gates.source.json: unknown expensive proof ${proofClass}`);
  }
  for (const proofClass of gates.fullAffectedProofClasses ?? []) {
    if (!proofClassIds.has(proofClass))
      failures.push(`gates.source.json: unknown full proof ${proofClass}`);
  }

  const overrideByPath = new Map(
    (gates.packageOverrides ?? []).map((entry) => [entry.path, entry]),
  );
  for (const override of gates.packageOverrides ?? []) {
    if (!records.some((record) => record.path === override.path)) {
      failures.push(
        `gates.source.json: package override references unknown package ${override.path}`,
      );
    }
    for (const proofClass of [
      ...(override.proofClasses ?? []),
      ...(override.affectedProofClasses ?? []),
    ]) {
      if (!proofClassIds.has(proofClass)) {
        failures.push(`${override.path}: unknown proof class ${proofClass}`);
      }
    }
  }

  for (const record of records) {
    const manifest = readJson(`${record.path}/package.json`);
    const override = overrideByPath.get(record.path);
    const fastProof = override?.fastProof ?? gates.defaultPackageProof?.fastProof;
    if (fastProof === undefined) failures.push(`${record.path}: missing fast proof ownership`);
    if (manifest.scripts?.test?.includes("--passWithNoTests") && fastProof !== "none") {
      failures.push(
        `${record.path}: --passWithNoTests requires fastProof none in gates.source.json`,
      );
    }
    if (fastProof === "none") {
      if (!manifest.scripts?.test?.includes("--passWithNoTests")) {
        failures.push(`${record.path}: fastProof none requires explicit --passWithNoTests script`);
      }
      if (!(override?.affectedProofClasses ?? []).includes("runtime")) {
        failures.push(`${record.path}: fastProof none must route affected changes to runtime`);
      }
    }
    if (
      typeof manifest.scripts?.test === "string" &&
      manifest.scripts.test.startsWith("vp test run") &&
      !manifest.scripts.test.includes("*.runtime.test.ts")
    ) {
      failures.push(`${record.path}: fast test script must exclude *.runtime.test.ts`);
    }
  }

  for (const file of walk("packages").filter((entry) => entry.endsWith(".worker.test.ts"))) {
    failures.push(`${file}: runtime tests must use *.runtime.test.ts`);
  }
  const runtimeTestFiles = walk("packages").filter((entry) => entry.endsWith(".runtime.test.ts"));
  for (const file of runtimeTestFiles) {
    const owner = records
      .filter((record) => file === record.path || file.startsWith(`${record.path}/`))
      .sort((left, right) => right.path.length - left.path.length)[0];
    const override = owner === undefined ? undefined : overrideByPath.get(owner.path);
    if (owner === undefined || !(override?.proofClasses ?? []).includes("runtime")) {
      failures.push(`${file}: runtime test has no runtime proof owner`);
    }
  }
  for (const file of walk(".").filter((entry) => entry.endsWith(".tsbuildinfo"))) {
    if (!file.startsWith(".cache/")) failures.push(`${file}: tsbuildinfo must live under .cache/`);
  }

  const sourceEdges = graphPackageSourceImportEdges(repoRoot, records);
  const graphEdges = [
    ...sourceEdges,
    ...packageManifestDependencyEdges(repoRoot, records),
    ...tsconfigReferenceEdges(repoRoot, records),
  ];
  const graphKeys = new Set(graphEdges.map((edge) => `${edge.from.name}->${edge.to.name}`));
  for (const edge of sourceEdges) {
    if (!graphKeys.has(`${edge.from.name}->${edge.to.name}`)) {
      failures.push(`${edge.file}: affected graph is missing source import edge ${edge.specifier}`);
    }
  }

  failIfAny("gate tier governance", failures);
};

const checkSpikeHygiene = () => {
  const tracked = execFileSync("git", ["ls-files", "spikes"], { cwd: repoRoot, encoding: "utf8" })
    .split("\n")
    .map((line) => line.trim())
    .filter((file) => file.length > 0 && fs.existsSync(path.join(repoRoot, file)));
  const allowed = new Set();
  failIfAny(
    "spike hygiene",
    tracked
      .filter((file) => !allowed.has(file))
      .map((file) => `tracked spike file is not allowed: ${file}`),
  );
};

const sliceBetweenMarkers = (source, startMarker, endMarker) => {
  const start = source.indexOf(startMarker);
  if (start === -1) return "";
  const end = source.indexOf(endMarker, start);
  return end === -1 ? source.slice(start) : source.slice(start, end);
};

const checkGeneratedStaticTargetLinking = () => {
  const failures = [];
  const sourcePath = "packages/composers/agent-authoring/src/index.ts";
  const source = read(sourcePath);
  const renderStaticTargetSource = sliceBetweenMarkers(
    source,
    "const renderStaticTarget =",
    "const generatedClientModuleImports =",
  );
  const linkWorkspaceStaticTargetSource = sliceBetweenMarkers(
    source,
    "export const linkWorkspaceStaticTarget =",
    "const renderAgentOsConfigSchema =",
  );
  const renderSvelteKitRemoteSource = sliceBetweenMarkers(
    source,
    "const renderSvelteKitRemote =",
    "const renderStaticClient =",
  );
  const renderStaticClientSource = sliceBetweenMarkers(
    source,
    "const renderStaticClient =",
    "const renderStaticClientTypes =",
  );
  if (renderStaticTargetSource.length === 0) {
    failures.push(`${sourcePath}: generated-static-target-linking: missing renderStaticTarget`);
  }
  if (linkWorkspaceStaticTargetSource.length === 0) {
    failures.push(
      `${sourcePath}: generated-static-target-linking: missing linkWorkspaceStaticTarget`,
    );
  }
  if (renderSvelteKitRemoteSource.length === 0) {
    failures.push(`${sourcePath}: generated-static-target-linking: missing renderSvelteKitRemote`);
  }
  if (renderStaticClientSource.length === 0) {
    failures.push(`${sourcePath}: generated-static-target-linking: missing renderStaticClient`);
  }

  const requiredStaticWiringMarkers = [
    'import semanticDeclarations from "./manifest.json";',
    'import deploymentProvenance from "./deployment.json";',
    "createAgentDurableObject",
    "installCloudflareWorkspaceOperationProvider",
    "OpenAiCompatibleLlmTransportLive",
    "defineWorkspaceAgentMount",
    "bindWorkspaceToolsForRuntime",
    "makeCloudflareWorkspaceEnv",
    "getSandbox",
    "generatedCustomTools",
    "llmTransport: () => OpenAiCompatibleLlmTransportLive",
    "extensions: (env) => workspaceOperationInstallFor(env).extensions",
    "override submit(spec: AgentSubmitSpec): Promise<SubmitResult>",
    "submitRunInput(input: SubmitRunInput): Promise<SubmitResult>",
    "readWorkspaceFile(",
  ];
  for (const marker of requiredStaticWiringMarkers) {
    if (!renderStaticTargetSource.includes(marker)) {
      failures.push(
        `${sourcePath}: generated-static-target-linking: renderStaticTarget missing static marker ${marker}`,
      );
    }
  }

  const requiredModuleKinds = [
    '"semantic-json"',
    '"target-runtime"',
    '"provider-runtime"',
    '"workspace-host"',
    '"authored-tool"',
    '"workspace-binding"',
    '"execution-domain-runtime"',
    '"platform-runtime"',
    '"client-core"',
    '"client-transport"',
    '"client-framework"',
  ];
  for (const marker of requiredModuleKinds) {
    if (!source.includes(`kind: ${marker}`) && !source.includes(`| ${marker}`)) {
      failures.push(
        `${sourcePath}: generated-static-target-linking: module graph missing ${marker}`,
      );
    }
  }

  const durableObjectConfigStart = renderStaticTargetSource.indexOf("createAgentDurableObject<");
  const durableObjectConfig =
    durableObjectConfigStart === -1 ? "" : renderStaticTargetSource.slice(durableObjectConfigStart);
  if (durableObjectConfig.length === 0) {
    failures.push(
      `${sourcePath}: generated-static-target-linking: target must call createAgentDurableObject`,
    );
  }
  for (const forbidden of ["deploymentProvenance", "targetDeployment"]) {
    if (durableObjectConfig.includes(forbidden)) {
      failures.push(
        `${sourcePath}: generated-static-target-linking: runtime wiring must not consume ${forbidden}`,
      );
    }
  }
  for (const forbidden of [
    "makeRuntime({",
    "workspaceExtension(",
    "dynamic import",
    "await import(",
    "import(",
  ]) {
    if (renderStaticTargetSource.includes(forbidden)) {
      failures.push(
        `${sourcePath}: generated-static-target-linking: closed target must not contain ${forbidden}`,
      );
    }
  }

  const requiredRemoteBridgeMarkers = [
    'renderNamedImport(["command", "getRequestEvent", "query"], modules.svelteKitServer)',
    "durableObjectRpcClient",
    "decodeSseHttpEvents",
    "responseToSseHttpChunks",
    "manifestTruthIdentity",
    "submitRunInput",
    "readWorkspaceFile",
    "streamEvents",
    "export const invokeAgentCommand = command(",
    "export const runEventStream = query.live(",
  ];
  for (const marker of requiredRemoteBridgeMarkers) {
    if (!renderSvelteKitRemoteSource.includes(marker)) {
      failures.push(
        `${sourcePath}: generated-static-target-linking: renderSvelteKitRemote missing bridge marker ${marker}`,
      );
    }
  }

  const requiredClientBridgeMarkers = [
    'import { invokeAgentCommand, runEventStream } from "./sveltekit.remote";',
    "streamSource: options.streamSource ?? generatedStreamSource",
    "rpcInvoker: options.rpcInvoker ?? generatedRpcInvoker",
    "clientReadable(bridge.client)",
    "selectClientReadable(bridge.client",
  ];
  for (const marker of requiredClientBridgeMarkers) {
    if (!renderStaticClientSource.includes(marker)) {
      failures.push(
        `${sourcePath}: generated-static-target-linking: renderStaticClient missing generated bridge marker ${marker}`,
      );
    }
  }

  if (!linkWorkspaceStaticTargetSource.includes('".agentos/generated/sveltekit.remote.ts"')) {
    failures.push(
      `${sourcePath}: generated-static-target-linking: SvelteKit target must emit sveltekit.remote.ts`,
    );
  }

  failIfAny("generated static target linking", failures);
};

const checkConvergenceBoundary = () => {
  checkClientBoundaries();
  checkGeneratedStaticTargetLinking();
  checkSpikeHygiene();
  console.log("convergence boundary passed");
};

const convergenceRoleIds = new Set([
  "law-contract-owner",
  "capability-protocol",
  "provider-bundle",
  "projection-sink",
  "repo-local-tooling",
]);

const convergenceRoleManifest = () =>
  readJson("tooling/agentos-cli/src/check/sources/role-survival.source.json");

const publicExportNames = (apiSource) =>
  new Set([
    ...manifestNames(path.join(repoRoot, apiSource), "Public exports"),
    ...manifestNames(path.join(repoRoot, apiSource), "Experimental exports"),
    ...manifestNames(path.join(repoRoot, apiSource), "Deprecated exports"),
  ]);

const roleSurvivalPackageMatches = (record, rule) =>
  !(
    (rule.excludePaths ?? []).includes(record.path) ||
    (rule.excludePathPrefixes ?? []).some((prefix) => packagePathMatches(record.path, prefix))
  ) &&
  ((rule.paths ?? []).includes(record.path) ||
    (rule.pathPrefixes ?? []).some((prefix) => packagePathMatches(record.path, prefix)));

const roleSurvivalArrayAt = (file, pointer) => {
  const value = readJson(file)[pointer];
  return Array.isArray(value) ? value : undefined;
};

const checkRoleSurvivalRoles = ({ manifest, failures }) => {
  if (manifest.schemaVersion !== 1) failures.push("role survival manifest schemaVersion must be 1");
  const actualRoles = new Set();
  for (const role of manifest.roles ?? []) {
    if (!isRecord(role) || typeof role.id !== "string") {
      failures.push("role survival manifest roles must declare string ids");
      continue;
    }
    actualRoles.add(role.id);
    if (!convergenceRoleIds.has(role.id)) failures.push(`unexpected convergence role ${role.id}`);
    if (typeof role.meaning !== "string" || role.meaning.length === 0) {
      failures.push(`${role.id}: missing role meaning`);
    }
  }
  for (const roleId of convergenceRoleIds) {
    if (!actualRoles.has(roleId)) failures.push(`missing convergence role ${roleId}`);
  }
};

const checkRoleSurvivalPackages = ({ manifest, failures }) => {
  const rules = Array.isArray(manifest.packageRoleRules) ? manifest.packageRoleRules : [];
  for (const [index, rule] of rules.entries()) {
    const label = `packageRoleRules[${index}]`;
    if (!isRecord(rule)) {
      failures.push(`${label} must be an object`);
      continue;
    }
    if (!convergenceRoleIds.has(rule.role)) failures.push(`${label}: invalid role ${rule.role}`);
    if (!Array.isArray(rule.paths)) failures.push(`${label}: paths must be an array`);
    if (!Array.isArray(rule.pathPrefixes)) failures.push(`${label}: pathPrefixes must be an array`);
    if (rule.excludePaths !== undefined && !Array.isArray(rule.excludePaths)) {
      failures.push(`${label}: excludePaths must be an array when present`);
    }
    if (rule.excludePathPrefixes !== undefined && !Array.isArray(rule.excludePathPrefixes)) {
      failures.push(`${label}: excludePathPrefixes must be an array when present`);
    }
    if (typeof rule.reason !== "string" || rule.reason.length === 0) {
      failures.push(`${label}: missing reason`);
    }
  }

  const packageRecords = workspacePackageRecords();
  const packagesByPath = new Map(packageRecords.map((record) => [record.path, record]));
  const surfacePackages = readJson("docs/surface.json").packages ?? [];
  const surfaceByPath = new Map();
  for (const pkg of surfacePackages) {
    if (!isRecord(pkg) || typeof pkg.path !== "string") {
      failures.push("docs/surface.json: package entries must declare path");
      continue;
    }
    if (surfaceByPath.has(pkg.path))
      failures.push(`docs/surface.json: duplicate package path ${pkg.path}`);
    surfaceByPath.set(pkg.path, pkg);
  }

  for (const record of packageRecords) {
    const matchingRules = rules.filter((rule) => roleSurvivalPackageMatches(record, rule));
    if (matchingRules.length !== 1) {
      failures.push(
        `${record.path}: expected exactly one convergence role, matched ${matchingRules.length}`,
      );
    }
    const surface = surfaceByPath.get(record.path);
    if (surface === undefined) {
      failures.push(`${record.path}: missing docs/surface.json package owner`);
    } else if (surface.name !== record.name) {
      failures.push(
        `${record.path}: docs/surface.json name ${surface.name} differs from ${record.name}`,
      );
    }
  }
  for (const pkg of surfacePackages) {
    if (!packagesByPath.has(pkg.path))
      failures.push(`docs/surface.json: stale package path ${pkg.path}`);
  }
};

const checkRoleSurvivalExports = ({ failures }) => {
  const surfacePackages = readJson("docs/surface.json").packages ?? [];
  let exportCount = 0;
  for (const pkg of surfacePackages) {
    if (!isRecord(pkg) || typeof pkg.path !== "string") continue;
    const packageJson = readJson(`${pkg.path}/package.json`);
    if (typeof pkg.apiSource !== "string") {
      if (packageJson.private !== true) {
        failures.push(
          `${pkg.path}: non-private packages require apiSource for export role projection`,
        );
      }
      if (packageJson.exports !== undefined) {
        failures.push(`${pkg.path}: package exports require apiSource for export role projection`);
      }
      exportCount += Object.keys(packageJson.bin ?? {}).length;
      continue;
    }
    const packageApi = `${pkg.path}/PUBLIC_API.md`;
    if (!fs.existsSync(path.join(repoRoot, packageApi))) {
      failures.push(`${pkg.path}: missing generated PUBLIC_API.md`);
    }
    if (!fs.existsSync(path.join(repoRoot, pkg.apiSource))) {
      failures.push(`${pkg.path}: missing apiSource ${pkg.apiSource}`);
      continue;
    }
    exportCount += publicExportNames(pkg.apiSource).size;
  }
  return exportCount;
};

const checkRoleSurvivalScripts = ({ manifest, failures }) => {
  const rootScripts = manifest.scriptSurfaces?.rootScripts;
  if (rootScripts?.role !== "repo-local-tooling") {
    failures.push("scriptSurfaces.rootScripts must project to repo-local-tooling");
  }
  if (rootScripts?.sourceRule !== "repo-tooling-surface") {
    failures.push("scriptSurfaces.rootScripts must point to repo-tooling-surface");
  }
  const expectedRootScripts = new Set(
    (ruleConstraints("repo-tooling-surface").rootScripts ?? []).flatMap((script) => {
      if (typeof script !== "string") {
        failures.push("repo-tooling-surface rootScripts must contain strings");
        return [];
      }
      return [script];
    }),
  );
  const actualRootScripts = Object.keys(readJson("package.json").scripts ?? {});
  for (const script of actualRootScripts) {
    if (!expectedRootScripts.has(script))
      failures.push(`package.json: unowned root script ${script}`);
  }
  for (const script of expectedRootScripts) {
    const scriptName = String(script);
    if (!actualRootScripts.includes(scriptName))
      failures.push(`package.json: missing root script ${scriptName}`);
  }

  const packageScripts = manifest.scriptSurfaces?.packageScripts;
  if (packageScripts?.role !== "repo-local-tooling") {
    failures.push("scriptSurfaces.packageScripts must project to repo-local-tooling");
  }
  const allowedPackageScripts = new Set(packageScripts?.allowedNames ?? []);
  let scriptCount = actualRootScripts.length;
  for (const record of workspacePackageRecords()) {
    const pkg = readJson(`${record.path}/package.json`);
    for (const scriptName of Object.keys(pkg.scripts ?? {})) {
      scriptCount += 1;
      if (!allowedPackageScripts.has(scriptName)) {
        failures.push(`${record.path}/package.json: unowned package script ${scriptName}`);
      }
    }
  }
  return scriptCount;
};

const checkRoleSurvivalDocsAndVocabulary = ({ manifest, failures }) => {
  const docSurfaces = manifest.docSurfaces ?? {};
  if (docSurfaces.surfaceSource?.path !== "docs/surface.json") {
    failures.push("docSurfaces.surfaceSource must own docs/surface.json");
  }
  if (docSurfaces.surfaceSource?.role !== "repo-local-tooling") {
    failures.push("docs/surface.json must project to repo-local-tooling");
  }
  if (docSurfaces.packageDocs !== "inherit-package-role") {
    failures.push("docSurfaces.packageDocs must inherit package role");
  }
  if (docSurfaces.packageApiDocs !== "inherit-package-role") {
    failures.push("docSurfaces.packageApiDocs must inherit package role");
  }

  const surfacePackages = readJson("docs/surface.json").packages ?? [];
  const expectedPackageDocs = new Set(
    surfacePackages.flatMap((pkg) => {
      if (!isRecord(pkg) || typeof pkg.slug !== "string") {
        failures.push("docs/surface.json: package doc surfaces require string slugs");
        return [];
      }
      return [`docs/packages/${pkg.slug}.md`];
    }),
  );
  const expectedApiDocs = new Set(
    surfacePackages.flatMap((pkg) =>
      isRecord(pkg) && typeof pkg.apiSource === "string" ? [pkg.apiSource] : [],
    ),
  );
  for (const file of expectedPackageDocs) {
    const filePath = String(file);
    if (!fs.existsSync(path.join(repoRoot, filePath)))
      failures.push(`missing package doc ${filePath}`);
  }
  for (const file of walk("docs/packages").filter((entry) => entry.endsWith(".md"))) {
    if (!expectedPackageDocs.has(file)) failures.push(`unowned package doc ${file}`);
  }
  for (const file of expectedApiDocs) {
    const filePath = String(file);
    if (!fs.existsSync(path.join(repoRoot, filePath)))
      failures.push(`missing package API doc ${filePath}`);
  }
  for (const file of walk("docs/api").filter((entry) => entry.endsWith(".md"))) {
    if (!expectedApiDocs.has(file)) failures.push(`unowned package API doc ${file}`);
  }

  const agentSources = Array.isArray(docSurfaces.agentSources) ? docSurfaces.agentSources : [];
  const coveredAgentSources = new Set();
  let vocabularyCount = 0;
  for (const [index, source] of agentSources.entries()) {
    const label = `docSurfaces.agentSources[${index}]`;
    if (!isRecord(source)) {
      failures.push(`${label} must be an object`);
      continue;
    }
    if (!convergenceRoleIds.has(source.role))
      failures.push(`${label}: invalid role ${source.role}`);
    if (typeof source.path !== "string") {
      failures.push(`${label}: missing path`);
      continue;
    }
    coveredAgentSources.add(source.path);
    const values = roleSurvivalArrayAt(source.path, source.pointer);
    if (values === undefined) {
      failures.push(`${source.path}: ${source.pointer} must be an array`);
    } else {
      vocabularyCount += values.length;
    }
  }
  for (const file of walk("docs/agent").filter((entry) => entry.endsWith(".source.json"))) {
    if (!coveredAgentSources.has(file)) failures.push(`unowned agent source vocabulary ${file}`);
  }
  return {
    docCount: 1 + expectedPackageDocs.size + expectedApiDocs.size + coveredAgentSources.size,
    vocabularyCount,
  };
};

const checkConvergenceRoles = () => {
  const failures = [];
  const manifest = convergenceRoleManifest();

  checkRoleSurvivalRoles({ manifest, failures });
  checkRoleSurvivalPackages({ manifest, failures });
  const exportCount = checkRoleSurvivalExports({ failures });
  const scriptCount = checkRoleSurvivalScripts({ manifest, failures });
  const { docCount, vocabularyCount } = checkRoleSurvivalDocsAndVocabulary({
    manifest,
    failures,
  });

  failIfAny("convergence roles", failures);
  console.log(
    `convergence roles covered ${workspacePackageRecords().length} packages, ${exportCount} exports, ${scriptCount} scripts, ${docCount} doc surfaces, ${vocabularyCount} public vocabulary entries`,
  );
};

const publicSurfaceSweepManifest = () =>
  readJson("tooling/agentos-cli/src/check/sources/public-surface-sweep.source.json");

const packagePublicSymbols = (pkg) => {
  if (typeof pkg.apiSource !== "string") return new Set();
  return publicExportNames(pkg.apiSource);
};

const packageExportsSymbol = (exports, symbolName) =>
  [...exports].some((entry) => String(entry).endsWith(`:${symbolName}`));

const checkConvergencePublicSurface = () => {
  checkPublicApi();
  checkConvergenceRoles();
  checkClientBoundaries();

  const manifest = publicSurfaceSweepManifest();
  const failures = [];
  if (manifest.schemaVersion !== 1) {
    failures.push("public surface sweep manifest schemaVersion must be 1");
  }
  if (manifest.deprecatedExports?.policy !== "forbidden") {
    failures.push("deprecatedExports policy must be forbidden");
  }

  const surfacePackages = readJson("docs/surface.json").packages ?? [];
  const surfaceByName = new Map(surfacePackages.map((pkg) => [pkg.name, pkg]));
  const retiredPackages = new Set(manifest.retiredPackages ?? []);
  for (const record of workspacePackageRecords()) {
    if (retiredPackages.has(record.name)) {
      failures.push(`${record.name}: retired package remains in workspace`);
    }
  }
  for (const pkg of surfacePackages) {
    if (retiredPackages.has(pkg.name)) {
      failures.push(`${pkg.name}: retired package remains in docs/surface.json`);
    }
  }

  let deprecatedSectionCount = 0;
  for (const pkg of surfacePackages) {
    if (!isRecord(pkg) || typeof pkg.apiSource !== "string") continue;
    const source = read(pkg.apiSource);
    const body = clientSectionBody(source, "Deprecated exports").trim();
    if (body.length > 0) {
      deprecatedSectionCount += 1;
      if (body !== "None.") failures.push(`${pkg.apiSource}: deprecated exports must be None.`);
    }
  }

  for (const retained of manifest.retainedProjectionVocabulary ?? []) {
    if (!isRecord(retained)) {
      failures.push("retainedProjectionVocabulary entries must be objects");
      continue;
    }
    if (!convergenceRoleIds.has(retained.role)) {
      failures.push(`${retained.export}: retained projection vocabulary has invalid role`);
    }
    if (typeof retained.reason !== "string" || retained.reason.length === 0) {
      failures.push(`${retained.export}: retained projection vocabulary requires reason`);
    }
    const [packageName, symbolName] =
      typeof retained.export === "string" ? retained.export.split(":") : [];
    const pkg = surfaceByName.get(packageName);
    if (pkg === undefined || symbolName === undefined) {
      failures.push(`${retained.export}: retained projection vocabulary must name package:symbol`);
      continue;
    }
    if (!packageExportsSymbol(packagePublicSymbols(pkg), symbolName)) {
      failures.push(`${retained.export}: retained projection vocabulary is not publicly exported`);
    }
  }

  failIfAny("convergence public surface", failures);
  console.log(
    `convergence public surface covered ${surfacePackages.length} package surfaces and ${deprecatedSectionCount} deprecated-export sections`,
  );
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

const checkBoundaryProjection = () => runCommand("vp check", { cwd: repoRoot });

const checkerById = new Map([
  ["architecture-sources", checkArchitectureSources],
  ["backend-neutrality", checkBackendNeutrality],
  ["boundaries", checkBoundaryProjection],
  ["client-boundaries", checkClientBoundaries],
  ["convergence-boundary", checkConvergenceBoundary],
  ["convergence-import-dag", checkConvergenceImportDag],
  ["convergence-public-surface", checkConvergencePublicSurface],
  ["convergence-roles", checkConvergenceRoles],
  ["d12-a155-substrate-absorption", checkBoundaryProjection],
  ["distribution-units", checkDistributionUnits],
  ["docs-site-build", checkDocsSiteBuild],
  ["event-namespaces", checkEventNamespaces],
  ["limit-registry", checkLimitRegistry],
  ["generated-static-target-linking", checkGeneratedStaticTargetLinking],
  ["gate-tier-governance", checkGateTierGovernance],
  ["module-graph-oracle", checkModuleGraphOracle],
  ["module-buckets", checkModuleBuckets],
  ["owner-coupling", checkOwnerCoupling],
  ["owner-identity-boundary", checkOwnerIdentityBoundary],
  ["owner-ids", checkOwnerIds],
  ["public-api", checkPublicApi],
  ["repo-tooling-surface", checkRepoToolingSurface],
  ["source-aliases", checkSourceAliases],
  ["spike-hygiene", checkSpikeHygiene],
  ["substrate-import-dag", checkSubstrateImportDag],
  ["transaction-sync", checkTransactionSync],
]);
const checkerIdsWithArgs = new Set([
  "distribution-units",
  "module-buckets",
  "owner-coupling",
  "owner-identity-boundary",
]);

export const listAlgorithmicCheckers = () => [...checkerById.keys()].sort(compare);
export const hasAlgorithmicChecker = (checkerId) => checkerById.has(checkerId);
export const algorithmicCheckerAcceptsArgs = (checkerId) => checkerIdsWithArgs.has(checkerId);

export const runAlgorithmicChecker = async (checkerId, args = []) => {
  const checker = checkerById.get(checkerId);
  if (checker === undefined) throw new Error(`unknown algorithmic checker ${checkerId}`);
  console.log(`$ agentos algorithmic-check ${checkerId}`);
  await Promise.resolve(checker(args));
};

const isCli =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isCli) {
  const [checkerId, ...rest] = process.argv.slice(2);
  if (checkerId === undefined || checkerId === "--help" || checkerId === "-h") {
    console.log("usage: node tooling/agentos-cli/src/check/algorithmic-checks.mjs <checker-id>");
    process.exit(checkerId === undefined ? 1 : 0);
  }
  if (!algorithmicCheckerAcceptsArgs(checkerId) && rest.length > 0) {
    console.error(`unexpected argument(s): ${rest.join(" ")}`);
    process.exit(1);
  }
  try {
    await runAlgorithmicChecker(checkerId, rest);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
