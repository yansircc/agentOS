import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { workspacePackageRecords as workspaceManifestPackageRecords } from "../lib/workspace-manifest.mjs";

const compare = (left, right) => left.localeCompare(right);
const readJsonFile = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const sourceModuleFilePattern = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/u;
const internalPackageNamePattern = /^@agent-os\/[^/]+/u;

export const walkFiles = (repoRoot, relativePath, options = {}) => {
  const absolutePath = path.join(repoRoot, relativePath);
  if (!fs.existsSync(absolutePath)) return [];
  const stat = fs.statSync(absolutePath);
  if (stat.isFile()) return [relativePath];
  const ignored = options.ignored ?? new Set(["node_modules", "dist", ".wrangler", ".turbo"]);
  const files = [];
  for (const entry of fs.readdirSync(absolutePath, { withFileTypes: true })) {
    if (entry.isDirectory() && ignored.has(entry.name)) continue;
    const child = path.join(relativePath, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(repoRoot, child, options));
    if (entry.isFile()) files.push(child.split(path.sep).join("/"));
  }
  return files.sort(compare);
};

export const workspacePackageRecords = (repoRoot) => workspaceManifestPackageRecords(repoRoot);

const scriptKindForFile = (fileName) => {
  if (fileName.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (fileName.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (fileName.endsWith(".js") || fileName.endsWith(".mjs") || fileName.endsWith(".cjs")) {
    return ts.ScriptKind.JS;
  }
  return ts.ScriptKind.TS;
};

const moduleSpecifierPosition = (sourceFile, node) => {
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return { line: position.line + 1, column: position.character + 1 };
};

const pushImportRecord = (sourceFile, records, node, specifier, importKind, syntaxKind) => {
  records.push({
    specifier,
    importKind,
    syntaxKind,
    ...moduleSpecifierPosition(sourceFile, node),
  });
};

export const importSpecifierRecords = (content, fileName = "agentos-check.ts") => {
  const sourceFile = ts.createSourceFile(
    fileName,
    content,
    ts.ScriptTarget.Latest,
    true,
    scriptKindForFile(fileName),
  );
  const records = [];
  const visit = (node) => {
    if (
      ts.isImportDeclaration(node) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      pushImportRecord(
        sourceFile,
        records,
        node.moduleSpecifier,
        node.moduleSpecifier.text,
        node.importClause?.isTypeOnly === true ? "type" : "value",
        "import",
      );
    }
    if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      pushImportRecord(
        sourceFile,
        records,
        node.moduleSpecifier,
        node.moduleSpecifier.text,
        node.isTypeOnly ? "type" : "export",
        "export",
      );
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      pushImportRecord(
        sourceFile,
        records,
        node.arguments[0],
        node.arguments[0].text,
        "dynamic",
        "dynamic-import",
      );
    }
    if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      pushImportRecord(
        sourceFile,
        records,
        node.moduleReference.expression,
        node.moduleReference.expression.text,
        node.isTypeOnly ? "type" : "value",
        "import-equals",
      );
    }
    if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteralLike(node.argument.literal)
    ) {
      pushImportRecord(
        sourceFile,
        records,
        node.argument.literal,
        node.argument.literal.text,
        "type",
        "import-type",
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return records;
};

export const importSpecifiers = (content, fileName = "agentos-check.ts") =>
  importSpecifierRecords(content, fileName).map((record) => record.specifier);

export const packageFromInternalSpecifier = (recordsByName, specifier) => {
  if (!specifier.startsWith("@agent-os/")) return undefined;
  const [scope, name] = specifier.split("/");
  if (scope !== "@agent-os" || name === undefined) return undefined;
  return recordsByName.get(`${scope}/${name}`);
};

const toRepoPath = (repoRoot, absolutePath) =>
  path.relative(repoRoot, absolutePath).split(path.sep).join("/");

const isInsideRepo = (repoRoot, absolutePath) => {
  const relativePath = path.relative(repoRoot, absolutePath);
  return (
    relativePath.length > 0 && !relativePath.startsWith("..") && !path.isAbsolute(relativePath)
  );
};

export const owningPackageForFile = (records, file) =>
  records
    .filter((record) => file === record.path || file.startsWith(`${record.path}/`))
    .sort((left, right) => right.path.length - left.path.length)[0];

export const packageSourceFiles = (repoRoot, record) =>
  walkFiles(repoRoot, `${record.path}/src`).filter((entry) => sourceModuleFilePattern.test(entry));

const diagnosticText = (diagnostic) =>
  ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");

const fallbackCompilerOptions = (repoRoot) => {
  const config = readJsonFile(path.join(repoRoot, "tsconfig.source-paths.json"));
  const converted = ts.convertCompilerOptionsFromJson(
    {
      ...config.compilerOptions,
      allowJs: true,
      module: "ESNext",
      moduleResolution: "Bundler",
      resolveJsonModule: true,
      target: "ES2022",
    },
    repoRoot,
    "tsconfig.source-paths.json",
  );
  if (converted.errors.length > 0) {
    throw new Error(converted.errors.map(diagnosticText).join("\n"));
  }
  return converted.options;
};

const compilerOptionsLoader = (repoRoot) => {
  const byConfig = new Map();
  const fallback = () => fallbackCompilerOptions(repoRoot);
  return (sourceFile) => {
    const absoluteSourceFile = path.join(repoRoot, sourceFile);
    const configPath = ts.findConfigFile(path.dirname(absoluteSourceFile), (file) =>
      ts.sys.fileExists(file),
    );
    if (configPath === undefined) return fallback();
    const cached = byConfig.get(configPath);
    if (cached !== undefined) return cached;
    const parsed = ts.getParsedCommandLineOfConfigFile(
      configPath,
      { allowJs: true, resolveJsonModule: true },
      {
        ...ts.sys,
        onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
          throw new Error(diagnosticText(diagnostic));
        },
      },
    );
    if (parsed === undefined) throw new Error(`${toRepoPath(repoRoot, configPath)} did not parse`);
    if (parsed.errors.length > 0) {
      throw new Error(parsed.errors.map(diagnosticText).join("\n"));
    }
    byConfig.set(configPath, parsed.options);
    return parsed.options;
  };
};

export const resolveModuleSpecifier = (repoRoot, fromFile, specifier, compilerOptions) => {
  const resolved = ts.resolveModuleName(
    specifier,
    path.join(repoRoot, fromFile),
    compilerOptions,
    ts.sys,
  ).resolvedModule;
  if (resolved === undefined) return undefined;
  const resolvedFileName = path.resolve(resolved.resolvedFileName);
  if (!isInsideRepo(repoRoot, resolvedFileName)) return undefined;
  return toRepoPath(repoRoot, resolvedFileName);
};

const edgeKey = (edge) => `${edge.fromFile}\0${edge.specifier}\0${edge.toFile}\0${edge.importKind}`;

export const sourceModuleImportEdges = (repoRoot, records) => {
  const compilerOptionsForFile = compilerOptionsLoader(repoRoot);
  const edges = [];
  const seen = new Set();
  for (const from of records) {
    for (const file of packageSourceFiles(repoRoot, from)) {
      const source = fs.readFileSync(path.join(repoRoot, file), "utf8");
      const compilerOptions = compilerOptionsForFile(file);
      for (const importRecord of importSpecifierRecords(source, file)) {
        const toFile = resolveModuleSpecifier(
          repoRoot,
          file,
          importRecord.specifier,
          compilerOptions,
        );
        if (toFile === undefined) continue;
        const to = owningPackageForFile(records, toFile);
        if (to === undefined) continue;
        const edge = {
          from,
          to,
          fromFile: file,
          toFile,
          file,
          specifier: importRecord.specifier,
          importKind: importRecord.importKind,
          syntaxKind: importRecord.syntaxKind,
          line: importRecord.line,
          column: importRecord.column,
          source: "source-module-import",
        };
        const key = edgeKey(edge);
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push(edge);
      }
    }
  }
  return edges.sort(
    (left, right) =>
      compare(left.fromFile, right.fromFile) ||
      compare(left.specifier, right.specifier) ||
      compare(left.toFile, right.toFile) ||
      compare(left.importKind, right.importKind),
  );
};

export const sourceModuleGraph = (repoRoot, records) => ({
  packages: records,
  files: records.flatMap((record) =>
    packageSourceFiles(repoRoot, record).map((file) => ({ package: record, file })),
  ),
  edges: sourceModuleImportEdges(repoRoot, records),
});

export const moduleGraphOracleFailures = (repoRoot, records) => {
  const graphEdges = sourceModuleImportEdges(repoRoot, records);
  const observed = new Set(graphEdges.map(edgeKey));
  const compilerOptionsForFile = compilerOptionsLoader(repoRoot);
  const failures = [];
  for (const from of records) {
    for (const file of packageSourceFiles(repoRoot, from)) {
      const source = fs.readFileSync(path.join(repoRoot, file), "utf8");
      const compilerOptions = compilerOptionsForFile(file);
      for (const importRecord of importSpecifierRecords(source, file)) {
        const toFile = resolveModuleSpecifier(
          repoRoot,
          file,
          importRecord.specifier,
          compilerOptions,
        );
        if (toFile === undefined) continue;
        const to = owningPackageForFile(records, toFile);
        if (to === undefined) continue;
        const expectedKey = edgeKey({
          fromFile: file,
          specifier: importRecord.specifier,
          toFile,
          importKind: importRecord.importKind,
        });
        if (!observed.has(expectedKey)) {
          failures.push(
            `${file}:${importRecord.line}:${importRecord.column}: module graph missed TypeScript-resolved ${importRecord.importKind} edge ${importRecord.specifier} -> ${toFile}`,
          );
        }
      }
    }
  }
  if (!graphEdges.some((edge) => edge.from.name === edge.to.name)) {
    failures.push("module graph must retain at least one same-package edge");
  }
  if (!graphEdges.some((edge) => edge.importKind === "type")) {
    failures.push("module graph must retain type-only edges");
  }
  if (!graphEdges.some((edge) => edge.syntaxKind === "export")) {
    failures.push("module graph must retain re-export edges");
  }
  if (!graphEdges.some((edge) => internalPackageNamePattern.test(edge.specifier))) {
    failures.push("module graph must retain @agent-os alias/subpath edges");
  }
  return failures;
};

export const packageSourceImportEdges = (repoRoot, records) => {
  const seen = new Set();
  return sourceModuleImportEdges(repoRoot, records)
    .filter((edge) => edge.to.name !== edge.from.name)
    .map((edge) => ({
      from: edge.from,
      to: edge.to,
      source: "source-import",
      file: edge.fromFile,
      specifier: edge.specifier,
      importKind: edge.importKind,
      syntaxKind: edge.syntaxKind,
      toFile: edge.toFile,
    }))
    .filter((edge) => {
      const key = `${edge.from.name}\0${edge.to.name}\0${edge.file}\0${edge.specifier}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
};

export const packageManifestDependencyEdges = (repoRoot, records) => {
  const recordsByName = new Map(records.map((record) => [record.name, record]));
  const edges = [];
  for (const from of records) {
    const manifest = readJsonFile(path.join(repoRoot, from.path, "package.json"));
    for (const field of [
      "dependencies",
      "devDependencies",
      "peerDependencies",
      "optionalDependencies",
    ]) {
      for (const name of Object.keys(manifest[field] ?? {})) {
        const to = recordsByName.get(name);
        if (to !== undefined && to.name !== from.name) {
          edges.push({
            from,
            to,
            source: `package-json:${field}`,
            file: `${from.path}/package.json`,
          });
        }
      }
    }
  }
  return edges;
};

export const tsconfigReferenceEdges = (repoRoot, records) => {
  const recordsByPath = new Map(records.map((record) => [record.path, record]));
  const edges = [];
  for (const from of records) {
    const tsconfigPath = path.join(repoRoot, from.path, "tsconfig.json");
    if (!fs.existsSync(tsconfigPath)) continue;
    const tsconfig = readJsonFile(tsconfigPath);
    for (const reference of tsconfig.references ?? []) {
      if (typeof reference?.path !== "string") continue;
      const targetPath = path
        .relative(repoRoot, path.resolve(repoRoot, from.path, reference.path))
        .split(path.sep)
        .join("/");
      const to = recordsByPath.get(targetPath);
      if (to !== undefined && to.name !== from.name) {
        edges.push({ from, to, source: "tsconfig-reference", file: `${from.path}/tsconfig.json` });
      }
    }
  }
  return edges;
};

export const packageImportCycles = (records, edges) => {
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
