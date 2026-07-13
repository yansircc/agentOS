import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import ts from "typescript";

const proofKinds = new Set(["algorithmic", "generatedProjection", "packageTest"]);
const gateCompositionKind = "gateComposition";
const coverageFields = new Set(["schemaVersion", "invariant", "entries"]);
const entryFields = new Set(["ruleId", "owner", "invariantId", "source", "proof"]);
const proofFields = new Set(["kind", "command", "positive", "redCases", "blindSpots"]);
const liveSourceFields = new Set(["kind", "path", "selector", "entrypoint"]);
const historicalSourceFields = new Set(["kind", "commit", "path", "supersededBy"]);

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const nonEmpty = (value) => typeof value === "string" && value.trim().length > 0;
const safeRelativePath = (value) =>
  nonEmpty(value) &&
  !path.isAbsolute(value) &&
  !value.split(/[\\/]/u).some((part) => part === ".." || part.length === 0);

const repoPath = (...segments) => path.posix.normalize(path.posix.join(...segments));

const unexpectedFieldFailures = ({ value, allowed, label }) =>
  isRecord(value)
    ? Object.keys(value)
        .filter((key) => !allowed.has(key))
        .map((key) => `${label}: unexpected field ${key}`)
    : [];

const astSelectorExists = ({ sourcePath, content, selector }) => {
  const ast = ts.createSourceFile(sourcePath, content, ts.ScriptTarget.Latest, true);
  let found = false;
  const visit = (node) => {
    if (selector.kind === "symbol") {
      if (
        (ts.isVariableDeclaration(node) ||
          ts.isFunctionDeclaration(node) ||
          ts.isClassDeclaration(node) ||
          ts.isInterfaceDeclaration(node) ||
          ts.isTypeAliasDeclaration(node) ||
          ts.isEnumDeclaration(node)) &&
        node.name !== undefined &&
        ts.isIdentifier(node.name) &&
        node.name.text === selector.value
      ) {
        found = true;
      }
    } else if (ts.isCallExpression(node) && node.arguments.length > 0) {
      const expression = node.expression;
      const testName = ts.isIdentifier(expression)
        ? expression.text
        : ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression)
          ? expression.expression.text
          : undefined;
      if (
        (testName === "describe" || testName === "it" || testName === "test") &&
        ts.isStringLiteralLike(node.arguments[0]) &&
        node.arguments[0].text === selector.value
      ) {
        found = true;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return found;
};

const resolvedRelativeModule = (repoRoot, importerPath, specifier) => {
  if (!specifier.startsWith(".")) return undefined;
  const base = repoPath(path.posix.dirname(importerPath), specifier);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.mts`,
    `${base}.cts`,
    `${base}.js`,
    `${base}.mjs`,
    `${base}.cjs`,
    repoPath(base, "index.ts"),
    repoPath(base, "index.tsx"),
    repoPath(base, "index.mts"),
    repoPath(base, "index.js"),
    repoPath(base, "index.mjs"),
  ];
  return candidates.find((candidate) => {
    const absolute = path.join(repoRoot, candidate);
    return fs.existsSync(absolute) && fs.statSync(absolute).isFile();
  });
};

const importedRelativeModules = ({ repoRoot, sourcePath }) => {
  const source = fs.readFileSync(path.join(repoRoot, sourcePath), "utf8");
  const ast = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true);
  const imports = [];
  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      const resolved = resolvedRelativeModule(repoRoot, sourcePath, node.moduleSpecifier.text);
      if (resolved !== undefined) imports.push(resolved);
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return imports;
};

const importClosureContains = ({ repoRoot, entrypoint, target }) => {
  const pending = [entrypoint];
  const visited = new Set();
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === target) return true;
    if (current === undefined || visited.has(current)) continue;
    visited.add(current);
    pending.push(...importedRelativeModules({ repoRoot, sourcePath: current }));
  }
  return false;
};

const importClosureContainsTest = ({ repoRoot, entrypoint, selector }) => {
  const pending = [entrypoint];
  const visited = new Set();
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || visited.has(current)) continue;
    visited.add(current);
    const content = fs.readFileSync(path.join(repoRoot, current), "utf8");
    if (
      astSelectorExists({
        sourcePath: current,
        content,
        selector: { kind: "test", value: selector },
      })
    ) {
      return true;
    }
    pending.push(...importedRelativeModules({ repoRoot, sourcePath: current }));
  }
  return false;
};

const sourceSelectorFailures = ({ source, absolute, label }) => {
  const selector = source.selector;
  if (!isRecord(selector) || !nonEmpty(selector.kind) || !nonEmpty(selector.value)) {
    return [`${label}: live source requires a positive selector`];
  }
  if (selector.kind === "module") return [];
  const content = fs.readFileSync(absolute, "utf8");
  if (selector.kind !== "symbol" && selector.kind !== "test") {
    return [`${label}: unknown live source selector kind ${selector.kind}`];
  }

  const found = astSelectorExists({ sourcePath: source.path, content, selector });
  return found ? [] : [`${label}: live source selector is absent: ${selector.value}`];
};

const sourceFailures = ({ source, label, repoRoot }) => {
  if (!isRecord(source)) return [`${label}: source must be an object`];
  if (source.kind === "live") {
    const failures = unexpectedFieldFailures({
      value: source,
      allowed: liveSourceFields,
      label: `${label}.source`,
    });
    if (!safeRelativePath(source.path)) {
      failures.push(`${label}: live source path must be repo-relative`);
      return failures;
    }
    const absolute = path.join(repoRoot, source.path);
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
      failures.push(`${label}: live proof source does not exist: ${source.path}`);
      return failures;
    }
    failures.push(...sourceSelectorFailures({ source, absolute, label }));
    return failures;
  }
  if (source.kind === "historical") {
    const failures = unexpectedFieldFailures({
      value: source,
      allowed: historicalSourceFields,
      label: `${label}.source`,
    });
    if (!/^[0-9a-f]{40}$/u.test(source.commit ?? "")) {
      failures.push(`${label}: historical source commit must be a full SHA`);
    }
    if (!safeRelativePath(source.path)) {
      failures.push(`${label}: historical source path must be repo-relative`);
    }
    if (source.supersededBy !== label) {
      failures.push(`${label}: historical source supersededBy must equal the current rule id`);
    }
    if (failures.length === 0) {
      try {
        const commitType = execFileSync("git", ["cat-file", "-t", source.commit], {
          cwd: repoRoot,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        if (commitType !== "commit") {
          failures.push(`${label}: historical source commit must be an immutable commit object`);
          return failures;
        }
        const sourceType = execFileSync(
          "git",
          ["cat-file", "-t", `${source.commit}:${source.path}`],
          {
            cwd: repoRoot,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
          },
        ).trim();
        if (sourceType !== "blob") {
          failures.push(`${label}: historical proof source must be an immutable file blob`);
        }
      } catch {
        failures.push(`${label}: historical proof source does not exist at ${source.commit}`);
      }
    }
    return failures;
  }
  return [`${label}: source kind must be live or historical`];
};

const parsePackageTestCommand = ({ command, label }) => {
  if (!isRecord(command) || !Array.isArray(command.argv)) {
    return { failures: [`${label}: package test proof requires argv`] };
  }
  const prefix = ["../../node_modules/.bin/vp", "test", "run", "--configLoader", "runner"];
  if (!prefix.every((part, index) => command.argv[index] === part)) {
    return { failures: [`${label}: package test proof must use the focused vp runner`] };
  }
  let rest = command.argv.slice(prefix.length);
  let config;
  if (rest[0] === "--config") {
    if (!safeRelativePath(rest[1])) {
      return { failures: [`${label}: package test config must be repo-relative`] };
    }
    config = rest[1];
    rest = rest.slice(2);
  }
  if (
    rest.length !== 3 ||
    !safeRelativePath(rest[0]) ||
    !rest[0].endsWith(".test.ts") ||
    rest[1] !== "-t" ||
    !nonEmpty(rest[2])
  ) {
    return {
      failures: [`${label}: package test proof must bind one test entrypoint and exact selector`],
    };
  }
  let proofClass;
  if (config === undefined) {
    if (rest[0].endsWith(".runtime.test.ts")) {
      return { failures: [`${label}: runtime test proof requires a canonical runtime config`] };
    }
    proofClass = "test";
  } else {
    const runtimePathByConfig = new Map([
      ["vitest.cloudflare.config.ts", /^test\/cloudflare\/.+\.runtime\.test\.ts$/u],
      ["vitest.node.config.ts", /^test\/node\/.+\.runtime\.test\.ts$/u],
    ]);
    const runtimePath = runtimePathByConfig.get(config);
    if (
      command.cwd !== "packages/runtime" ||
      runtimePath === undefined ||
      !runtimePath.test(rest[0])
    ) {
      return {
        failures: [
          `${label}: package test config and entrypoint must select one canonical runtime tier`,
        ],
      };
    }
    proofClass = "runtime";
  }
  return {
    failures: [],
    entrypoint: repoPath(command.cwd, rest[0]),
    selector: rest[2],
    proofClass,
  };
};

const commandFailures = ({ command, kind, label, repoRoot, hasAlgorithmicChecker }) => {
  const failures = [];
  if (!isRecord(command) || !safeRelativePath(command.cwd ?? ".")) {
    return [`${label}: proof command cwd must be repo-relative`];
  }
  if (!Array.isArray(command.argv) || command.argv.length < 2 || !command.argv.every(nonEmpty)) {
    return [`${label}: proof command must use non-empty argv form`];
  }
  if (!fs.existsSync(path.join(repoRoot, command.cwd))) {
    failures.push(`${label}: proof command cwd does not exist`);
  }

  if (kind === "algorithmic" || kind === "gateComposition") {
    const [executable, modulePath, checkerId, ...rest] = command.argv;
    if (
      command.cwd !== "." ||
      executable !== "node" ||
      modulePath !== "packages/cli/src/check/algorithmic-checks.mjs" ||
      !nonEmpty(checkerId) ||
      rest.length !== 0 ||
      !hasAlgorithmicChecker(checkerId)
    ) {
      failures.push(`${label}: algorithmic proof command must bind one registered checker`);
    }
  }
  if (kind === "generatedProjection") {
    const [executable, generator, flag, ...rest] = command.argv;
    if (
      command.cwd !== "." ||
      executable !== "node" ||
      !safeRelativePath(generator) ||
      !generator.startsWith("packages/cli/src/generate/") ||
      !fs.existsSync(path.join(repoRoot, generator)) ||
      flag !== "--check" ||
      rest.length !== 0
    ) {
      failures.push(`${label}: generated projection proof must invoke one live generator --check`);
    }
  }
  if (kind === "packageTest") {
    failures.push(...parsePackageTestCommand({ command, label }).failures);
  }
  if (
    command.dependencyMode !== undefined &&
    command.dependencyMode !== "linked" &&
    command.dependencyMode !== "isolatedInstall"
  ) {
    failures.push(`${label}: unknown dependencyMode`);
  }
  if (
    command.copyPaths !== undefined &&
    (!Array.isArray(command.copyPaths) || !command.copyPaths.every(safeRelativePath))
  ) {
    failures.push(`${label}: copyPaths must contain repo-relative prepared artifacts`);
  }
  return failures;
};

const sourceCommandCongruenceFailures = ({
  source,
  proof,
  label,
  repoRoot,
  algorithmicCheckerSource,
}) => {
  if (!isRecord(source) || !isRecord(proof?.command)) return [];
  if (proof.kind === "algorithmic" || proof.kind === "gateComposition") {
    const checkerId = proof.command.argv?.[2];
    const expected = algorithmicCheckerSource(checkerId);
    if (expected === undefined) {
      return [`${label}: algorithmic checker requires live source metadata`];
    }
    const checkerFailures = sourceFailures({
      source: {
        kind: "live",
        path: expected.path,
        selector: { kind: "symbol", value: expected.symbol },
      },
      label: `${label}.checker`,
      repoRoot,
    });
    if (source.kind === "historical") return checkerFailures;
    if (
      source.kind !== "live" ||
      source.path !== expected.path ||
      source.selector?.kind !== "symbol" ||
      source.selector.value !== expected.symbol
    ) {
      checkerFailures.push(
        `${label}: algorithmic source must match the registered checker path and symbol`,
      );
    }
    if (source.entrypoint !== undefined) {
      checkerFailures.push(
        `${label}: algorithmic source must not declare a package-test entrypoint`,
      );
    }
    return checkerFailures;
  }
  if (proof.kind === "generatedProjection") {
    if (source.kind === "historical") return [];
    if (
      source.kind !== "live" ||
      source.path !== proof.command.argv?.[1] ||
      source.selector?.kind !== "module" ||
      source.entrypoint !== undefined
    ) {
      return [`${label}: generated source must be the generator invoked by the proof command`];
    }
    return [];
  }
  if (proof.kind === "packageTest") {
    const parsed = parsePackageTestCommand({ command: proof.command, label });
    if (parsed.failures.length > 0) return [];
    const failures = [];
    const commandEntrypoint = path.join(repoRoot, parsed.entrypoint);
    if (!fs.existsSync(commandEntrypoint) || !fs.statSync(commandEntrypoint).isFile()) {
      failures.push(`${label}: package command test entrypoint does not exist`);
    } else if (
      !importClosureContainsTest({
        repoRoot,
        entrypoint: parsed.entrypoint,
        selector: parsed.selector,
      })
    ) {
      failures.push(`${label}: package command selector is absent from the test import closure`);
    }
    if (source.kind === "historical") return failures;
    if (
      source.kind !== "live" ||
      !safeRelativePath(source.entrypoint) ||
      source.entrypoint !== parsed.entrypoint
    ) {
      failures.push(`${label}: package source entrypoint must equal the command test file`);
    }
    if (source.selector?.kind !== "test" || source.selector.value !== parsed.selector) {
      failures.push(`${label}: package source selector must equal the command -t selector`);
    }
    if (
      failures.length === 0 &&
      !importClosureContains({
        repoRoot,
        entrypoint: source.entrypoint,
        target: source.path,
      })
    ) {
      failures.push(`${label}: package source must be in the entrypoint import closure`);
    }
    return failures;
  }
  return [];
};

const redCaseFailures = ({ redCase, label, proofKind, packageRoot }) => {
  if (!isRecord(redCase) || !nonEmpty(redCase.id)) return [`${label}: red case requires an id`];
  const failures = [];
  if (redCase.kind === "repositoryMutation") {
    if (redCase.isolation !== "detachedWorktree") {
      failures.push(`${label}: repository mutation must use a detached worktree`);
    }
    if (!Array.isArray(redCase.edits) || redCase.edits.length === 0) {
      failures.push(`${label}: repository mutation requires exact edits`);
    }
    for (const [index, edit] of (redCase.edits ?? []).entries()) {
      const editLabel = `${label}.edits[${index}]`;
      if (!isRecord(edit) || !safeRelativePath(edit.path)) {
        failures.push(`${editLabel}: edit path must be repo-relative`);
        continue;
      }
      if (edit.op === "replace") {
        if (
          !nonEmpty(edit.before) ||
          typeof edit.after !== "string" ||
          edit.before === edit.after
        ) {
          failures.push(`${editLabel}: replace requires distinct exact before/after text`);
        }
      } else if (edit.op === "create") {
        if (typeof edit.content !== "string" || edit.content.length === 0) {
          failures.push(`${editLabel}: create requires content`);
        }
      } else {
        failures.push(`${editLabel}: edit op must be replace or create`);
      }
      if (edit.stage !== undefined && edit.stage !== true) {
        failures.push(`${editLabel}: stage is either omitted or true`);
      }
      if (
        proofKind === "packageTest" &&
        (!nonEmpty(packageRoot) || !edit.path.startsWith(`${packageRoot}/src/`))
      ) {
        failures.push(`${editLabel}: package-test mutation must change production source`);
      }
    }
    if (!Number.isInteger(redCase.expected?.exitCode) || redCase.expected.exitCode === 0) {
      failures.push(`${label}: repository red case must expect a non-zero exit`);
    }
    if (!nonEmpty(redCase.expected?.outputIncludes)) {
      failures.push(`${label}: repository red case requires a stable diagnostic`);
    }
  } else {
    failures.push(`${label}: red case kind must be repositoryMutation`);
  }
  return failures;
};

const ruleAcceptanceFailures = ({ rule, proof, label }) => {
  const acceptance = rule.acceptance;
  if (!isRecord(acceptance)) return [`${label}: boundary rule requires acceptance`];
  if (proof.kind === "algorithmic" || proof.kind === gateCompositionKind) {
    const checkerId = proof.command?.argv?.[2];
    return acceptance.engine === "algorithmic" && acceptance.checker === checkerId
      ? []
      : [`${label}: boundary rule acceptance must match algorithmic proof checker ${checkerId}`];
  }
  if (proof.kind === "generatedProjection") {
    const command = Array.isArray(proof.command?.argv) ? proof.command.argv.join(" ") : undefined;
    return acceptance.engine === "generatedProjection" && acceptance.command === command
      ? []
      : [`${label}: boundary rule acceptance must match generated projection command`];
  }
  if (proof.kind === "packageTest") {
    if (acceptance.engine !== "proofClass") {
      return [`${label}: boundary rule acceptance must use proofClass for packageTest proof`];
    }
    const parsed = parsePackageTestCommand({ command: proof.command, label });
    if (parsed.failures.length > 0) return [];
    return Array.isArray(acceptance.proofClasses) &&
      acceptance.proofClasses.length === 1 &&
      acceptance.proofClasses[0] === parsed.proofClass
      ? []
      : [
          `${label}: boundary rule proofClasses must equal derived package test tier ${parsed.proofClass}`,
        ];
  }
  return [];
};

const compositionFailures = ({
  proof,
  label,
  repoRoot,
  hasAlgorithmicChecker,
  algorithmicCheckerSource,
  algorithmicCheckerComponents,
}) => {
  const checkerId = proof.command?.argv?.[2];
  const components = algorithmicCheckerComponents(checkerId);
  const hasComponentMetadata = components !== undefined;
  if (proof.kind !== gateCompositionKind) {
    return hasComponentMetadata
      ? [`${label}: component-bearing checker requires gateComposition proof`]
      : [];
  }
  if (!Array.isArray(components) || components.length === 0) {
    return [`${label}: gateComposition proof requires a non-empty component-bearing checker`];
  }
  const failures = [];
  if (new Set(components).size !== components.length) {
    failures.push(`${label}: gate composition components must be unique`);
  }
  for (const component of components) {
    if (!nonEmpty(component) || !hasAlgorithmicChecker(component)) {
      failures.push(`${label}: gate composition component is not registered: ${String(component)}`);
      continue;
    }
    const componentSource = algorithmicCheckerSource(component);
    if (
      !isRecord(componentSource) ||
      !nonEmpty(componentSource.path) ||
      !nonEmpty(componentSource.symbol)
    ) {
      failures.push(`${label}: gate composition component lacks source metadata: ${component}`);
      continue;
    }
    failures.push(
      ...sourceFailures({
        source: {
          kind: "live",
          path: componentSource.path,
          selector: { kind: "symbol", value: componentSource.symbol },
        },
        label: `${label}.components.${component}`,
        repoRoot,
      }),
    );
  }
  return failures;
};

const proofFailures = ({
  proof,
  source,
  rule,
  label,
  repoRoot,
  hasAlgorithmicChecker,
  algorithmicCheckerSource,
  algorithmicCheckerComponents,
}) => {
  if (!isRecord(proof)) return [`${label}: missing proof`];
  const failures = unexpectedFieldFailures({
    value: proof,
    allowed: proofFields,
    label: `${label}.proof`,
  });
  if (!proofKinds.has(proof.kind) && proof.kind !== gateCompositionKind) {
    failures.push(`${label}: unsupported proof kind ${String(proof.kind)}`);
    return failures;
  }
  failures.push(
    ...commandFailures({
      command: proof.command,
      kind: proof.kind,
      label,
      repoRoot,
      hasAlgorithmicChecker,
    }),
  );
  failures.push(
    ...sourceCommandCongruenceFailures({
      source,
      proof,
      label,
      repoRoot,
      algorithmicCheckerSource,
    }),
  );
  failures.push(...ruleAcceptanceFailures({ rule, proof, label }));
  failures.push(
    ...compositionFailures({
      proof,
      label,
      repoRoot,
      hasAlgorithmicChecker,
      algorithmicCheckerSource,
      algorithmicCheckerComponents,
    }),
  );
  if (!isRecord(proof.positive) || !nonEmpty(proof.positive.contract)) {
    failures.push(`${label}: proof requires a positive consumer contract`);
  }
  if (proof.positive?.expectedExitCode !== 0) {
    failures.push(`${label}: positive proof must expect exit code 0`);
  }
  if (
    proof.kind === "packageTest" &&
    (!Number.isInteger(proof.positive?.minPassedTests) || proof.positive.minPassedTests < 1)
  ) {
    failures.push(`${label}: package proof must require at least one passing test`);
  }
  if (!Array.isArray(proof.redCases) || proof.redCases.length === 0) {
    failures.push(`${label}: proof requires at least one executable red case`);
  } else {
    for (const [index, redCase] of proof.redCases.entries()) {
      failures.push(
        ...redCaseFailures({
          redCase,
          label: `${label}.redCases[${index}]`,
          proofKind: proof.kind,
          packageRoot: proof.command?.cwd,
        }),
      );
    }
  }
  if (!Array.isArray(proof.blindSpots) || !proof.blindSpots.every(nonEmpty)) {
    failures.push(`${label}: proof blindSpots must be an array of non-empty strings`);
  }
  return failures;
};

const guardCoverageWiringFailures = (rulesSource) => {
  const failures = [];
  const allSteps = rulesSource.commandGroups?.all;
  const guardSteps = rulesSource.commandGroups?.["guard-coverage"];
  const allReferences = Array.isArray(allSteps)
    ? allSteps.filter((step) => step?.type === "group" && step.id === "guard-coverage")
    : [];
  if (allReferences.length !== 1) {
    failures.push("commandGroups.all must include guard-coverage exactly once");
  }
  if (
    !Array.isArray(guardSteps) ||
    guardSteps.length !== 1 ||
    guardSteps[0]?.type !== "command" ||
    guardSteps[0]?.command !== "node packages/cli/src/check/check-coverage.mjs" ||
    Object.keys(guardSteps[0] ?? {}).some((key) => key !== "type" && key !== "command")
  ) {
    failures.push("commandGroups.guard-coverage must own the positive registry command");
  }
  return failures;
};

export const proofRegistryFailures = ({
  coverage,
  rulesSource,
  repoRoot,
  hasAlgorithmicChecker,
  algorithmicCheckerSource,
  algorithmicCheckerComponents,
}) => {
  if (!isRecord(coverage)) return ["check coverage must be an object"];
  if (!isRecord(rulesSource)) return ["boundary rules source must be an object"];
  const failures = unexpectedFieldFailures({
    value: coverage,
    allowed: coverageFields,
    label: "check coverage",
  });
  if (coverage.schemaVersion !== 2) failures.push("check coverage schemaVersion must be 2");
  failures.push(...guardCoverageWiringFailures(rulesSource));
  const rules = Array.isArray(rulesSource.rules) ? rulesSource.rules : [];
  const entries = Array.isArray(coverage.entries) ? coverage.entries : [];
  const byRuleId = new Map();
  for (const [index, entry] of entries.entries()) {
    failures.push(
      ...unexpectedFieldFailures({
        value: entry,
        allowed: entryFields,
        label: isRecord(entry) && nonEmpty(entry.ruleId) ? entry.ruleId : `entry[${index}]`,
      }),
    );
    const list = byRuleId.get(entry?.ruleId) ?? [];
    list.push(entry);
    byRuleId.set(entry?.ruleId, list);
  }
  if (entries.length !== rules.length) {
    failures.push(
      `check coverage must have one entry per rule: ${entries.length} != ${rules.length}`,
    );
  }

  const ruleIds = new Set();
  for (const rule of rules) {
    if (!nonEmpty(rule?.id)) {
      failures.push("boundary rule requires an id");
      continue;
    }
    if (ruleIds.has(rule.id)) failures.push(`${rule.id}: duplicate boundary rule`);
    ruleIds.add(rule.id);
  }

  for (const rule of rules) {
    if (!nonEmpty(rule?.id)) continue;
    const matches = byRuleId.get(rule.id) ?? [];
    if (matches.length !== 1) {
      failures.push(`${rule.id}: expected exactly one coverage entry`);
      continue;
    }
    const entry = matches[0];
    if (entry.owner !== rule.owner || entry.invariantId !== rule.invariantId) {
      failures.push(`${rule.id}: coverage owner and invariant must match the rule source`);
    }
    failures.push(
      ...sourceFailures({
        source: entry.source,
        label: rule.id,
        repoRoot,
      }),
    );
    failures.push(
      ...proofFailures({
        proof: entry.proof,
        source: entry.source,
        rule,
        label: rule.id,
        repoRoot,
        hasAlgorithmicChecker,
        algorithmicCheckerSource,
        algorithmicCheckerComponents,
      }),
    );
  }
  for (const ruleId of byRuleId.keys()) {
    if (!ruleIds.has(ruleId)) failures.push(`${String(ruleId)}: unknown coverage rule`);
  }
  return failures;
};
