export const createSourceAliasChecks = ({
  fs,
  path,
  pathToFileURL,
  repoRoot,
  readJson,
  toRepoPath,
  compare,
  isRecord,
  failIfAny,
}) => {
  const packageJsonFiles = () => {
    const files = [];
    const visit = (dir) => {
      const packageJson = path.join(dir, "package.json");
      if (fs.existsSync(packageJson)) {
        files.push(packageJson);
        return;
      }
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name !== "node_modules") visit(path.join(dir, entry.name));
      }
    };
    for (const root of ["packages", "tooling"]) visit(path.join(repoRoot, root));
    return files.sort(compare);
  };

  const checkSourceAliases = async () => {
    const failures = [];
    const { agentOsSourceAliasSpecs } = await import(
      pathToFileURL(path.join(repoRoot, "tooling/vitest-config/source-aliases.ts")).href
    );
    const actual = new Map(
      [...agentOsSourceAliasSpecs].sort(([left], [right]) => left.localeCompare(right)),
    );
    const expected = new Map();
    for (const packageJsonPath of packageJsonFiles()) {
      const packageDir = path.dirname(packageJsonPath);
      const manifest = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
      if (!manifest.name?.startsWith("@agent-os/")) continue;
      const exportsValue =
        manifest.exports ??
        (fs.existsSync(path.join(packageDir, "src/index.ts")) ? { ".": "./src/index.ts" } : {});
      for (const [exportPath, exportTarget] of Object.entries(
        isRecord(exportsValue) ? exportsValue : { ".": exportsValue },
      )) {
        const target =
          typeof exportTarget === "string"
            ? exportTarget
            : (exportTarget?.default ?? exportTarget?.import ?? exportTarget?.types);
        if (typeof target !== "string" || !target.startsWith("./")) continue;
        const specifier =
          exportPath === "."
            ? manifest.name
            : `${manifest.name}/${exportPath.replace(/^\.\//u, "")}`;
        expected.set(specifier, toRepoPath(path.join(packageDir, target)));
      }
    }
    for (const [specifier, sourcePath] of expected) {
      if (actual.get(specifier) !== sourcePath) {
        failures.push(
          `source alias ${String(specifier)}: expected ${String(sourcePath)}; actual ${String(actual.get(specifier))}`,
        );
      }
    }
    for (const specifier of actual.keys()) {
      if (!expected.has(specifier)) failures.push(`extra source alias ${String(specifier)}`);
    }
    const tsconfig = readJson("tsconfig.source-paths.json");
    if (tsconfig.compilerOptions?.baseUrl !== undefined) {
      failures.push("tsconfig.source-paths.json must not set compilerOptions.baseUrl");
    }
    const actualPaths = tsconfig.compilerOptions?.paths ?? {};
    for (const [specifier, sourcePath] of actual) {
      const expectedPaths = [`./${String(sourcePath)}`];
      if (JSON.stringify(actualPaths[specifier]) !== JSON.stringify(expectedPaths)) {
        failures.push(
          `tsconfig.source-paths.json paths.${String(specifier)}: expected ${JSON.stringify(expectedPaths)}`,
        );
      }
    }
    for (const file of packageJsonFiles()
      .map((packageJsonPath) => path.join(path.dirname(packageJsonPath), "tsconfig.json"))
      .filter((file) => fs.existsSync(file))) {
      const tsconfigSource = readJson(toRepoPath(file));
      const expectedExtends = path
        .relative(path.dirname(file), path.join(repoRoot, "tsconfig.source-paths.json"))
        .split(path.sep)
        .join("/");
      if (tsconfigSource.extends !== expectedExtends) {
        failures.push(`${toRepoPath(file)}: expected extends ${JSON.stringify(expectedExtends)}`);
      }
      const localAgentOsPaths = Object.keys(tsconfigSource.compilerOptions?.paths ?? {}).filter(
        (specifier) => specifier.startsWith("@agent-os/"),
      );
      if (localAgentOsPaths.length > 0) {
        failures.push(
          `${toRepoPath(file)} has package-local @agent-os paths: ${localAgentOsPaths.join(", ")}`,
        );
      }
    }
    failIfAny("source aliases", failures);
  };

  return { checkSourceAliases };
};
