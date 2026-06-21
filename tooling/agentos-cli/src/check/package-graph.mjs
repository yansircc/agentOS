import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const compare = (left, right) => left.localeCompare(right);
const readJsonFile = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

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

export const workspacePackageRecords = (repoRoot) => {
  const rootPackage = readJsonFile(path.join(repoRoot, "package.json"));
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

export const importSpecifiers = (content, fileName = "agentos-check.ts") => {
  const sourceFile = ts.createSourceFile(
    fileName,
    content,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
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

export const packageFromInternalSpecifier = (recordsByName, specifier) => {
  if (!specifier.startsWith("@agent-os/")) return undefined;
  const [scope, name] = specifier.split("/");
  if (scope !== "@agent-os" || name === undefined) return undefined;
  return recordsByName.get(`${scope}/${name}`);
};

export const packageSourceImportEdges = (repoRoot, records) => {
  const recordsByName = new Map(records.map((record) => [record.name, record]));
  const edges = [];
  for (const from of records) {
    for (const file of walkFiles(repoRoot, `${from.path}/src`).filter((entry) =>
      /\.(?:ts|tsx|mts|cts|js|mjs)$/u.test(entry),
    )) {
      const source = fs.readFileSync(path.join(repoRoot, file), "utf8");
      for (const specifier of importSpecifiers(source, file)) {
        const to = packageFromInternalSpecifier(recordsByName, specifier);
        if (to !== undefined && to.name !== from.name) {
          edges.push({ from, to, source: "source-import", file, specifier });
        }
      }
    }
  }
  return edges;
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
