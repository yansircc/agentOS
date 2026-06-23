export const createOwnerChecks = ({
  ts,
  graphWorkspacePackageRecords,
  repoRoot,
  read,
  walk,
  compare,
  isRecord,
  unwrap,
  callName,
  packageSourceFiles,
  packageTestFiles,
}) => {
  const ownerCouplingSinkProperties = new Set([
    "boundaryOwner",
    "boundaryOwnerId",
    "boundaryPackageId",
    "claimedBy",
    "factOwnerRef",
    "owner",
    "packageId",
    "settlementId",
  ]);
  const ownerIdentityBoundarySinkProperties = new Set([
    "boundaryOwner",
    "boundaryOwnerId",
    "boundaryPackageId",
    "claimedBy",
    "factOwnerRef",
    "owner",
    "settlementId",
  ]);
  const packageMetadataNames = new Set(["packageId", "sourcePackageName", "publicPackageName"]);

  const publicNameForSourcePackage = (name) => name.replace(/^@agent-os\//u, "@yansirplus/");

  const ownerCouplingPackageNames = () => {
    const sourcePackageNames = new Set(
      graphWorkspacePackageRecords(repoRoot)
        .map((record) => record.name)
        .filter((name) => typeof name === "string" && name.startsWith("@agent-os/")),
    );
    const publicPackageNames = new Set([...sourcePackageNames].map(publicNameForSourcePackage));
    return { sourcePackageNames, publicPackageNames };
  };

  const ownerCouplingPropertyName = (name) => {
    if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) {
      return name.text;
    }
    return undefined;
  };

  const ownerCouplingPosition = (sourceFile, node) => {
    const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    return { line: position.line + 1, column: position.character + 1 };
  };

  const packageMetadataSource = (expression, packageNames) => {
    const unwrapped = unwrap(expression);
    if (ts.isStringLiteralLike(unwrapped)) {
      if (packageNames.sourcePackageNames.has(unwrapped.text)) return "sourcePackageNameLiteral";
      if (packageNames.publicPackageNames.has(unwrapped.text)) return "publicPackageNameLiteral";
      return undefined;
    }
    if (ts.isIdentifier(unwrapped) && packageMetadataNames.has(unwrapped.text)) {
      return unwrapped.text;
    }
    if (ts.isPropertyAccessExpression(unwrapped) && packageMetadataNames.has(unwrapped.name.text)) {
      return unwrapped.name.text;
    }
    if (ts.isCallExpression(unwrapped) && callName(unwrapped.expression) === "publicPackageName") {
      return "publicPackageName";
    }
    if (ts.isTemplateExpression(unwrapped)) {
      for (const span of unwrapped.templateSpans) {
        const source = packageMetadataSource(span.expression, packageNames);
        if (source !== undefined) return source;
      }
    }
    if (ts.isBinaryExpression(unwrapped)) {
      return (
        packageMetadataSource(unwrapped.left, packageNames) ??
        packageMetadataSource(unwrapped.right, packageNames)
      );
    }
    if (ts.isConditionalExpression(unwrapped)) {
      return (
        packageMetadataSource(unwrapped.whenTrue, packageNames) ??
        packageMetadataSource(unwrapped.whenFalse, packageNames)
      );
    }
    return undefined;
  };

  const packageMetadataFindingsForSource = (content, file, packageNames, sinkProperties) => {
    const sourceFile = ts.createSourceFile(
      file,
      content,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const findings = [];
    const record = (node, sink, source) => {
      const position = ownerCouplingPosition(sourceFile, node);
      findings.push({
        file,
        line: position.line,
        column: position.column,
        sink,
        source,
        expression: node.getText(sourceFile),
      });
    };

    const visit = (node) => {
      if (ts.isPropertyAssignment(node)) {
        const sink = ownerCouplingPropertyName(node.name);
        const source = packageMetadataSource(node.initializer, packageNames);
        if (sink !== undefined && source !== undefined && sinkProperties.has(sink)) {
          record(node.initializer, sink, source);
        }
      }

      if (ts.isBinaryExpression(node)) {
        const leftText = node.left.getText(sourceFile);
        const rightText = node.right.getText(sourceFile);
        const leftSource = packageMetadataSource(node.left, packageNames);
        const rightSource = packageMetadataSource(node.right, packageNames);
        if (leftText.includes("factOwnerRef") && rightSource !== undefined) {
          record(node.right, "factOwnerRef", rightSource);
        }
        if (rightText.includes("factOwnerRef") && leftSource !== undefined) {
          record(node.left, "factOwnerRef", leftSource);
        }
      }

      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return findings;
  };

  const ownerCouplingFindingsForSource = (content, file, packageNames) =>
    packageMetadataFindingsForSource(content, file, packageNames, ownerCouplingSinkProperties);

  const ownerIdentityBoundaryFindingsForSource = (content, file, packageNames) =>
    packageMetadataFindingsForSource(
      content,
      file,
      packageNames,
      ownerIdentityBoundarySinkProperties,
    );

  const ownerIdentityBoundaryNegativeFixtures = [
    {
      name: "fact owner from contract package id",
      content: ["const event = {", "  factOwnerRef: contract.packageId,", "};", ""],
      expected: [["factOwnerRef", "packageId"]],
    },
    {
      name: "fact owner from source package name",
      content: ["const event = {", "  factOwnerRef: contract.sourcePackageName,", "};", ""],
      expected: [["factOwnerRef", "sourcePackageName"]],
    },
    {
      name: "fact owner from public package projection",
      content: [
        "const event = {",
        "  factOwnerRef: publicPackageName(contract.packageId),",
        "};",
        "",
      ],
      expected: [["factOwnerRef", "publicPackageName"]],
    },
    {
      name: "fact owner from public package literal",
      content: ["const event = {", '  factOwnerRef: "@yansirplus/runtime",', "};", ""],
      expected: [["factOwnerRef", "publicPackageNameLiteral"]],
    },
    {
      name: "settlement id from package metadata",
      content: [
        "const settlement = defineSettlementContract({",
        "  settlementId: spec.sourcePackageName,",
        "});",
        "",
      ],
      expected: [["settlementId", "sourcePackageName"]],
    },
    {
      name: "extension conflict owner from package metadata",
      content: ["const conflict = {", "  claimedBy: declaration.packageId,", "};", ""],
      expected: [["claimedBy", "packageId"]],
    },
    {
      name: "namespace owner from package metadata",
      content: ["const namespace = {", "  owner: namespace.sourcePackageName,", "};", ""],
      expected: [["owner", "sourcePackageName"]],
    },
    {
      name: "boundary owner from package metadata",
      content: ["const intent = {", "  boundaryOwnerId: boundaryPackage.packageId,", "};", ""],
      expected: [["boundaryOwnerId", "packageId"]],
    },
    {
      name: "legacy boundary package field from package metadata",
      content: ["const intent = {", "  boundaryPackageId: boundaryPackage.packageId,", "};", ""],
      expected: [["boundaryPackageId", "packageId"]],
    },
    {
      name: "ledger identity comparison from package metadata",
      content: ["if (committed.factOwnerRef !== contract.packageId) {}", ""],
      expected: [["factOwnerRef", "packageId"]],
    },
  ];

  const findingPairs = (findings) => findings.map((finding) => [finding.sink, finding.source]);

  const ownerIdentityBoundaryNegativeFixtureFailures = (packageNames) => {
    const failures = [];
    for (const fixture of ownerIdentityBoundaryNegativeFixtures) {
      const findings = ownerIdentityBoundaryFindingsForSource(
        fixture.content.join("\n"),
        `negative-fixtures/${fixture.name}.ts`,
        packageNames,
      );
      const actual = findingPairs(findings);
      for (const expected of fixture.expected) {
        if (!actual.some(([sink, source]) => sink === expected[0] && source === expected[1])) {
          failures.push(
            `${fixture.name}: expected ${expected[0]} from ${expected[1]}, got ${JSON.stringify(
              actual,
            )}`,
          );
        }
      }
    }
    return failures;
  };

  const ownerCouplingScanFiles = () =>
    [
      ...walk("packages").filter((file) => /\.(?:ts|tsx|mts|cts)$/u.test(file)),
      ...walk("packages/cli/src").filter((file) => /\.(?:mjs|ts)$/u.test(file)),
      ...walk("tooling/distribution").filter((file) => /\.(?:mjs|ts)$/u.test(file)),
    ].sort(compare);

  const checkOwnerCoupling = (args = []) => {
    const reportOnly = args.length === 1 && args[0] === "--report-only";
    if (!reportOnly && args.length > 0) {
      throw new Error(`owner-coupling: unexpected argument(s): ${args.join(" ")}`);
    }
    const packageNames = ownerCouplingPackageNames();
    const findings = ownerCouplingScanFiles().flatMap((file) =>
      ownerCouplingFindingsForSource(read(file), file, packageNames),
    );
    const lines = findings.map(
      (finding) =>
        `${finding.file}:${finding.line}:${finding.column}: owner-coupling: ${finding.sink} reads ${finding.source} via ${finding.expression}`,
    );
    if (reportOnly) {
      console.log(`owner coupling report-only: ${findings.length} finding(s)`);
      for (const line of lines) console.log(line);
      return;
    }
    failIfAny("owner coupling", lines);
  };

  const checkOwnerIdentityBoundary = (args = []) => {
    const negativeFixtures = args.length === 1 && args[0] === "--negative-fixtures";
    if (!negativeFixtures && args.length > 0) {
      throw new Error(`owner-identity-boundary: unexpected argument(s): ${args.join(" ")}`);
    }
    const packageNames = ownerCouplingPackageNames();
    if (negativeFixtures) {
      failIfAny(
        "owner identity boundary negative fixtures",
        ownerIdentityBoundaryNegativeFixtureFailures(packageNames),
      );
      return;
    }
    const findings = ownerCouplingScanFiles().flatMap((file) =>
      ownerIdentityBoundaryFindingsForSource(read(file), file, packageNames),
    );
    failIfAny(
      "owner identity boundary",
      findings.map(
        (finding) =>
          `${finding.file}:${finding.line}:${finding.column}: owner-identity-boundary: ${finding.sink} reads ${finding.source} via ${finding.expression}`,
      ),
    );
  };

  const ownerIdRegistryPath = "architecture/owner-ids.json";

  const ownerIdRegistry = () => readJson(ownerIdRegistryPath);

  const ownerIdValue = (expression, constStrings) => {
    const unwrapped = unwrap(expression);
    if (ts.isStringLiteralLike(unwrapped)) return unwrapped.text;
    if (ts.isIdentifier(unwrapped)) return constStrings.get(unwrapped.text);
    return undefined;
  };

  const ownerIdConstStrings = (sourceFile) => {
    const out = new Map();
    const visit = (node) => {
      if (ts.isVariableStatement(node)) {
        for (const declaration of node.declarationList.declarations) {
          if (!ts.isIdentifier(declaration.name) || declaration.initializer === undefined) continue;
          const value = ownerIdValue(declaration.initializer, out);
          if (value !== undefined) out.set(declaration.name.text, value);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return out;
  };

  const ownerIdObjectProperty = (objectLiteral, name) => {
    for (const property of objectLiteral.properties) {
      if (!ts.isPropertyAssignment(property)) continue;
      const propertyName = ownerCouplingPropertyName(property.name);
      if (propertyName === name) return property.initializer;
    }
    return undefined;
  };

  const ownerIdDeclarationFindingsForSource = ({
    content,
    file,
    registeredOwners,
    workspacePackageNames,
  }) => {
    const sourceFile = ts.createSourceFile(
      file,
      content,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const constStrings = ownerIdConstStrings(sourceFile);
    const findings = [];
    const declarationCalls = new Set(["defineCarrier", "defineBoundaryContract", "eventNamespace"]);
    const record = (node, message) => {
      const position = ownerCouplingPosition(sourceFile, node);
      findings.push(`${file}:${position.line}:${position.column}: owner-ids: ${message}`);
    };

    const visit = (node) => {
      if (ts.isCallExpression(node) && declarationCalls.has(callName(node.expression))) {
        const [firstArg] = node.arguments;
        if (firstArg === undefined || !ts.isObjectLiteralExpression(unwrap(firstArg))) {
          record(node, `${callName(node.expression)} declaration must use an object literal`);
        } else {
          const objectLiteral = unwrap(firstArg);
          const ownerNode = ownerIdObjectProperty(objectLiteral, "ownerId");
          const sourceNode = ownerIdObjectProperty(objectLiteral, "sourcePackageName");
          const packageNode = ownerIdObjectProperty(objectLiteral, "packageId");
          if (packageNode !== undefined) {
            record(
              packageNode,
              `${callName(node.expression)} declaration must not declare packageId`,
            );
          }
          const ownerId =
            ownerNode === undefined ? undefined : ownerIdValue(ownerNode, constStrings);
          const sourcePackageName =
            sourceNode === undefined ? undefined : ownerIdValue(sourceNode, constStrings);
          if (ownerId === undefined) {
            record(node, `${callName(node.expression)} declaration requires literal ownerId`);
          } else if (!registeredOwners.has(ownerId)) {
            record(
              ownerNode ?? node,
              `ownerId ${ownerId} is not registered in ${ownerIdRegistryPath}`,
            );
          } else if (registeredOwners.get(ownerId)?.status === "retired") {
            record(ownerNode ?? node, `ownerId ${ownerId} is retired and cannot be declared`);
          }
          if (sourcePackageName === undefined) {
            record(
              node,
              `${callName(node.expression)} declaration requires literal sourcePackageName`,
            );
          } else if (!workspacePackageNames.has(sourcePackageName)) {
            record(
              sourceNode ?? node,
              `sourcePackageName ${sourcePackageName} is not a workspace package`,
            );
          } else if (
            ownerId !== undefined &&
            registeredOwners.has(ownerId) &&
            registeredOwners.get(ownerId)?.status === "active"
          ) {
            const owner = registeredOwners.get(ownerId);
            const sources = new Set(owner.sourcePackageNames ?? []);
            if (!sources.has(sourcePackageName)) {
              record(
                sourceNode ?? node,
                `sourcePackageName ${sourcePackageName} is not registered for ownerId ${ownerId}`,
              );
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return findings;
  };

  const coreClaimedNamespaceFindingsForSource = ({
    content,
    file,
    registeredOwners,
    workspacePackageNames,
  }) => {
    const sourceFile = ts.createSourceFile(
      file,
      content,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const constStrings = ownerIdConstStrings(sourceFile);
    const findings = [];
    const record = (node, message) => {
      const position = ownerCouplingPosition(sourceFile, node);
      findings.push(`${file}:${position.line}:${position.column}: owner-ids: ${message}`);
    };

    const validateNamespaceObject = (objectLiteral) => {
      const ownerNode = ownerIdObjectProperty(objectLiteral, "ownerId");
      const sourceNode = ownerIdObjectProperty(objectLiteral, "sourcePackageName");
      const packageNode = ownerIdObjectProperty(objectLiteral, "packageId");
      if (packageNode !== undefined) {
        record(packageNode, "CORE_CLAIMED_EVENT_NAMESPACES must not declare packageId");
      }
      const ownerId = ownerNode === undefined ? undefined : ownerIdValue(ownerNode, constStrings);
      const sourcePackageName =
        sourceNode === undefined ? undefined : ownerIdValue(sourceNode, constStrings);
      if (ownerId === undefined) {
        record(objectLiteral, "CORE_CLAIMED_EVENT_NAMESPACES entry requires literal ownerId");
      } else if (!registeredOwners.has(ownerId)) {
        record(
          ownerNode ?? objectLiteral,
          `ownerId ${ownerId} is not registered in ${ownerIdRegistryPath}`,
        );
      } else if (registeredOwners.get(ownerId)?.status === "retired") {
        record(ownerNode ?? objectLiteral, `ownerId ${ownerId} is retired and cannot be declared`);
      }
      if (sourcePackageName === undefined) {
        record(
          objectLiteral,
          "CORE_CLAIMED_EVENT_NAMESPACES entry requires literal sourcePackageName",
        );
      } else if (!workspacePackageNames.has(sourcePackageName)) {
        record(
          sourceNode ?? objectLiteral,
          `sourcePackageName ${sourcePackageName} is not a workspace package`,
        );
      } else if (
        ownerId !== undefined &&
        registeredOwners.has(ownerId) &&
        registeredOwners.get(ownerId)?.status === "active"
      ) {
        const owner = registeredOwners.get(ownerId);
        const sources = new Set(owner.sourcePackageNames ?? []);
        if (!sources.has(sourcePackageName)) {
          record(
            sourceNode ?? objectLiteral,
            `sourcePackageName ${sourcePackageName} is not registered for ownerId ${ownerId}`,
          );
        }
      }
    };

    const visit = (node) => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === "CORE_CLAIMED_EVENT_NAMESPACES" &&
        node.initializer !== undefined
      ) {
        const initializer = unwrap(node.initializer);
        if (!ts.isArrayLiteralExpression(initializer)) {
          record(node, "CORE_CLAIMED_EVENT_NAMESPACES must be an array literal");
          return;
        }
        for (const element of initializer.elements) {
          const entry = unwrap(element);
          if (ts.isObjectLiteralExpression(entry)) {
            validateNamespaceObject(entry);
          } else {
            record(element, "CORE_CLAIMED_EVENT_NAMESPACES entries must be object literals");
          }
        }
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return findings;
  };

  const ownerIdRegistryFindings = ({ registry, workspacePackageNames }) => {
    const findings = [];
    if (!isRecord(registry)) {
      return [`${ownerIdRegistryPath}: owner registry must be a JSON object`];
    }
    if (registry.schemaVersion !== 1) {
      findings.push(`${ownerIdRegistryPath}: schemaVersion must be 1`);
    }
    if (!isRecord(registry.policy)) {
      findings.push(`${ownerIdRegistryPath}: policy object is required`);
    } else {
      if (registry.policy.allocation !== "append-only") {
        findings.push(`${ownerIdRegistryPath}: policy.allocation must be append-only`);
      }
      for (const key of ["retirement", "namespaceSplit"]) {
        if (typeof registry.policy[key] !== "string" || registry.policy[key].length === 0) {
          findings.push(`${ownerIdRegistryPath}: policy.${key} must be a non-empty string`);
        }
      }
    }
    if (!Array.isArray(registry.owners) || registry.owners.length === 0) {
      findings.push(`${ownerIdRegistryPath}: owners must be a non-empty array`);
      return findings;
    }
    const seenOwnerIds = new Set();
    for (const [index, owner] of registry.owners.entries()) {
      const label = `${ownerIdRegistryPath}:owners[${index}]`;
      if (!isRecord(owner)) {
        findings.push(`${label}: owner must be an object`);
        continue;
      }
      if (typeof owner.ownerId !== "string" || owner.ownerId.length === 0) {
        findings.push(`${label}: ownerId must be a non-empty string`);
      } else if (seenOwnerIds.has(owner.ownerId)) {
        findings.push(`${label}: duplicate ownerId ${owner.ownerId}`);
      } else {
        seenOwnerIds.add(owner.ownerId);
      }
      if (owner.status !== "active" && owner.status !== "retired") {
        findings.push(`${label}: status must be active or retired`);
      }
      if (owner.status === "active") {
        if (
          !Array.isArray(owner.sourcePackageNames) ||
          owner.sourcePackageNames.length === 0 ||
          !owner.sourcePackageNames.every((name) => typeof name === "string" && name.length > 0)
        ) {
          findings.push(
            `${label}: active owner sourcePackageNames must be a non-empty string array`,
          );
          continue;
        }
        if ("retiredSourcePackageNames" in owner) {
          findings.push(`${label}: active owner must not declare retiredSourcePackageNames`);
        }
        for (const sourcePackageName of owner.sourcePackageNames) {
          if (!workspacePackageNames.has(sourcePackageName)) {
            findings.push(
              `${label}: sourcePackageName ${sourcePackageName} is not a workspace package`,
            );
          }
        }
      }
      if (owner.status === "retired") {
        if ("sourcePackageNames" in owner) {
          findings.push(`${label}: retired owner must not declare live sourcePackageNames`);
        }
        if (
          !Array.isArray(owner.retiredSourcePackageNames) ||
          owner.retiredSourcePackageNames.length === 0 ||
          !owner.retiredSourcePackageNames.every(
            (name) => typeof name === "string" && name.length > 0,
          )
        ) {
          findings.push(
            `${label}: retiredSourcePackageNames must be a non-empty string array for retired owners`,
          );
        }
      }
    }
    return findings;
  };

  const checkOwnerIds = () => {
    const workspacePackageNames = new Set(
      graphWorkspacePackageRecords(repoRoot)
        .map((record) => record.name)
        .filter((name) => typeof name === "string" && name.startsWith("@agent-os/")),
    );
    const registry = ownerIdRegistry();
    const registryFindings = ownerIdRegistryFindings({ registry, workspacePackageNames });
    const registeredOwners = new Map(
      (Array.isArray(registry.owners) ? registry.owners : [])
        .filter((owner) => isRecord(owner) && typeof owner.ownerId === "string")
        .map((owner) => [owner.ownerId, owner]),
    );
    const declarationFindings = packageSourceFiles().flatMap((file) =>
      ownerIdDeclarationFindingsForSource({
        content: read(file),
        file,
        registeredOwners,
        workspacePackageNames,
      }),
    );
    const retiredTestDeclarationFindings = packageTestFiles().flatMap((file) =>
      ownerIdDeclarationFindingsForSource({
        content: read(file),
        file,
        registeredOwners,
        workspacePackageNames,
      }).filter((finding) => finding.includes(" is retired and cannot be declared")),
    );
    const coreNamespaceFindings = coreClaimedNamespaceFindingsForSource({
      content: read("packages/core/src/errors.ts"),
      file: "packages/core/src/errors.ts",
      registeredOwners,
      workspacePackageNames,
    });
    failIfAny("owner ids", [
      ...registryFindings,
      ...declarationFindings,
      ...retiredTestDeclarationFindings,
      ...coreNamespaceFindings,
    ]);
  };

  return {
    ownerCouplingFindingsForSource,
    ownerIdentityBoundaryFindingsForSource,
    ownerIdentityBoundaryNegativeFixtureFailures,
    ownerIdDeclarationFindingsForSource,
    coreClaimedNamespaceFindingsForSource,
    ownerIdRegistryFindings,
    ownerIdRegistry,
    checkOwnerCoupling,
    checkOwnerIdentityBoundary,
    checkOwnerIds,
  };
};
