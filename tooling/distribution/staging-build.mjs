import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import {
  distRoot,
  fail,
  isSourcePackageName,
  packageUnitOptionalPeers,
  packageVersion,
  projectedDependencyRange,
  publicPackageName,
  publicSpecifier,
  publishAccess,
  repoRoot,
  repoPath,
  rewritePublicScopePlaceholders,
  rewritePublicSpecifiers,
  sourcePackageScope,
  stagingRoot,
  writeJson,
} from "./support.mjs";
import {
  assertSourceManifests,
  assertSurface,
  catalog,
  isBinMjsTarget,
  isBinTsTarget,
  isPackageBinSourceTarget,
  isSourceMjsTarget,
  isSourceTsExportTarget,
  packageBinTargets,
  packageImportsEffect,
  publishedRecords,
} from "./package-records.mjs";

export const resolveExportTarget = (value) => {
  if (typeof value === "string") return value;
  if (value === null || typeof value !== "object") return undefined;
  return (
    resolveExportTarget(value.default) ??
    resolveExportTarget(value.import) ??
    resolveExportTarget(value.types)
  );
};

export const exportEntries = (record) => {
  const exportsValue =
    record.packageJson.exports ??
    record.packageJson.main ??
    (record.packageJson.bin === undefined ? "./src/index.ts" : undefined);
  if (exportsValue === undefined) return [];
  if (typeof exportsValue === "string") {
    return [[".", exportsValue]];
  }
  if (exportsValue === null || typeof exportsValue !== "object") return [];
  return Object.entries(exportsValue)
    .map(([exportPath, exportTarget]) => [exportPath, resolveExportTarget(exportTarget)])
    .filter((entry) => typeof entry[1] === "string")
    .sort(([left], [right]) => left.localeCompare(right));
};

export const isJsonAssetExportTarget = (target) =>
  target.startsWith("./") &&
  !target.includes("..") &&
  !target.startsWith("./src/") &&
  target.endsWith(".json");

export const srcTargetToDist = (target, ext) => {
  if (!target.startsWith("./src/") || !target.endsWith(".ts")) {
    fail(`export target must be a source .ts file: ${target}`);
  }
  return `./dist/${target.slice("./src/".length, -".ts".length)}.${ext}`;
};

export const binTargetToDist = (target) => {
  if (isBinTsTarget(target)) {
    return `./dist/bin/${target.slice("./bin/".length, -".ts".length)}.js`;
  }
  if (isBinMjsTarget(target)) {
    return `./dist/bin/${target.slice("./bin/".length)}`;
  }
  if (isSourceMjsTarget(target)) {
    return `./dist/${target.slice("./src/".length)}`;
  }
  fail(`bin target must be a source .ts/.mjs file or bin .ts/.mjs file: ${target}`);
};

export const generatedExportEntry = (target) => {
  if (isSourceTsExportTarget(target)) {
    return {
      types: srcTargetToDist(target, "d.ts"),
      default: srcTargetToDist(target, "js"),
    };
  }
  if (isJsonAssetExportTarget(target)) return { default: target };
  fail(`export target must be a source .ts module or package JSON asset: ${target}`);
};

export const projectedBinTarget = (target) => {
  if (isSourceTsExportTarget(target)) return srcTargetToDist(target, "js");
  if (isBinTsTarget(target) || isBinMjsTarget(target) || isSourceMjsTarget(target)) {
    return binTargetToDist(target);
  }
  fail(`bin target must be a source .ts/.mjs file or bin .ts/.mjs file: ${target}`);
};

export const projectedBin = (record) => {
  const bin = record.packageJson.bin;
  if (bin === undefined) return undefined;
  if (typeof bin === "string") return projectedBinTarget(bin);
  if (bin === null || typeof bin !== "object" || Array.isArray(bin)) {
    fail(`${record.packagePath}: package bin must be a string or record`);
  }
  return Object.fromEntries(
    Object.entries(bin)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, target]) => {
        if (typeof target !== "string") {
          fail(
            `${record.packagePath}: package bin ${name} must target a source .ts/.mjs file or bin .ts/.mjs file`,
          );
        }
        return [name, projectedBinTarget(target)];
      }),
  );
};

export const distJsForSourceFile = (record, file) => {
  const srcRel = path.relative(path.join(record.packageDir, "src"), file);
  if (!srcRel.startsWith("..") && !path.isAbsolute(srcRel)) {
    return path.join(record.stageDir, "dist", srcRel.replace(/(?:\.d)?\.ts$/u, ".js"));
  }
  const binRel = path.relative(path.join(record.packageDir, "bin"), file);
  if (!binRel.startsWith("..") && !path.isAbsolute(binRel)) {
    return path.join(record.stageDir, "dist", "bin", binRel.replace(/(?:\.d)?\.ts$/u, ".js"));
  }
  return undefined;
};

export const resolveRelativeTargetFile = (sourceFile, specifier, declarationOutput) => {
  if (!specifier.startsWith(".") || specifier.endsWith(".js") || specifier.endsWith(".json")) {
    return undefined;
  }
  const base = path.resolve(path.dirname(sourceFile), specifier);
  if (fs.existsSync(base) && fs.statSync(base).isFile()) {
    if (
      base.endsWith(".ts") ||
      base.endsWith(".mjs") ||
      (declarationOutput && base.endsWith(".d.ts"))
    ) {
      return base;
    }
  }
  if (fs.existsSync(`${base}.ts`)) {
    return `${base}.ts`;
  }
  if (fs.existsSync(`${base}.mjs`)) {
    return `${base}.mjs`;
  }
  if (fs.existsSync(path.join(base, "index.ts"))) {
    return path.join(base, "index.ts");
  }
  if (declarationOutput && fs.existsSync(`${base}.d.ts`)) {
    return `${base}.d.ts`;
  }
  if (declarationOutput && fs.existsSync(path.join(base, "index.d.ts"))) {
    return path.join(base, "index.d.ts");
  }
  return undefined;
};

export const relativeJsSpecifier = (fromOutFile, toOutFile) => {
  const relative = path.relative(path.dirname(fromOutFile), toOutFile).split(path.sep).join("/");
  return relative.startsWith(".") ? relative : `./${relative}`;
};

export const resolveRelativeSpecifier = (
  record,
  sourceFile,
  outFile,
  specifier,
  declarationOutput,
) => {
  const targetFile = resolveRelativeTargetFile(sourceFile, specifier, declarationOutput);
  if (targetFile === undefined) return specifier;
  const targetOutFile = distJsForSourceFile(record, targetFile);
  if (targetOutFile === undefined) return specifier;
  return relativeJsSpecifier(outFile, targetOutFile);
};

export const resolveModuleSpecifier = (
  record,
  sourceFile,
  outFile,
  specifier,
  declarationOutput,
) => {
  if (specifier.startsWith(".")) {
    return resolveRelativeSpecifier(record, sourceFile, outFile, specifier, declarationOutput);
  }
  return publicSpecifier(specifier);
};

export const rewriteModuleSpecifiers = (record, text, sourceFile, outFile, declarationOutput) =>
  text
    .replace(/(\bfrom\s*["'])([^"']+)(["'])/g, (_match, prefix, specifier, suffix) => {
      return `${prefix}${resolveModuleSpecifier(
        record,
        sourceFile,
        outFile,
        specifier,
        declarationOutput,
      )}${suffix}`;
    })
    .replace(/(\bimport\s*\(\s*["'])([^"']+)(["']\s*\))/g, (_match, prefix, specifier, suffix) => {
      return `${prefix}${resolveModuleSpecifier(
        record,
        sourceFile,
        outFile,
        specifier,
        declarationOutput,
      )}${suffix}`;
    })
    .replace(/(\bimport\s*["'])([^"']+)(["'])/g, (_match, prefix, specifier, suffix) => {
      return `${prefix}${resolveModuleSpecifier(
        record,
        sourceFile,
        outFile,
        specifier,
        declarationOutput,
      )}${suffix}`;
    })
    .replace(
      /(\bnew\s+URL\s*\(\s*["'])([^"']+)(["']\s*,\s*import\.meta\.url\s*\))/g,
      (_match, prefix, specifier, suffix) =>
        `${prefix}${resolveModuleSpecifier(
          record,
          sourceFile,
          outFile,
          specifier,
          declarationOutput,
        )}${suffix}`,
    );

export const exportedSourceRootFiles = (record) => {
  const files = [];
  for (const [, target] of exportEntries(record)) {
    if (isSourceTsExportTarget(target) || isSourceMjsTarget(target)) {
      files.push(path.join(record.packageDir, target.slice("./".length)));
    }
  }
  for (const target of packageBinTargets(record).filter(isPackageBinSourceTarget)) {
    files.push(path.join(record.packageDir, target.slice("./".length)));
  }
  return [...new Set(files)].sort((left, right) => left.localeCompare(right));
};

export const relativeSourceSpecifiers = (file) => {
  const text = fs.readFileSync(file, "utf8");
  const sourceFile = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".mjs") ? ts.ScriptKind.JS : ts.ScriptKind.TS,
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
  return specifiers.filter((specifier) => specifier.startsWith("."));
};

export const runtimeSourceFiles = (record) => {
  const roots = exportedSourceRootFiles(record);
  const visited = new Set();
  const pending = [...roots];
  while (pending.length > 0) {
    const file = pending.pop();
    if (visited.has(file)) continue;
    visited.add(file);
    for (const specifier of relativeSourceSpecifiers(file)) {
      const target = resolveRelativeTargetFile(file, specifier, false);
      if (target !== undefined && (target.endsWith(".ts") || target.endsWith(".mjs"))) {
        pending.push(target);
      }
    }
  }
  return [...visited].sort((left, right) => left.localeCompare(right));
};

export const emitJsFile = (record, file, out) => {
  const source = fs.readFileSync(file, "utf8");
  if (file.endsWith(".mjs")) {
    fs.writeFileSync(
      out,
      rewritePublicScopePlaceholders(rewriteModuleSpecifiers(record, source, file, out, false)),
    );
    return;
  }
  const transpiled = ts.transpileModule(source, {
    fileName: file,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ES2022,
      importsNotUsedAsValues: ts.ImportsNotUsedAsValues.Remove,
      sourceMap: false,
    },
  });
  fs.writeFileSync(
    out,
    rewritePublicScopePlaceholders(
      rewriteModuleSpecifiers(record, transpiled.outputText, file, out, false),
    ),
  );
};

export const emitJs = (record) => {
  for (const file of runtimeSourceFiles(record)) {
    const out = distJsForSourceFile(record, file);
    if (out === undefined) fail(`${record.packagePath}: cannot emit ${repoPath(file)}`);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    emitJsFile(record, file, out);
  }
};

export const sourceDeclaresContextService = (file, source) => {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const isContextServiceExpression = (expression) => {
    if (ts.isCallExpression(expression)) return isContextServiceExpression(expression.expression);
    return (
      ts.isPropertyAccessExpression(expression) &&
      expression.name.text === "Service" &&
      ts.isIdentifier(expression.expression) &&
      expression.expression.text === "Context"
    );
  };
  let found = false;
  const visit = (node) => {
    if (found) return;
    if (ts.isClassDeclaration(node)) {
      for (const clause of node.heritageClauses ?? []) {
        if (clause.token !== ts.SyntaxKind.ExtendsKeyword) continue;
        for (const type of clause.types) {
          if (isContextServiceExpression(type.expression)) {
            found = true;
            return;
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
};

export const emitIsolatedDeclaration = (record, file, source) => {
  const rel = path.relative(path.join(record.packageDir, "src"), file);
  const out = path.join(record.stageDir, "dist", rel.replace(/\.ts$/u, ".d.ts"));
  const result = ts.transpileDeclaration(source, {
    fileName: file,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ES2022,
      strict: true,
      isolatedDeclarations: true,
      removeComments: true,
    },
  });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(
    out,
    rewritePublicScopePlaceholders(
      rewriteModuleSpecifiers(record, result.outputText, file, out, true),
    ),
  );
};

export const emitSemanticDeclaration = (record, file) => {
  const sourceRoot = path.join(record.packageDir, "src");
  const configPath = path.join(record.packageDir, "tsconfig.json");
  const config = ts.readConfigFile(configPath, (fileName) => ts.sys.readFile(fileName));
  if (config.error !== undefined) {
    fail(`${record.packagePath}: failed to read tsconfig\n${formatTsDiagnostics([config.error])}`);
  }
  const parsed = ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    record.packageDir,
    {
      noEmit: false,
      declaration: true,
      emitDeclarationOnly: true,
      declarationMap: false,
      removeComments: true,
      noEmitOnError: false,
      noCheck: true,
      outDir: path.join(record.stageDir, "dist"),
      rootDir: repoRoot,
      incremental: false,
      composite: false,
    },
    configPath,
  );
  if (parsed.errors.length > 0) {
    fail(`${record.packagePath}: failed to parse tsconfig\n${formatTsDiagnostics(parsed.errors)}`);
  }
  const options = {
    ...parsed.options,
    noEmit: false,
    declaration: true,
    emitDeclarationOnly: true,
    declarationMap: false,
    removeComments: true,
    noEmitOnError: false,
    noCheck: true,
    outDir: path.join(record.stageDir, "dist"),
    rootDir: repoRoot,
    incremental: false,
    composite: false,
    tsBuildInfoFile: undefined,
  };
  const outForSourceFile = (file) => {
    const rel = path.relative(sourceRoot, file);
    if (rel.startsWith("..") || path.isAbsolute(rel)) return undefined;
    return path.join(record.stageDir, "dist", rel.replace(/\.ts$/u, ".d.ts"));
  };
  const emitted = new Set();
  const host = ts.createCompilerHost(options);
  host.writeFile = (fileName, text, writeByteOrderMark, onError, sourceFileList) => {
    const sourceFile = sourceFileList?.find((candidate) => outForSourceFile(candidate.fileName));
    const out = sourceFile === undefined ? undefined : outForSourceFile(sourceFile.fileName);
    if (out === undefined) return;
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(
      out,
      rewritePublicScopePlaceholders(
        rewriteModuleSpecifiers(record, text, sourceFile.fileName, out, true),
      ),
      writeByteOrderMark ? { encoding: "utf8" } : "utf8",
    );
    emitted.add(out);
  };
  const program = ts.createProgram([file], options, host);
  const sourceFile = program.getSourceFile(file);
  if (sourceFile === undefined) {
    fail(`${record.packagePath}: semantic declaration source not found ${repoPath(file)}`);
  }
  const emitResult = program.emit(sourceFile, host.writeFile, undefined, true);
  if (emitResult.emitSkipped) {
    fail(
      `${record.packagePath}: semantic declaration emit skipped ${repoPath(file)}\n${formatTsDiagnostics(
        emitResult.diagnostics,
      )}`,
    );
  }
  const out = outForSourceFile(file);
  if (out !== undefined && !emitted.has(out)) {
    fail(`${record.packagePath}: semantic declaration emit skipped ${repoPath(file)}`);
  }
};

export const emitDeclarations = (record) => {
  for (const file of runtimeSourceFiles(record).filter((candidate) => candidate.endsWith(".ts"))) {
    const source = fs.readFileSync(file, "utf8");
    if (sourceDeclaresContextService(file, source)) {
      emitSemanticDeclaration(record, file);
      continue;
    }
    emitIsolatedDeclaration(record, file, source);
  }
};

export const formatTsDiagnostics = (diagnostics) =>
  ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: (file) => file,
    getCurrentDirectory: () => repoRoot,
    getNewLine: () => "\n",
  });

export const exportedJsonAssets = (record) =>
  exportEntries(record)
    .map(([, target]) => target)
    .filter(isJsonAssetExportTarget);

export const copyExportedAssets = (record) => {
  for (const target of exportedJsonAssets(record)) {
    const rel = target.slice("./".length);
    const source = path.join(record.packageDir, rel);
    const out = path.join(record.stageDir, rel);
    if (!fs.existsSync(source) || !fs.statSync(source).isFile()) {
      fail(`${record.packagePath}: exported asset does not exist: ${target}`);
    }
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.copyFileSync(source, out);
  }
};

export const agentCatalogProvenancePath = () =>
  path.join(repoRoot, "agent-catalog", "agentOS", "references", "provenance.json");

export const agentCatalogProvenance = () => {
  const file = agentCatalogProvenancePath();
  if (!fs.existsSync(file)) {
    fail(`${repoPath(file)} is missing; run agent-catalog:generate first`);
  }
  const provenance = JSON.parse(fs.readFileSync(file, "utf8"));
  const catalogRoot = provenance.package?.catalogRoot;
  const sourcePackage = provenance.package?.sourcePackage;
  const publicPackage = provenance.package?.publicPackage;
  if (catalogRoot !== "agent-catalog/agentOS") {
    fail(`${repoPath(file)} must declare package.catalogRoot agent-catalog/agentOS`);
  }
  if (typeof sourcePackage !== "string" || sourcePackage.length === 0) {
    fail(`${repoPath(file)} must declare package.sourcePackage`);
  }
  if (!publishedRecords().some((record) => record.packageJson.name === sourcePackage)) {
    fail(`${repoPath(file)} declares non-published package.sourcePackage ${sourcePackage}`);
  }
  if (publicPackage !== publicPackageName(sourcePackage)) {
    fail(`${repoPath(file)} package.publicPackage does not match publish scope`);
  }
  return { catalogRoot, sourcePackage };
};

export const recordOwnsAgentCatalog = (record) =>
  record.packageJson.name === agentCatalogProvenance().sourcePackage;

export const copyDirectory = (sourceRoot, targetRoot) => {
  for (const source of allFiles(sourceRoot)) {
    const rel = path.relative(sourceRoot, source);
    const target = path.join(targetRoot, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
  }
};

export const copyAgentCatalog = (record) => {
  if (!recordOwnsAgentCatalog(record)) return;
  const { catalogRoot } = agentCatalogProvenance();
  copyDirectory(path.join(repoRoot, catalogRoot), path.join(record.stageDir, catalogRoot));
};

export const allFiles = (dir) => {
  if (!fs.existsSync(dir)) return [];
  const files = [];
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) {
        visit(target);
        continue;
      }
      if (entry.isFile()) files.push(target);
    }
  };
  visit(dir);
  return files.sort((left, right) => left.localeCompare(right));
};

export const projectedDependencies = (record) => {
  const version = packageVersion();
  const rootCatalog = catalog();
  const dependencies = {};
  for (const [name, value] of Object.entries(record.packageJson.dependencies ?? {})) {
    if (name === "effect") continue;
    if (isSourcePackageName(name)) {
      dependencies[publicPackageName(name)] = version;
      continue;
    }
    dependencies[name] = projectedDependencyRange(name, value, rootCatalog);
    if (dependencies[name] === undefined)
      fail(`${record.packagePath}: missing catalog value for ${name}`);
  }
  return Object.keys(dependencies).length === 0 ? undefined : dependencies;
};

export const projectedPeerDependencies = (record) => {
  const rootCatalog = catalog();
  const peers = {};
  const sourcePeers = new Map(Object.entries(record.packageJson.peerDependencies ?? {}));
  for (const name of packageUnitOptionalPeers(record)) {
    if (!sourcePeers.has(name)) {
      sourcePeers.set(name, isSourcePackageName(name) ? "workspace:*" : "catalog:");
    }
  }
  for (const [name, value] of sourcePeers) {
    const projectedName = isSourcePackageName(name) ? publicPackageName(name) : name;
    peers[projectedName] = projectedDependencyRange(name, value, rootCatalog);
    if (peers[projectedName] === undefined)
      fail(`${record.packagePath}: missing peer projection value for ${name}`);
  }
  if (packageImportsEffect(record)) {
    peers.effect = rootCatalog.effect;
  }
  return Object.keys(peers).length === 0 ? undefined : peers;
};

export const projectedPeerDependenciesMeta = (record) => {
  const entries = new Map(Object.entries(record.packageJson.peerDependenciesMeta ?? {}));
  for (const name of packageUnitOptionalPeers(record)) {
    if (!entries.has(name)) entries.set(name, { optional: true });
  }
  if (entries.size === 0) return undefined;
  return Object.fromEntries(
    [...entries.entries()].map(([name, value]) => [
      isSourcePackageName(name) ? publicPackageName(name) : name,
      value,
    ]),
  );
};

export const generatedManifest = (record) => {
  const entries = exportEntries(record);
  const exportsValue = Object.fromEntries(
    entries.map(([exportPath, target]) => [exportPath, generatedExportEntry(target)]),
  );
  const exportedAssets = exportedJsonAssets(record).map((target) => target.slice("./".length));
  const agentCatalogFiles = recordOwnsAgentCatalog(record) ? ["agent-catalog"] : [];
  const manifest = {
    name: publicPackageName(record.packageJson.name),
    version: packageVersion(),
    type: "module",
    license: "UNLICENSED",
    publishConfig: {
      access: publishAccess(),
    },
    main: exportsValue["."]?.default,
    types: exportsValue["."]?.types,
    bin: projectedBin(record),
    exports: entries.length === 0 ? undefined : exportsValue,
    files: [
      "dist",
      ...agentCatalogFiles,
      ...exportedAssets,
      ...(fs.existsSync(path.join(record.packageDir, "README.md")) ? ["README.md"] : []),
      ...(fs.existsSync(path.join(record.packageDir, "PUBLIC_API.md")) ? ["PUBLIC_API.md"] : []),
    ],
    dependencies: projectedDependencies(record),
    peerDependencies: projectedPeerDependencies(record),
    peerDependenciesMeta: projectedPeerDependenciesMeta(record),
  };
  return Object.fromEntries(Object.entries(manifest).filter(([, value]) => value !== undefined));
};

export const copyPackageDocs = (record) => {
  for (const name of ["README.md", "PUBLIC_API.md"]) {
    const source = path.join(record.packageDir, name);
    if (fs.existsSync(source)) {
      fs.writeFileSync(
        path.join(record.stageDir, name),
        rewritePublicSpecifiers(fs.readFileSync(source, "utf8")),
      );
    }
  }
};

export const assertStagedPackageDocsUsePublicScope = () => {
  const offenders = [];
  for (const record of publishedRecords()) {
    for (const name of ["README.md", "PUBLIC_API.md"]) {
      const file = path.join(record.stageDir, name);
      if (!fs.existsSync(file)) continue;
      const text = fs.readFileSync(file, "utf8");
      if (text.includes(`${sourcePackageScope}/`)) offenders.push(path.relative(root, file));
    }
  }
  if (offenders.length > 0) {
    fail(`staged package docs contain source package scope:\n${offenders.join("\n")}`);
  }
};

export const buildInternalPackages = () => {
  assertSurface();
  assertSourceManifests();
  fs.rmSync(distRoot, { recursive: true, force: true });
  fs.mkdirSync(stagingRoot, { recursive: true });
  for (const record of publishedRecords()) {
    fs.mkdirSync(record.stageDir, { recursive: true });
    emitJs(record);
    emitDeclarations(record);
    copyExportedAssets(record);
    copyPackageDocs(record);
    copyAgentCatalog(record);
    writeJson(path.join(record.stageDir, "package.json"), generatedManifest(record));
  }
  assertStagedPackageDocsUsePublicScope();
  console.log(`built ${publishedRecords().length} internal npm package projections`);
};
