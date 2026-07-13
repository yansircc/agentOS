import os from "node:os";

const runtimePackageName = "@agent-os/runtime";
const runtimeRootFile = "packages/runtime/src/index.ts";
const nodeRuntimeRoot = "packages/runtime/src/node";

const runtimeModuleGraph = (ts, file, source) => {
  const failures = [];
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const visit = (node) => {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      if (node.arguments.length !== 1 || !ts.isStringLiteralLike(node.arguments[0])) {
        failures.push(`${file}: runtime dynamic import specifier must be a string literal`);
      }
    }
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "require"
    ) {
      failures.push(`${file}: runtime module graph forbids CommonJS require`);
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  const preprocessed = ts.preProcessFile(source, true, true);
  for (const [references, kind] of [
    [preprocessed.referencedFiles, "path"],
    [preprocessed.typeReferenceDirectives, "types"],
    [preprocessed.libReferenceDirectives, "lib"],
  ]) {
    if (references.length > 0) {
      failures.push(`${file}: runtime module graph forbids triple-slash ${kind} references`);
    }
  }
  return {
    failures,
    specifiers: preprocessed.importedFiles.map((reference) => reference.fileName),
  };
};

const runtimeCompilerOptionsByRoot = new Map();
const runtimeCompilerOptions = ({ fs, path, ts, repoRoot }) => {
  const cached = runtimeCompilerOptionsByRoot.get(repoRoot);
  if (cached !== undefined) return cached;
  const configPath = path.join(repoRoot, "packages/runtime/tsconfig.json");
  const config = ts.readConfigFile(configPath, (file) => fs.readFileSync(file, "utf8"));
  if (config.error !== undefined) throw new Error("runtime tsconfig is unreadable");
  const host = {
    ...ts.sys,
    fileExists: (file) => fs.existsSync(file) && fs.statSync(file).isFile(),
    readFile: (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : undefined),
  };
  const parsed = ts.parseJsonConfigFileContent(
    config.config,
    host,
    path.dirname(configPath),
    undefined,
    configPath,
  );
  if (parsed.errors.length > 0) throw new Error("runtime tsconfig cannot be resolved");
  runtimeCompilerOptionsByRoot.set(repoRoot, parsed.options);
  return parsed.options;
};

const resolveRuntimeModule = ({ fs, path, ts, repoRoot, fromFile, specifier }) => {
  const host = {
    ...ts.sys,
    fileExists: (file) => fs.existsSync(file) && fs.statSync(file).isFile(),
    readFile: (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : undefined),
    realpath: (file) => fs.realpathSync(file),
    getCurrentDirectory: () => repoRoot,
  };
  const resolved = ts.resolveModuleName(
    specifier,
    path.resolve(repoRoot, fromFile),
    runtimeCompilerOptions({ fs, path, ts, repoRoot }),
    host,
  ).resolvedModule?.resolvedFileName;
  if (resolved === undefined || !fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    return undefined;
  }
  const physicalRoot = fs.realpathSync(repoRoot);
  const physicalFile = fs.realpathSync(resolved);
  if (!pathIsInside(path, physicalRoot, physicalFile)) return undefined;
  return path.relative(physicalRoot, physicalFile).split(path.sep).join("/");
};

const productionProfiles = (rootPackage) =>
  Array.isArray(rootPackage.agentos?.backendNeutrality?.productionRuntimeProfiles)
    ? rootPackage.agentos.backendNeutrality.productionRuntimeProfiles
    : [];

const productionProfileIdentityFailures = (profiles) => {
  const failures = [];
  const ids = new Set();
  for (const [index, profile] of profiles.entries()) {
    if (typeof profile?.id !== "string" || profile.id.length === 0) continue;
    if (ids.has(profile.id)) {
      failures.push(
        `productionRuntimeProfiles[${index}]: duplicate production profile id ${profile.id}`,
      );
    }
    ids.add(profile.id);
  }
  return failures;
};

const profilePathSegment = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u;
const suiteLabelPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const lawIdPattern = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u;
const productionProfileSuffix = (profile) => {
  if (
    profile?.sourcePackageName !== runtimePackageName ||
    typeof profile?.subpath !== "string" ||
    !profile.subpath.startsWith(`${runtimePackageName}/`)
  ) {
    return undefined;
  }
  const suffix = profile.subpath.slice(runtimePackageName.length + 1);
  const segments = suffix.split("/");
  return segments.length > 0 && segments.every((segment) => profilePathSegment.test(segment))
    ? suffix
    : undefined;
};

const productionContractTestPath = (profile) => {
  const suffix = productionProfileSuffix(profile);
  if (suffix === undefined) return undefined;
  const expected = `packages/runtime/test/${suffix}/backend-protocol-contract.runtime.test.ts`;
  return profile?.contractTest === expected ? expected : undefined;
};

const profileFamilyContains = (specifier, subpath) =>
  typeof subpath === "string" && (specifier === subpath || specifier.startsWith(`${subpath}/`));

const isImplementationTypeScriptFile = (file) => file.endsWith(".ts") && !file.endsWith(".d.ts");

const pathIsInside = (path, parent, candidate) => {
  const relative = path.relative(parent, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
};

const canonicalProfileEntrypoint = ({ fs, path, runtimePackageRoot, suffix }) => {
  const candidates = [`./src/${suffix}.ts`, `./src/${suffix}/index.ts`];
  const existing = candidates.filter((candidate) => {
    const absolute = path.resolve(runtimePackageRoot, candidate);
    return fs.existsSync(absolute) && fs.statSync(absolute).isFile();
  });
  return existing.length === 1 ? existing[0] : undefined;
};

export const backendProviderAxisFailures = ({ fs, path, ts, repoRoot, read, readJson, walk }) => {
  const failures = [];
  const rootPackage = readJson("package.json");
  const runtimePackage = readJson("packages/runtime/package.json");
  const runtimePackageRoot = path.resolve(repoRoot, "packages/runtime");
  const runtimePackageRealpath = fs.realpathSync(runtimePackageRoot);
  const profiles = productionProfiles(rootPackage);
  const profileRoots = [];
  const profileRecords = [];

  failures.push(...productionProfileIdentityFailures(profiles));
  for (const file of walk("packages/runtime/src")) {
    if (!isImplementationTypeScriptFile(file)) {
      failures.push(`${file}: runtime source graph must contain only implementation .ts files`);
    }
  }

  if (profiles.length === 0) {
    failures.push("package.json must declare at least one production runtime profile");
  }

  for (const [index, profile] of profiles.entries()) {
    const label = typeof profile?.id === "string" ? profile.id : `profile[${index}]`;
    const suffix = productionProfileSuffix(profile);
    if (suffix === undefined) {
      failures.push(
        `${label}: production profile must name a safe explicit ${runtimePackageName} subpath`,
      );
      continue;
    }
    const exportKey = `./${suffix}`;
    const exportEntry = runtimePackage.exports?.[exportKey];
    const expectedEntrypoint = canonicalProfileEntrypoint({
      fs,
      path,
      runtimePackageRoot,
      suffix,
    });
    if (expectedEntrypoint === undefined) {
      failures.push(
        `${label}: production profile ${exportKey} must own exactly one canonical source entrypoint`,
      );
    }
    if (exportEntry === null || typeof exportEntry !== "object" || Array.isArray(exportEntry)) {
      failures.push(
        `${label}: production profile export ${exportKey} must declare types and default`,
      );
    } else {
      const conditions = Object.keys(exportEntry).sort();
      if (conditions.length !== 2 || conditions[0] !== "default" || conditions[1] !== "types") {
        failures.push(
          `${label}: production profile export ${exportKey} must contain exactly types and default`,
        );
      }
      for (const condition of ["types", "default"]) {
        const exportedPath = exportEntry[condition];
        if (expectedEntrypoint === undefined || exportedPath !== expectedEntrypoint) {
          failures.push(
            `${label}: production profile export ${exportKey} ${condition} must stay under ./src/${suffix} at expected entrypoint ${expectedEntrypoint ?? "<ambiguous>"}`,
          );
        }
        if (typeof exportedPath !== "string") continue;
        const absolute = path.resolve(runtimePackageRoot, exportedPath);
        if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
          failures.push(
            `${label}: production profile export ${exportKey} ${condition} target is missing: ${exportedPath}`,
          );
          continue;
        }
        const resolved = fs.realpathSync(absolute);
        if (!pathIsInside(path, runtimePackageRealpath, resolved)) {
          failures.push(
            `${label}: production profile export ${exportKey} ${condition} escapes packages/runtime`,
          );
        }
        const expectedPhysical =
          expectedEntrypoint === undefined
            ? undefined
            : path.resolve(runtimePackageRealpath, expectedEntrypoint);
        if (expectedPhysical !== undefined && resolved !== expectedPhysical) {
          failures.push(
            `${label}: production profile export ${exportKey} ${condition} must resolve to its declared source axis`,
          );
        }
      }
    }
    if (expectedEntrypoint !== undefined) {
      const entrypoint = `packages/runtime/${expectedEntrypoint.slice(2)}`;
      const root =
        expectedEntrypoint === `./src/${suffix}.ts` ? entrypoint : `packages/runtime/src/${suffix}`;
      profileRoots.push(root);
      profileRecords.push({ label, subpath: profile.subpath, root, entrypoint });
    }
  }

  if (new Set(profileRoots).size !== profileRoots.length) {
    failures.push("production profiles must own distinct runtime source axes");
  }
  for (const [index, left] of profileRecords.entries()) {
    for (const right of profileRecords.slice(index + 1)) {
      if (left.root.startsWith(`${right.root}/`) || right.root.startsWith(`${left.root}/`)) {
        failures.push(
          `${left.label} and ${right.label}: production runtime source axes must not overlap`,
        );
      }
    }
  }

  const visited = new Set();
  const visit = (file) => {
    if (visited.has(file)) return;
    visited.add(file);
    const graph = runtimeModuleGraph(ts, file, read(file));
    failures.push(...graph.failures);
    for (const specifier of graph.specifiers) {
      if (profileRecords.some((profile) => profileFamilyContains(specifier, profile.subpath))) {
        failures.push(
          `${file}: neutral runtime root graph imports production profile ${specifier}`,
        );
        continue;
      }
      const resolved = resolveRuntimeModule({ fs, path, ts, repoRoot, fromFile: file, specifier });
      if (resolved === undefined) continue;
      if (!isImplementationTypeScriptFile(resolved)) {
        failures.push(
          `${file}: compiler-resolved repo-local dependency ${resolved} must be an implementation .ts file`,
        );
        continue;
      }
      const profileRoot = profileRoots.find(
        (root) => resolved === root || resolved.startsWith(`${root}/`),
      );
      if (profileRoot !== undefined) {
        failures.push(`${file}: neutral runtime root graph reaches production profile ${resolved}`);
        continue;
      }
      visit(resolved);
    }
  };
  visit(runtimeRootFile);

  for (const origin of profileRecords) {
    const profileVisited = new Set();
    const visitProfile = (file) => {
      if (profileVisited.has(file)) return;
      profileVisited.add(file);
      const graph = runtimeModuleGraph(ts, file, read(file));
      failures.push(...graph.failures);
      for (const specifier of graph.specifiers) {
        const importedProfile = profileRecords.find(
          (candidate) =>
            candidate !== origin && profileFamilyContains(specifier, candidate.subpath),
        );
        if (importedProfile !== undefined) {
          failures.push(
            `${file}: production profile ${origin.label} imports ${importedProfile.label} through ${specifier}`,
          );
          continue;
        }
        const resolved = resolveRuntimeModule({
          fs,
          path,
          ts,
          repoRoot,
          fromFile: file,
          specifier,
        });
        if (resolved === undefined) continue;
        if (!isImplementationTypeScriptFile(resolved)) {
          failures.push(
            `${file}: compiler-resolved repo-local dependency ${resolved} must be an implementation .ts file`,
          );
          continue;
        }
        const reachedProfile = profileRecords.find(
          (candidate) =>
            candidate !== origin &&
            (resolved === candidate.root || resolved.startsWith(`${candidate.root}/`)),
        );
        if (reachedProfile !== undefined) {
          failures.push(
            `${file}: production profile ${origin.label} reaches ${reachedProfile.label} source axis at ${resolved}`,
          );
          continue;
        }
        visitProfile(resolved);
      }
    };
    visitProfile(origin.entrypoint);
  }
  return failures;
};

const namedImportBindings = (ts, ast) => {
  const bindings = new Map();
  for (const statement of ast.statements) {
    const namedBindings = ts.isImportDeclaration(statement)
      ? statement.importClause?.namedBindings
      : undefined;
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteralLike(statement.moduleSpecifier) ||
      namedBindings === undefined ||
      !ts.isNamedImports(namedBindings)
    ) {
      continue;
    }
    for (const element of namedBindings.elements) {
      bindings.set(element.name.text, {
        moduleSpecifier: statement.moduleSpecifier.text,
        importedName: (element.propertyName ?? element.name).text,
        typeOnly: statement.importClause?.isTypeOnly === true || element.isTypeOnly,
      });
    }
  }
  return bindings;
};

const topLevelFunctionBinding = (ts, ast, name) => {
  for (const statement of ast.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) return statement;
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name) &&
        declaration.name.text === name &&
        declaration.initializer !== undefined &&
        (ts.isArrowFunction(declaration.initializer) ||
          ts.isFunctionExpression(declaration.initializer))
      ) {
        return declaration.initializer;
      }
    }
  }
  return undefined;
};

const subtreeContainsIdentifier = (ts, root, names) => {
  let found = false;
  const visit = (node) => {
    if (ts.isIdentifier(node) && names.has(node.text)) found = true;
    if (!found) ts.forEachChild(node, visit);
  };
  if (root !== undefined) visit(root);
  return found;
};

const objectPropertyName = (ts, property) =>
  ts.isShorthandPropertyAssignment(property)
    ? property.name.text
    : ts.isPropertyAssignment(property) &&
        (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name))
      ? property.name.text
      : undefined;

const objectPropertyIdentifier = (ts, property) =>
  ts.isShorthandPropertyAssignment(property)
    ? property.name
    : ts.isPropertyAssignment(property) && ts.isIdentifier(property.initializer)
      ? property.initializer
      : undefined;

const backendConformanceSourceFile = "packages/core/src/backend-protocol/conformance.ts";

const expressionValue = (ts, node) => {
  let current = node;
  while (
    current !== undefined &&
    (ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isParenthesizedExpression(current))
  ) {
    current = current.expression;
  }
  return current;
};

const backendConformanceLawIds = ({ ts, read }) => {
  const source = read(backendConformanceSourceFile);
  const ast = ts.createSourceFile(
    backendConformanceSourceFile,
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const declarations = ast.statements
    .filter(ts.isVariableStatement)
    .flatMap((statement) => Array.from(statement.declarationList.declarations));
  const initializerFor = (name) =>
    expressionValue(
      ts,
      declarations.find(
        (candidate) => ts.isIdentifier(candidate.name) && candidate.name.text === name,
      )?.initializer,
    );
  const idInitializer = initializerFor("BACKEND_CONFORMANCE_LAW_ID");
  if (idInitializer === undefined || !ts.isObjectLiteralExpression(idInitializer)) {
    throw new Error("backend conformance law-id catalog must be an object literal");
  }
  const idsByName = new Map();
  for (const property of idInitializer.properties) {
    const name =
      ts.isPropertyAssignment(property) && ts.isIdentifier(property.name)
        ? property.name.text
        : undefined;
    const value =
      ts.isPropertyAssignment(property) && ts.isStringLiteralLike(property.initializer)
        ? property.initializer.text
        : undefined;
    if (name === undefined || value === undefined || !lawIdPattern.test(value)) {
      throw new Error("backend conformance law-id catalog must contain only closed string ids");
    }
    idsByName.set(name, value);
  }
  if (idsByName.size === 0 || new Set(idsByName.values()).size !== idsByName.size) {
    throw new Error("backend conformance law-id catalog must contain unique ids");
  }
  const manifestInitializer = initializerFor("BACKEND_CONFORMANCE_LAWS");
  if (manifestInitializer === undefined || !ts.isArrayLiteralExpression(manifestInitializer)) {
    throw new Error("backend conformance law manifest must be an array literal");
  }
  const manifestIds = manifestInitializer.elements.map((element) => {
    const idExpression =
      ts.isCallExpression(element) &&
      ts.isIdentifier(element.expression) &&
      element.expression.text === "law"
        ? element.arguments[0]
        : undefined;
    const idName =
      idExpression !== undefined &&
      ts.isPropertyAccessExpression(idExpression) &&
      ts.isIdentifier(idExpression.expression) &&
      idExpression.expression.text === "BACKEND_CONFORMANCE_LAW_ID"
        ? idExpression.name.text
        : undefined;
    const id = idName === undefined ? undefined : idsByName.get(idName);
    if (id === undefined) {
      throw new Error("backend conformance law manifest must reference catalog law ids");
    }
    return id;
  });
  if (manifestIds.length === 0 || new Set(manifestIds).size !== manifestIds.length) {
    throw new Error("backend conformance law manifest must contain unique ids");
  }
  return manifestIds;
};

const productionSuiteResultFailures = ({ output, suiteName, expectedLawIds }) => {
  let report;
  try {
    report = JSON.parse(output);
  } catch {
    return ["Vitest JSON reporter did not produce valid JSON"];
  }
  const testResults = Array.isArray(report?.testResults) ? report.testResults : [];
  const assertions = testResults.flatMap((result) =>
    Array.isArray(result?.assertionResults) ? result.assertionResults : [],
  );
  const suiteAssertions = assertions.filter(
    (assertion) =>
      Array.isArray(assertion?.ancestorTitles) &&
      assertion.ancestorTitles.length === 1 &&
      assertion.ancestorTitles[0] === suiteName,
  );
  const failures = [];
  const actualLawIds = [];
  for (const assertion of suiteAssertions) {
    if (assertion?.status !== "passed") {
      failures.push(`${suiteName}: conformance assertion did not pass`);
      continue;
    }
    const separator = typeof assertion.title === "string" ? assertion.title.indexOf(": ") : -1;
    const lawId = separator > 0 ? assertion.title.slice(0, separator) : undefined;
    if (lawId === undefined || !lawIdPattern.test(lawId)) {
      failures.push(`${suiteName}: conformance assertion has no canonical law id`);
      continue;
    }
    actualLawIds.push(lawId);
  }
  const expected = [...expectedLawIds];
  const actual = [...actualLawIds];
  if (
    actual.length !== expected.length ||
    actual.some((lawId, index) => lawId !== expected[index])
  ) {
    failures.push(
      `${suiteName}: passed law ids do not exactly cover the backend conformance catalog`,
    );
  }
  if (report?.success !== true) failures.push(`${suiteName}: Vitest report is not successful`);
  return failures;
};

export const backendNeutralProductionRuntimeProofFailures = ({
  fs,
  path,
  ts,
  repoRoot,
  read,
  readJson,
}) => {
  const failures = [];
  const profiles = productionProfiles(readJson("package.json"));
  const labels = new Set();
  failures.push(...productionProfileIdentityFailures(profiles));
  try {
    backendConformanceLawIds({ ts, read });
  } catch (error) {
    failures.push(
      `${backendConformanceSourceFile}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (profiles.length === 0) {
    failures.push("package.json must declare at least one production runtime profile");
  }

  for (const [index, profile] of profiles.entries()) {
    const label = typeof profile?.id === "string" ? profile.id : `profile[${index}]`;
    const suffix = productionProfileSuffix(profile);
    if (suffix === undefined) {
      failures.push(
        `${label}: production profile must name a safe explicit ${runtimePackageName} subpath`,
      );
      continue;
    }
    if (productionContractTestPath(profile) === undefined) {
      failures.push(
        `${label}: production profile contract test must be the canonical runtime test for ${suffix}`,
      );
      continue;
    }
    let source;
    try {
      source = read(profile.contractTest);
    } catch {
      failures.push(
        `${profile.contractTest}: production profile ${label} contract test is missing`,
      );
      continue;
    }
    const ast = ts.createSourceFile(profile.contractTest, source, ts.ScriptTarget.Latest, true);
    const imports = namedImportBindings(ts, ast);
    const registrarNames = new Set(
      Array.from(imports.entries())
        .filter(
          ([, origin]) =>
            origin.moduleSpecifier === "@agent-os/runtime/testing" &&
            origin.importedName === "registerBackendConformanceSuite" &&
            !origin.typeOnly,
        )
        .map(([name]) => name),
    );
    const calls = [];
    const visit = (node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        registrarNames.has(node.expression.text)
      ) {
        calls.push(node);
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
    const topLevelCalls = ast.statements.flatMap((statement) =>
      ts.isExpressionStatement(statement) &&
      ts.isCallExpression(statement.expression) &&
      ts.isIdentifier(statement.expression.expression) &&
      registrarNames.has(statement.expression.expression.text)
        ? [statement.expression]
        : [],
    );
    if (registrarNames.size !== 1 || calls.length !== 1 || topLevelCalls.length !== 1) {
      failures.push(
        `${profile.contractTest}: production profile ${label} must register the shared backend conformance suite exactly once as a top-level call`,
      );
      continue;
    }

    const call = topLevelCalls[0];
    const [registrar, suiteLabel, factory, options] = call.arguments;
    if (call.arguments.length !== 4) {
      failures.push(
        `${profile.contractTest}: shared backend conformance call requires four arguments`,
      );
      continue;
    }
    const registrarOrigin = ts.isIdentifier(registrar) ? imports.get(registrar.text) : undefined;
    const registrarModule =
      registrarOrigin === undefined
        ? undefined
        : resolveRuntimeModule({
            fs,
            path,
            ts,
            repoRoot,
            fromFile: profile.contractTest,
            specifier: registrarOrigin.moduleSpecifier,
          });
    if (
      registrarOrigin?.importedName !== "VITEST_BACKEND_CONFORMANCE_REGISTRAR" ||
      registrarOrigin.typeOnly ||
      registrarModule !== "packages/runtime/test/backend-conformance-registrar.ts"
    ) {
      failures.push(
        `${profile.contractTest}: shared backend conformance registrar must import VITEST_BACKEND_CONFORMANCE_REGISTRAR from the canonical test registrar`,
      );
    }
    if (!ts.isStringLiteralLike(suiteLabel) || !suiteLabelPattern.test(suiteLabel.text)) {
      failures.push(
        `${profile.contractTest}: shared backend conformance label must use the closed profile label grammar`,
      );
    } else if (labels.has(suiteLabel.text)) {
      failures.push(
        `${profile.contractTest}: duplicate backend conformance label ${suiteLabel.text}`,
      );
    } else {
      labels.add(suiteLabel.text);
    }
    const factoryBinding = ts.isIdentifier(factory)
      ? topLevelFunctionBinding(ts, ast, factory.text)
      : undefined;
    const driverTypeNames = new Set(
      Array.from(imports.entries())
        .filter(
          ([, origin]) =>
            origin.moduleSpecifier === "@agent-os/runtime/testing" &&
            origin.importedName === "RuntimeBackendContractDriver",
        )
        .map(([name]) => name),
    );
    if (
      factoryBinding === undefined ||
      factoryBinding.type === undefined ||
      !subtreeContainsIdentifier(ts, factoryBinding.type, driverTypeNames)
    ) {
      failures.push(
        `${profile.contractTest}: shared backend conformance factory must be a local function explicitly returning RuntimeBackendContractDriver`,
      );
    }
    const runtimeFactOwnerProperty = ts.isObjectLiteralExpression(options)
      ? options.properties.find(
          (property) => objectPropertyName(ts, property) === "runtimeFactOwner",
        )
      : undefined;
    const runtimeFactOwner =
      runtimeFactOwnerProperty === undefined
        ? undefined
        : objectPropertyIdentifier(ts, runtimeFactOwnerProperty);
    const ownerOrigin =
      runtimeFactOwner === undefined ? undefined : imports.get(runtimeFactOwner.text);
    if (
      ownerOrigin?.moduleSpecifier !== "@agent-os/core/runtime-protocol" ||
      ownerOrigin.importedName !== "RUNTIME_FACT_OWNER" ||
      ownerOrigin.typeOnly
    ) {
      failures.push(
        `${profile.contractTest}: shared backend conformance options must import RUNTIME_FACT_OWNER from @agent-os/core/runtime-protocol`,
      );
    }
  }
  return failures;
};

export const productionRuntimeProofCommandSpecs = ({ ts, read, readJson }) =>
  productionProfiles(readJson("package.json")).map((profile) => {
    const source = read(profile.contractTest);
    const ast = ts.createSourceFile(profile.contractTest, source, ts.ScriptTarget.Latest, true);
    const imports = namedImportBindings(ts, ast);
    const suiteNames = new Set(
      Array.from(imports.entries())
        .filter(
          ([, origin]) =>
            origin.moduleSpecifier === "@agent-os/runtime/testing" &&
            origin.importedName === "registerBackendConformanceSuite" &&
            !origin.typeOnly,
        )
        .map(([name]) => name),
    );
    const call = ast.statements.find(
      (statement) =>
        ts.isExpressionStatement(statement) &&
        ts.isCallExpression(statement.expression) &&
        ts.isIdentifier(statement.expression.expression) &&
        suiteNames.has(statement.expression.expression.text),
    )?.expression;
    const suiteLabel = call?.arguments[1];
    const suffix = productionProfileSuffix(profile);
    if (
      call === undefined ||
      !ts.isCallExpression(call) ||
      !ts.isStringLiteralLike(suiteLabel) ||
      !suiteLabelPattern.test(suiteLabel.text) ||
      suffix === undefined ||
      productionContractTestPath(profile) === undefined
    ) {
      throw new Error(`${profile.contractTest}: invalid production runtime proof registration`);
    }
    const argv = [
      "../../node_modules/.bin/vp",
      "test",
      "run",
      "--configLoader",
      "runner",
      "--config",
      `vitest.${suffix.replaceAll("/", "-")}.config.ts`,
      "--reporter=json",
    ];
    argv.push(
      profile.contractTest.slice("packages/runtime/".length),
      "-t",
      `^${suiteLabel.text} backend conformance(?: |$)`,
    );
    return {
      contractTest: profile.contractTest,
      suiteName: `${suiteLabel.text} backend conformance`,
      cwd: "packages/runtime",
      argv,
    };
  });

export const backendNeutralProductionRuntimeProof = ({
  fs,
  path,
  ts,
  repoRoot,
  read,
  readJson,
  execFileSync,
  failIfAny,
}) => {
  const failures = backendNeutralProductionRuntimeProofFailures({
    fs,
    path,
    ts,
    repoRoot,
    read,
    readJson,
  });
  if (failures.length > 0) {
    failIfAny("backend neutral production runtime proof", failures);
    return;
  }
  const expectedLawIds = backendConformanceLawIds({ ts, read });
  const reportDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "agentos-production-runtime-proof-"),
  );
  try {
    for (const [index, spec] of productionRuntimeProofCommandSpecs({
      ts,
      read,
      readJson,
    }).entries()) {
      const [executable, ...args] = spec.argv;
      const reportPath = path.join(reportDirectory, `${index}.json`);
      try {
        execFileSync(
          path.resolve(repoRoot, spec.cwd, executable),
          [...args, "--outputFile", reportPath],
          {
            cwd: path.resolve(repoRoot, spec.cwd),
            encoding: "utf8",
            env: {
              ...process.env,
              CI: "true",
              PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN: "false",
            },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        const resultFailures = productionSuiteResultFailures({
          output: fs.readFileSync(reportPath, "utf8"),
          suiteName: spec.suiteName,
          expectedLawIds,
        });
        if (resultFailures.length > 0) {
          throw new Error(resultFailures.join("; "));
        }
        console.log(
          `${spec.contractTest}: ${expectedLawIds.length}/${expectedLawIds.length} laws passed`,
        );
      } catch (error) {
        const detail = error instanceof Error ? `: ${error.message}` : "";
        throw new Error(
          `${spec.contractTest}: shared backend conformance execution failed${detail}`,
        );
      }
    }
  } finally {
    fs.rmSync(reportDirectory, { recursive: true, force: true });
  }
  console.log("backend neutral production runtime proof passed");
};

export const nodePostgresRuntimeImportBoundaryFailures = ({
  fs,
  path,
  ts,
  repoRoot,
  read,
  walk,
}) => {
  const failures = [];
  for (const file of walk("packages/runtime/src").filter(
    (entry) =>
      /\.(?:ts|tsx)$/u.test(entry) &&
      entry !== nodeRuntimeRoot &&
      !entry.startsWith(`${nodeRuntimeRoot}/`),
  )) {
    const graph = runtimeModuleGraph(ts, file, read(file));
    failures.push(...graph.failures);
    for (const specifier of graph.specifiers) {
      const selfImport = profileFamilyContains(specifier, `${runtimePackageName}/node`);
      const resolved = resolveRuntimeModule({ fs, path, ts, repoRoot, fromFile: file, specifier });
      if (
        selfImport ||
        resolved === nodeRuntimeRoot ||
        resolved?.startsWith(`${nodeRuntimeRoot}/`)
      ) {
        failures.push(`${file}: import ${specifier} crosses the node-postgres subpath boundary`);
      }
    }
  }
  return failures;
};

export const createRuntimeProofChecks = ({
  fs,
  path,
  ts,
  repoRoot,
  read,
  readJson,
  walk,
  execFileSync,
  failIfAny,
}) => ({
  checkBackendProviderAxisBoundary: () =>
    failIfAny(
      "backend provider axis boundary",
      backendProviderAxisFailures({ fs, path, ts, repoRoot, read, readJson, walk }),
    ),
  checkBackendNeutralProductionRuntimeProof: () =>
    backendNeutralProductionRuntimeProof({
      fs,
      path,
      ts,
      repoRoot,
      read,
      readJson,
      execFileSync,
      failIfAny,
    }),
  checkNodePostgresRuntimeImportBoundary: () =>
    failIfAny(
      "node-postgres runtime import boundary",
      nodePostgresRuntimeImportBoundaryFailures({ fs, path, ts, repoRoot, read, walk }),
    ),
});
