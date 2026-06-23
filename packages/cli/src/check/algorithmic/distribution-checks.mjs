export const createDistributionChecks = ({
  fs,
  path,
  ts,
  repoRoot,
  compare,
  isRecord,
  readJson,
  walk,
  failIfAny,
  importSpecifierRecords,
  graphWorkspacePackageRecords,
  sourceModuleGraph,
  moduleBucketRegistry,
  packageUnitsRegistryFindings,
  distributionRootsRegistryFindings,
  packageUnitsRegistryPath,
  distributionRootsRegistryPath,
  distributionMinimalityFailures,
}) => {
  const distributionInstallScriptNames = new Set([
    "install",
    "postinstall",
    "preinstall",
    "prepare",
  ]);
  const distributionPackageWideMetadataFields = ["engines", "os", "cpu", "libc"];
  const distributionNativeToolPattern =
    /\b(?:node-gyp|prebuild(?:ify|-install)?|cmake-js|node-pre-gyp)\b/u;
  const distributionNativeFilePattern = /(?:^|\/)(?:binding\.gyp|CMakeLists\.txt)$|\.node$/u;
  const distributionSourcePattern = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|d\.ts)$/u;

  const distributionFinding = ({
    kind,
    severity = "splitter",
    file,
    packageName,
    message,
    specifier,
    target,
    line,
    column,
  }) => ({
    kind,
    severity,
    file,
    packageName,
    message,
    specifier,
    target,
    line,
    column,
  });

  const manifestSectionEntries = (manifest, section) =>
    Object.entries(isRecord(manifest[section]) ? manifest[section] : {}).sort(([left], [right]) =>
      compare(left, right),
    );

  const isInternalPackageDependency = (name) => name.startsWith("@agent-os/");

  const optionalPeerNames = (manifest) =>
    new Set(
      manifestSectionEntries(manifest, "peerDependencies")
        .filter(([name]) => manifest.peerDependenciesMeta?.[name]?.optional === true)
        .map(([name]) => name),
    );

  const peerSpecifierMatches = (specifier, peerName) =>
    specifier === peerName || specifier.startsWith(`${peerName}/`);

  const distributionManifestFindings = (record, manifest, packageFiles = []) => {
    const findings = [];
    const packageJson = `${record.path}/package.json`;

    for (const [scriptName, scriptValue] of manifestSectionEntries(manifest, "scripts")) {
      if (!distributionInstallScriptNames.has(scriptName)) continue;
      findings.push(
        distributionFinding({
          kind: "package-install-script",
          file: packageJson,
          packageName: record.name,
          message: `package-wide ${scriptName} script executes during install lifecycle`,
          target: scriptValue,
        }),
      );
    }

    if (manifest.gypfile !== undefined) {
      findings.push(
        distributionFinding({
          kind: "native-marker",
          file: packageJson,
          packageName: record.name,
          message: "package manifest declares gypfile native build metadata",
          target: String(manifest.gypfile),
        }),
      );
    }
    for (const file of packageFiles.filter((entry) => distributionNativeFilePattern.test(entry))) {
      findings.push(
        distributionFinding({
          kind: "native-marker",
          file,
          packageName: record.name,
          message: "package contains native build or native artifact marker",
          target: path.basename(file),
        }),
      );
    }
    for (const section of ["dependencies", "optionalDependencies", "devDependencies"]) {
      for (const [name, version] of manifestSectionEntries(manifest, section)) {
        if (!distributionNativeToolPattern.test(`${name} ${String(version)}`)) continue;
        findings.push(
          distributionFinding({
            kind: "native-tool-dependency",
            severity: section === "devDependencies" ? "info" : "splitter",
            file: packageJson,
            packageName: record.name,
            message: `${section}.${name} carries native build tooling`,
            specifier: name,
            target: version,
          }),
        );
      }
    }

    for (const field of distributionPackageWideMetadataFields) {
      if (manifest[field] === undefined) continue;
      findings.push(
        distributionFinding({
          kind: "package-wide-metadata",
          file: packageJson,
          packageName: record.name,
          message: `${field} is a package-wide install constraint and cannot be subpath-localized`,
          target: JSON.stringify(manifest[field]),
        }),
      );
    }

    for (const section of ["dependencies", "optionalDependencies"]) {
      for (const [name, version] of manifestSectionEntries(manifest, section)) {
        if (isInternalPackageDependency(name)) continue;
        findings.push(
          distributionFinding({
            kind: "hard-dependency",
            file: packageJson,
            packageName: record.name,
            message: `${section}.${name} is installed for every consumer of the package`,
            specifier: name,
            target: version,
          }),
        );
      }
    }

    for (const [name, version] of manifestSectionEntries(manifest, "peerDependencies")) {
      const optional = manifest.peerDependenciesMeta?.[name]?.optional === true;
      findings.push(
        distributionFinding({
          kind: optional ? "optional-peer" : "required-peer",
          severity: optional ? "info" : "splitter",
          file: packageJson,
          packageName: record.name,
          message: optional
            ? `${name} is localizable when every import remains behind explicit subpath exports`
            : `${name} is a package-wide peer obligation`,
          specifier: name,
          target: version,
        }),
      );
    }

    return findings;
  };

  const distributionScriptKindForFile = (file) => {
    if (file.endsWith(".tsx")) return ts.ScriptKind.TSX;
    if (file.endsWith(".jsx")) return ts.ScriptKind.JSX;
    if (file.endsWith(".js") || file.endsWith(".mjs") || file.endsWith(".cjs")) {
      return ts.ScriptKind.JS;
    }
    return ts.ScriptKind.TS;
  };

  const distributionNodePosition = (sourceFile, node) => {
    const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    return { line: position.line + 1, column: position.character + 1 };
  };

  const distributionExpressionText = (sourceFile, node) =>
    node.getText(sourceFile).replace(/\s+/gu, " ").slice(0, 160);

  const distributionExpressionName = (expression) => {
    if (ts.isIdentifier(expression)) return expression.text;
    if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
    return undefined;
  };

  const distributionRootIdentifier = (node) => {
    let current = node;
    while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
      current = current.expression;
    }
    return ts.isIdentifier(current) ? current.text : undefined;
  };

  const distributionTouchesAmbientGlobal = (node) => {
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const root = distributionRootIdentifier(node);
      const text = node.getText();
      if (root === "globalThis" || root === "window" || root === "document") return true;
      if (root === "process" && text.startsWith("process.env")) return true;
    }
    let found = false;
    ts.forEachChild(node, (child) => {
      if (!found && distributionTouchesAmbientGlobal(child)) found = true;
    });
    return found;
  };

  const distributionContainsLoadSideEffect = (node) => {
    if (
      ts.isArrowFunction(node) ||
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isClassExpression(node)
    ) {
      return false;
    }
    if (ts.isBinaryExpression(node) && distributionTouchesAmbientGlobal(node.left)) return true;
    if (
      (ts.isPostfixUnaryExpression(node) || ts.isPrefixUnaryExpression(node)) &&
      distributionTouchesAmbientGlobal(node.operand)
    ) {
      return true;
    }
    if (
      ts.isCallExpression(node) &&
      [
        "exec",
        "execFile",
        "fork",
        "mkdirSync",
        "rmSync",
        "spawn",
        "spawnSync",
        "writeFileSync",
      ].includes(distributionExpressionName(node.expression) ?? "")
    ) {
      return true;
    }
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "Worker"
    ) {
      return true;
    }
    let found = false;
    ts.forEachChild(node, (child) => {
      if (!found && distributionContainsLoadSideEffect(child)) found = true;
    });
    return found;
  };

  const distributionSourceProbeFindingsForSource = (content, file, packageName) => {
    const sourceFile = ts.createSourceFile(
      file,
      content,
      ts.ScriptTarget.Latest,
      true,
      distributionScriptKindForFile(file),
    );
    const findings = [];
    const recordNode = (kind, node, message) => {
      const position = distributionNodePosition(sourceFile, node);
      findings.push(
        distributionFinding({
          kind,
          file,
          packageName,
          message,
          target: distributionExpressionText(sourceFile, node),
          line: position.line,
          column: position.column,
        }),
      );
    };
    const visitAugmentation = (node) => {
      if (ts.isModuleDeclaration(node)) {
        if (node.name.kind === ts.SyntaxKind.GlobalKeyword) {
          recordNode("global-type-augmentation", node, "source declares global type augmentation");
        } else if (ts.isStringLiteralLike(node.name)) {
          recordNode("module-type-augmentation", node, "source declares module type augmentation");
        } else if (ts.isIdentifier(node.name) && node.name.text === "NodeJS") {
          recordNode("global-type-augmentation", node, "source augments NodeJS namespace types");
        }
      }
      if (
        ts.isInterfaceDeclaration(node) &&
        ["Document", "ImportMeta", "ProcessEnv", "Window"].includes(node.name.text)
      ) {
        recordNode("global-type-augmentation", node, `source declares ambient ${node.name.text}`);
      }
      ts.forEachChild(node, visitAugmentation);
    };
    visitAugmentation(sourceFile);

    for (const statement of sourceFile.statements) {
      if (
        (ts.isExpressionStatement(statement) &&
          distributionContainsLoadSideEffect(statement.expression)) ||
        (ts.isVariableStatement(statement) && distributionContainsLoadSideEffect(statement))
      ) {
        recordNode(
          "package-load-side-effect",
          statement,
          "top-level source touches ambient process/global state or host execution",
        );
      }
    }
    return findings;
  };

  const distributionExportTargets = (target) => {
    if (typeof target === "string") return [target];
    if (!isRecord(target)) return [];
    return Object.values(target).flatMap((value) => distributionExportTargets(value));
  };

  const distributionExportEntries = (record, manifest) => {
    const exportsValue = manifest.exports;
    if (exportsValue === undefined) {
      return fs.existsSync(path.join(repoRoot, record.path, "src/index.ts"))
        ? [{ subpath: ".", targets: [`${record.path}/src/index.ts`] }]
        : [];
    }
    const entries = isRecord(exportsValue) ? Object.entries(exportsValue) : [[".", exportsValue]];
    return entries
      .map(([subpath, target]) => ({
        subpath,
        targets: distributionExportTargets(target)
          .filter((entry) => entry.startsWith("./"))
          .map((entry) => path.join(record.path, entry).split(path.sep).join("/"))
          .filter((entry) => distributionSourcePattern.test(entry)),
      }))
      .filter((entry) => entry.targets.length > 0)
      .sort((left, right) => compare(left.subpath, right.subpath));
  };

  const distributionClosureForRoots = (roots, edges) => {
    const byFrom = new Map();
    for (const edge of edges) {
      byFrom.set(edge.fromFile, [...(byFrom.get(edge.fromFile) ?? []), edge.toFile]);
    }
    const visited = new Set();
    const pending = [...roots].sort(compare);
    while (pending.length > 0) {
      const file = pending.shift();
      if (file === undefined || visited.has(file)) continue;
      visited.add(file);
      for (const target of byFrom.get(file) ?? []) {
        if (!visited.has(target)) pending.push(target);
      }
      pending.sort(compare);
    }
    return visited;
  };

  const distributionPeerImportsInFiles = (sourceByFile, files, peerNames) => {
    const imports = [];
    for (const file of [...files].sort(compare)) {
      const source = sourceByFile.get(file);
      if (source === undefined) continue;
      for (const importRecord of importSpecifierRecords(source, file)) {
        for (const peerName of peerNames) {
          if (!peerSpecifierMatches(importRecord.specifier, peerName)) continue;
          imports.push({ file, peerName, ...importRecord });
        }
      }
    }
    return imports;
  };

  const distributionSubpathFindings = ({ record, manifest, sourceByFile, edges }) => {
    const optionalPeers = optionalPeerNames(manifest);
    if (optionalPeers.size === 0) return [];
    const exportEntries = distributionExportEntries(record, manifest);
    const samePackageEdges = edges.filter(
      (edge) => edge.from.name === record.name && edge.to.name === record.name,
    );
    const findings = [];
    const rootEntry = exportEntries.find((entry) => entry.subpath === ".");
    const rootClosure =
      rootEntry === undefined
        ? new Set()
        : distributionClosureForRoots(rootEntry.targets, samePackageEdges);
    for (const importRecord of distributionPeerImportsInFiles(
      sourceByFile,
      rootClosure,
      optionalPeers,
    )) {
      const typeOnly =
        importRecord.importKind === "type" ||
        importRecord.syntaxKind === "import-type" ||
        importRecord.syntaxKind === "export";
      findings.push(
        distributionFinding({
          kind: typeOnly ? "root-dts-peer-type-leak" : "root-subpath-peer-leak",
          file: importRecord.file,
          packageName: record.name,
          message: `package root closure reaches optional peer ${importRecord.peerName}; move it behind an explicit subpath`,
          specifier: importRecord.specifier,
          target: rootEntry?.subpath ?? ".",
          line: importRecord.line,
          column: importRecord.column,
        }),
      );
    }

    for (const peerName of [...optionalPeers].sort(compare)) {
      const subpaths = [];
      for (const entry of exportEntries.filter((candidate) => candidate.subpath !== ".")) {
        const closure = distributionClosureForRoots(entry.targets, samePackageEdges);
        const imports = distributionPeerImportsInFiles(sourceByFile, closure, new Set([peerName]));
        if (imports.length > 0) subpaths.push(entry.subpath);
      }
      if (subpaths.length === 0) continue;
      findings.push(
        distributionFinding({
          kind: "optional-peer-locality",
          severity: "info",
          file: `${record.path}/package.json`,
          packageName: record.name,
          message: `${peerName} is only needed by explicit subpath closure(s)`,
          specifier: peerName,
          target: subpaths.join(", "),
        }),
      );
    }

    return findings;
  };

  const distributionFindingsForPackage = ({
    record,
    manifest,
    packageFiles = [],
    sourceByFile = new Map(),
    edges = [],
  }) => [
    ...distributionManifestFindings(record, manifest, packageFiles),
    ...[...sourceByFile.entries()].flatMap(([file, source]) =>
      distributionSourceProbeFindingsForSource(source, file, record.name),
    ),
    ...distributionSubpathFindings({ record, manifest, sourceByFile, edges }),
  ];

  const distributionEffectPeerFindings = (records, expectedRange) => {
    const ranges = new Map();
    const findings = [];
    for (const { record, manifest } of records) {
      const range = manifest.peerDependencies?.effect;
      if (typeof range !== "string") continue;
      ranges.set(range, [...(ranges.get(range) ?? []), record]);
    }
    const expected = expectedRange ?? [...ranges.keys()].sort(compare)[0];
    if (expected === undefined || (expectedRange === undefined && ranges.size <= 1))
      return findings;
    for (const [range, rangeRecords] of [...ranges.entries()].sort(([left], [right]) =>
      compare(left, right),
    )) {
      if (range === expected) continue;
      for (const record of rangeRecords) {
        findings.push(
          distributionFinding({
            kind: "effect-peer-invariant",
            file: `${record.path}/package.json`,
            packageName: record.name,
            message: `effect peer range ${range} differs from single-source range ${expected}`,
            specifier: "effect",
            target: range,
          }),
        );
      }
    }
    return findings;
  };

  const hardInstallEntryName = (entry) => {
    if (typeof entry === "string") return entry;
    if (isRecord(entry) && typeof entry.name === "string") return entry.name;
    return undefined;
  };

  const packageUnitHardDependencyNames = (unit) => {
    const envelope = unit.hardInstallEnvelope;
    if (!isRecord(envelope)) return new Set();
    return new Set(
      (Array.isArray(envelope.dependencies)
        ? envelope.dependencies.map(hardInstallEntryName)
        : []
      ).filter((value) => typeof value === "string" && value.length > 0),
    );
  };

  const packageUnitRequiredPeers = (unit) =>
    Array.isArray(unit.hardInstallEnvelope?.requiredPeers)
      ? unit.hardInstallEnvelope.requiredPeers.filter(
          (peer) =>
            isRecord(peer) && typeof peer.name === "string" && typeof peer.range === "string",
        )
      : [];

  const packageUnitOptionalPeerEntries = (unit) =>
    Array.isArray(unit.publicSubpaths)
      ? unit.publicSubpaths.flatMap((subpath) =>
          Array.isArray(subpath.optionalPeers)
            ? subpath.optionalPeers
                .filter((peer) => typeof peer === "string" && peer.length > 0)
                .map((peer) => ({ peer, subpath: subpath.subpath }))
            : [],
        )
      : [];

  const distributionUnitFinding = ({ kind, unit, message, specifier, target }) =>
    distributionFinding({
      kind,
      file: packageUnitsRegistryPath,
      packageName: isRecord(unit) && typeof unit.id === "string" ? unit.id : undefined,
      message,
      specifier,
      target,
    });

  const distributionUnitRegistryFindings = ({ registry, expectedEffectRange }) => {
    if (!isRecord(registry) || !Array.isArray(registry.packageUnits)) return [];
    const findings = [];
    for (const unit of registry.packageUnits.filter(isRecord)) {
      const rootSubpaths = Array.isArray(unit.publicSubpaths)
        ? unit.publicSubpaths.filter((subpath) => subpath.subpath === ".")
        : [];
      if (rootSubpaths.length !== 1) {
        findings.push(
          distributionUnitFinding({
            kind: "package-unit-root-export",
            unit,
            message: "package unit must declare exactly one root public subpath",
            target: String(rootSubpaths.length),
          }),
        );
      }
      for (const rootSubpath of rootSubpaths) {
        const rootOptionalPeers = Array.isArray(rootSubpath.optionalPeers)
          ? rootSubpath.optionalPeers.filter((peer) => typeof peer === "string" && peer.length > 0)
          : [];
        for (const peer of rootOptionalPeers) {
          findings.push(
            distributionUnitFinding({
              kind: "package-unit-root-optional-peer",
              unit,
              message: "package root cannot require a subpath-local optional peer",
              specifier: peer,
              target: ".",
            }),
          );
        }
      }

      const hardDependencyNames = packageUnitHardDependencyNames(unit);
      const requiredPeers = packageUnitRequiredPeers(unit);
      const requiredPeerNames = new Set(requiredPeers.map((peer) => peer.name));
      const optionalPeerEntries = packageUnitOptionalPeerEntries(unit);
      const optionalPeerKeys = new Set();
      for (const { peer, subpath } of optionalPeerEntries) {
        const key = `${subpath}\0${peer}`;
        if (optionalPeerKeys.has(key)) {
          findings.push(
            distributionUnitFinding({
              kind: "package-unit-optional-peer-duplicate",
              unit,
              message: "subpath optionalPeers must not contain duplicate peers",
              specifier: peer,
              target: subpath,
            }),
          );
        }
        optionalPeerKeys.add(key);
        if (hardDependencyNames.has(peer) || requiredPeerNames.has(peer)) {
          findings.push(
            distributionUnitFinding({
              kind: "package-unit-hard-locality",
              unit,
              message: "subpath-local optional peer is also declared as a package-wide obligation",
              specifier: peer,
              target: subpath,
            }),
          );
        }
        if (peer === "effect") {
          findings.push(
            distributionUnitFinding({
              kind: "package-unit-effect-peer-invariant",
              unit,
              message:
                "effect is a single package-wide peer invariant, not a subpath-local optional peer",
              specifier: peer,
              target: subpath,
            }),
          );
        }
      }

      for (const peer of requiredPeers.filter((entry) => entry.name === "effect")) {
        if (expectedEffectRange !== undefined && peer.range !== expectedEffectRange) {
          findings.push(
            distributionUnitFinding({
              kind: "package-unit-effect-peer-invariant",
              unit,
              message: `effect peer range must match root catalog single source ${expectedEffectRange}`,
              specifier: "effect",
              target: peer.range,
            }),
          );
        }
      }
    }
    return findings;
  };

  const distributionArchitectureFailures = () => {
    const workspacePackageRecords = graphWorkspacePackageRecords(repoRoot).filter(
      (record) => typeof record.name === "string" && record.name.startsWith("@agent-os/"),
    );
    const workspacePackageRecordsByName = new Map(
      workspacePackageRecords.map((record) => [record.name, record]),
    );
    const moduleBuckets = moduleBucketRegistry();
    const packageUnits = readJson(packageUnitsRegistryPath);
    const distributionRoots = readJson(distributionRootsRegistryPath);
    const packageUnitsById = new Map(
      Array.isArray(packageUnits.packageUnits)
        ? packageUnits.packageUnits
            .filter(isRecord)
            .map((unit) => [unit.id, unit])
            .filter(([id]) => typeof id === "string")
        : [],
    );
    const bucketIds = new Set(
      Array.isArray(moduleBuckets.buckets) ? moduleBuckets.buckets.map((bucket) => bucket.id) : [],
    );
    const ambientIds = new Set(
      Array.isArray(moduleBuckets.ambients)
        ? moduleBuckets.ambients.map((ambient) => ambient.id)
        : [],
    );
    const packageUnitIds = new Set(
      Array.isArray(packageUnits.packageUnits)
        ? packageUnits.packageUnits.map((unit) => unit.id)
        : [],
    );
    const targetProfileIds = new Set(
      Array.isArray(distributionRoots.targetProfiles)
        ? distributionRoots.targetProfiles.map((profile) => profile.id)
        : [],
    );
    const expectedEffectRange = readJson("package.json").catalog?.effect;
    return [
      ...packageUnitsRegistryFindings({
        registry: packageUnits,
        bucketIds,
        ambientIds,
        targetProfileIds,
        workspacePackageRecordsByName,
      }),
      ...distributionRootsRegistryFindings({
        registry: distributionRoots,
        packageUnitIds,
        ambientIds,
        packageUnitsById,
      }),
      ...distributionUnitRegistryFindings({
        registry: packageUnits,
        expectedEffectRange,
      }).map(formatDistributionFinding),
    ];
  };

  const distributionUnitNegativeFixtureFailures = () => {
    const failures = [];
    const fixtureRecord = {
      name: "@agent-os/runtime",
      path: "packages/runtime",
    };
    const bucketIds = new Set(["axioms", "ledger", "projection", "adapter"]);
    const ambientIds = new Set(["neutral", "browser", "node", "cloudflare-worker"]);
    const targetProfileIds = new Set(["neutral", "browser", "node", "cloudflare-worker"]);
    const schemaFindings = packageUnitsRegistryFindings({
      registry: { schemaVersion: 2, policy: {}, packageUnits: [] },
      bucketIds,
      ambientIds,
      targetProfileIds,
    });
    if (!schemaFindings.some((finding) => finding.includes("schemaVersion must be 1"))) {
      failures.push(
        `schema negative fixture: expected schemaVersion failure, got ${schemaFindings.join("\n")}`,
      );
    }

    const semanticFindings = distributionUnitRegistryFindings({
      expectedEffectRange: "^4.0.0",
      registry: {
        packageUnits: [
          {
            id: "client",
            hardInstallEnvelope: {
              dependencies: ["react"],
              installScripts: [],
              nativeArtifacts: [],
              packageWideMetadata: [],
              requiredPeers: [{ name: "effect", range: "^5.0.0" }],
            },
            publicSubpaths: [
              { subpath: ".", optionalPeers: ["react"] },
              { subpath: "./react", optionalPeers: ["react", "react"] },
              { subpath: "./effect", optionalPeers: ["effect"] },
            ],
          },
        ],
      },
    });
    for (const kind of [
      "package-unit-root-optional-peer",
      "package-unit-hard-locality",
      "package-unit-optional-peer-duplicate",
      "package-unit-effect-peer-invariant",
    ]) {
      if (!semanticFindings.some((finding) => finding.kind === kind)) {
        failures.push(
          `semantic negative fixture: expected ${kind}, got ${JSON.stringify(
            semanticFindings.map((finding) => finding.kind),
          )}`,
        );
      }
    }

    const leakFindings = distributionFindingsForPackage({
      record: fixtureRecord,
      manifest: {
        peerDependencies: { react: "^19" },
        peerDependenciesMeta: { react: { optional: true } },
        exports: {
          ".": "./src/index.ts",
          "./react": "./src/react.ts",
        },
      },
      sourceByFile: new Map([
        ["packages/runtime/src/index.ts", 'export type { ReactNode } from "./react";'],
        [
          "packages/runtime/src/react.ts",
          'import type { ReactNode } from "react"; import { useMemo } from "react"; export type { ReactNode }; export { useMemo };',
        ],
      ]),
      edges: [
        {
          from: fixtureRecord,
          to: fixtureRecord,
          fromFile: "packages/runtime/src/index.ts",
          toFile: "packages/runtime/src/react.ts",
          specifier: "./react",
        },
      ],
    });
    for (const kind of ["root-dts-peer-type-leak", "root-subpath-peer-leak"]) {
      if (!leakFindings.some((finding) => finding.kind === kind)) {
        failures.push(
          `root leak negative fixture: expected ${kind}, got ${JSON.stringify(
            leakFindings.map((finding) => finding.kind),
          )}`,
        );
      }
    }

    const effectFindings = distributionEffectPeerFindings(
      [
        {
          record: fixtureRecord,
          manifest: {
            peerDependencies: {
              effect: "^5.0.0",
            },
          },
        },
      ],
      "^4.0.0",
    );
    if (!effectFindings.some((finding) => finding.kind === "effect-peer-invariant")) {
      failures.push(
        `effect peer negative fixture: expected effect-peer-invariant, got ${JSON.stringify(
          effectFindings.map((finding) => finding.kind),
        )}`,
      );
    }

    return failures;
  };

  const formatDistributionFinding = (finding) => {
    const location =
      finding.line === undefined
        ? finding.file
        : `${finding.file}:${finding.line}:${finding.column ?? 1}`;
    const target = finding.target === undefined ? "" : ` -> ${finding.target}`;
    const specifier = finding.specifier === undefined ? "" : ` via ${finding.specifier}`;
    return `${location}: distribution-units:${finding.severity}:${finding.kind}: ${finding.message}${specifier}${target}`;
  };

  const checkDistributionUnits = (args = []) => {
    const reportOnly = args.length === 1 && args[0] === "--report-only";
    const negativeFixtures = args.length === 1 && args[0] === "--negative-fixtures";
    const enforceMinimality = args.length === 1 && args[0] === "--enforce-minimality";
    if (!reportOnly && !negativeFixtures && !enforceMinimality && args.length > 0) {
      throw new Error(`distribution-units: unexpected argument(s): ${args.join(" ")}`);
    }
    if (negativeFixtures) {
      failIfAny("distribution units negative fixtures", distributionUnitNegativeFixtureFailures());
      return;
    }
    const records = graphWorkspacePackageRecords(repoRoot).filter(
      (record) => typeof record.name === "string" && record.name.startsWith("@agent-os/"),
    );
    const graph = sourceModuleGraph(repoRoot, records);
    const sourceByFile = new Map(
      graph.files.map((entry) => [
        entry.file,
        fs.readFileSync(path.join(repoRoot, entry.file), "utf8"),
      ]),
    );
    const recordsWithManifests = records.map((record) => ({
      record,
      manifest: readJson(`${record.path}/package.json`),
    }));
    const reportFindings = [
      ...recordsWithManifests.flatMap(({ record, manifest }) => {
        const packageSourceByFile = new Map(
          [...sourceByFile.entries()].filter(([file]) => file.startsWith(`${record.path}/`)),
        );
        return distributionFindingsForPackage({
          record,
          manifest,
          packageFiles: walk(record.path),
          sourceByFile: packageSourceByFile,
          edges: graph.edges,
        });
      }),
      ...distributionEffectPeerFindings(
        recordsWithManifests,
        readJson("package.json").catalog?.effect,
      ),
    ].sort(
      (left, right) =>
        compare(left.severity, right.severity) ||
        compare(left.kind, right.kind) ||
        compare(left.file, right.file) ||
        compare(left.specifier ?? "", right.specifier ?? ""),
    );
    if (reportOnly) {
      const splitterCount = reportFindings.filter((finding) => finding.severity !== "info").length;
      const infoCount = reportFindings.length - splitterCount;
      const lines = reportFindings.map(formatDistributionFinding);
      console.log(
        `distribution units report-only: ${reportFindings.length} finding(s); ${splitterCount} package-wide obligation(s); ${infoCount} localizable observation(s)`,
      );
      for (const line of lines) console.log(line);
      return;
    }
    const rootLeakFindings = recordsWithManifests.flatMap(({ record, manifest }) => {
      const packageSourceByFile = new Map(
        [...sourceByFile.entries()].filter(([file]) => file.startsWith(`${record.path}/`)),
      );
      return distributionSubpathFindings({
        record,
        manifest,
        sourceByFile: packageSourceByFile,
        edges: graph.edges,
      }).filter((finding) => finding.kind.startsWith("root-"));
    });
    const effectPeerFindings = distributionEffectPeerFindings(
      recordsWithManifests,
      readJson("package.json").catalog?.effect,
    );
    const failures = [
      ...distributionArchitectureFailures(),
      ...rootLeakFindings.map(formatDistributionFinding),
      ...effectPeerFindings.map(formatDistributionFinding),
    ];
    if (enforceMinimality) failures.push(...distributionMinimalityFailures());
    failIfAny(enforceMinimality ? "distribution units minimality" : "distribution units", failures);
  };

  return {
    distributionManifestFindings,
    distributionSourceProbeFindingsForSource,
    distributionSubpathFindings,
    distributionFindingsForPackage,
    distributionEffectPeerFindings,
    distributionExportEntries,
    distributionClosureForRoots,
    distributionUnitRegistryFindings,
    distributionUnitNegativeFixtureFailures,
    distributionUnitFinding,
    packageUnitOptionalPeerEntries,
    formatDistributionFinding,
    checkDistributionUnits,
  };
};
