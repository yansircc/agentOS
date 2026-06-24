export const createRepoSurfaceChecks = ({
  fs,
  path,
  ts,
  repoRoot,
  read,
  readJson,
  walk,
  compare,
  isRecord,
  failIfAny,
  collectAgentDocsModel,
  apiSourceMode,
  exportedNamesForPackage,
  sourceTsdocApiMarkdown,
  sourceTsdocModes,
  sourceTsdocRecordsForPackage,
  validateSourceTsdocRecords,
}) => {
  const manifestEntries = (file, section) => {
    const source = fs.readFileSync(file, "utf8");
    const start = source.indexOf(`## ${section}`);
    if (start === -1) return [];
    const rest = source.slice(start + section.length + 3);
    const next = rest.search(/^## /mu);
    const body = next === -1 ? rest : rest.slice(0, next);
    return [...body.matchAll(/`([^`:]+):([^`]+)`/gu)].map((match) => ({
      name: match[0].slice(1, -1),
      section,
      line: source.slice(0, start + section.length + 3 + match.index).split("\n").length,
    }));
  };

  const manifestNames = (file, section) =>
    new Set(manifestEntries(file, section).map((entry) => entry.name));

  const duplicateManifestEntries = (file, sections) => {
    const entries = sections.flatMap((section) => manifestEntries(file, section));
    const byName = new Map();
    for (const entry of entries) {
      byName.set(entry.name, [...(byName.get(entry.name) ?? []), entry]);
    }
    return [...byName.entries()]
      .filter(([, occurrences]) => occurrences.length > 1)
      .map(([name, occurrences]) => ({ name, occurrences }));
  };

  const targetPackages = () => {
    const surface = readJson("docs/surface.json");
    return surface.packages.filter((pkg) => {
      const packageJson = path.join(repoRoot, pkg.path, "package.json");
      if (!fs.existsSync(packageJson)) return false;
      const manifest = JSON.parse(fs.readFileSync(packageJson, "utf8"));
      return (
        pkg.apiSource !== undefined || (pkg.published === true && manifest.exports !== undefined)
      );
    });
  };

  const checkPublicApi = () => {
    const failures = [];
    const runtimeRoot = "packages/runtime/src/index.ts";
    const runtimeRootSource = read(runtimeRoot);
    const runtimeRootAst = ts.createSourceFile(
      path.join(repoRoot, runtimeRoot),
      runtimeRootSource,
      ts.ScriptTarget.Latest,
      true,
    );
    for (const statement of runtimeRootAst.statements) {
      if (
        ts.isExportDeclaration(statement) &&
        (statement.exportClause === undefined || ts.isNamespaceExport(statement.exportClause))
      ) {
        const { line, character } = runtimeRootAst.getLineAndCharacterOfPosition(
          statement.getStart(runtimeRootAst),
        );
        failures.push(
          `${runtimeRoot}:${line + 1}:${character + 1}: runtime root barrel must use explicit named exports; export-star syntax is forbidden`,
        );
      }
    }
    for (const target of targetPackages()) {
      if (target.apiSource === undefined) {
        failures.push(
          `${target.name}: published package exports require apiSource in docs/surface.json`,
        );
        continue;
      }
      const manifest = path.join(repoRoot, target.apiSource);
      if (!fs.existsSync(manifest)) {
        failures.push(`missing public API intent source for ${target.name}: ${target.apiSource}`);
        continue;
      }

      const mode = apiSourceMode(target);
      if (sourceTsdocModes.has(mode)) {
        const records = sourceTsdocRecordsForPackage(repoRoot, target);
        failures.push(...validateSourceTsdocRecords(target, records));
        const expected = `${sourceTsdocApiMarkdown(target, records).replace(/\s+$/u, "")}\n`;
        if (fs.readFileSync(manifest, "utf8") !== expected) {
          failures.push(`${target.apiSource} is stale; run pnpm run docs:generate`);
        }
      } else if (mode !== "manual") {
        failures.push(`${target.name}: unsupported apiSourceMode ${mode}`);
      }

      const publicSections = ["Public exports", "Experimental exports", "Deprecated exports"];
      for (const duplicate of duplicateManifestEntries(manifest, [
        ...publicSections,
        "Internal-only exports",
      ])) {
        const refs = duplicate.occurrences
          .map((entry) => `${entry.section}:${entry.line}`)
          .join(", ");
        failures.push(
          `${target.name}: ${target.apiSource} declares duplicate API entry ${duplicate.name} at ${refs}`,
        );
      }

      const declaredPublic = new Set(
        publicSections.flatMap((section) => [...manifestNames(manifest, section)]),
      );
      const internal = manifestNames(manifest, "Internal-only exports");
      const actual = exportedNamesForPackage(repoRoot, target)
        .map((record) => record.key)
        .sort();

      for (const name of actual) {
        if (!declaredPublic.has(name)) {
          failures.push(
            `${target.name}: exported but not declared in ${target.apiSource}: ${name}`,
          );
        }
        if (internal.has(name)) {
          failures.push(`${target.name}: internal export is still exported: ${name}`);
        }
      }
      for (const name of declaredPublic) {
        if (!actual.includes(String(name))) {
          failures.push(
            `${target.name}: ${target.apiSource} lists missing export: ${String(name)}`,
          );
        }
      }
    }
    failIfAny("public API projection", failures);
  };

  const checkEventNamespaces = () => {
    const failures = collectAgentDocsModel(repoRoot).namespaceModel.failures;
    failIfAny("event namespace projection", failures);
  };

  const importSpecifiers = (content) => {
    const sourceFile = ts.createSourceFile(
      "agentos-check.mjs",
      content,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
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

  const ruleConstraints = (ruleId) => {
    const source = readJson("docs/agent/boundary-rules.source.json");
    const rule = source.rules?.find((entry) => isRecord(entry) && entry.id === ruleId);
    if (!isRecord(rule) || !isRecord(rule.constraints)) {
      throw new Error(`docs/agent/boundary-rules.source.json: ${ruleId} missing constraints`);
    }
    return rule.constraints;
  };

  const checkRepoToolingSurface = () => {
    const constraints = ruleConstraints("repo-tooling-surface");
    const failures = [];
    const expected = [...constraints.rootScripts].sort(compare);
    const actual = Object.keys(readJson("package.json").scripts ?? {}).sort(compare);
    for (const scriptName of expected.filter((name) => !actual.includes(name))) {
      failures.push(`package.json: missing root script ${scriptName}`);
    }
    for (const scriptName of actual.filter((name) => !expected.includes(name))) {
      failures.push(`package.json: unexpected root script ${scriptName}`);
    }
    for (const scriptName of actual) {
      if (
        /^(check|test):/u.test(scriptName) &&
        !constraints.allowedPrefixedRootScripts.includes(scriptName)
      ) {
        failures.push(`package.json: unexpected fine-grained root script ${scriptName}`);
      }
    }

    for (const file of walk("scripts")) {
      if (!constraints.scriptsDirectoryAllowPrefixes.some((prefix) => file.startsWith(prefix))) {
        failures.push(`scripts/: non-parallel-dev script remains at ${file}`);
        continue;
      }
      if (!constraints.scriptsDirectoryAllowedExtensions.includes(path.extname(file))) {
        failures.push(`scripts/: ${file} must use an allowed script extension`);
      }
    }

    const packagesRoot = path.join(repoRoot, "packages");
    const cliRoot = path.join(packagesRoot, "cli");
    const cliManifest = readJson("packages/cli/package.json");
    const declaredCliPackageDependencies = new Set(
      ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"].flatMap(
        (section) => Object.keys(cliManifest[section] ?? {}),
      ),
    );
    const packageSpecPrefixesRequiringDeclaredDependency =
      constraints.packageSpecPrefixesRequireDeclaredDependency ??
      constraints.forbiddenPackageSpecPrefixes ??
      [];
    const declaredPackageForSpecifier = (specifier) =>
      [...declaredCliPackageDependencies].find(
        (name) => specifier === name || specifier.startsWith(`${name}/`),
      );
    for (const file of walk("packages/cli/src").filter((entry) =>
      /\.(?:mjs|js|ts|tsx)$/u.test(entry),
    )) {
      const content = read(file);
      for (const specifier of importSpecifiers(content)) {
        if (
          packageSpecPrefixesRequiringDeclaredDependency.some((prefix) =>
            specifier.startsWith(prefix),
          ) &&
          declaredPackageForSpecifier(specifier) === undefined
        ) {
          failures.push(`${file}: CLI package specifier ${specifier} is not a declared dependency`);
        }
        if (specifier.startsWith(".")) {
          const resolved = path.resolve(path.dirname(path.join(repoRoot, file)), specifier);
          const isPackagesSource =
            resolved === packagesRoot || resolved.startsWith(`${packagesRoot}${path.sep}`);
          const isCliSource = resolved === cliRoot || resolved.startsWith(`${cliRoot}${path.sep}`);
          if (isPackagesSource && !isCliSource) {
            failures.push(`${file}: CLI must not import packages source via ${specifier}`);
          }
        }
      }
    }

    const legacyPattern = new RegExp(constraints.forbiddenLegacyScriptReferencePattern, "u");
    for (const file of constraints.legacyReferenceScanRoots.flatMap((root) => walk(root))) {
      if (!/\.(?:json|jsonc|md|mjs|ts|tsx)$/u.test(file)) continue;
      for (const [index, line] of read(file).split("\n").entries()) {
        if (legacyPattern.test(line)) {
          failures.push(`${file}:${index + 1}: legacy scripts/ check/generate reference remains`);
        }
      }
    }
    failIfAny("repo tooling surface", failures);
  };

  return {
    manifestEntries,
    manifestNames,
    duplicateManifestEntries,
    importSpecifiers,
    ruleConstraints,
    checkPublicApi,
    checkEventNamespaces,
    checkRepoToolingSurface,
  };
};
