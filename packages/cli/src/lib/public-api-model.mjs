import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

export const apiSourceMode = (pkg) => pkg.apiSourceMode ?? "manual";

export const sourceTsdocModes = new Set(["source-tsdoc"]);

const statusTags = new Set(["public", "experimental", "internal", "deprecated"]);

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

export const exportedNamesFromAst = (file, seen) => {
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

export const exportedNamesFromSource = (file, seen = new Set()) => {
  const abs = path.resolve(file);
  if (seen.has(abs)) return new Set();
  seen.add(abs);
  return exportedNamesFromAst(abs, seen);
};

const plainComment = (comment) => {
  if (comment === undefined) return "";
  if (typeof comment === "string") return comment;
  if (Array.isArray(comment)) return comment.map((part) => part.text).join("");
  return String(comment);
};

const tsdocForNode = (node, sourceFile) => {
  const docs = node.jsDoc ?? [];
  const doc = docs.at(-1);
  if (doc === undefined) {
    return { summary: "", tags: [] };
  }

  const tags = [];
  for (const tag of doc.tags ?? []) {
    tags.push({
      name: tag.tagName.getText(sourceFile),
      text: plainComment(tag.comment).trim(),
    });
  }

  return {
    summary: plainComment(doc.comment).replace(/\s+/gu, " ").trim(),
    tags,
  };
};

const sourceExportRecordsFromAst = (file, entrypoint, seen) => {
  const abs = path.resolve(file);
  if (seen.has(abs)) return [];
  seen.add(abs);

  const source = fs.readFileSync(abs, "utf8");
  const sourceFile = ts.createSourceFile(abs, source, ts.ScriptTarget.Latest, true);
  const records = [];

  const pushRecord = (name, node) => {
    const tsdoc = tsdocForNode(node, sourceFile);
    const matchingTags = tsdoc.tags.filter((tag) => statusTags.has(tag.name));
    const status = matchingTags.length === 1 ? matchingTags[0] : null;
    records.push({
      entrypoint,
      name,
      key: `${entrypoint}:${name}`,
      file: abs,
      summary: tsdoc.summary,
      tags: tsdoc.tags,
      status,
      statusTags: matchingTags,
    });
  };

  for (const statement of sourceFile.statements) {
    if (ts.isExportDeclaration(statement)) {
      const specifier =
        statement.moduleSpecifier !== undefined && ts.isStringLiteral(statement.moduleSpecifier)
          ? statement.moduleSpecifier.text
          : null;
      if (statement.exportClause === undefined && specifier !== null && specifier.startsWith(".")) {
        records.push(
          ...sourceExportRecordsFromAst(resolveRelativeModule(abs, specifier), entrypoint, seen),
        );
      } else if (
        statement.exportClause !== undefined &&
        ts.isNamedExports(statement.exportClause) &&
        specifier !== null &&
        specifier.startsWith(".")
      ) {
        const target = resolveRelativeModule(abs, specifier);
        const targetRecords = sourceExportRecordsFromAst(target, entrypoint, new Set(seen));
        for (const element of statement.exportClause.elements) {
          const importedName = element.propertyName?.text ?? element.name.text;
          const exportedName = element.name.text;
          const targetRecord = targetRecords.find((record) => record.name === importedName);
          if (targetRecord === undefined) continue;
          records.push({
            ...targetRecord,
            name: exportedName,
            key: `${entrypoint}:${exportedName}`,
          });
        }
      }
      continue;
    }

    if (ts.isExportAssignment(statement)) {
      pushRecord(statement.isExportEquals === true ? "export=" : "default", statement);
      continue;
    }

    if (!hasExportModifier(statement)) continue;

    if (hasDefaultModifier(statement)) {
      pushRecord("default", statement);
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
      if (name !== null) pushRecord(name, statement);
      continue;
    }

    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        const name = nameFromDeclaration(declaration.name);
        if (name !== null) pushRecord(name, statement);
      }
    }
  }

  return records;
};

const packageEntrypoints = (root, pkg) => {
  const pkgDir = path.join(root, pkg.path);
  const manifest = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"));
  return Object.entries(manifest.exports ?? {})
    .map(([entrypoint, exportSpec]) => {
      const source = exportSpec?.default ?? exportSpec;
      return typeof source === "string" && source.startsWith("./")
        ? { entrypoint, file: path.join(pkgDir, source) }
        : null;
    })
    .filter((entry) => entry !== null);
};

export const exportedNamesForPackage = (root, pkg) =>
  packageEntrypoints(root, pkg).flatMap(({ entrypoint, file }) =>
    [...exportedNamesFromSource(file)].map((name) => ({
      entrypoint,
      name: String(name),
      key: `${entrypoint}:${String(name)}`,
    })),
  );

export const sourceTsdocRecordsForPackage = (root, pkg) =>
  packageEntrypoints(root, pkg)
    .flatMap(({ entrypoint, file }) => sourceExportRecordsFromAst(file, entrypoint, new Set()))
    .sort((left, right) => left.key.localeCompare(right.key));

export const validateSourceTsdocRecords = (pkg, records) => {
  const failures = [];
  const seen = new Set();

  for (const record of records) {
    if (seen.has(record.key)) {
      failures.push(`${pkg.name}: duplicate exported symbol record ${record.key}`);
      continue;
    }
    seen.add(record.key);

    if (record.summary.length === 0) {
      failures.push(`${pkg.name}: ${record.key} is missing a TSDoc summary`);
    }
    if (record.statusTags.length !== 1) {
      failures.push(
        `${pkg.name}: ${record.key} must have exactly one API status tag (@public, @experimental, @internal, or @deprecated)`,
      );
      continue;
    }
    if (record.status?.name === "internal") {
      failures.push(`${pkg.name}: ${record.key} is tagged @internal but exported`);
    }
    if (record.status?.name === "deprecated" && record.status.text.length === 0) {
      failures.push(`${pkg.name}: ${record.key} has @deprecated without a reason`);
    }
  }

  return failures;
};

const listSection = (records) =>
  records.length === 0
    ? "None."
    : records.map((record) => `- \`${record.key}\` - ${record.summary}`).join("\n");

export const sourceTsdocApiMarkdown = (pkg, records) => {
  const byStatus = (status) => records.filter((record) => record.status?.name === status);
  const deprecated = byStatus("deprecated");
  const deprecatedSection =
    deprecated.length === 0
      ? "None."
      : deprecated
          .map(
            (record) => `- \`${record.key}\` - ${record.summary} Deprecated: ${record.status.text}`,
          )
          .join("\n");

  return [
    `# ${pkg.name} Public API Intent`,
    "",
    "<!-- generated by packages/cli/src/generate/generate-docs.mjs; edit exported TSDoc in package source -->",
    "",
    "## Public exports",
    "",
    listSection(byStatus("public")),
    "",
    "## Experimental exports",
    "",
    listSection(byStatus("experimental")),
    "",
    "## Deprecated exports",
    "",
    deprecatedSection,
    "",
    "## Internal-only exports",
    "",
    "Any package file or symbol not listed above.",
    "",
  ].join("\n");
};
