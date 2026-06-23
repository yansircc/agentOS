export const createRuntimeStructuralChecks = ({
  fs,
  path,
  ts,
  execFileSync,
  repoRoot,
  read,
  readJson,
  walk,
  isRecord,
  failIfAny,
  packageSourceFiles,
  nodeLabel,
  unwrap,
  callName,
  graphWorkspacePackageRecords,
  graphPackageSourceImportEdges,
  packageManifestDependencyEdges,
  tsconfigReferenceEdges,
}) => {
  const checkTransactionSync = () => {
    const failures = [];
    const inspectBody = (sourceFile, body, label) => {
      const visit = (node) => {
        if (ts.isAwaitExpression(node))
          failures.push(`${nodeLabel(sourceFile, node)} ${label} must not await`);
        if (
          ts.isNewExpression(node) &&
          ts.isIdentifier(node.expression) &&
          node.expression.text === "Promise"
        ) {
          failures.push(`${nodeLabel(sourceFile, node)} ${label} must not create Promise`);
        }
        if (
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          ts.isIdentifier(node.expression.expression) &&
          node.expression.expression.text === "Promise"
        ) {
          failures.push(
            `${nodeLabel(sourceFile, node)} ${label} must not call Promise static helpers`,
          );
        }
        if (
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === "then"
        ) {
          failures.push(`${nodeLabel(sourceFile, node)} ${label} must not call .then`);
        }
        if (
          ts.isCallExpression(node) &&
          ["setTimeout", "setInterval", "setImmediate", "queueMicrotask"].includes(
            callName(node.expression),
          )
        ) {
          failures.push(`${nodeLabel(sourceFile, node)} ${label} must not schedule async work`);
        }
        ts.forEachChild(node, visit);
      };
      visit(body);
    };
    for (const file of packageSourceFiles()) {
      const sourceFile = ts.createSourceFile(
        path.join(repoRoot, file),
        read(file),
        ts.ScriptTarget.Latest,
        true,
      );
      const visit = (node) => {
        if (ts.isCallExpression(node) && callName(node.expression) === "transactionSync") {
          const builder = unwrap(node.arguments[0]);
          if (!builder || (!ts.isArrowFunction(builder) && !ts.isFunctionExpression(builder))) {
            failures.push(
              `${nodeLabel(sourceFile, node)} transactionSync must use an inline sync builder`,
            );
          } else {
            if (
              builder.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)
            ) {
              failures.push(
                `${nodeLabel(sourceFile, builder)} transactionSync builder must not be async`,
              );
            }
            inspectBody(sourceFile, builder.body, "transactionSync builder");
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
    }
    failIfAny("transactionSync sync-only projection", failures);
  };

  const checkBackendNeutrality = () => {
    const failures = [];
    const rootPackage = readJson("package.json");
    const status = rootPackage.agentos?.backendNeutralityStatus;
    if (!["boundary-prepared", "backend-neutral"].includes(status)) {
      failures.push("package.json must declare agentos.backendNeutralityStatus");
    }
    const profiles = rootPackage.agentos?.backendNeutrality?.productionRuntimeProfiles;
    if (!Array.isArray(profiles)) {
      failures.push(
        "package.json must declare agentos.backendNeutrality.productionRuntimeProfiles",
      );
    }
    if (status === "backend-neutral" && Array.isArray(profiles) && profiles.length < 2) {
      failures.push("backend-neutral status requires at least 2 production runtime profiles");
    }
    for (const [index, profile] of (profiles ?? []).entries()) {
      const label = `package.json:agentos.backendNeutrality.productionRuntimeProfiles[${index}]`;
      if (!isRecord(profile)) {
        failures.push(`${label}: profile must be an object`);
        continue;
      }
      if (typeof profile.id !== "string" || profile.id.length === 0) {
        failures.push(`${label}: id must be a non-empty string`);
      }
      if (profile.sourcePackageName !== "@agent-os/runtime") {
        failures.push(`${label}: sourcePackageName must be @agent-os/runtime`);
      }
      if (
        typeof profile.subpath !== "string" ||
        !profile.subpath.startsWith("@agent-os/runtime/")
      ) {
        failures.push(`${label}: subpath must be an @agent-os/runtime/* subpath`);
      }
      if (typeof profile.contractTest !== "string" || profile.contractTest.length === 0) {
        failures.push(`${label}: contractTest must be a non-empty path`);
        continue;
      }
      if (!fs.existsSync(path.join(repoRoot, profile.contractTest))) {
        failures.push(`${profile.contractTest}: missing backend protocol contract test`);
      }
    }
    failIfAny("backend neutrality", failures);
  };

  const checkGateTierGovernance = () => {
    const failures = [];
    const gates = readJson("docs/agent/gates.source.json");
    const records = graphWorkspacePackageRecords(repoRoot).filter((record) =>
      record.name?.startsWith("@agent-os/"),
    );
    const proofClassIds = new Set(Object.keys(gates.proofClasses ?? {}));
    for (const required of ["structural", "typecheck", "test", "runtime", "distribution"]) {
      if (!proofClassIds.has(required))
        failures.push(`gates.source.json: missing ${required} proof class`);
    }
    for (const proofClass of gates.expensiveProofClasses ?? []) {
      if (!proofClassIds.has(proofClass))
        failures.push(`gates.source.json: unknown expensive proof ${proofClass}`);
    }
    for (const proofClass of gates.fullAffectedProofClasses ?? []) {
      if (!proofClassIds.has(proofClass))
        failures.push(`gates.source.json: unknown full proof ${proofClass}`);
    }

    const overrideByPath = new Map(
      (gates.packageOverrides ?? []).map((entry) => [entry.path, entry]),
    );
    for (const override of gates.packageOverrides ?? []) {
      if (!records.some((record) => record.path === override.path)) {
        failures.push(
          `gates.source.json: package override references unknown package ${override.path}`,
        );
      }
      for (const proofClass of [
        ...(override.proofClasses ?? []),
        ...(override.affectedProofClasses ?? []),
      ]) {
        if (!proofClassIds.has(proofClass)) {
          failures.push(`${override.path}: unknown proof class ${proofClass}`);
        }
      }
    }

    for (const record of records) {
      const manifest = readJson(`${record.path}/package.json`);
      const override = overrideByPath.get(record.path);
      const fastProof = override?.fastProof ?? gates.defaultPackageProof?.fastProof;
      if (fastProof === undefined) failures.push(`${record.path}: missing fast proof ownership`);
      if (manifest.scripts?.test?.includes("--passWithNoTests") && fastProof !== "none") {
        failures.push(
          `${record.path}: --passWithNoTests requires fastProof none in gates.source.json`,
        );
      }
      if (fastProof === "none") {
        if (!manifest.scripts?.test?.includes("--passWithNoTests")) {
          failures.push(
            `${record.path}: fastProof none requires explicit --passWithNoTests script`,
          );
        }
        if (!(override?.affectedProofClasses ?? []).includes("runtime")) {
          failures.push(`${record.path}: fastProof none must route affected changes to runtime`);
        }
      }
      if (
        typeof manifest.scripts?.test === "string" &&
        manifest.scripts.test.startsWith("vp test run") &&
        !manifest.scripts.test.includes("*.runtime.test.ts")
      ) {
        failures.push(`${record.path}: fast test script must exclude *.runtime.test.ts`);
      }
    }

    for (const file of walk("packages").filter((entry) => entry.endsWith(".worker.test.ts"))) {
      failures.push(`${file}: runtime tests must use *.runtime.test.ts`);
    }
    const runtimeTestFiles = walk("packages").filter((entry) => entry.endsWith(".runtime.test.ts"));
    for (const file of runtimeTestFiles) {
      const owner = records
        .filter((record) => file === record.path || file.startsWith(`${record.path}/`))
        .sort((left, right) => right.path.length - left.path.length)[0];
      const override = owner === undefined ? undefined : overrideByPath.get(owner.path);
      if (owner === undefined || !(override?.proofClasses ?? []).includes("runtime")) {
        failures.push(`${file}: runtime test has no runtime proof owner`);
      }
    }
    for (const file of walk(".").filter((entry) => entry.endsWith(".tsbuildinfo"))) {
      if (!file.startsWith(".cache/"))
        failures.push(`${file}: tsbuildinfo must live under .cache/`);
    }

    const sourceEdges = graphPackageSourceImportEdges(repoRoot, records);
    const graphEdges = [
      ...sourceEdges,
      ...packageManifestDependencyEdges(repoRoot, records),
      ...tsconfigReferenceEdges(repoRoot, records),
    ];
    const graphKeys = new Set(graphEdges.map((edge) => `${edge.from.name}->${edge.to.name}`));
    for (const edge of sourceEdges) {
      if (!graphKeys.has(`${edge.from.name}->${edge.to.name}`)) {
        failures.push(
          `${edge.file}: affected graph is missing source import edge ${edge.specifier}`,
        );
      }
    }

    failIfAny("gate tier governance", failures);
  };

  const checkSpikeHygiene = () => {
    const tracked = execFileSync("git", ["ls-files", "spikes"], { cwd: repoRoot, encoding: "utf8" })
      .split("\n")
      .map((line) => line.trim())
      .filter((file) => file.length > 0 && fs.existsSync(path.join(repoRoot, file)));
    const allowed = new Set();
    failIfAny(
      "spike hygiene",
      tracked
        .filter((file) => !allowed.has(file))
        .map((file) => `tracked spike file is not allowed: ${file}`),
    );
  };

  return {
    checkTransactionSync,
    checkBackendNeutrality,
    checkGateTierGovernance,
    checkSpikeHygiene,
  };
};
