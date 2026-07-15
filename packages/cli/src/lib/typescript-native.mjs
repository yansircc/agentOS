import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as ast from "typescript/unstable/ast";
import { API, ModuleKind, SymbolFlags } from "typescript/unstable/sync";

const overlay = new Map();
let operationSequence = 0;
const nativeOptions = {
  cwd: process.cwd(),
  fs: {
    readFile: (file) => overlay.get(path.resolve(file)),
    fileExists: (file) => (overlay.has(path.resolve(file)) ? true : undefined),
  },
};
const native = new API(nativeOptions);
const resolutionNative = new API(nativeOptions);
const openedResolutionProjects = new Set();
let resolutionSnapshot;
let activeResolutionSession;

const beginModuleResolutionSession = () => {
  if (activeResolutionSession === undefined) {
    activeResolutionSession = { depth: 0, refreshedProjects: new Set() };
  }
  const session = activeResolutionSession;
  session.depth += 1;
  let disposed = false;
  return {
    dispose: () => {
      if (disposed || activeResolutionSession !== session) {
        throw new Error("TypeScript module resolution session ownership mismatch");
      }
      disposed = true;
      session.depth -= 1;
      if (session.depth === 0) activeResolutionSession = undefined;
    },
  };
};

const updateForFile = (file) => {
  const absolute = path.resolve(file);
  const snapshot = native.updateSnapshot({ openFiles: [absolute] });
  return { absolute, snapshot };
};

const closeSnapshotFile = (snapshot, file) => {
  const closed = native.updateSnapshot({ closeFiles: [file] });
  snapshot.dispose();
  closed.dispose();
  overlay.delete(file);
};

const closeSnapshotProject = (snapshot, configFile) => {
  const closed = native.updateSnapshot({ closeProjects: [configFile] });
  snapshot.dispose();
  closed.dispose();
  overlay.delete(configFile);
};

const directiveMetadata = (source) => {
  const referencedFiles = [];
  const typeReferenceDirectives = [];
  const libReferenceDirectives = [];
  const amdDependencies = [];
  const commentDirectives = [];
  let hasNoDefaultLib = false;
  let moduleName;
  let checkJsDirective;
  let offset = 0;
  for (const line of source.split(/(?<=\n)/u)) {
    const reference = line.match(
      /^\s*\/\/\/\s*<reference\s+(path|types|lib|no-default-lib)="([^"]+)"\s*\/>\s*$/u,
    );
    if (reference !== null) {
      const record = { fileName: reference[2], pos: offset, end: offset + line.length };
      if (reference[1] === "path") referencedFiles.push(record);
      if (reference[1] === "types") typeReferenceDirectives.push(record);
      if (reference[1] === "lib") libReferenceDirectives.push(record);
      if (reference[1] === "no-default-lib" && reference[2] === "true") hasNoDefaultLib = true;
    }
    const amdDependency = line.match(/^\s*\/\/\/\s*<amd-dependency\s+path="([^"]+)"\s*\/>\s*$/u);
    if (amdDependency !== null) amdDependencies.push({ path: amdDependency[1] });
    const amdModule = line.match(/^\s*\/\/\/\s*<amd-module\s+name="([^"]+)"\s*\/>\s*$/u);
    if (amdModule !== null) moduleName = amdModule[1];
    if (/^\s*\/\/\s*@ts-nocheck\b/u.test(line)) checkJsDirective = { enabled: false };
    if (/^\s*\/\/\s*@ts-(?:ignore|expect-error)\b/u.test(line)) {
      commentDirectives.push({ pos: offset, end: offset + line.length });
    }
    offset += line.length;
  }
  return {
    referencedFiles,
    typeReferenceDirectives,
    libReferenceDirectives,
    amdDependencies,
    hasNoDefaultLib,
    moduleName,
    checkJsDirective,
    commentDirectives,
  };
};

const sourceFileProxy = (sourceFile, requestedFileName, parseDiagnostics) => {
  const directives = directiveMetadata(sourceFile.text);
  return new Proxy(sourceFile, {
    get: (target, property) => {
      if (property === "__nativeSourceFile") return target;
      if (property === "fileName") return requestedFileName;
      if (property === "parseDiagnostics") return parseDiagnostics;
      if (property in directives) return directives[property];
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
};

const createSourceFile = (fileName, source) => {
  const extension = path.extname(fileName) || ".ts";
  const absolute = path.resolve(`/.agentos-native/source-${operationSequence++}${extension}`);
  overlay.set(absolute, source);
  const { snapshot } = updateForFile(absolute);
  const project = snapshot.getDefaultProjectForFile(absolute);
  const sourceFile = project?.program.getSourceFile(absolute);
  if (project === undefined || sourceFile === undefined) {
    throw new Error(`TypeScript 7 native parser did not return ${fileName}`);
  }
  const result = sourceFileProxy(sourceFile, fileName, [
    ...project.program.getSyntacticDiagnostics(absolute),
  ]);
  closeSnapshotFile(snapshot, absolute);
  return result;
};

const forEachChild = (node, visitNode, visitNodes) => node.forEachChild(visitNode, visitNodes);

const isStringLiteralLike = (node) =>
  ast.isStringLiteral(node) || ast.isNoSubstitutionTemplateLiteral(node);
const isPropertySignature = (node) => ast.isPropertySignatureDeclaration(node);
const isParameter = (node) => ast.isParameterDeclaration(node);
const canHaveModifiers = (node) => "modifiers" in node;
const getModifiers = (node) => node.modifiers;

const flattenDiagnosticMessageText = (message, newline = "\n") => {
  if (typeof message === "string") return message;
  const parts = [];
  let current = message;
  while (current !== undefined) {
    parts.push(current.messageText);
    current = current.next?.[0];
  }
  return parts.join(newline);
};

const sys = {
  args: process.argv.slice(2),
  newLine: "\n",
  useCaseSensitiveFileNames: true,
  write: (text) => process.stdout.write(text),
  writeOutputIsTTY: () => process.stdout.isTTY === true,
  readFile: (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : undefined),
  writeFile: (file, content) => fs.writeFileSync(file, content),
  fileExists: (file) => fs.existsSync(file) && fs.statSync(file).isFile(),
  directoryExists: (directory) => fs.existsSync(directory) && fs.statSync(directory).isDirectory(),
  createDirectory: (directory) => fs.mkdirSync(directory, { recursive: true }),
  getCurrentDirectory: () => process.cwd(),
  getDirectories: (directory) =>
    fs.existsSync(directory)
      ? fs
          .readdirSync(directory, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => path.join(directory, entry.name))
      : [],
  readDirectory: (directory) =>
    fs.existsSync(directory)
      ? fs.readdirSync(directory, { recursive: true }).map((entry) => path.join(directory, entry))
      : [],
  realpath: (file) => fs.realpathSync(file),
};

const parseConfig = (configFile, existingOptions = {}) => {
  try {
    const parsed = native.parseConfigFile(path.resolve(configFile));
    return {
      options: { ...parsed.options, ...existingOptions },
      fileNames: [...parsed.fileNames],
      errors: [],
    };
  } catch (error) {
    return {
      options: { ...existingOptions },
      fileNames: [],
      errors: [{ messageText: error instanceof Error ? error.message : String(error) }],
    };
  }
};

const readConfigFile = (configFile) =>
  fs.existsSync(configFile)
    ? { config: { __nativeConfigFile: path.resolve(configFile) } }
    : { error: { messageText: `Cannot read file '${configFile}'.` } };

const parseJsonConfigFileContent = (config, _host, basePath, existingOptions = {}, configFile) => {
  const owner = config?.__nativeConfigFile ?? configFile;
  if (owner !== undefined) return parseConfig(owner, existingOptions);
  return { options: { ...config, ...existingOptions }, fileNames: [], errors: [] };
};

const getParsedCommandLineOfConfigFile = (configFile, existingOptions = {}) =>
  parseConfig(configFile, existingOptions);

const convertCompilerOptionsFromJson = (options) => ({ options: { ...options }, errors: [] });

const findConfigFile = (searchPath, fileExists = sys.fileExists, configName = "tsconfig.json") => {
  let current = path.resolve(searchPath);
  while (true) {
    const candidate = path.join(current, configName);
    if (fileExists(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
};

const sourceReferences = (source) => {
  const sourceFile = createSourceFile(
    `/.agentos-native/preprocess-${operationSequence++}.ts`,
    source,
  );
  const importedFiles = [];
  const visit = (node) => {
    if (
      (ast.isImportDeclaration(node) || ast.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      isStringLiteralLike(node.moduleSpecifier)
    ) {
      importedFiles.push({ fileName: node.moduleSpecifier.text });
    }
    if (
      ast.isCallExpression(node) &&
      node.expression.kind === ast.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      isStringLiteralLike(node.arguments[0])
    ) {
      importedFiles.push({ fileName: node.arguments[0].text });
    }
    if (
      ast.isImportEqualsDeclaration(node) &&
      ast.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression !== undefined &&
      isStringLiteralLike(node.moduleReference.expression)
    ) {
      importedFiles.push({ fileName: node.moduleReference.expression.text });
    }
    if (
      ast.isImportTypeNode(node) &&
      ast.isLiteralTypeNode(node.argument) &&
      isStringLiteralLike(node.argument.literal)
    ) {
      importedFiles.push({ fileName: node.argument.literal.text });
    }
    forEachChild(node, visit);
  };
  visit(sourceFile);
  return {
    importedFiles,
    referencedFiles: [...sourceFile.referencedFiles],
    typeReferenceDirectives: [...sourceFile.typeReferenceDirectives],
    libReferenceDirectives: [...sourceFile.libReferenceDirectives],
  };
};

const resolveModuleName = (specifier, containingFile, options = {}) => {
  const physicalResolutionPath = (resolvedFile) =>
    sys.realpath(path.resolve(containingFile)) === path.resolve(containingFile)
      ? sys.realpath(resolvedFile)
      : resolvedFile;
  const configuredProject = path.resolve(options.configFilePath ?? "");
  if (options.configFilePath !== undefined && sys.fileExists(configuredProject)) {
    const needsOpen = !openedResolutionProjects.has(configuredProject);
    const needsRefresh =
      activeResolutionSession === undefined ||
      !activeResolutionSession.refreshedProjects.has(configuredProject);
    if (needsOpen || needsRefresh) {
      const update = needsOpen
        ? {
            closeProjects: [...openedResolutionProjects],
            openProjects: [configuredProject],
          }
        : activeResolutionSession === undefined
          ? { fileChanges: { changed: [path.resolve(containingFile)] } }
          : { fileChanges: { invalidateAll: true } };
      const previous = resolutionSnapshot;
      resolutionSnapshot = resolutionNative.updateSnapshot(update);
      previous?.dispose();
      if (needsOpen) {
        openedResolutionProjects.clear();
        openedResolutionProjects.add(configuredProject);
      }
      activeResolutionSession?.refreshedProjects.add(configuredProject);
    }
    const project = resolutionSnapshot.getProject(configuredProject);
    const absoluteContainingFile = path.resolve(containingFile);
    const canonicalContainingFile = sys.realpath(absoluteContainingFile);
    const sourceFileName = project?.program.getSourceFileNames().find((file) => {
      if (path.resolve(file) === absoluteContainingFile) return true;
      try {
        return sys.realpath(file) === canonicalContainingFile;
      } catch {
        return false;
      }
    });
    const sourceFile =
      sourceFileName === undefined ? undefined : project?.program.getSourceFile(sourceFileName);
    let moduleSpecifier;
    const visit = (node) => {
      if (moduleSpecifier !== undefined) return;
      if (
        (ast.isImportDeclaration(node) || ast.isExportDeclaration(node)) &&
        node.moduleSpecifier !== undefined &&
        isStringLiteralLike(node.moduleSpecifier) &&
        node.moduleSpecifier.text === specifier
      ) {
        moduleSpecifier = node.moduleSpecifier;
        return;
      }
      if (
        ast.isImportEqualsDeclaration(node) &&
        ast.isExternalModuleReference(node.moduleReference) &&
        isStringLiteralLike(node.moduleReference.expression) &&
        node.moduleReference.expression.text === specifier
      ) {
        moduleSpecifier = node.moduleReference.expression;
        return;
      }
      if (
        ast.isCallExpression(node) &&
        node.expression.kind === ast.SyntaxKind.ImportKeyword &&
        node.arguments.length === 1 &&
        isStringLiteralLike(node.arguments[0]) &&
        node.arguments[0].text === specifier
      ) {
        moduleSpecifier = node.arguments[0];
        return;
      }
      if (
        ast.isImportTypeNode(node) &&
        ast.isLiteralTypeNode(node.argument) &&
        isStringLiteralLike(node.argument.literal) &&
        node.argument.literal.text === specifier
      ) {
        moduleSpecifier = node.argument.literal;
        return;
      }
      forEachChild(node, visit);
    };
    if (sourceFile !== undefined) visit(sourceFile);
    const moduleSymbol =
      moduleSpecifier === undefined
        ? undefined
        : project.checker.getSymbolAtLocation(moduleSpecifier);
    const resolvedFile = moduleSymbol?.declarations
      .map((handle) => handle.resolve(project))
      .find(Boolean)
      ?.getSourceFile().fileName;
    const resolved = resolvedFile === undefined ? undefined : physicalResolutionPath(resolvedFile);
    return resolved === undefined
      ? { resolvedModule: undefined }
      : {
          resolvedModule: {
            resolvedFileName: resolved,
            isExternalLibraryImport: !specifier.startsWith("."),
          },
        };
  }

  const ownerDirectory = path.dirname(path.resolve(containingFile));
  const configDirectory =
    options.pathsBasePath ??
    (options.configFilePath === undefined ? ownerDirectory : path.dirname(options.configFilePath));
  const sourceFile = path.join(
    ownerDirectory,
    `.agentos-native-resolution-${operationSequence}.ts`,
  );
  const configFile = path.join(
    configDirectory,
    `.agentos-native-resolution-${operationSequence++}.json`,
  );
  overlay.set(sourceFile, `import * as resolved from ${JSON.stringify(specifier)};\n`);
  overlay.set(
    configFile,
    JSON.stringify({
      files: [sourceFile],
      compilerOptions: compilerOptionsForJson({
        ...options,
        configFilePath: undefined,
        pathsBasePath: undefined,
        noEmit: true,
      }),
    }),
  );
  const snapshot = native.updateSnapshot({ openProjects: [configFile] });
  const project = snapshot.getProject(configFile);
  const source = project?.program.getSourceFile(sourceFile);
  const importDeclaration = source?.statements.find(ast.isImportDeclaration);
  const moduleSymbol =
    importDeclaration === undefined
      ? undefined
      : project.checker.getSymbolAtLocation(importDeclaration.moduleSpecifier);
  const resolvedFile = moduleSymbol?.declarations
    .map((handle) => handle.resolve(project))
    .find(Boolean)
    ?.getSourceFile().fileName;
  const resolved = resolvedFile === undefined ? undefined : physicalResolutionPath(resolvedFile);
  closeSnapshotProject(snapshot, configFile);
  overlay.delete(sourceFile);
  return resolved === undefined
    ? { resolvedModule: undefined }
    : {
        resolvedModule: {
          resolvedFileName: resolved,
          isExternalLibraryImport: !specifier.startsWith("."),
        },
      };
};

const unwrapSymbol = (symbol) => symbol?.__nativeSymbol ?? symbol;

const checkerFacade = (checker, project) => {
  const symbols = new WeakMap();
  const resolvedDeclarations = (symbol) =>
    symbol.declarations.map((handle) => handle.resolve(project)).filter(Boolean);
  const isTypeOnlyDeclaration = (node) =>
    node?.isTypeOnly === true || node?.parent?.isTypeOnly === true;
  const aliasTarget = (symbol) =>
    (symbol.flags & SymbolFlags.Alias) === 0 ? symbol : checker.getAliasedSymbol(symbol);
  const exportCapability = (moduleSymbol, exportName, target, active = new Set()) => {
    const key = `${moduleSymbol.id}:${exportName}:${target.id}`;
    if (active.has(key)) return { found: false, value: false };
    const nextActive = new Set(active).add(key);
    const moduleSources = new Set(
      resolvedDeclarations(moduleSymbol).map((declaration) => declaration.getSourceFile().fileName),
    );
    const exported = checker
      .getExportsOfModule(moduleSymbol)
      .find((entry) => entry.name === exportName && aliasTarget(entry) === target);
    if (exported === undefined) return { found: false, value: false };

    const ownDeclarations = resolvedDeclarations(exported).filter((declaration) =>
      moduleSources.has(declaration.getSourceFile().fileName),
    );
    if (ownDeclarations.length > 0) {
      const valueDeclaration = ownDeclarations.find(
        (declaration) => !isTypeOnlyDeclaration(declaration),
      );
      return valueDeclaration === undefined
        ? { found: true, value: false, declaration: ownDeclarations[0] }
        : { found: true, value: true };
    }

    let found = false;
    let declaration;
    for (const sourceFile of resolvedDeclarations(moduleSymbol)) {
      for (const statement of sourceFile.statements ?? []) {
        if (
          !ast.isExportDeclaration(statement) ||
          statement.exportClause !== undefined ||
          statement.moduleSpecifier === undefined
        ) {
          continue;
        }
        const targetModule = checker.getSymbolAtLocation(statement.moduleSpecifier);
        if (targetModule === undefined) continue;
        const contribution = checker
          .getExportsOfModule(targetModule)
          .find((entry) => entry.name === exportName && aliasTarget(entry) === target);
        if (contribution === undefined) continue;
        const downstream = exportCapability(targetModule, exportName, target, nextActive);
        if (!downstream.found) continue;
        found = true;
        if (statement.isTypeOnly !== true && downstream.value) {
          return { found: true, value: true };
        }
        declaration ??= statement.isTypeOnly === true ? statement : downstream.declaration;
      }
    }
    return { found, value: false, declaration };
  };
  const wrapSymbol = (symbol) => {
    const cached = symbols.get(symbol);
    if (cached !== undefined) return cached;
    const wrapped = {
      __nativeSymbol: symbol,
      flags: symbol.flags,
      getName: () => symbol.name,
      getDeclarations: () =>
        symbol.declarations.map((declaration) => declaration.resolve(project)).filter(Boolean),
    };
    symbols.set(symbol, wrapped);
    return wrapped;
  };
  return {
    getSymbolAtLocation: (node) => {
      const symbol = checker.getSymbolAtLocation(node?.__nativeSourceFile ?? node);
      return symbol === undefined ? undefined : wrapSymbol(symbol);
    },
    getExportsOfModule: (symbol) =>
      checker.getExportsOfModule(unwrapSymbol(symbol)).map((entry) => wrapSymbol(entry)),
    getAliasedSymbol: (symbol) => wrapSymbol(checker.getAliasedSymbol(unwrapSymbol(symbol))),
    getTypeOnlyAliasDeclaration: (symbol) => {
      let current = unwrapSymbol(symbol);
      const seen = new Set();
      while (current !== undefined && !seen.has(current)) {
        seen.add(current);
        const declarations = resolvedDeclarations(current);
        const declaration = declarations.find(isTypeOnlyDeclaration);
        if (declaration !== undefined) return declaration;
        if ((current.flags & SymbolFlags.Alias) === 0) return undefined;
        const finalTarget = checker.getAliasedSymbol(current);
        for (const node of declarations) {
          const exportDeclaration = ast.isExportSpecifier(node) ? node.parent?.parent : undefined;
          if (
            exportDeclaration === undefined ||
            !ast.isExportDeclaration(exportDeclaration) ||
            exportDeclaration.moduleSpecifier === undefined
          ) {
            continue;
          }
          const moduleSymbol = checker.getSymbolAtLocation(exportDeclaration.moduleSpecifier);
          if (moduleSymbol === undefined) continue;
          const exportName = node.propertyName?.text ?? node.name.text;
          const capability = exportCapability(moduleSymbol, exportName, finalTarget);
          if (capability.found && !capability.value) return capability.declaration;
        }
        current = checker.getImmediateAliasedSymbol(current);
      }
      return undefined;
    },
  };
};

const compilerOptionsForJson = (options) =>
  Object.fromEntries(
    Object.entries(options ?? {})
      .filter(([, value]) => value !== undefined)
      .map(([name, value]) => {
        if (name === "target" && typeof value === "number") return [name, ast.ScriptTarget[value]];
        if (name === "module" && typeof value === "number") return [name, ModuleKind[value]];
        if (name === "moduleResolution" && typeof value === "number") {
          return [name, value === 100 ? "Bundler" : value];
        }
        return [name, value];
      }),
  );

const rawCompilerOptions = (options, outDir) => {
  const pathsBasePath = options.pathsBasePath;
  const converted = compilerOptionsForJson({
    ...options,
    configFilePath: undefined,
    pathsBasePath: undefined,
    tsBuildInfoFile: undefined,
    incremental: false,
    composite: false,
    outDir,
  });
  if (converted.paths !== undefined && pathsBasePath !== undefined) {
    converted.paths = Object.fromEntries(
      Object.entries(converted.paths).map(([specifier, targets]) => [
        specifier,
        targets.map((target) =>
          path.isAbsolute(target) ? target : path.resolve(pathsBasePath, target),
        ),
      ]),
    );
  }
  return converted;
};

const outputFiles = (directory) =>
  fs.existsSync(directory)
    ? fs
        .readdirSync(directory, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => path.join(entry.parentPath, entry.name))
        .sort()
    : [];

const emitRaw = ({ rootNames, options = {} }) => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "agentos-typescript-7-emit-"));
  const outDir = path.join(temporaryDirectory, "out");
  const configFile = path.join(temporaryDirectory, "tsconfig.json");
  const tsc = path.join(
    path.dirname(fileURLToPath(import.meta.resolve("typescript/package.json"))),
    "bin",
    "tsc",
  );
  try {
    fs.writeFileSync(
      configFile,
      JSON.stringify({
        files: rootNames.map((file) => path.resolve(file)),
        compilerOptions: rawCompilerOptions(options, outDir),
      }),
    );
    const result = spawnSync(process.execPath, [tsc, "--project", configFile], {
      cwd: options.pathsBasePath ?? process.cwd(),
      encoding: "utf8",
    });
    const outputs = outputFiles(outDir).map((file) => ({
      fileName: path.relative(outDir, file).split(path.sep).join("/"),
      text: fs.readFileSync(file, "utf8"),
    }));
    return {
      emitSkipped: outputs.length === 0,
      exitStatus: result.status,
      diagnosticsText: `${result.stdout ?? ""}${result.stderr ?? ""}`,
      outputs,
    };
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
};

const formatDiagnosticsWithColorAndContext = (diagnostics, host) =>
  diagnostics
    .map((diagnostic) => {
      const message = flattenDiagnosticMessageText(diagnostic.messageText, host.getNewLine());
      const code = diagnostic.code === undefined ? "" : `TS${diagnostic.code}: `;
      return `${code}${message}`;
    })
    .join(host.getNewLine());

const createProgram = (input) => {
  const rootNames = Array.isArray(input) ? input : input.rootNames;
  const options = Array.isArray(input) ? {} : (input.options ?? {});
  const absoluteRoots = rootNames.map((file) => path.resolve(file));
  const configFile = path.join(
    path.dirname(absoluteRoots[0]),
    `.agentos-native-program-${operationSequence++}.json`,
  );
  overlay.set(
    configFile,
    JSON.stringify({ files: absoluteRoots, compilerOptions: compilerOptionsForJson(options) }),
  );
  const snapshot = native.updateSnapshot({ openProjects: [configFile] });
  const project = snapshot.getProject(configFile);
  if (project === undefined)
    throw new Error(`TypeScript 7 native project missing ${absoluteRoots[0]}`);
  const sourceFiles = new Map();
  const wrapSourceFile = (sourceFile) => {
    if (sourceFile === undefined) return undefined;
    const cached = sourceFiles.get(sourceFile.fileName);
    if (cached !== undefined) return cached;
    const wrapped = sourceFileProxy(sourceFile, sourceFile.fileName, [
      ...project.program.getSyntacticDiagnostics(sourceFile.fileName),
    ]);
    sourceFiles.set(sourceFile.fileName, wrapped);
    return wrapped;
  };
  return {
    getSourceFile: (file) => wrapSourceFile(project.program.getSourceFile(path.resolve(file))),
    getSourceFiles: () =>
      project.program
        .getSourceFileNames()
        .map((file) => wrapSourceFile(project.program.getSourceFile(file))),
    getSyntacticDiagnostics: (file) => project.program.getSyntacticDiagnostics(file?.fileName),
    getSemanticDiagnostics: (file) => project.program.getSemanticDiagnostics(file?.fileName),
    getTypeChecker: () => checkerFacade(project.checker, project),
    dispose: () => {
      closeSnapshotProject(snapshot, configFile);
    },
  };
};

const ts = {
  ...ast,
  ModuleKind,
  ModuleResolutionKind: { Bundler: 100 },
  SymbolFlags,
  createSourceFile,
  forEachChild,
  isStringLiteralLike,
  isPropertySignature,
  isParameter,
  canHaveModifiers,
  getModifiers,
  flattenDiagnosticMessageText,
  sys,
  readConfigFile,
  parseJsonConfigFileContent,
  getParsedCommandLineOfConfigFile,
  convertCompilerOptionsFromJson,
  findConfigFile,
  preProcessFile: sourceReferences,
  resolveModuleName,
  beginModuleResolutionSession,
  createProgram,
  emitRaw,
  formatDiagnosticsWithColorAndContext,
};

export default ts;
