import { parseApiIntentSource, publicApiIntentSections } from "./public-api-intent.mjs";

const rootOwnerPackagePaths = ["packages/core", "packages/runtime"];

const unique = (values) => [...new Set(values)];

const nodeLabel = (sourceFile, node) => {
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return `${sourceFile.fileName}:${position.line + 1}:${position.character + 1}`;
};

const sourceDirectiveFailures = ({ sourceFile, file, label }) => {
  const failures = [];
  for (const [kind, directives] of [
    ["path", sourceFile.referencedFiles],
    ["types", sourceFile.typeReferenceDirectives],
    ["lib", sourceFile.libReferenceDirectives],
  ]) {
    for (const directive of directives) {
      const position = sourceFile.getLineAndCharacterOfPosition(directive.pos);
      failures.push(
        `${file}:${position.line + 1}:${position.character + 1}: ${label} triple-slash ${kind} directive is forbidden`,
      );
    }
  }
  if (sourceFile.hasNoDefaultLib) {
    failures.push(`${file}: ${label} triple-slash no-default-lib directive is forbidden`);
  }
  if (sourceFile.amdDependencies.length > 0) {
    failures.push(`${file}: ${label} triple-slash amd-dependency directive is forbidden`);
  }
  if (sourceFile.moduleName !== undefined) {
    failures.push(`${file}: ${label} triple-slash amd-module directive is forbidden`);
  }
  return failures;
};

const exportName = (node) => node.text;

export const rootExportRecordsFromSource = ({ ts, file, source }) => {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const records = [];
  const failures = sourceFile.parseDiagnostics.map(
    (diagnostic) =>
      `${file}: root facade parse failed: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`,
  );
  failures.push(...sourceDirectiveFailures({ sourceFile, file, label: "root facade" }));

  for (const statement of sourceFile.statements) {
    if (!ts.isExportDeclaration(statement)) {
      failures.push(
        `${nodeLabel(sourceFile, statement)}: root facade permits only source-bearing named re-exports`,
      );
      continue;
    }
    if (
      statement.moduleSpecifier === undefined ||
      !ts.isStringLiteralLike(statement.moduleSpecifier)
    ) {
      failures.push(
        `${nodeLabel(sourceFile, statement)}: root facade local re-export is forbidden; name an owner module`,
      );
      continue;
    }
    const sourceModule = statement.moduleSpecifier.text;
    if (!sourceModule.startsWith(".")) {
      failures.push(
        `${nodeLabel(sourceFile, statement)}: root facade external/workspace re-export ${sourceModule} is forbidden`,
      );
      continue;
    }
    if (statement.exportClause === undefined) {
      failures.push(
        `${nodeLabel(sourceFile, statement)}: root facade export-star is forbidden; name every public symbol`,
      );
      continue;
    }
    if (!ts.isNamedExports(statement.exportClause)) {
      failures.push(
        `${nodeLabel(sourceFile, statement)}: root facade namespace export is forbidden`,
      );
      continue;
    }
    if (statement.exportClause.elements.length === 0) {
      failures.push(
        `${nodeLabel(sourceFile, statement)}: root facade named re-export must contain a symbol`,
      );
      continue;
    }

    for (const element of statement.exportClause.elements) {
      const publicName = exportName(element.name);
      const sourceName = exportName(element.propertyName ?? element.name);
      if (publicName === "default" || sourceName === "default") {
        failures.push(
          `${nodeLabel(sourceFile, element)}: root facade default export or default re-export is forbidden`,
        );
        continue;
      }
      records.push({
        publicName,
        sourceModule,
        sourceName,
        exportKind: statement.isTypeOnly || element.isTypeOnly ? "type" : "value",
        location: nodeLabel(sourceFile, element),
      });
    }
  }

  return { records, failures };
};

const exportTargetLeaves = (value) => {
  if (typeof value === "string") return { targets: [value], invalid: 0 };
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { targets: [], invalid: 1 };
  }
  return Object.values(value).reduce(
    (combined, child) => {
      const leaves = exportTargetLeaves(child);
      return {
        targets: [...combined.targets, ...leaves.targets],
        invalid: combined.invalid + leaves.invalid,
      };
    },
    { targets: [], invalid: 0 },
  );
};

const isWithin = ({ path, parent, child }) => {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
};

const canonicalExportTargets = ({
  fs,
  path,
  packageDirectory,
  canonicalPackageDirectory,
  packageName,
  label,
  value,
  failures,
}) => {
  const leaves = exportTargetLeaves(value);
  if (leaves.invalid > 0) {
    failures.push(
      `${packageName}: ${label} conditions contain ${leaves.invalid} non-source target(s)`,
    );
  }
  return unique(
    leaves.targets
      .map((target) => {
        const lexicalFile = path.resolve(packageDirectory, target);
        if (!isWithin({ path, parent: packageDirectory, child: lexicalFile })) {
          failures.push(`${packageName}: ${label} target escapes its package: ${target}`);
          return undefined;
        }
        if (!fs.existsSync(lexicalFile) || !fs.statSync(lexicalFile).isFile()) {
          failures.push(`${packageName}: ${label} source does not exist: ${target}`);
          return undefined;
        }
        const canonicalFile = fs.realpathSync(lexicalFile);
        if (
          !isWithin({
            path,
            parent: canonicalPackageDirectory,
            child: canonicalFile,
          })
        ) {
          failures.push(`${packageName}: ${label} source resolves outside its package: ${target}`);
          return undefined;
        }
        return canonicalFile;
      })
      .filter(Boolean),
  );
};

const publicIntentModel = ({ source, file }) => {
  const parsed = parseApiIntentSource({ source, sections: publicApiIntentSections, file });
  const counts = new Map();
  for (const entry of parsed.entries) {
    counts.set(entry.name, (counts.get(entry.name) ?? 0) + 1);
  }
  return { counts, failures: parsed.failures };
};

const defaultCompilerOptions = (ts) => ({
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  target: ts.ScriptTarget.Latest,
  noCheck: false,
  skipLibCheck: false,
  noEmit: true,
});

const proofCompilerOptions = (options) => ({
  ...options,
  noCheck: false,
  skipLibCheck: false,
  skipDefaultLibCheck: false,
  ...(options.allowJs === true ? { checkJs: true } : {}),
  noEmit: true,
});

const packageCompilerOptions = ({ fs, path, ts, packageDirectory, packageName, failures }) => {
  const configFile = path.join(packageDirectory, "tsconfig.json");
  if (!fs.existsSync(configFile) || !fs.statSync(configFile).isFile()) {
    failures.push(`${packageName}: package tsconfig.json is required for root owner proof`);
    return defaultCompilerOptions(ts);
  }
  const read = ts.readConfigFile(configFile, ts.sys.readFile);
  const parsed =
    read.error === undefined
      ? ts.parseJsonConfigFileContent(read.config, ts.sys, packageDirectory, {}, configFile)
      : undefined;
  for (const diagnostic of [read.error, ...(parsed?.errors ?? [])].filter(Boolean)) {
    failures.push(
      `${packageName}: package tsconfig.json is invalid: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`,
    );
  }
  return proofCompilerOptions(parsed?.options ?? defaultCompilerOptions(ts));
};

const resolveRelativeModule = ({ path, ts, options, fromFile, specifier }) => {
  const resolved = ts.resolveModuleName(specifier, fromFile, options, ts.sys).resolvedModule
    ?.resolvedFileName;
  return resolved === undefined ? undefined : path.resolve(resolved);
};

const createOwnerCapabilityLookup = ({
  fs,
  path,
  ts,
  packageDirectory,
  options,
  rootFile,
  ownerFiles,
}) => {
  const absoluteRootFile = path.resolve(rootFile);
  const absoluteOwnerFiles = unique(ownerFiles.map((file) => path.resolve(file)));
  const rootNames = unique([absoluteRootFile, ...absoluteOwnerFiles]);
  const program = ts.createProgram({ rootNames, options });
  const checker = program.getTypeChecker();
  const moduleExports = new Map();

  const exportsFor = (file) => {
    const absolute = path.resolve(file);
    if (moduleExports.has(absolute)) return moduleExports.get(absolute);
    const sourceFile = program.getSourceFile(absolute);
    const moduleSymbol =
      sourceFile === undefined ? undefined : checker.getSymbolAtLocation(sourceFile);
    const symbols = moduleSymbol === undefined ? [] : checker.getExportsOfModule(moduleSymbol);
    moduleExports.set(absolute, symbols);
    return symbols;
  };

  const isPackageSource = (sourceFile) =>
    isWithin({
      path,
      parent: packageDirectory,
      child: path.resolve(sourceFile.fileName),
    });
  const proofSourceFiles = program.getSourceFiles().filter(isPackageSource);

  const sourceDependencyFailures = [];
  for (const sourceFile of proofSourceFiles) {
    for (const imported of ts.preProcessFile(sourceFile.text, true, true).importedFiles) {
      if (
        path.isAbsolute(imported.fileName) ||
        path.win32.isAbsolute(imported.fileName) ||
        imported.fileName.startsWith("file:")
      ) {
        sourceDependencyFailures.push(
          `${sourceFile.fileName}: absolute source dependency is forbidden: ${imported.fileName}`,
        );
        continue;
      }
      if (!imported.fileName.startsWith(".")) continue;
      const lexicalBase = path.resolve(path.dirname(sourceFile.fileName), imported.fileName);
      if (!isWithin({ path, parent: packageDirectory, child: lexicalBase })) {
        sourceDependencyFailures.push(
          `${sourceFile.fileName}: relative dependency escapes its package: ${imported.fileName}`,
        );
        continue;
      }
      const resolved = resolveRelativeModule({
        path,
        ts,
        options,
        fromFile: sourceFile.fileName,
        specifier: imported.fileName,
      });
      if (resolved === undefined || !fs.existsSync(resolved)) {
        sourceDependencyFailures.push(
          `${sourceFile.fileName}: relative dependency cannot be resolved: ${imported.fileName}`,
        );
        continue;
      }
      const canonicalDependency = fs.realpathSync(resolved);
      if (!isWithin({ path, parent: packageDirectory, child: canonicalDependency })) {
        sourceDependencyFailures.push(
          `${sourceFile.fileName}: relative dependency resolves outside its package: ${imported.fileName}`,
        );
      }
    }
  }

  const diagnosticLabel = (sourceFile, diagnostic) => {
    if (diagnostic.start === undefined) return sourceFile.fileName;
    const position = sourceFile.getLineAndCharacterOfPosition(diagnostic.start);
    return `${sourceFile.fileName}:${position.line + 1}:${position.character + 1}`;
  };

  const failures = [...sourceDependencyFailures];
  for (const file of absoluteOwnerFiles) {
    if (program.getSourceFile(file) === undefined) {
      failures.push(`${file}: owner source is absent from TypeScript program`);
    }
  }
  for (const sourceFile of proofSourceFiles) {
    const canonicalSourceFile = fs.realpathSync(sourceFile.fileName);
    if (!isWithin({ path, parent: packageDirectory, child: canonicalSourceFile })) {
      failures.push(`${sourceFile.fileName}: owner proof dependency resolves outside its package`);
    }
    failures.push(
      ...sourceDirectiveFailures({
        sourceFile,
        file: sourceFile.fileName,
        label: "owner export closure",
      }),
    );
    if (sourceFile.checkJsDirective?.enabled === false) {
      failures.push(`${sourceFile.fileName}: owner export closure forbids @ts-nocheck`);
    }
    if ((sourceFile.commentDirectives?.length ?? 0) > 0) {
      failures.push(
        `${sourceFile.fileName}: owner export closure forbids TypeScript diagnostic suppression directives`,
      );
    }
    for (const diagnostic of program.getSyntacticDiagnostics(sourceFile)) {
      failures.push(
        `${diagnosticLabel(sourceFile, diagnostic)}: owner export closure is syntactically invalid: TS${diagnostic.code} ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`,
      );
    }
    for (const diagnostic of program.getSemanticDiagnostics(sourceFile)) {
      failures.push(
        `${diagnosticLabel(sourceFile, diagnostic)}: owner export closure is semantically invalid: TS${diagnostic.code} ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`,
      );
    }
  }

  const lookup = (file, sourceName, publicName) => {
    const ownerMatches = exportsFor(file).filter((symbol) => symbol.getName() === sourceName);
    if (ownerMatches.length !== 1) {
      return { count: ownerMatches.length, provenance: false, type: false, value: false };
    }
    const ownerSymbol = ownerMatches[0];
    const ownerTarget =
      (ownerSymbol.flags & ts.SymbolFlags.Alias) === 0
        ? ownerSymbol
        : checker.getAliasedSymbol(ownerSymbol);
    const rootMatches = exportsFor(absoluteRootFile).filter(
      (symbol) => symbol.getName() === publicName,
    );
    if (rootMatches.length !== 1) {
      return { count: ownerMatches.length, provenance: false, type: false, value: false };
    }
    const rootSymbol = rootMatches[0];
    if ((rootSymbol.flags & ts.SymbolFlags.Alias) === 0) {
      return { count: ownerMatches.length, provenance: false, type: false, value: false };
    }
    const target = checker.getAliasedSymbol(rootSymbol);
    const targetFiles = unique(
      (target.getDeclarations() ?? []).map((declaration) =>
        fs.realpathSync(declaration.getSourceFile().fileName),
      ),
    );
    const typeOnlyPath = checker.getTypeOnlyAliasDeclaration(rootSymbol) !== undefined;
    return {
      count: 1,
      provenance: target === ownerTarget,
      target,
      targetWithinPackage:
        targetFiles.length > 0 &&
        targetFiles.every((file) => isWithin({ path, parent: packageDirectory, child: file })),
      type: (target.flags & ts.SymbolFlags.Type) !== 0,
      value: !typeOnlyPath && (target.flags & ts.SymbolFlags.Value) !== 0,
    };
  };

  return { failures: unique(failures), lookup };
};

const entrypointAudiences = ({ packageName, surfacePackage, subpath, failures }) => {
  const matches = (surfacePackage.entrypoints ?? []).filter((entry) => entry.subpath === subpath);
  if (matches.length !== 1) {
    failures.push(
      `${packageName}: docs/surface.json must declare exactly one ${subpath} entrypoint; observed ${matches.length}`,
    );
    return undefined;
  }
  const audiences = matches[0].audiences;
  if (
    !Array.isArray(audiences) ||
    audiences.length === 0 ||
    audiences.some((audience) => typeof audience !== "string" || audience.length === 0) ||
    new Set(audiences).size !== audiences.length
  ) {
    failures.push(
      `${packageName}: docs/surface.json ${subpath} audiences must be a non-empty unique string set`,
    );
    return undefined;
  }
  return audiences;
};

const onePublicIntent = ({ packageName, apiSource, counts, key, role, failures }) => {
  const count = counts.get(key) ?? 0;
  if (count !== 1) {
    failures.push(
      `${packageName}: ${apiSource} must declare exactly one ${role} intent ${key}; observed ${count}`,
    );
  }
};

export const packageRootOwnerFailures = ({
  fs,
  path,
  ts,
  repoRoot,
  packagePath,
  surfacePackage,
}) => {
  const failures = [];
  const packageDirectory = path.join(repoRoot, packagePath);
  const canonicalPackageDirectory = fs.realpathSync(packageDirectory);
  const packageManifestPath = path.join(packageDirectory, "package.json");
  const manifest = JSON.parse(fs.readFileSync(packageManifestPath, "utf8"));
  const packageName = manifest.name ?? packagePath;
  const options = packageCompilerOptions({
    fs,
    path,
    ts,
    packageDirectory,
    packageName,
    failures,
  });
  const exportsMap = manifest.exports;
  if (exportsMap === null || typeof exportsMap !== "object" || Array.isArray(exportsMap)) {
    return [`${packageName}: package exports map is required for root owner proof`];
  }

  const rootTargets = canonicalExportTargets({
    fs,
    path,
    packageDirectory,
    canonicalPackageDirectory,
    packageName,
    label: "package root",
    value: exportsMap["."],
    failures,
  });
  if (rootTargets.length !== 1) {
    return unique([
      ...failures,
      `${packageName}: package root must resolve to exactly one source module; observed ${rootTargets.length}`,
    ]);
  }
  const rootFile = rootTargets[0];

  const relativeRootFile = path.relative(repoRoot, rootFile).split(path.sep).join("/");
  const parsed = rootExportRecordsFromSource({
    ts,
    file: relativeRootFile,
    source: fs.readFileSync(rootFile, "utf8"),
  });
  failures.push(...parsed.failures);

  const publicNames = new Map();
  for (const record of parsed.records) {
    publicNames.set(record.publicName, [...(publicNames.get(record.publicName) ?? []), record]);
  }
  for (const [name, records] of publicNames) {
    if (records.length > 1) {
      failures.push(
        `${packageName}: root publicName ${name} has ${records.length} mappings; exactly one is required`,
      );
    }
  }

  const ownerExports = Object.entries(exportsMap)
    .filter(([subpath]) => subpath !== "." && !subpath.includes("*"))
    .map(([subpath, target]) => ({
      subpath,
      files: canonicalExportTargets({
        fs,
        path,
        packageDirectory,
        canonicalPackageDirectory,
        packageName,
        label: `package owner ${subpath}`,
        value: target,
        failures,
      }),
    }));
  for (const owner of ownerExports) {
    if (owner.files.length !== 1) {
      failures.push(
        `${packageName}: package owner ${owner.subpath} conditions must converge to exactly one source module; observed ${owner.files.length}`,
      );
    }
    if (owner.files.includes(rootFile)) {
      failures.push(
        `${packageName}: package owner ${owner.subpath} must not alias the package root source`,
      );
    }
  }
  const ownerProofs = [];
  for (const record of parsed.records) {
    const resolvedFile = resolveRelativeModule({
      path,
      ts,
      options,
      fromFile: rootFile,
      specifier: record.sourceModule,
    });
    if (resolvedFile === undefined) {
      failures.push(
        `${record.location}: ${packageName} root source module ${record.sourceModule} cannot be resolved`,
      );
      continue;
    }
    if (
      !isWithin({
        path,
        parent: canonicalPackageDirectory,
        child: resolvedFile,
      })
    ) {
      failures.push(
        `${record.location}: ${packageName} root owner module escapes its package: ${record.sourceModule}`,
      );
      continue;
    }
    if (!fs.existsSync(resolvedFile) || !fs.statSync(resolvedFile).isFile()) {
      failures.push(
        `${record.location}: ${packageName} root owner module is not a file: ${record.sourceModule}`,
      );
      continue;
    }
    const canonicalResolvedFile = fs.realpathSync(resolvedFile);
    if (
      !isWithin({
        path,
        parent: canonicalPackageDirectory,
        child: canonicalResolvedFile,
      })
    ) {
      failures.push(
        `${record.location}: ${packageName} root owner module resolves outside its package: ${record.sourceModule}`,
      );
      continue;
    }
    const ownerCandidates = ownerExports.filter(
      (owner) => owner.files.includes(canonicalResolvedFile) && !owner.files.includes(rootFile),
    );
    if (ownerCandidates.length !== 1) {
      failures.push(
        `${record.location}: ${packageName} root mapping ${record.publicName} -> ${record.sourceModule}:${record.sourceName} must resolve to exactly one non-root package owner; observed ${ownerCandidates.length}`,
      );
      continue;
    }
    ownerProofs.push({
      ...record,
      ownerFile: canonicalResolvedFile,
      ownerSubpath: ownerCandidates[0].subpath,
    });
  }

  if (surfacePackage === undefined) {
    failures.push(`${packageName}: docs/surface.json package declaration is required`);
    return unique(failures);
  }
  const apiSource = surfacePackage.apiSource;
  let intentCounts;
  if (typeof apiSource !== "string") {
    failures.push(`${packageName}: docs/surface.json apiSource is required for root owner proof`);
  } else {
    const apiFile = path.join(repoRoot, apiSource);
    if (!fs.existsSync(apiFile) || !fs.statSync(apiFile).isFile()) {
      failures.push(`${packageName}: public API intent source does not exist: ${apiSource}`);
    } else {
      const intentModel = publicIntentModel({
        source: fs.readFileSync(apiFile, "utf8"),
        file: apiSource,
      });
      intentCounts = intentModel.counts;
      failures.push(...intentModel.failures);
    }
  }

  const audienceCache = new Map();
  const audiencesFor = (subpath) => {
    if (!audienceCache.has(subpath)) {
      audienceCache.set(
        subpath,
        entrypointAudiences({ packageName, surfacePackage, subpath, failures }),
      );
    }
    return audienceCache.get(subpath);
  };
  const rootAudiences = audiencesFor(".");
  for (const subpath of unique(ownerProofs.map((proof) => proof.ownerSubpath))) {
    const ownerAudiences = audiencesFor(subpath);
    if (rootAudiences !== undefined && ownerAudiences !== undefined) {
      const missing = rootAudiences.filter((audience) => !ownerAudiences.includes(audience));
      if (missing.length > 0) {
        failures.push(
          `${packageName}: root audiences [${rootAudiences.join(", ")}] are not a subset of owner ${subpath} audiences [${ownerAudiences.join(", ")}]; missing ${missing.join(", ")}`,
        );
      }
    }
  }

  const ownerCapabilities = createOwnerCapabilityLookup({
    fs,
    path,
    ts,
    packageDirectory: canonicalPackageDirectory,
    options,
    rootFile,
    ownerFiles: ownerProofs.map((proof) => proof.ownerFile),
  });
  failures.push(...ownerCapabilities.failures);
  const ultimateMappings = new Map();
  for (const proof of ownerProofs) {
    if (intentCounts !== undefined && typeof apiSource === "string") {
      onePublicIntent({
        packageName,
        apiSource,
        counts: intentCounts,
        key: `.:${proof.publicName}`,
        role: "root aggregation",
        failures,
      });
      onePublicIntent({
        packageName,
        apiSource,
        counts: intentCounts,
        key: `${proof.ownerSubpath}:${proof.sourceName}`,
        role: "owner",
        failures,
      });
    }

    const capabilities = ownerCapabilities.lookup(
      proof.ownerFile,
      proof.sourceName,
      proof.publicName,
    );
    if (capabilities.count !== 1) {
      failures.push(
        `${packageName}: owner ${proof.ownerSubpath} must actually export exactly one ${proof.sourceName}; observed ${capabilities.count}`,
      );
      continue;
    }
    if (!capabilities.provenance || capabilities.target === undefined) {
      failures.push(
        `${packageName}: root ${proof.publicName} does not resolve to owner ${proof.ownerSubpath}:${proof.sourceName} ultimate symbol`,
      );
      continue;
    }
    if (!capabilities.targetWithinPackage) {
      failures.push(
        `${packageName}: root ${proof.publicName} ultimate symbol resolves outside its package`,
      );
      continue;
    }
    ultimateMappings.set(capabilities.target, [
      ...(ultimateMappings.get(capabilities.target) ?? []),
      proof,
    ]);
    if (!capabilities[proof.exportKind]) {
      const actual = [
        capabilities.type ? "type" : undefined,
        capabilities.value ? "value" : undefined,
      ]
        .filter(Boolean)
        .join("+");
      failures.push(
        `${packageName}: root ${proof.publicName} requests ${proof.exportKind} from ${proof.ownerSubpath}:${proof.sourceName}, but owner capabilities are ${actual || "none"}`,
      );
    }
  }
  for (const records of ultimateMappings.values()) {
    if (records.length > 1) {
      failures.push(
        `${packageName}: owner source symbol ${records[0].ownerSubpath}:${records[0].sourceName} maps to multiple root names ${records.map((record) => record.publicName).join(", ")}`,
      );
    }
  }

  return unique(failures);
};

export const createRootOwnerChecks = ({ fs, path, ts, repoRoot, readJson }) => ({
  rootOwnerProofFailures: () => {
    const surface = readJson("docs/surface.json");
    return rootOwnerPackagePaths.flatMap((packagePath) => {
      const manifest = JSON.parse(
        fs.readFileSync(path.join(repoRoot, packagePath, "package.json"), "utf8"),
      );
      const matches = (surface.packages ?? []).filter((pkg) => pkg.name === manifest.name);
      if (matches.length !== 1) {
        return [
          `${manifest.name}: docs/surface.json must declare exactly one package record; observed ${matches.length}`,
        ];
      }
      return packageRootOwnerFailures({
        fs,
        path,
        ts,
        repoRoot,
        packagePath,
        surfacePackage: matches[0],
      });
    });
  },
});
