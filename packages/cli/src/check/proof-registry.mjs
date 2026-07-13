import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import ts from "typescript";

const proofKinds = new Set([
  "algorithmic",
  "generatedProjection",
  "packageTest",
  "gateComposition",
]);

// CST #478 deletes this freeze while atomically cutting authority to the positive registry.
const phaseOTransitionActions = new Map([
  ["boundaries", "retire"],
  ["d12-a155-substrate-absorption", "retire"],
  ["convergence-boundary", "gateComposition"],
]);

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const nonEmpty = (value) => typeof value === "string" && value.trim().length > 0;
const safeRelativePath = (value) =>
  nonEmpty(value) &&
  !path.isAbsolute(value) &&
  !value.split(/[\\/]/u).some((part) => part === ".." || part.length === 0);

const repoPath = (...segments) => path.posix.normalize(path.posix.join(...segments));

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

const parseJsonPointer = (value) => {
  if (typeof value !== "string") return undefined;
  if (value === "") return [];
  if (!value.startsWith("/")) return undefined;
  const tokens = value.slice(1).split("/");
  if (tokens.some((token) => /~(?:[^01]|$)/u.test(token))) return undefined;
  return tokens.map((token) => token.replaceAll("~1", "/").replaceAll("~0", "~"));
};

const resolveJsonPointer = (document, tokens) => {
  let current = document;
  for (const token of tokens) {
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9][0-9]*)$/u.test(token) || !Object.hasOwn(current, token)) {
        return { found: false };
      }
    } else if (!isRecord(current) || !Object.hasOwn(current, token)) {
      return { found: false };
    }
    current = current[token];
  }
  return { found: true, value: current };
};

const sourceSelectorFailures = ({ source, absolute, label, expectedJsonPointerId }) => {
  const selector = source.selector;
  const valueIsValid =
    isRecord(selector) &&
    (selector.kind === "jsonPointer"
      ? typeof selector.value === "string"
      : nonEmpty(selector.value));
  if (!isRecord(selector) || !nonEmpty(selector.kind) || !valueIsValid) {
    return [`${label}: live source requires a positive selector`];
  }
  if (selector.kind === "module") return [];
  const content = fs.readFileSync(absolute, "utf8");
  if (selector.kind === "jsonPointer") {
    let document;
    try {
      document = JSON.parse(content);
    } catch {
      return [`${label}: JSON pointer selector requires JSON source`];
    }
    const tokens = parseJsonPointer(selector.value);
    if (tokens === undefined) return [`${label}: invalid JSON pointer selector syntax`];
    const resolved = resolveJsonPointer(document, tokens);
    if (!resolved.found) return [`${label}: JSON pointer selector is absent`];
    if (
      expectedJsonPointerId !== undefined &&
      (!isRecord(resolved.value) || resolved.value.id !== expectedJsonPointerId)
    ) {
      return [`${label}: JSON pointer selector must resolve to rule ${expectedJsonPointerId}`];
    }
    return [];
  }
  if (selector.kind !== "symbol" && selector.kind !== "test") {
    return [`${label}: unknown live source selector kind ${selector.kind}`];
  }

  const ast = ts.createSourceFile(source.path, content, ts.ScriptTarget.Latest, true);
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
  return found ? [] : [`${label}: live source selector is absent: ${selector.value}`];
};

const sourceFailures = ({ source, label, repoRoot, expectedJsonPointerId }) => {
  if (!isRecord(source)) return [`${label}: source must be an object`];
  if (
    expectedJsonPointerId !== undefined &&
    (source.kind !== "live" ||
      source.path !== "docs/agent/boundary-rules.source.json" ||
      source.selector?.kind !== "jsonPointer")
  ) {
    return [
      `${label}: retiring rule source must be its matching docs/agent/boundary-rules.source.json object via JSON Pointer`,
    ];
  }
  if (source.kind === "live") {
    if (!safeRelativePath(source.path)) return [`${label}: live source path must be repo-relative`];
    const absolute = path.join(repoRoot, source.path);
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
      return [`${label}: live proof source does not exist: ${source.path}`];
    }
    return sourceSelectorFailures({ source, absolute, label, expectedJsonPointerId });
  }
  if (source.kind === "historical") {
    const failures = [];
    if (!/^[0-9a-f]{40}$/u.test(source.commit ?? "")) {
      failures.push(`${label}: historical source commit must be a full SHA`);
    }
    if (!safeRelativePath(source.path)) {
      failures.push(`${label}: historical source path must be repo-relative`);
    }
    if (!nonEmpty(source.supersededBy)) {
      failures.push(`${label}: historical source requires supersededBy`);
    }
    if (failures.length === 0) {
      try {
        execFileSync("git", ["cat-file", "-e", `${source.commit}:${source.path}`], {
          cwd: repoRoot,
          stdio: "ignore",
        });
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
  if (rest[0] === "--config") {
    if (!safeRelativePath(rest[1])) {
      return { failures: [`${label}: package test config must be repo-relative`] };
    }
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
  return {
    failures: [],
    entrypoint: repoPath(command.cwd, rest[0]),
    selector: rest[2],
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
    if (
      expected === undefined ||
      source.kind !== "live" ||
      source.path !== expected.path ||
      source.selector?.kind !== "symbol" ||
      source.selector.value !== expected.symbol
    ) {
      return [`${label}: algorithmic source must match the registered checker path and symbol`];
    }
    if (source.entrypoint !== undefined) {
      return [`${label}: algorithmic source must not declare a package-test entrypoint`];
    }
    return [];
  }
  if (proof.kind === "generatedProjection") {
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

const proofFailures = ({
  proof,
  source,
  target,
  label,
  repoRoot,
  hasAlgorithmicChecker,
  algorithmicCheckerSource,
  algorithmicCheckerComponents,
}) => {
  if (!isRecord(proof)) return [`${label}: missing proof`];
  if (proof.kind === "unsupported") {
    if (!nonEmpty(proof.reason)) {
      return [`${label}: unsupported proof requires a reason`];
    }
    return [];
  }
  if (!proofKinds.has(proof.kind))
    return [`${label}: unsupported proof kind ${String(proof.kind)}`];
  const failures = commandFailures({
    command: proof.command,
    kind: proof.kind,
    label,
    repoRoot,
    hasAlgorithmicChecker,
  });
  failures.push(
    ...sourceCommandCongruenceFailures({
      source,
      proof,
      label,
      repoRoot,
      algorithmicCheckerSource,
    }),
  );
  const checkerId = proof.command?.argv?.[2];
  const proofTarget =
    proof.kind === "algorithmic" || proof.kind === "gateComposition"
      ? { kind: "algorithmic", ruleId: label, checker: checkerId }
      : proof.kind === "generatedProjection"
        ? { kind: "manifestRule", ruleId: label, engine: "generatedProjection" }
        : proof.kind === "packageTest"
          ? { kind: "proofClass", ruleId: label }
          : undefined;
  const targetMatches = proofTarget !== undefined && isDeepStrictEqual(target, proofTarget);
  if (!targetMatches) {
    if (
      !isRecord(proof.targetTransition) ||
      !isDeepStrictEqual(proof.targetTransition.from, target) ||
      !isDeepStrictEqual(proof.targetTransition.to, proofTarget) ||
      proof.targetTransition.cutoverTask !== 478
    ) {
      failures.push(`${label}: target transition must bind exact from/to targets at CST #478`);
    }
  } else if (proof.targetTransition !== undefined) {
    failures.push(`${label}: targetTransition is allowed only for a real legacy target mismatch`);
  }
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

export const proofRegistryFailures = ({
  coverage,
  rulesSource,
  repoRoot,
  hasAlgorithmicChecker,
  algorithmicCheckerSource,
  algorithmicCheckerComponents,
}) => {
  const failures = [];
  if (coverage.schemaVersion !== 2) failures.push("check coverage schemaVersion must be 2");
  if (
    coverage.transition?.authority !== "legacy-boundary-rules-through-cst-478" ||
    !nonEmpty(coverage.transition?.removalCondition)
  ) {
    failures.push("check coverage transition must bind the #478 authority cut");
  }
  const ruleActions = Array.isArray(coverage.transition?.ruleActions)
    ? coverage.transition.ruleActions
    : [];
  const actionByRuleId = new Map();
  for (const [index, action] of ruleActions.entries()) {
    const actionLabel = `transition.ruleActions[${index}]`;
    if (
      !isRecord(action) ||
      !nonEmpty(action.ruleId) ||
      (action.action !== "retire" && action.action !== "gateComposition") ||
      action.cutoverTask !== 478
    ) {
      failures.push(
        `${actionLabel}: action must bind one rule to retire or gateComposition at #478`,
      );
      continue;
    }
    if (action.action === "retire" && !nonEmpty(action.removalCondition)) {
      failures.push(`${actionLabel}: retiring rule requires a removal condition`);
    }
    if (actionByRuleId.has(action.ruleId)) {
      failures.push(`${actionLabel}: duplicate rule transition ${action.ruleId}`);
    }
    actionByRuleId.set(action.ruleId, action);
  }
  for (const [ruleId, expectedAction] of phaseOTransitionActions) {
    if (actionByRuleId.get(ruleId)?.action !== expectedAction) {
      failures.push(
        `${ruleId}: Phase O transition action must remain ${expectedAction} through CST #478`,
      );
    }
  }
  for (const ruleId of actionByRuleId.keys()) {
    if (!phaseOTransitionActions.has(ruleId)) {
      failures.push(`${ruleId}: Phase O transition action is not authorized before CST #478`);
    }
  }
  const rules = Array.isArray(rulesSource.rules) ? rulesSource.rules : [];
  const entries = Array.isArray(coverage.entries) ? coverage.entries : [];
  const byRuleId = new Map();
  for (const entry of entries) {
    const list = byRuleId.get(entry?.ruleId) ?? [];
    list.push(entry);
    byRuleId.set(entry?.ruleId, list);
  }
  if (entries.length !== rules.length) {
    failures.push(
      `check coverage must have one entry per rule: ${entries.length} != ${rules.length}`,
    );
  }

  for (const rule of rules) {
    const matches = byRuleId.get(rule.id) ?? [];
    if (matches.length !== 1) {
      failures.push(`${rule.id}: expected exactly one coverage entry`);
      continue;
    }
    const entry = matches[0];
    if (entry.owner !== rule.owner || entry.invariantId !== rule.invariantId) {
      failures.push(`${rule.id}: coverage owner and invariant must match the rule source`);
    }
    const action = phaseOTransitionActions.get(rule.id);
    failures.push(
      ...sourceFailures({
        source: entry.source,
        label: rule.id,
        repoRoot,
        expectedJsonPointerId: action === "retire" ? rule.id : undefined,
      }),
    );
    failures.push(
      ...proofFailures({
        proof: entry.proof,
        source: entry.source,
        target: entry.target,
        label: rule.id,
        repoRoot,
        hasAlgorithmicChecker,
        algorithmicCheckerSource,
      }),
    );
    if ((action === "retire") !== (entry.proof?.kind === "unsupported")) {
      failures.push(`${rule.id}: unsupported proof must derive from a retiring rule transition`);
    }
    if ((action === "gateComposition") !== (entry.proof?.kind === "gateComposition")) {
      failures.push(`${rule.id}: gate composition proof must derive from its rule transition`);
    }
    if (
      entry.proof?.kind === "gateComposition" &&
      !Array.isArray(algorithmicCheckerComponents(entry.proof.command?.argv?.[2]))
    ) {
      failures.push(`${rule.id}: gate composition checker must own its component list`);
    }
  }
  for (const ruleId of byRuleId.keys()) {
    if (!rules.some((rule) => rule.id === ruleId))
      failures.push(`${String(ruleId)}: unknown coverage rule`);
  }
  for (const ruleId of actionByRuleId.keys()) {
    if (!rules.some((rule) => rule.id === ruleId)) {
      failures.push(`${ruleId}: transition references unknown rule`);
    }
  }
  return failures;
};
