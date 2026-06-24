export const packageExportSubpaths = (packageJson) => {
  const exported = packageJson.exports;
  if (typeof exported === "string") return ["."];
  if (exported === null || typeof exported !== "object" || Array.isArray(exported)) return ["."];
  return Object.keys(exported)
    .filter((key) => key === "." || key.startsWith("./"))
    .sort((left, right) => left.localeCompare(right));
};

export const createPackageBoundaryChecks = ({
  fs,
  path,
  execFileSync,
  repoRoot,
  read,
  readJson,
  walk,
  compare,
  isRecord,
  failIfAny,
  ruleConstraints,
  graphWorkspacePackageRecords,
  graphPackageSourceImportEdges,
  graphPackageImportCycles,
  sourceModuleGraph,
  moduleGraphOracleFailures,
  importSpecifierRecords,
  distributionExportEntries,
  distributionClosureForRoots,
  distributionUnitFinding,
  packageUnitOptionalPeerEntries,
  formatDistributionFinding,
  checkModuleBuckets,
  moduleAmbientForPath,
  allowedAmbientImports,
  packageUnitsRegistryPath,
  distributionRootsRegistryPath,
}) => {
  const packagePathMatches = (packagePath, prefix) =>
    packagePath === prefix || packagePath.startsWith(`${prefix}/`);

  const packageMatchesConstraint = (record, names = [], pathPrefixes = []) =>
    names.includes(record.name) ||
    pathPrefixes.some((prefix) => packagePathMatches(record.path, prefix));

  const packageConstraintNameFailures = ({ ruleId, constraints, records }) => {
    const liveNames = new Set(records.map((record) => record.name));
    const failures = [];
    for (const [index, constraint] of (constraints.forbiddenEdges ?? []).entries()) {
      if (!isRecord(constraint)) continue;
      for (const key of [
        "fromPackageNames",
        "allowedTargetPackageNames",
        "forbiddenTargetPackageNames",
      ]) {
        const names = constraint[key];
        if (!Array.isArray(names)) continue;
        for (const name of names) {
          if (typeof name !== "string" || liveNames.has(name)) continue;
          failures.push(
            `${ruleId}: constraints.forbiddenEdges[${index}].${key} references non-workspace package ${name}`,
          );
        }
      }
    }
    return failures;
  };

  const sourceFileMatchesPublicSubpath = (packagePath, subpath, sourceFile) => {
    if (typeof packagePath !== "string" || typeof subpath !== "string") return false;
    if (subpath === "." || !subpath.startsWith("./")) return false;
    const sourceBase = `${packagePath}/src/${subpath.slice(2)}`;
    return (
      sourceFile === `${sourceBase}.ts` ||
      sourceFile === `${sourceBase}.tsx` ||
      sourceFile === `${sourceBase}/index.ts` ||
      sourceFile === `${sourceBase}/index.tsx` ||
      sourceFile.startsWith(`${sourceBase}/`)
    );
  };

  const packageUnitOptionalPeerAllowsEdge = ({ registry, edge }) => {
    if (!isRecord(registry) || !Array.isArray(registry.packageUnits)) return false;
    const fromName = edge.from?.name;
    const fromPath = edge.from?.path;
    const toName = edge.to?.name;
    const sourceFile = edge.file ?? edge.fromFile;
    if (
      typeof fromName !== "string" ||
      typeof fromPath !== "string" ||
      typeof toName !== "string" ||
      typeof sourceFile !== "string"
    ) {
      return false;
    }

    return registry.packageUnits.filter(isRecord).some((unit) => {
      if (unit.targetSourcePackageName !== fromName) return false;
      if (!Array.isArray(unit.publicSubpaths)) return false;
      return unit.publicSubpaths.filter(isRecord).some((subpath) => {
        const optionalPeers = Array.isArray(subpath.optionalPeers) ? subpath.optionalPeers : [];
        return (
          optionalPeers.includes(toName) &&
          sourceFileMatchesPublicSubpath(fromPath, subpath.subpath, sourceFile)
        );
      });
    });
  };

  const checkForbiddenPackageEdges = ({ ruleId, constraints, edges, failures }) => {
    const packageUnits = packageUnitsRegistry();
    for (const edge of edges) {
      for (const constraint of constraints.forbiddenEdges ?? []) {
        if (
          !packageMatchesConstraint(
            edge.from,
            constraint.fromPackageNames ?? [],
            constraint.fromPackagePathPrefixes ?? [],
          )
        ) {
          continue;
        }
        if (
          packageMatchesConstraint(
            edge.to,
            constraint.allowedTargetPackageNames ?? [],
            constraint.allowedTargetPackagePathPrefixes ?? [],
          )
        ) {
          continue;
        }
        if (
          packageMatchesConstraint(
            edge.to,
            constraint.forbiddenTargetPackageNames ?? [],
            constraint.forbiddenTargetPackagePathPrefixes ?? [],
          )
        ) {
          if (packageUnitOptionalPeerAllowsEdge({ registry: packageUnits, edge })) continue;
          failures.push(
            `${edge.file}: ${ruleId}: ${edge.from.name} must not import downstream package ${edge.specifier} (${edge.to.path})`,
          );
        }
      }
    }
  };

  const checkPackageImportDag = ({ ruleId, label }) => {
    const constraints = ruleConstraints(ruleId);
    const records = graphWorkspacePackageRecords(repoRoot).filter(
      (record) => typeof record.name === "string" && record.name.startsWith("@agent-os/"),
    );
    const edges = graphPackageSourceImportEdges(repoRoot, records);
    const failures = [];

    failures.push(...packageConstraintNameFailures({ ruleId, constraints, records }));

    for (const cycle of graphPackageImportCycles(records, edges)) {
      failures.push(`${ruleId}: package cycle ${cycle.join(" -> ")}`);
    }

    checkForbiddenPackageEdges({ ruleId, constraints, edges, failures });

    failIfAny(label, failures);
  };

  const checkSubstrateImportDag = () =>
    checkPackageImportDag({ ruleId: "substrate-import-dag", label: "substrate import DAG" });

  const checkConvergenceImportDag = () => {
    checkPackageImportDag({
      ruleId: "convergence-import-dag",
      label: "convergence import DAG",
    });
    checkModuleBuckets();
  };

  const checkModuleGraphOracle = () => {
    const records = graphWorkspacePackageRecords(repoRoot).filter(
      (record) => typeof record.name === "string" && record.name.startsWith("@agent-os/"),
    );
    const graph = sourceModuleGraph(repoRoot, records);
    const failures = moduleGraphOracleFailures(repoRoot, records);
    failIfAny("module graph oracle", failures);
    console.log(
      `module graph oracle covered ${graph.files.length} source files and ${graph.edges.length} internal module edges`,
    );
  };

  const packageUnitsRegistry = () => readJson(packageUnitsRegistryPath);
  const distributionRootsRegistry = () => readJson(distributionRootsRegistryPath);

  const packageUnitRecords = () =>
    (packageUnitsRegistry().packageUnits ?? []).filter(
      (unit) =>
        isRecord(unit) &&
        typeof unit.id === "string" &&
        typeof unit.targetSourcePackageName === "string" &&
        typeof unit.publicPackageName === "string",
    );

  const packageUnitSourceNames = () =>
    new Set(packageUnitRecords().map((unit) => unit.targetSourcePackageName));

  const packageUnitPublicNames = () =>
    new Set(packageUnitRecords().map((unit) => unit.publicPackageName));

  const packageUnitSourcePathByName = () => {
    const unitNames = packageUnitSourceNames();
    return new Map(
      graphWorkspacePackageRecords(repoRoot)
        .filter((record) => unitNames.has(record.name))
        .map((record) => [record.name, record.path]),
    );
  };

  const allowedToolingSurface = (pkg) =>
    isRecord(pkg) &&
    typeof pkg.path === "string" &&
    pkg.path.startsWith("tooling/") &&
    pkg.published === false;

  const packageUnitExportSpecifiers = () => {
    const sourceSpecifiers = new Set();
    const publicSpecifiers = new Set();
    for (const unit of packageUnitRecords()) {
      const unitPath = packageUnitSourcePathByName().get(unit.targetSourcePackageName);
      if (typeof unitPath !== "string") continue;
      const manifest = readJson(`${unitPath}/package.json`);
      for (const exportSubpath of packageExportSubpaths(manifest)) {
        const suffix = exportSubpath === "." ? "" : `/${exportSubpath.slice(2)}`;
        sourceSpecifiers.add(`${unit.targetSourcePackageName}${suffix}`);
        publicSpecifiers.add(`${unit.publicPackageName}${suffix}`);
      }
    }
    return { sourceSpecifiers, publicSpecifiers };
  };

  const consumerFacingSpecifierFiles = () => [
    "README.md",
    "docs/usage-surfaces.md",
    "docs/runtime-packages.md",
    ...walk("docs/tutorials").filter((file) => file.endsWith(".md")),
    ...walk("docs/guides").filter((file) => file.endsWith(".md")),
    ...walk("docs/concepts").filter((file) => file.endsWith(".md")),
    "skills/agentos/SKILL.md",
    "skills/agentos-release/SKILL.md",
    "skills/agentos/references/package-map.md",
  ];

  const packageSpecifierPattern =
    /@(?:agent-os|yansirplus)\/(?:\*|[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*(?:\/[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)*)/gu;

  const textPosition = (content, index) => {
    const prefix = content.slice(0, index);
    const lines = prefix.split("\n");
    return { line: lines.length, column: lines.at(-1).length + 1 };
  };

  const consumerFacingSpecifierFailuresForContent = ({
    file,
    content,
    sourceSpecifiers,
    publicSpecifiers,
    toolingSourceSpecifiers,
  }) => {
    const failures = [];
    for (const match of content.matchAll(packageSpecifierPattern)) {
      const specifier = match[0];
      const allowed = specifier.startsWith("@yansirplus/")
        ? publicSpecifiers.has(specifier)
        : sourceSpecifiers.has(specifier) || toolingSourceSpecifiers.has(specifier);
      if (allowed) continue;
      const position = textPosition(content, match.index ?? 0);
      failures.push(
        `${file}:${position.line}:${position.column}: obsolete consumer-facing package specifier ${specifier}`,
      );
    }
    return failures;
  };

  const consumerFacingSpecifierFailures = () => {
    const { sourceSpecifiers, publicSpecifiers } = packageUnitExportSpecifiers();
    const toolingSourceSpecifiers = new Set(
      (readJson("docs/surface.json").packages ?? [])
        .filter((pkg) => allowedToolingSurface(pkg) && typeof pkg.name === "string")
        .map((pkg) => pkg.name),
    );
    const failures = [];
    for (const file of consumerFacingSpecifierFiles()) {
      if (!fs.existsSync(path.join(repoRoot, file))) continue;
      const content = read(file);
      failures.push(
        ...consumerFacingSpecifierFailuresForContent({
          file,
          content,
          sourceSpecifiers,
          publicSpecifiers,
          toolingSourceSpecifiers,
        }),
      );
    }
    return failures.sort(compare);
  };

  const markdownLinkPattern = /!?\[[^\]\n]*\]\(([^)\n]+)\)/gu;
  const externalMarkdownTargetPattern = /^(?:[a-z][a-z0-9+.-]*:|#|\/)/iu;

  const normalizeMarkdownTarget = (rawTarget) => {
    const target = rawTarget.trim().split(/\s+/u)[0]?.replace(/^<|>$/gu, "") ?? "";
    if (target.length === 0 || externalMarkdownTargetPattern.test(target)) return undefined;
    return target.split("#")[0];
  };

  const markdownTargetCandidates = (file, target) => {
    const decoded = decodeURI(target);
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(file), decoded));
    if (base.endsWith("/")) return [`${base}index.md`];
    if (path.posix.extname(base).length > 0) return [base];
    return [base, `${base}.md`, `${base}/index.md`];
  };

  const markdownLinkFailuresForContent = ({ file, content }) => {
    const failures = [];
    for (const match of content.matchAll(markdownLinkPattern)) {
      const target = normalizeMarkdownTarget(match[1]);
      if (target === undefined) continue;
      let candidates;
      try {
        candidates = markdownTargetCandidates(file, target);
      } catch {
        const position = textPosition(content, match.index ?? 0);
        failures.push(
          `${file}:${position.line}:${position.column}: markdown link target ${target} is not a valid URI path`,
        );
        continue;
      }
      const targetExtension = path.posix.extname(candidates[0] ?? "");
      if (targetExtension.length > 0 && targetExtension !== ".md") continue;
      if (candidates.some((candidate) => fs.existsSync(path.join(repoRoot, candidate)))) continue;
      const position = textPosition(content, match.index ?? 0);
      failures.push(
        `${file}:${position.line}:${position.column}: markdown link target ${target} does not resolve to ${candidates.join(" or ")}`,
      );
    }
    return failures;
  };

  const docsLinkIntegrityFailures = () =>
    [
      ...walk("docs").filter((file) => file.endsWith(".md")),
      ...walk("tooling/docs-site/src/content/docs").filter((file) => file.endsWith(".md")),
    ]
      .flatMap((file) => markdownLinkFailuresForContent({ file, content: read(file) }))
      .sort(compare);

  const checkDocsLinkIntegrity = () => {
    failIfAny("docs link integrity", docsLinkIntegrityFailures());
  };

  const specifierAllowedByPackageUnits = (specifier, unitNames = packageUnitSourceNames()) =>
    [...unitNames].some((name) => specifierMatchesPackage(specifier, name));

  const packageUnitDocSources = () => {
    const unitNames = packageUnitSourceNames();
    const allowedApiSources = new Set();
    const allowedPackageDocs = new Set();
    for (const pkg of readJson("docs/surface.json").packages ?? []) {
      if (!isRecord(pkg)) continue;
      if (!unitNames.has(pkg.name) && !allowedToolingSurface(pkg)) continue;
      if (typeof pkg.apiSource === "string") allowedApiSources.add(pkg.apiSource);
      if (typeof pkg.slug === "string") allowedPackageDocs.add(`docs/packages/${pkg.slug}.md`);
    }
    return { allowedApiSources, allowedPackageDocs };
  };

  const packageUnitOptionalPeerFindings = () => {
    const findings = [];
    for (const unit of packageUnitRecords()) {
      for (const { peer, subpath } of packageUnitOptionalPeerEntries(unit)) {
        if (!peer.startsWith("@agent-os/")) continue;
        findings.push(
          formatDistributionFinding(
            distributionUnitFinding({
              kind: "package-unit-internal-optional-peer",
              unit,
              message:
                "internal @agent-os modules must be package-local subpaths, not package-unit optional peers",
              specifier: peer,
              target: subpath,
            }),
          ),
        );
      }
    }
    return findings;
  };

  const obsoletePublicPackageFailures = () => {
    const failures = [];
    const unitNames = packageUnitSourceNames();
    const unitPaths = new Set(
      [...packageUnitSourcePathByName().values()].filter(
        (unitPath) => typeof unitPath === "string",
      ),
    );
    const unitPublicNames = packageUnitPublicNames();
    const surfacePackages = readJson("docs/surface.json").packages ?? [];
    const surfaceByPath = new Map(
      surfacePackages
        .filter((pkg) => isRecord(pkg) && typeof pkg.path === "string")
        .map((pkg) => [pkg.path, pkg]),
    );

    for (const packageJson of walk("packages").filter((file) => file.endsWith("/package.json"))) {
      const packagePath = packageJson.slice(0, -"/package.json".length);
      const manifest = readJson(packageJson);
      if (!manifest.name?.startsWith("@agent-os/")) continue;
      if (!unitNames.has(manifest.name)) {
        failures.push(
          `${packageJson}: obsolete source package ${manifest.name} is not declared by architecture/package-units.json`,
        );
      }
      if (!unitPaths.has(packagePath)) {
        failures.push(`${packageJson}: package path is outside final package-unit roots`);
      }
    }

    for (const packageJson of walk("tooling").filter((file) => file.endsWith("/package.json"))) {
      const packagePath = packageJson.slice(0, -"/package.json".length);
      const manifest = readJson(packageJson);
      if (!manifest.name?.startsWith("@agent-os/")) continue;
      const surface = surfaceByPath.get(packagePath);
      if (!allowedToolingSurface(surface)) {
        failures.push(`${packageJson}: tooling package must be private docs/tooling surface only`);
      }
    }

    for (const pkg of surfacePackages) {
      if (!isRecord(pkg)) {
        failures.push("docs/surface.json: package entries must be objects");
        continue;
      }
      const label = `docs/surface.json:${pkg.name ?? pkg.path ?? "package"}`;
      if (allowedToolingSurface(pkg)) continue;
      if (!unitNames.has(pkg.name)) {
        failures.push(`${label}: obsolete package remains in docs/surface.json`);
      }
      if (pkg.published === true && !unitNames.has(pkg.name)) {
        failures.push(`${label}: obsolete published package remains public`);
      }
      if (
        typeof pkg.path === "string" &&
        pkg.path.startsWith("packages/") &&
        !unitPaths.has(pkg.path)
      ) {
        failures.push(`${label}: package path is outside final package-unit roots`);
      }
    }

    const { allowedApiSources, allowedPackageDocs } = packageUnitDocSources();
    for (const file of walk("docs/api").filter((entry) => entry.endsWith(".md"))) {
      if (!allowedApiSources.has(file)) failures.push(`${file}: obsolete API intent page remains`);
    }
    for (const file of walk("docs/packages").filter((entry) => entry.endsWith(".md"))) {
      if (!allowedPackageDocs.has(file)) failures.push(`${file}: obsolete package doc remains`);
    }
    for (const file of walk("tooling/docs-site/src/content/docs/api").filter((entry) =>
      entry.endsWith(".md"),
    )) {
      const source = `docs/api/${path.basename(file)}`;
      if (!allowedApiSources.has(source)) {
        failures.push(`${file}: obsolete docs-site API projection remains`);
      }
    }
    for (const file of walk("tooling/docs-site/src/content/docs/packages").filter((entry) =>
      entry.endsWith(".md"),
    )) {
      const source = `docs/packages/${path.basename(file)}`;
      if (!allowedPackageDocs.has(source)) {
        failures.push(`${file}: obsolete docs-site package projection remains`);
      }
    }

    for (const file of walk("packages").filter((entry) =>
      /\/(?:README|PUBLIC_API)\.md$/u.test(entry),
    )) {
      if (![...unitPaths].some((unitPath) => file.startsWith(`${unitPath}/`))) {
        failures.push(`${file}: obsolete generated package doc remains`);
      }
    }

    const sourceAliases = readJson("tsconfig.source-paths.json").compilerOptions?.paths ?? {};
    for (const specifier of Object.keys(sourceAliases)) {
      if (!specifier.startsWith("@agent-os/")) continue;
      if (!specifierAllowedByPackageUnits(specifier, unitNames)) {
        failures.push(`${specifier}: obsolete source alias remains`);
      }
    }

    for (const unitName of unitNames) {
      const unitPath = packageUnitSourcePathByName().get(unitName);
      if (typeof unitPath !== "string") {
        failures.push(`${String(unitName)}: package unit source package is missing from workspace`);
        continue;
      }
      const manifest = readJson(`${unitPath}/package.json`);
      for (const section of ["dependencies", "devDependencies", "peerDependencies"]) {
        for (const dependencyName of Object.keys(manifest[section] ?? {})) {
          if (!dependencyName.startsWith("@agent-os/")) continue;
          if (!unitNames.has(dependencyName)) {
            failures.push(
              `${unitPath}/package.json:${section}: obsolete internal dependency ${dependencyName}`,
            );
          }
        }
      }
    }

    for (const [unitName, unitPath] of packageUnitSourcePathByName()) {
      if (typeof unitName !== "string") continue;
      if (typeof unitPath !== "string") continue;
      for (const file of walk(unitPath).filter((entry) =>
        /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/u.test(entry),
      )) {
        const source = read(file);
        for (const importRecord of importSpecifierRecords(source, file)) {
          if (!importRecord.specifier.startsWith("@agent-os/")) continue;
          if (specifierAllowedByPackageUnits(importRecord.specifier, unitNames)) continue;
          failures.push(
            `${file}:${importRecord.line}:${importRecord.column}: obsolete import specifier ${importRecord.specifier} in final package ${unitName}`,
          );
        }
      }
    }

    const ownerRegistry = ownerIdRegistry();
    for (const [index, owner] of (ownerRegistry.owners ?? []).entries()) {
      if (!isRecord(owner) || !Array.isArray(owner.sourcePackageNames)) continue;
      for (const sourcePackageName of owner.sourcePackageNames) {
        if (typeof sourcePackageName !== "string" || !sourcePackageName.startsWith("@agent-os/")) {
          continue;
        }
        if (!unitNames.has(sourcePackageName)) {
          failures.push(
            `architecture/owner-ids.json:owners[${index}]: obsolete sourcePackageName ${sourcePackageName}`,
          );
        }
      }
    }

    for (const unit of packageUnitRecords()) {
      for (const publicName of [unit.publicPackageName]) {
        if (!unitPublicNames.has(publicName)) {
          failures.push(
            `${unit.id}: public package ${publicName} is not a package-unit public name`,
          );
        }
      }
    }

    failures.push(...consumerFacingSpecifierFailures());

    return failures.sort(compare);
  };

  const distributionMinimalityFailures = () => [
    ...packageUnitOptionalPeerFindings(),
    ...obsoletePublicPackageFailures(),
  ];

  const checkNoObsoletePublicPackages = () => {
    failIfAny("no obsolete public packages", obsoletePublicPackageFailures());
  };

  const sourceSpecifierForPublicSubpath = (unit, publicSpecifier) => {
    if (
      typeof publicSpecifier !== "string" ||
      typeof unit.publicPackageName !== "string" ||
      typeof unit.targetSourcePackageName !== "string" ||
      (publicSpecifier !== unit.publicPackageName &&
        !publicSpecifier.startsWith(`${unit.publicPackageName}/`))
    ) {
      return undefined;
    }
    return `${unit.targetSourcePackageName}${publicSpecifier.slice(unit.publicPackageName.length)}`;
  };

  const subpathForSourceSpecifier = (unit, sourceSpecifier) => {
    if (
      typeof sourceSpecifier !== "string" ||
      typeof unit.targetSourcePackageName !== "string" ||
      (sourceSpecifier !== unit.targetSourcePackageName &&
        !sourceSpecifier.startsWith(`${unit.targetSourcePackageName}/`))
    ) {
      return undefined;
    }
    const suffix = sourceSpecifier.slice(unit.targetSourcePackageName.length);
    return suffix.length === 0 ? "." : `.${suffix}`;
  };

  const publicSpecifierForSourceSpecifier = (unit, sourceSpecifier) => {
    const subpath = subpathForSourceSpecifier(unit, sourceSpecifier);
    if (subpath === undefined) return undefined;
    if (subpath === ".") return unit.publicPackageName;
    if (!subpath.startsWith("./")) return undefined;
    return `${unit.publicPackageName}/${subpath.slice(2)}`;
  };

  const packageUnitPublicSpecifiers = () => {
    const specifiers = new Set();
    for (const unit of packageUnitRecords()) {
      for (const entry of unit.publicSubpaths ?? []) {
        if (!isRecord(entry) || typeof entry.subpath !== "string") continue;
        if (entry.subpath === ".") {
          specifiers.add(unit.publicPackageName);
        } else if (entry.subpath.startsWith("./")) {
          specifiers.add(`${unit.publicPackageName}/${entry.subpath.slice(2)}`);
        }
      }
    }
    return specifiers;
  };

  const packageUnitPublicSpecifierForSource = (sourceSpecifier) => {
    for (const unit of packageUnitRecords()) {
      const publicSpecifier = publicSpecifierForSourceSpecifier(unit, sourceSpecifier);
      if (publicSpecifier !== undefined) return publicSpecifier;
    }
    return undefined;
  };

  const specifierMatchesPackage = (specifier, packageName) =>
    specifier === packageName || specifier.startsWith(`${packageName}/`);

  const specifierMatchesForbidden = (specifier, forbidden) =>
    forbidden.endsWith(":")
      ? specifier.startsWith(forbidden)
      : specifier === forbidden || specifier.startsWith(`${forbidden}/`);

  const graphSourceByFile = (graph) =>
    new Map(
      graph.files.map((entry) => [
        entry.file,
        fs.readFileSync(path.join(repoRoot, entry.file), "utf8"),
      ]),
    );

  const exportEntriesBySubpath = (record) => {
    const manifest = readJson(`${record.path}/package.json`);
    return new Map(
      distributionExportEntries(record, manifest).map((entry) => [entry.subpath, entry]),
    );
  };

  const packageUnitRecordsBySourceName = (records) =>
    new Map(records.map((record) => [record.name, record]));

  const subpathNoLeakPackageFilter = (args) => {
    if (args.length === 0) return undefined;
    if (args.length === 2 && args[0] === "--package" && typeof args[1] === "string") return args[1];
    throw new Error("subpath-no-leak: expected optional --package <source-package-name>");
  };

  const checkSubpathNoLeak = (args = []) => {
    const packageFilter = subpathNoLeakPackageFilter(args);
    const records = graphWorkspacePackageRecords(repoRoot).filter(
      (record) => typeof record.name === "string" && record.name.startsWith("@agent-os/"),
    );
    const recordsByName = packageUnitRecordsBySourceName(records);
    const graph = sourceModuleGraph(repoRoot, records);
    const sourceByFile = graphSourceByFile(graph);
    const failures = [];
    for (const unit of packageUnitsRegistry().packageUnits ?? []) {
      if (!isRecord(unit) || typeof unit.targetSourcePackageName !== "string") continue;
      if (packageFilter !== undefined && unit.targetSourcePackageName !== packageFilter) continue;
      const record = recordsByName.get(unit.targetSourcePackageName);
      if (record === undefined) continue;
      const entriesBySubpath = exportEntriesBySubpath(record);
      const rootEntry = entriesBySubpath.get(".");
      if (rootEntry === undefined) {
        failures.push(`${unit.id}: package root export is missing`);
        continue;
      }
      const samePackageEdges = graph.edges.filter(
        (edge) => edge.from.name === record.name && edge.to.name === record.name,
      );
      const rootClosure = distributionClosureForRoots(rootEntry.targets, samePackageEdges);
      const subpathOnlyPeers = new Set(
        (unit.publicSubpaths ?? [])
          .filter((subpath) => isRecord(subpath) && subpath.subpath !== ".")
          .flatMap((subpath) =>
            Array.isArray(subpath.optionalPeers)
              ? subpath.optionalPeers.filter((peer) => typeof peer === "string")
              : [],
          ),
      );
      for (const file of [...rootClosure].sort(compare)) {
        const source = sourceByFile.get(file);
        if (source === undefined) continue;
        for (const importRecord of importSpecifierRecords(source, file)) {
          for (const peer of subpathOnlyPeers) {
            if (specifierMatchesPackage(importRecord.specifier, peer)) {
              failures.push(
                `${String(file)}:${importRecord.line}:${importRecord.column}: subpath-no-leak: root closure imports subpath-only peer ${String(peer)} via ${importRecord.specifier}`,
              );
            }
          }
        }
      }
      for (const subpath of (unit.publicSubpaths ?? []).filter(
        (entry) => isRecord(entry) && entry.subpath !== ".",
      )) {
        const entry = entriesBySubpath.get(subpath.subpath);
        if (entry === undefined) {
          continue;
        }
        for (const target of entry.targets) {
          if (rootClosure.has(target)) {
            failures.push(
              `${target}: subpath-no-leak: package root closure reaches ${unit.id} ${subpath.subpath}`,
            );
          }
        }
      }
    }
    failIfAny("subpath no leak", failures);
  };

  const profileTypeNames = (ambient) => {
    if (ambient === "cloudflare-worker") return ["@cloudflare/workers-types"];
    if (ambient === "node") return ["node"];
    return [];
  };

  const profileCacheDir = (batch, profileId) =>
    path.join(repoRoot, ".cache", "profile-verification", batch, profileId);

  const profileEntrySource = (specifiers) =>
    specifiers
      .map((specifier, index) => [
        `import * as profile${index} from ${JSON.stringify(specifier)};`,
        `void profile${index};`,
      ])
      .flat()
      .join("\n") + "\n";

  const runProfileTypecheck = ({ batch, profile, sourceSpecifiers }) => {
    const dir = profileCacheDir(batch, profile.id);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const entryPath = path.join(dir, "entry.ts");
    const configPath = path.join(dir, "tsconfig.json");
    fs.writeFileSync(entryPath, profileEntrySource(sourceSpecifiers));
    const sourcePathConfig = readJson("tsconfig.source-paths.json").compilerOptions ?? {};
    const baseUrl = path.relative(dir, repoRoot).split(path.sep).join("/") || ".";
    fs.writeFileSync(
      configPath,
      `${JSON.stringify(
        {
          compilerOptions: {
            ...sourcePathConfig,
            baseUrl,
            target: "ES2022",
            module: "ESNext",
            moduleResolution: "Bundler",
            strict: true,
            skipLibCheck: true,
            noEmit: true,
            types: profileTypeNames(profile.ambient),
          },
          include: ["entry.ts"],
        },
        null,
        2,
      )}\n`,
    );
    try {
      execFileSync(path.join(repoRoot, "node_modules", ".bin", "tsc"), ["-p", configPath], {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return [];
    } catch (error) {
      return [
        `${profile.id}: profile-verification typecheck failed\n${error.stdout ?? ""}${error.stderr ?? ""}`,
      ];
    }
  };

  const absoluteFiles = (dir) => {
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
    return files.sort(compare);
  };

  const relativeImportFrom = (fromDir, targetFile) => {
    const relative = path
      .relative(fromDir, path.join(repoRoot, targetFile))
      .split(path.sep)
      .join("/");
    return relative.startsWith(".") ? relative : `./${relative}`;
  };

  const runProfileBundle = ({ batch, profile, bundleFiles, forbiddenSpecifiers }) => {
    const dir = profileCacheDir(batch, profile.id);
    fs.mkdirSync(dir, { recursive: true });
    const entryPath = path.join(dir, "entry.ts");
    const outDir = path.join(dir, "bundle");
    fs.writeFileSync(
      entryPath,
      profileEntrySource(bundleFiles.map((file) => relativeImportFrom(dir, file))),
    );
    fs.rmSync(outDir, { recursive: true, force: true });
    const args = [
      "exec",
      "esbuild",
      entryPath,
      "--outdir",
      outDir,
      "--target",
      profile.ambient === "node" ? "node" : "browser",
    ];
    if (profile.ambient === "cloudflare-worker") args.push("--external", "cloudflare:*");
    if (profile.ambient !== "node") args.push("--external", "node:*");
    try {
      execFileSync("pnpm", args, {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      return [
        `${profile.id}: profile-verification bundle failed\n${error.stdout ?? ""}${error.stderr ?? ""}`,
      ];
    }
    const failures = [];
    for (const file of absoluteFiles(outDir).filter((entry) => entry.endsWith(".js"))) {
      const text = fs.readFileSync(file, "utf8");
      for (const forbidden of forbiddenSpecifiers) {
        if (text.includes(forbidden)) {
          failures.push(
            `${toRepoPath(file)}: profile-verification bundle contains forbidden specifier ${forbidden}`,
          );
        }
      }
    }
    return failures;
  };

  const selectedSourceSpecifiersForProfileUnit = ({ profile, unit }) =>
    (profile.selectedSubpaths ?? [])
      .map((specifier) => sourceSpecifierForPublicSubpath(unit, specifier))
      .filter((specifier) => typeof specifier === "string");

  const profileVerificationFindings = ({ batch }) => {
    const packageUnits = packageUnitsRegistry().packageUnits ?? [];
    const roots = distributionRootsRegistry();
    const unitIds =
      batch === "runtime"
        ? new Set(["runtime"])
        : batch === "client"
          ? new Set(["client"])
          : new Set(packageUnits.filter(isRecord).map((unit) => unit.id));
    const units = packageUnits.filter((unit) => isRecord(unit) && unitIds.has(unit.id));
    const records = graphWorkspacePackageRecords(repoRoot).filter(
      (record) => typeof record.name === "string" && record.name.startsWith("@agent-os/"),
    );
    const recordsByName = packageUnitRecordsBySourceName(records);
    const graph = sourceModuleGraph(repoRoot, records);
    const sourceByFile = graphSourceByFile(graph);
    const failures = [];
    for (const unit of units) {
      const record = recordsByName.get(unit.targetSourcePackageName);
      if (record === undefined) {
        failures.push(`${unit.id}: source package ${unit.targetSourcePackageName} is missing`);
        continue;
      }
      const entriesBySubpath = exportEntriesBySubpath(record);
      for (const profile of roots.targetProfiles ?? []) {
        if (!isRecord(profile) || !(profile.packageUnits ?? []).includes(unit.id)) continue;
        const sourceSpecifiers = selectedSourceSpecifiersForProfileUnit({ profile, unit });
        if (sourceSpecifiers.length === 0) {
          failures.push(`${profile.id}:${unit.id}: profile selects no subpath for package unit`);
          continue;
        }
        const rootFiles = [];
        for (const specifier of sourceSpecifiers) {
          const subpath = subpathForSourceSpecifier(unit, specifier);
          const entry = subpath === undefined ? undefined : entriesBySubpath.get(subpath);
          if (entry === undefined) {
            failures.push(`${profile.id}:${specifier}: selected subpath is not exported`);
            continue;
          }
          rootFiles.push(...entry.targets);
        }
        const closure = distributionClosureForRoots(rootFiles, graph.edges);
        const allowedAmbients = allowedAmbientImports().get(profile.ambient) ?? new Set();
        for (const file of [...closure].sort(compare)) {
          const ambient = moduleAmbientForPath(file);
          if (!allowedAmbients.has(ambient)) {
            failures.push(
              `${String(file)}: profile-verification:${profile.id}: ${profile.ambient} profile links ${ambient} module`,
            );
          }
          const source = sourceByFile.get(file);
          if (source === undefined) continue;
          for (const importRecord of importSpecifierRecords(source, file)) {
            for (const forbidden of profile.forbiddenSpecifiers ?? []) {
              if (specifierMatchesForbidden(importRecord.specifier, forbidden)) {
                failures.push(
                  `${String(file)}:${importRecord.line}:${importRecord.column}: profile-verification:${profile.id}: forbidden specifier ${importRecord.specifier}`,
                );
              }
            }
          }
        }
        failures.push(
          ...runProfileTypecheck({ batch, profile, sourceSpecifiers }),
          ...runProfileBundle({
            batch,
            profile,
            bundleFiles: rootFiles,
            forbiddenSpecifiers: profile.forbiddenSpecifiers ?? [],
          }),
        );
      }
    }
    return failures;
  };

  const checkProfileVerification = (args = []) => {
    if (args.length !== 2 || args[0] !== "--batch") {
      throw new Error("profile-verification: expected --batch <batch>");
    }
    const batch = args[1];
    if (batch !== "runtime" && batch !== "client") {
      throw new Error(`profile-verification: unsupported batch ${batch}`);
    }
    failIfAny("profile verification", profileVerificationFindings({ batch }));
  };

  return {
    packageConstraintNameFailures,
    packageUnitOptionalPeerAllowsEdge,
    consumerFacingSpecifierFailuresForContent,
    markdownLinkFailuresForContent,
    obsoletePublicPackageFailures,
    distributionMinimalityFailures,
    consumerFacingSpecifierFailures,
    checkDocsLinkIntegrity,
    packageUnitOptionalPeerFindings,
    checkNoObsoletePublicPackages,
    packageUnitsRegistry,
    distributionRootsRegistry,
    packageUnitRecords,
    packageUnitSourceNames,
    packageUnitPublicNames,
    packageUnitSourcePathByName,
    packageUnitPublicSpecifiers,
    packageUnitPublicSpecifierForSource,
    sourceSpecifierForPublicSubpath,
    subpathForSourceSpecifier,
    selectedSourceSpecifiersForProfileUnit,
    runProfileTypecheck,
    specifierAllowedByPackageUnits,
    specifierMatchesPackage,
    checkSubstrateImportDag,
    checkConvergenceImportDag,
    checkModuleGraphOracle,
    checkSubpathNoLeak,
    checkProfileVerification,
  };
};
