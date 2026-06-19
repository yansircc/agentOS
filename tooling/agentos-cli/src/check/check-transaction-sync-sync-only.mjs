#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ts from "typescript";

const repoRoot = process.cwd();

const toRepoPath = (file) => path.relative(repoRoot, file).split(path.sep).join("/");

const sourceFiles = (root) => {
  const files = [];
  const visit = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (
          entry.name !== "node_modules" &&
          entry.name !== "dist" &&
          entry.name !== ".wrangler" &&
          entry.name !== ".turbo"
        ) {
          visit(file);
        }
        continue;
      }
      if (
        /\.(?:ts|tsx|mts|cts)$/.test(entry.name) &&
        !entry.name.endsWith(".d.ts") &&
        file.split(path.sep).includes("src")
      ) {
        files.push(file);
      }
    }
  };
  visit(path.join(root, "packages"));
  return files.sort((left, right) => left.localeCompare(right));
};

const nodeLabel = (sourceFile, node) => {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return `${toRepoPath(sourceFile.fileName)}:${line + 1}:${character + 1}`;
};

const unwrap = (node) => {
  let current = node;
  for (;;) {
    if (
      ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isParenthesizedExpression(current)
    ) {
      current = current.expression;
      continue;
    }
    return current;
  }
};

const propertyNameText = (name) => {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return undefined;
};

const callName = (expression) => {
  const unwrapped = unwrap(expression);
  if (ts.isIdentifier(unwrapped)) return unwrapped.text;
  if (ts.isPropertyAccessExpression(unwrapped)) return unwrapped.name.text;
  return undefined;
};

const isPromiseStaticCall = (node) =>
  ts.isCallExpression(node) &&
  ts.isPropertyAccessExpression(node.expression) &&
  ts.isIdentifier(node.expression.expression) &&
  node.expression.expression.text === "Promise";

const isThenCall = (node) =>
  ts.isCallExpression(node) &&
  ts.isPropertyAccessExpression(node.expression) &&
  node.expression.name.text === "then";

const isTimerOrMicrotaskCall = (node) => {
  if (!ts.isCallExpression(node)) return false;
  const name = callName(node.expression);
  return (
    name === "queueMicrotask" ||
    name === "setTimeout" ||
    name === "setInterval" ||
    name === "setImmediate"
  );
};

const isNewPromise = (node) =>
  ts.isNewExpression(node) &&
  ts.isIdentifier(node.expression) &&
  node.expression.text === "Promise";

const isThenableObject = (node) => {
  const unwrapped = unwrap(node);
  return (
    ts.isObjectLiteralExpression(unwrapped) &&
    unwrapped.properties.some(
      (property) =>
        (ts.isMethodDeclaration(property) || ts.isPropertyAssignment(property)) &&
        propertyNameText(property.name) === "then",
    )
  );
};

const inspectSyncOnlyFunction = (sourceFile, fn, label, failures) => {
  if (fn.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)) {
    failures.push(`${nodeLabel(sourceFile, fn)} ${label} must not be async`);
  }
  if (ts.isArrowFunction(fn) && !ts.isBlock(fn.body) && isThenableObject(fn.body)) {
    failures.push(`${nodeLabel(sourceFile, fn.body)} ${label} must not return a thenable`);
  }

  const visit = (node) => {
    if (ts.isAwaitExpression(node)) {
      failures.push(`${nodeLabel(sourceFile, node)} ${label} must not await`);
    }
    if (isThenCall(node)) {
      failures.push(
        `${nodeLabel(sourceFile, node)} ${label} must not call .then inside transaction`,
      );
    }
    if (isPromiseStaticCall(node) || isNewPromise(node)) {
      failures.push(`${nodeLabel(sourceFile, node)} ${label} must not create/use Promise`);
    }
    if (isTimerOrMicrotaskCall(node)) {
      failures.push(`${nodeLabel(sourceFile, node)} ${label} must not schedule async work`);
    }
    if (ts.isReturnStatement(node) && node.expression !== undefined) {
      const expression = unwrap(node.expression);
      if (
        isThenCall(expression) ||
        isPromiseStaticCall(expression) ||
        isNewPromise(expression) ||
        isThenableObject(expression)
      ) {
        failures.push(`${nodeLabel(sourceFile, node)} ${label} must not return a thenable`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(fn.body);
};

const inlineFunction = (node) => {
  const unwrapped = unwrap(node);
  return ts.isArrowFunction(unwrapped) || ts.isFunctionExpression(unwrapped) ? unwrapped : null;
};

const inspectTransactionBuilderArg = (sourceFile, arg, label, failures) => {
  const fn = inlineFunction(arg);
  if (fn === null) {
    failures.push(`${nodeLabel(sourceFile, arg)} ${label} must use an inline sync builder`);
    return;
  }
  inspectSyncOnlyFunction(sourceFile, fn, label, failures);
};

const objectLiteralProperties = (node) => {
  const unwrapped = unwrap(node);
  if (!ts.isObjectLiteralExpression(unwrapped)) return new Map();
  const properties = new Map();
  for (const property of unwrapped.properties) {
    if (!ts.isPropertyAssignment(property) && !ts.isMethodDeclaration(property)) continue;
    const name = propertyNameText(property.name);
    if (name !== undefined) properties.set(name, property);
  }
  return properties;
};

const isDurableTriggerObject = (node) => {
  const properties = objectLiteralProperties(node);
  return (
    properties.has("kind") &&
    properties.has("intentEventKind") &&
    properties.has("parseIntent") &&
    properties.has("acquire") &&
    properties.has("commit") &&
    properties.has("commitCancelled")
  );
};

const inspectDurableTriggerCommit = (sourceFile, node, failures) => {
  if (!isDurableTriggerObject(node)) return;
  const properties = objectLiteralProperties(node);
  for (const name of ["commit", "commitCancelled"]) {
    const property = properties.get(name);
    if (property === undefined) continue;
    if (ts.isMethodDeclaration(property)) {
      inspectSyncOnlyFunction(sourceFile, property, `durable trigger ${name}`, failures);
      continue;
    }
    const fn = inlineFunction(property.initializer);
    if (fn === null) {
      failures.push(`${nodeLabel(sourceFile, property)} durable trigger ${name} must be inline`);
      continue;
    }
    inspectSyncOnlyFunction(sourceFile, fn, `durable trigger ${name}`, failures);
  }
};

const collectFailuresForFiles = (files) => {
  const failures = [];
  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const visit = (node) => {
      if (ts.isCallExpression(node)) {
        const name = callName(node.expression);
        if (name === "transactionSync") {
          const builder = node.arguments[0];
          if (builder === undefined) {
            failures.push(`${nodeLabel(sourceFile, node)} transactionSync requires a builder`);
          } else {
            inspectTransactionBuilderArg(sourceFile, builder, "transactionSync builder", failures);
          }
        }
        if (name === "commitLedgerTransaction") {
          const builder = node.arguments[3];
          if (builder === undefined) {
            failures.push(
              `${nodeLabel(sourceFile, node)} commitLedgerTransaction requires a builder`,
            );
          } else {
            inspectTransactionBuilderArg(
              sourceFile,
              builder,
              "commitLedgerTransaction builder",
              failures,
            );
          }
        }
      }
      if (ts.isObjectLiteralExpression(node)) {
        inspectDurableTriggerCommit(sourceFile, node, failures);
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return failures;
};

const writeFixture = (root, name, source) => {
  const file = path.join(root, "packages/backend/src", name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, source);
  return file;
};

const selfTest = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentos-transaction-sync-"));
  try {
    const good = writeFixture(
      root,
      "good.ts",
      `
        transactionSync(() => ({ ok: true }));
        commitLedgerTransaction(ctx, bus, owner, (tx) => {
          tx.afterInsert(() => undefined);
        });
        const extension = { commit: async () => ({ id: 1 }) };
      `,
    );
    const bad = writeFixture(
      root,
      "bad.ts",
      `
        const write = () => undefined;
        transactionSync(write);
        transactionSync(async () => undefined);
        transactionSync(() => Promise.resolve());
        transactionSync(() => ({ then() {} }));
        transactionSync(() => {
          Promise.resolve();
          new Promise(() => undefined);
          queueMicrotask(() => undefined);
          setTimeout(() => undefined, 1);
          value.then(() => undefined);
        });
        commitLedgerTransaction(ctx, bus, owner, (tx) => {
          tx.afterInsert(() => Promise.resolve());
        });
        const trigger = {
          kind: "test.trigger",
          intentEventKind: "test.requested",
          parseIntent: () => ({ ok: true, intent: {} }),
          acquire: () => Effect.succeed({}),
          commit: async () => undefined,
          commitCancelled: () => Promise.resolve()
        };
      `,
    );

    const goodFailures = collectFailuresForFiles([good]);
    if (goodFailures.length > 0) {
      return [`self-test good fixture failed: ${JSON.stringify(goodFailures)}`];
    }
    const badFailures = collectFailuresForFiles([bad]);
    const expected = [
      "must use an inline sync builder",
      "must not be async",
      "must not create/use Promise",
      "must not return a thenable",
      "must not schedule async work",
      "must not call .then inside transaction",
      "durable trigger commit must not be async",
      "durable trigger commitCancelled must not create/use Promise",
    ];
    return expected
      .filter((needle) => !badFailures.some((failure) => failure.includes(needle)))
      .map((needle) => `self-test bad fixture did not report ${needle}: ${badFailures.join("; ")}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
};

const failures = process.argv.includes("--self-test")
  ? selfTest()
  : collectFailuresForFiles(sourceFiles(repoRoot));

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(
  process.argv.includes("--self-test")
    ? "transactionSync sync-only self-test passed"
    : "transactionSync sync-only gate passed",
);
