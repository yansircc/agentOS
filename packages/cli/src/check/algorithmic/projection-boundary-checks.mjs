export const createProjectionBoundaryChecks = ({
  fs,
  path,
  ts,
  repoRoot,
  read,
  readJson,
  walk,
  isRecord,
  failIfAny,
  graphWorkspacePackageRecords,
  sourceModuleGraph,
  workspacePackageRecords,
}) => {
  const projectionFoldBoundaryPath = "architecture/projection-fold-boundary.json";

  const hasExportModifier = (node) =>
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);

  const addBindingNames = (name, names) => {
    if (ts.isIdentifier(name)) {
      names.add(name.text);
      return;
    }
    if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
      for (const element of name.elements) {
        if (ts.isBindingElement(element)) addBindingNames(element.name, names);
      }
    }
  };

  const exportedSymbolNamesForFile = (file) => {
    const names = new Set();
    const sourceFile = ts.createSourceFile(
      file,
      read(file),
      ts.ScriptTarget.Latest,
      true,
      file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const visit = (node) => {
      if (hasExportModifier(node)) {
        if (
          (ts.isFunctionDeclaration(node) ||
            ts.isClassDeclaration(node) ||
            ts.isInterfaceDeclaration(node) ||
            ts.isTypeAliasDeclaration(node) ||
            ts.isEnumDeclaration(node)) &&
          node.name !== undefined
        ) {
          names.add(node.name.text);
        }
        if (ts.isVariableStatement(node)) {
          for (const declaration of node.declarationList.declarations) {
            addBindingNames(declaration.name, names);
          }
        }
      }
      if (
        ts.isExportDeclaration(node) &&
        node.exportClause !== undefined &&
        ts.isNamedExports(node.exportClause)
      ) {
        for (const element of node.exportClause.elements) names.add(element.name.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return names;
  };

  const exportedSymbolNamesUnder = (relativePath) => {
    const names = new Set();
    for (const file of walk(relativePath).filter((entry) => /\.(?:ts|tsx|mts|cts)$/u.test(entry))) {
      for (const name of exportedSymbolNamesForFile(file)) names.add(name);
    }
    return names;
  };

  const projectionFoldBoundaryFailures = () => {
    const failures = [];
    if (!fs.existsSync(path.join(repoRoot, projectionFoldBoundaryPath))) {
      failures.push(`${projectionFoldBoundaryPath}: missing projection fold audit decision`);
      return failures;
    }

    const registry = readJson(projectionFoldBoundaryPath);
    if (registry.schemaVersion !== 1) {
      failures.push(`${projectionFoldBoundaryPath}: schemaVersion must be 1`);
    }
    if (registry.decision !== "keep-consumer-boundary") {
      failures.push(
        `${projectionFoldBoundaryPath}: decision must stay keep-consumer-boundary until a shared core fold source exists`,
      );
    }
    if (registry.sharedFold !== false) {
      failures.push(`${projectionFoldBoundaryPath}: sharedFold must be false for this decision`);
    }
    for (const key of ["blockingContractReason", "corePromotionCondition"]) {
      if (typeof registry[key] !== "string" || registry[key].trim().length === 0) {
        failures.push(`${projectionFoldBoundaryPath}: ${key} must record the audit contract`);
      }
    }

    const packagePathByName = new Map(
      workspacePackageRecords().map((record) => [record.name, record.path]),
    );
    const records = graphWorkspacePackageRecords(repoRoot).filter(
      (record) => typeof record.name === "string" && record.name.startsWith("@agent-os/"),
    );
    const graph = sourceModuleGraph(repoRoot, records);
    const ownedFolds = Array.isArray(registry.ownedFolds) ? registry.ownedFolds : [];
    if (ownedFolds.length === 0) {
      failures.push(`${projectionFoldBoundaryPath}: ownedFolds must be non-empty`);
    }
    for (const [index, fold] of ownedFolds.entries()) {
      const label =
        isRecord(fold) && typeof fold.id === "string" ? fold.id : `ownedFolds[${index}]`;
      if (!isRecord(fold)) {
        failures.push(`${projectionFoldBoundaryPath}:${label}: fold entry must be an object`);
        continue;
      }
      const packageName = fold.packageName;
      const file = fold.file;
      const exports = Array.isArray(fold.exports) ? fold.exports : [];
      if (typeof packageName !== "string" || !packageName.startsWith("@agent-os/")) {
        failures.push(`${projectionFoldBoundaryPath}:${label}: packageName must be @agent-os/*`);
        continue;
      }
      const packagePath = packagePathByName.get(packageName);
      if (typeof packagePath !== "string") {
        failures.push(`${projectionFoldBoundaryPath}:${label}: package ${packageName} is missing`);
        continue;
      }
      if (typeof file !== "string" || !file.startsWith(`${packagePath}/`)) {
        failures.push(
          `${projectionFoldBoundaryPath}:${label}: file must live under package ${packageName}`,
        );
        continue;
      }
      if (!fs.existsSync(path.join(repoRoot, file))) {
        failures.push(`${projectionFoldBoundaryPath}:${label}: file is missing: ${file}`);
        continue;
      }
      if (exports.length === 0 || exports.some((name) => typeof name !== "string")) {
        failures.push(`${projectionFoldBoundaryPath}:${label}: exports must be non-empty strings`);
        continue;
      }
      const actualExports = exportedSymbolNamesForFile(file);
      for (const name of exports) {
        if (!actualExports.has(name)) {
          failures.push(`${file}: projection-fold-boundary:${label}: missing export ${name}`);
        }
      }
      if (
        !Array.isArray(fold.consumerRoots) ||
        fold.consumerRoots.length === 0 ||
        fold.consumerRoots.some((root) => typeof root !== "string")
      ) {
        failures.push(
          `${projectionFoldBoundaryPath}:${label}: consumerRoots must name the true consumer set`,
        );
      }
      if (
        !Array.isArray(fold.allowedConsumers) ||
        fold.allowedConsumers.some((consumer) => typeof consumer !== "string")
      ) {
        failures.push(`${projectionFoldBoundaryPath}:${label}: allowedConsumers must be strings`);
        continue;
      }
      const allowedConsumers = new Set(fold.allowedConsumers);
      for (const consumer of allowedConsumers) {
        if (!fs.existsSync(path.join(repoRoot, consumer))) {
          failures.push(
            `${projectionFoldBoundaryPath}:${label}: consumer file is missing ${String(consumer)}`,
          );
        }
      }
      const incoming = graph.edges.filter((edge) => edge.toFile === file && edge.fromFile !== file);
      const actualConsumers = new Set(incoming.map((edge) => edge.fromFile));
      for (const edge of incoming) {
        if (!allowedConsumers.has(edge.fromFile)) {
          failures.push(
            `${edge.fromFile}:${edge.line}:${edge.column}: projection-fold-boundary:${label}: unexpected consumer of ${file} via ${edge.specifier}`,
          );
        }
      }
      for (const consumer of allowedConsumers) {
        if (!actualConsumers.has(consumer)) {
          failures.push(
            `${projectionFoldBoundaryPath}:${label}: declared consumer ${String(consumer)} does not import ${file}`,
          );
        }
      }
    }

    const forbiddenCoreExports = Array.isArray(registry.coreForbiddenExports)
      ? registry.coreForbiddenExports
      : [];
    if (
      forbiddenCoreExports.length === 0 ||
      forbiddenCoreExports.some((name) => typeof name !== "string")
    ) {
      failures.push(
        `${projectionFoldBoundaryPath}: coreForbiddenExports must be non-empty strings`,
      );
    } else {
      const coreExports = exportedSymbolNamesUnder("packages/core/src");
      for (const name of forbiddenCoreExports) {
        if (coreExports.has(name)) {
          failures.push(
            `packages/core/src: projection-fold-boundary: core must not export disputed event fold symbol ${name}`,
          );
        }
      }
    }

    return failures;
  };

  const checkProjectionFoldBoundary = () => {
    const failures = projectionFoldBoundaryFailures();
    failIfAny("projection fold boundary", failures);
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
        failures.push(
          `${label}.overrideSurface: policy limits require an ordinary override surface`,
        );
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

  return {
    projectionFoldBoundaryFailures,
    checkProjectionFoldBoundary,
    checkLimitRegistry,
  };
};
