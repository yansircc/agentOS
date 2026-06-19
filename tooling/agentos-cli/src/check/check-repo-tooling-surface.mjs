#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const repoRoot = process.cwd();
const ruleId = "repo-tooling-surface";

const toPosix = (value) => value.split(path.sep).join("/");

const readJson = (relativePath) =>
  JSON.parse(fs.readFileSync(path.join(repoRoot, relativePath), "utf8"));

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

const walkFiles = (relativePath) => {
  const absolutePath = path.join(repoRoot, relativePath);
  if (!fs.existsSync(absolutePath)) return [];
  const entries = fs.readdirSync(absolutePath, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const child = path.join(relativePath, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkFiles(child));
    } else if (entry.isFile()) {
      files.push(toPosix(child));
    }
  }
  return files;
};

const readRuleConstraints = () => {
  const source = readJson("docs/agent/boundary-rules.source.json");
  const rule = source.rules?.find((entry) => isRecord(entry) && entry.id === ruleId);
  if (!isRecord(rule)) {
    throw new Error(`docs/agent/boundary-rules.source.json: missing ${ruleId}`);
  }
  if (!isRecord(rule.constraints)) {
    throw new Error(`docs/agent/boundary-rules.source.json: ${ruleId} missing constraints`);
  }
  return rule.constraints;
};

const diff = (left, right) => left.filter((value) => !right.includes(value));

const collectTextFiles = (roots) => {
  const files = [];
  const textExtensions = new Set([".json", ".jsonc", ".md", ".mjs", ".ts", ".tsx"]);
  for (const root of roots) {
    const absoluteRoot = path.join(repoRoot, root);
    if (!fs.existsSync(absoluteRoot)) continue;
    const stat = fs.statSync(absoluteRoot);
    const candidates = stat.isDirectory() ? walkFiles(root) : [root];
    for (const candidate of candidates) {
      if (textExtensions.has(path.extname(candidate))) files.push(candidate);
    }
  }
  return files;
};

const collectImportSpecifiers = (content) => {
  const specifiers = [];
  const sourceFile = ts.createSourceFile(
    "agentos-cli-check.mjs",
    content,
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
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return specifiers;
};

const constraints = readRuleConstraints();
const failures = [];
const compare = (left, right) => left.localeCompare(right);

const expectedRootScripts = [...constraints.rootScripts].sort(compare);
const allowedPrefixedRootScripts = constraints.allowedPrefixedRootScripts ?? [];
const actualRootScripts = Object.keys(readJson("package.json").scripts ?? {}).sort(compare);
const extraRootScripts = diff(actualRootScripts, expectedRootScripts);
const missingRootScripts = diff(expectedRootScripts, actualRootScripts);

for (const scriptName of missingRootScripts) {
  failures.push(`package.json: missing root script ${scriptName}`);
}
for (const scriptName of extraRootScripts) {
  failures.push(`package.json: unexpected root script ${scriptName}`);
}
for (const scriptName of actualRootScripts) {
  if (/^(check|test):/.test(scriptName) && !allowedPrefixedRootScripts.includes(scriptName)) {
    failures.push(`package.json: unexpected fine-grained root script ${scriptName}`);
  }
}

const allowedScriptPrefixes = constraints.scriptsDirectoryAllowPrefixes ?? [];
const allowedScriptExtensions = constraints.scriptsDirectoryAllowedExtensions ?? [];
for (const file of walkFiles("scripts")) {
  if (!allowedScriptPrefixes.some((prefix) => file.startsWith(prefix))) {
    failures.push(`scripts/: non-parallel-dev script remains at ${file}`);
    continue;
  }
  if (!allowedScriptExtensions.includes(path.extname(file))) {
    failures.push(`scripts/: ${file} must use an allowed script extension`);
  }
}

const cliSourceRoot = path.join(repoRoot, "tooling/agentos-cli/src");
const packagesRoot = path.join(repoRoot, "packages");
const forbiddenPackageSpecPrefixes = constraints.forbiddenPackageSpecPrefixes ?? [];
for (const file of walkFiles("tooling/agentos-cli/src")) {
  const content = fs.readFileSync(path.join(repoRoot, file), "utf8");
  for (const specifier of collectImportSpecifiers(content)) {
    if (forbiddenPackageSpecPrefixes.some((prefix) => specifier.startsWith(prefix))) {
      failures.push(`${file}: CLI must not import package specifier ${specifier}`);
      continue;
    }
    if (specifier.startsWith(".")) {
      const resolved = path.resolve(path.dirname(path.join(repoRoot, file)), specifier);
      if (resolved === packagesRoot || resolved.startsWith(`${packagesRoot}${path.sep}`)) {
        failures.push(`${file}: CLI must not import packages source via ${specifier}`);
      }
      continue;
    }
    if (path.isAbsolute(specifier)) {
      const resolved = path.resolve(specifier);
      if (resolved === packagesRoot || resolved.startsWith(`${packagesRoot}${path.sep}`)) {
        failures.push(`${file}: CLI must not import packages source via ${specifier}`);
      }
    }
  }
}

if (!fs.existsSync(cliSourceRoot)) {
  failures.push("tooling/agentos-cli/src: missing private CLI source root");
}

const legacyPattern = new RegExp(constraints.forbiddenLegacyScriptReferencePattern);
for (const file of collectTextFiles(constraints.legacyReferenceScanRoots ?? [])) {
  const content = fs.readFileSync(path.join(repoRoot, file), "utf8");
  for (const [index, line] of content.split("\n").entries()) {
    if (legacyPattern.test(line)) {
      failures.push(`${file}:${index + 1}: legacy scripts/ check/generate reference remains`);
    }
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log("repo tooling surface passed");
