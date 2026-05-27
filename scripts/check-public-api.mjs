#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const root = process.cwd();
const targets = [
  "core",
  "workspace-session",
  "cloudflare-resource",
  "decision-gate",
  "turn-stream",
  "run-stream",
  "tenant-material",
  "llm-transport-http",
  "skill-registry",
];

const hasExportModifier = (node) =>
  node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) === true;

const hasDefaultModifier = (node) =>
  node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword) === true;

const nameFromDeclaration = (name) => (ts.isIdentifier(name) ? name.text : null);

const resolveRelativeModule = (fromFile, specifier) => {
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, "index.ts"),
    path.join(base, "index.tsx"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  throw new Error(`cannot resolve export module ${specifier} from ${fromFile}`);
};

const exportedNamesFromAst = (file, seen) => {
  const source = fs.readFileSync(file, "utf8");
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const names = new Set();

  for (const statement of sourceFile.statements) {
    if (ts.isExportDeclaration(statement)) {
      const specifier =
        statement.moduleSpecifier !== undefined && ts.isStringLiteral(statement.moduleSpecifier)
          ? statement.moduleSpecifier.text
          : null;

      if (statement.exportClause === undefined) {
        if (specifier !== null && specifier.startsWith(".")) {
          const target = resolveRelativeModule(file, specifier);
          for (const name of exportedNamesFromSource(target, seen)) names.add(name);
        }
        continue;
      }

      if (ts.isNamespaceExport(statement.exportClause)) {
        names.add(statement.exportClause.name.text);
        continue;
      }

      for (const element of statement.exportClause.elements) {
        names.add(element.name.text);
      }
      continue;
    }

    if (ts.isExportAssignment(statement)) {
      names.add(statement.isExportEquals === true ? "export=" : "default");
      continue;
    }

    if (!hasExportModifier(statement)) continue;

    if (hasDefaultModifier(statement)) {
      names.add("default");
      continue;
    }

    if (
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement) ||
      ts.isClassDeclaration(statement) ||
      ts.isFunctionDeclaration(statement) ||
      ts.isEnumDeclaration(statement)
    ) {
      const name = statement.name === undefined ? null : nameFromDeclaration(statement.name);
      if (name !== null) names.add(name);
      continue;
    }

    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        const name = nameFromDeclaration(declaration.name);
        if (name !== null) names.add(name);
      }
    }
  }

  return names;
};

const exportedNamesFromSource = (file, seen = new Set()) => {
  const abs = path.resolve(file);
  if (seen.has(abs)) return new Set();
  seen.add(abs);
  return exportedNamesFromAst(abs, seen);
};

const manifestNames = (manifest, section) => {
  const source = fs.readFileSync(manifest, "utf8");
  const start = source.indexOf(`## ${section}`);
  if (start === -1) return new Set();
  const rest = source.slice(start + section.length + 3);
  const next = rest.search(/^## /m);
  const body = next === -1 ? rest : rest.slice(0, next);
  return new Set([...body.matchAll(/`([^`:]+):([^`]+)`/g)].map((match) => match[0].slice(1, -1)));
};

let failed = false;

for (const target of targets) {
  const pkgDir = path.join(root, "packages", target);
  const manifest = path.join(pkgDir, "PUBLIC_API.md");
  if (!fs.existsSync(manifest)) {
    console.error(`missing PUBLIC_API.md for ${target}`);
    failed = true;
    continue;
  }

  const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"));
  const exports = pkg.exports ?? {};
  const frozen = manifestNames(manifest, "Frozen exports");
  const experimental = manifestNames(manifest, "Experimental exports");
  const internal = manifestNames(manifest, "Internal-only exports");
  const declaredPublic = new Set([...frozen, ...experimental]);

  for (const [entrypoint, exportSpec] of Object.entries(exports)) {
    const source = exportSpec?.default ?? exportSpec;
    if (typeof source !== "string" || !source.startsWith("./")) continue;
    const file = path.join(pkgDir, source);
    const actual = [...exportedNamesFromSource(file)]
      .map((name) => `${entrypoint}:${String(name)}`)
      .sort();

    for (const name of actual) {
      if (!declaredPublic.has(name)) {
        console.error(`${target}: exported but not in PUBLIC_API.md: ${name}`);
        failed = true;
      }
      if (internal.has(name)) {
        console.error(`${target}: internal export is still exported: ${name}`);
        failed = true;
      }
    }

    for (const name of declaredPublic) {
      const [declaredEntrypoint] = name.split(":");
      if (declaredEntrypoint === entrypoint && !actual.includes(name)) {
        console.error(`${target}: PUBLIC_API.md lists missing export: ${name}`);
        failed = true;
      }
    }
  }
}

if (failed) process.exit(1);
console.log("public API manifests match package exports");
