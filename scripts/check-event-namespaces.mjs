#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ts from "typescript";

const repoRoot = process.cwd();
const sourceRoots = ["packages"];
const writerNames = new Set(["append", "insertEvent", "logLedgerEvent", "commit", "commitEvents"]);

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
  for (const sourceRoot of sourceRoots) visit(path.join(root, sourceRoot));
  return files.sort((left, right) => left.localeCompare(right));
};

const localConstants = (sourceFile) => {
  const constants = new Map();
  const record = (name, initializer) => {
    if (initializer === undefined) return;
    if (ts.isStringLiteralLike(initializer)) {
      constants.set(name, initializer.text);
      return;
    }
    if (ts.isNoSubstitutionTemplateLiteral(initializer)) {
      constants.set(name, initializer.text);
    }
  };

  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name)) record(declaration.name.text, declaration.initializer);
    }
  }
  return constants;
};

const unwrapExpression = (node) => {
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

const sourcePackageRoot = (file) => {
  const relative = toRepoPath(file);
  const parts = relative.split("/");
  if (parts[0] !== "packages" || parts.length < 3) return path.dirname(file);
  if (parts[1].startsWith("@")) return path.join(repoRoot, parts[0], parts[1], parts[2]);
  return path.join(repoRoot, parts[0], parts[1], parts[2]);
};

const literalValue = (node, constants) => {
  node = unwrapExpression(node);
  if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isIdentifier(node)) return constants.get(node.text);
  if (ts.isTemplateExpression(node)) {
    let out = node.head.text;
    for (const span of node.templateSpans) {
      const value = literalValue(span.expression, constants);
      if (value === undefined) return undefined;
      out += value + span.literal.text;
    }
    return out;
  }
  return undefined;
};

const propertyNameText = (name, constants) => {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  if (ts.isComputedPropertyName(name)) return literalValue(name.expression, constants);
  return undefined;
};

const objectProperty = (object, name, constants) => {
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    if (propertyNameText(property.name, constants) === name) return property.initializer;
  }
  return undefined;
};

const objectLiteral = (node) => {
  if (node === undefined) return undefined;
  const unwrapped = unwrapExpression(node);
  return ts.isObjectLiteralExpression(unwrapped) ? unwrapped : undefined;
};

const collectObjectStringValues = (node, constants, out) => {
  if (node === undefined) return;
  node = unwrapExpression(node);
  if (ts.isObjectLiteralExpression(node)) {
    for (const property of node.properties) {
      if (!ts.isPropertyAssignment(property)) continue;
      collectObjectStringValues(property.initializer, constants, out);
    }
    return;
  }
  if (ts.isArrayLiteralExpression(node)) {
    for (const element of node.elements) collectObjectStringValues(element, constants, out);
    return;
  }
  const value = literalValue(node, constants);
  if (value !== undefined) out.push(value);
};

const packageVocabulary = (parsed) => {
  const byPackage = new Map();
  for (const { file, sourceFile } of parsed) {
    const packageRoot = sourcePackageRoot(file);
    const values = byPackage.get(packageRoot) ?? [];
    const constants = localConstants(sourceFile);
    for (const statement of sourceFile.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      for (const declaration of statement.declarationList.declarations) {
        collectObjectStringValues(declaration.initializer, constants, values);
      }
    }
    byPackage.set(packageRoot, values);
  }
  return byPackage;
};

const arrayLiteralStrings = (node, constants) => {
  if (!node || !ts.isArrayLiteralExpression(node)) return [];
  return node.elements.flatMap((element) => {
    const value = literalValue(element, constants);
    return value === undefined ? [] : [value];
  });
};

const variableArrayStrings = (sourceFile, name) => {
  const constants = localConstants(sourceFile);
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== name) continue;
      return arrayLiteralStrings(unwrapExpression(declaration.initializer), constants);
    }
  }
  return [];
};

const ownedProtocolEvents = (sourceFile, prefixes) => {
  const values = [];
  const constants = localConstants(sourceFile);
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      collectObjectStringValues(declaration.initializer, constants, values);
    }
  }
  return values.filter((value) => prefixes.some((prefix) => value.startsWith(prefix)));
};

const carrierEventKinds = (eventsNode, prefix, constants) => {
  const events = objectLiteral(eventsNode);
  if (!events) return [];
  const kinds = [];
  for (const property of events.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const call = property.initializer;
    if (!ts.isCallExpression(call)) continue;
    const spec = objectLiteral(call.arguments[0]);
    if (!spec) continue;
    const kindNode = objectProperty(spec, "kind", constants);
    const suffix = kindNode === undefined ? undefined : literalValue(kindNode, constants);
    if (suffix !== undefined) kinds.push(`${prefix}${suffix}`);
  }
  return kinds;
};

const boundaryEventKinds = (eventsNode, constants) => {
  const events = objectLiteral(eventsNode);
  if (!events) return [];
  return events.properties.flatMap((property) => {
    if (!ts.isPropertyAssignment(property)) return [];
    const key = propertyNameText(property.name, constants);
    return key === undefined ? [] : [key];
  });
};

const collectDeclarations = (sourceFile, filePath, vocabularyByPackage) => {
  const constants = localConstants(sourceFile);
  const declarations = [];

  const visit = (node) => {
    if (ts.isReturnStatement(node)) {
      const spec = objectLiteral(node.expression);
      if (spec) {
        const packageIdNode = objectProperty(spec, "packageId", constants);
        const prefixesNode = objectProperty(spec, "kindPrefixes", constants);
        const versionNode = objectProperty(spec, "version", constants);
        const packageId =
          packageIdNode === undefined ? undefined : literalValue(packageIdNode, constants);
        const prefixes = arrayLiteralStrings(prefixesNode, constants);
        const version =
          versionNode === undefined ? undefined : literalValue(versionNode, constants);
        if (packageId !== undefined && version !== undefined && prefixes.length > 0) {
          const packageValues = vocabularyByPackage.get(sourcePackageRoot(filePath)) ?? [];
          declarations.push({
            owner: packageId,
            filePath,
            prefixes,
            events: packageValues.filter((value) =>
              prefixes.some((prefix) => value.startsWith(prefix)),
            ),
          });
        }
      }
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const callName = node.expression.text;
      if (callName === "defineCarrier") {
        const spec = objectLiteral(node.arguments[0]);
        if (spec) {
          const packageIdNode = objectProperty(spec, "packageId", constants);
          const prefixNode = objectProperty(spec, "prefix", constants);
          const eventsNode = objectProperty(spec, "events", constants);
          const packageId =
            packageIdNode === undefined
              ? "unknown carrier"
              : literalValue(packageIdNode, constants);
          const prefix = prefixNode === undefined ? undefined : literalValue(prefixNode, constants);
          if (prefix !== undefined) {
            declarations.push({
              owner: packageId ?? "unknown carrier",
              filePath,
              prefixes: [prefix],
              events: carrierEventKinds(eventsNode, prefix, constants),
            });
          }
        }
      }
      if (callName === "defineBoundaryContract") {
        const spec = objectLiteral(node.arguments[0]);
        if (spec) {
          const packageIdNode = objectProperty(spec, "packageId", constants);
          const prefixesNode = objectProperty(spec, "kindPrefixes", constants);
          const eventsNode = objectProperty(spec, "events", constants);
          const packageId =
            packageIdNode === undefined
              ? "unknown boundary"
              : literalValue(packageIdNode, constants);
          const prefixes = arrayLiteralStrings(prefixesNode, constants);
          if (prefixes.length > 0) {
            declarations.push({
              owner: packageId ?? "unknown boundary",
              filePath,
              prefixes,
              events: boundaryEventKinds(eventsNode, constants),
            });
          }
        }
      }
      if (callName === "eventNamespace") {
        const spec = objectLiteral(node.arguments[0]);
        if (spec) {
          const packageIdNode = objectProperty(spec, "packageId", constants);
          const prefixesNode = objectProperty(spec, "kindPrefixes", constants);
          const packageId =
            packageIdNode === undefined
              ? "unknown namespace"
              : literalValue(packageIdNode, constants);
          const prefixes = arrayLiteralStrings(prefixesNode, constants);
          if (prefixes.length > 0) {
            const packageValues = vocabularyByPackage.get(sourcePackageRoot(filePath)) ?? [];
            declarations.push({
              owner: packageId ?? "unknown namespace",
              filePath,
              prefixes,
              events: packageValues.filter((value) =>
                prefixes.some((prefix) => value.startsWith(prefix)),
              ),
            });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return declarations;
};

const collectReservedDeclarations = (parsed) => {
  const kernel = parsed.find(({ file }) =>
    file.endsWith(path.join("packages", "kernel", "src", "errors.ts")),
  );
  const backendProtocol = parsed.find(({ file }) =>
    file.endsWith(path.join("packages", "backends", "protocol", "src", "index.ts")),
  );
  const backendPrefixes =
    backendProtocol === undefined
      ? []
      : variableArrayStrings(backendProtocol.sourceFile, "BACKEND_PROTOCOL_EVENT_PREFIXES");
  const corePrefixes =
    kernel === undefined ? [] : variableArrayStrings(kernel.sourceFile, "CORE_CLAIMED_PREFIXES");
  const backendPrefixSet = new Set(backendPrefixes);
  const coreOwnedPrefixes = corePrefixes.filter((prefix) => !backendPrefixSet.has(prefix));
  const coreEvents = parsed.flatMap(({ sourceFile }) =>
    ownedProtocolEvents(sourceFile, coreOwnedPrefixes),
  );
  return [
    ...(kernel === undefined
      ? []
      : [
          {
            owner: "@agent-os/runtime-protocol",
            filePath: kernel.file,
            prefixes: coreOwnedPrefixes,
            events: coreEvents,
          },
        ]),
    ...(backendProtocol === undefined
      ? []
      : [
          {
            owner: "@agent-os/backend-protocol",
            filePath: backendProtocol.file,
            prefixes: backendPrefixes,
            events: ownedProtocolEvents(backendProtocol.sourceFile, backendPrefixes),
          },
        ]),
  ];
};

const isWriterCall = (call) => {
  const expression = call.expression;
  if (ts.isPropertyAccessExpression(expression)) return writerNames.has(expression.name.text);
  if (ts.isIdentifier(expression)) return writerNames.has(expression.text);
  return false;
};

const collectKindObjects = (node, out) => {
  if (ts.isObjectLiteralExpression(node)) {
    const kindProperty = node.properties.find(
      (property) =>
        ts.isPropertyAssignment(property) &&
        (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name)) &&
        property.name.text === "kind",
    );
    if (kindProperty !== undefined && ts.isPropertyAssignment(kindProperty)) {
      out.push(kindProperty.initializer);
    }
    const eventProperty = node.properties.find(
      (property) =>
        ts.isPropertyAssignment(property) &&
        (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name)) &&
        property.name.text === "event",
    );
    if (eventProperty !== undefined && ts.isPropertyAssignment(eventProperty)) {
      out.push(eventProperty.initializer);
    }
  }
  if (ts.isArrayLiteralExpression(node)) {
    for (const element of node.elements) collectKindObjects(element, out);
  }
};

const lineAndColumn = (sourceFile, node) => {
  const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return { line: pos.line + 1, column: pos.character + 1 };
};

const collectWriterKinds = (sourceFile, filePath) => {
  const constants = localConstants(sourceFile);
  const writes = [];
  const visit = (node) => {
    if (ts.isCallExpression(node) && isWriterCall(node)) {
      const kindNodes = [];
      for (const argument of node.arguments) collectKindObjects(argument, kindNodes);
      for (const kindNode of kindNodes) {
        const kind = literalValue(kindNode, constants);
        if (kind === undefined) continue;
        const position = lineAndColumn(sourceFile, kindNode);
        writes.push({ filePath, kind, line: position.line, column: position.column });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return writes;
};

const collectNamespaceFailures = (root) => {
  const files = sourceFiles(root);
  const parsed = files.map((file) => ({
    file,
    sourceFile: ts.createSourceFile(
      file,
      fs.readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    ),
  }));
  const vocabularyByPackage = packageVocabulary(parsed);
  const declarations = [
    ...collectReservedDeclarations(parsed),
    ...parsed.flatMap(({ file, sourceFile }) =>
      collectDeclarations(sourceFile, file, vocabularyByPackage),
    ),
  ].filter((declaration) => declaration.prefixes.length > 0);
  const owners = declarations.flatMap((declaration) =>
    declaration.prefixes.map((prefix) => ({
      prefix,
      owner: declaration.owner,
      filePath: declaration.filePath,
      declared: new Set(declaration.events),
    })),
  );
  const writes = parsed.flatMap(({ file, sourceFile }) => collectWriterKinds(sourceFile, file));
  const failures = [];

  for (let leftIndex = 0; leftIndex < owners.length; leftIndex++) {
    const left = owners[leftIndex];
    for (let rightIndex = leftIndex + 1; rightIndex < owners.length; rightIndex++) {
      const right = owners[rightIndex];
      if (!left.prefix.startsWith(right.prefix) && !right.prefix.startsWith(left.prefix)) continue;
      if (left.owner === right.owner && left.prefix === right.prefix) {
        failures.push(
          `${toRepoPath(left.filePath)} and ${toRepoPath(right.filePath)} duplicate owner ${
            left.owner
          } prefix ${JSON.stringify(left.prefix)}`,
        );
        continue;
      }
      if (left.owner !== right.owner) {
        failures.push(
          `${toRepoPath(left.filePath)}:${left.owner} prefix ${JSON.stringify(
            left.prefix,
          )} overlaps ${toRepoPath(right.filePath)}:${right.owner} prefix ${JSON.stringify(
            right.prefix,
          )}`,
        );
      }
    }
  }

  for (const write of writes) {
    const owner = owners.find((candidate) => write.kind.startsWith(candidate.prefix));
    if (owner === undefined) continue;
    if (owner.declared.has(write.kind)) continue;
    failures.push(
      `${toRepoPath(write.filePath)}:${write.line}:${write.column}: ${JSON.stringify(
        write.kind,
      )} writes under ${owner.owner} owned prefix ${JSON.stringify(
        owner.prefix,
      )} but is not declared by ${toRepoPath(owner.filePath)}`,
    );
  }
  return failures;
};

const collectSelfTestFailures = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentos-event-ns-"));
  try {
    fs.mkdirSync(path.join(root, "packages/kernel/src"), { recursive: true });
    fs.mkdirSync(path.join(root, "packages/backends/protocol/src"), { recursive: true });
    fs.mkdirSync(path.join(root, "packages/owner/src"), { recursive: true });
    fs.mkdirSync(path.join(root, "packages/writer/src"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "packages/kernel/src/errors.ts"),
      `
export const CORE_CLAIMED_PREFIXES = ["agent.", "resource."] as const;
`,
    );
    fs.writeFileSync(
      path.join(root, "packages/backends/protocol/src/index.ts"),
      `
export const BACKEND_PROTOCOL_EVENT_PREFIXES = ["dispatch."] as const;
export const DISPATCH_EVENT_KINDS = { REQUESTED: "dispatch.outbound.requested" } as const;
`,
    );
    fs.writeFileSync(
      path.join(root, "packages/owner/src/extension.ts"),
      `
import { eventNamespace } from "@agent-os/kernel/extensions";
const OWNED = "owned.";
export const OWNED_EVENTS = {
  GOOD: \`\${OWNED}good\`
} as const;
export const owner = eventNamespace({
  packageId: "@agent-os/owner",
  kindPrefixes: [OWNED, "resource."],
  version: "0.1.0"
});
`,
    );
    fs.writeFileSync(
      path.join(root, "packages/writer/src/index.ts"),
      `
tx.append({ kind: "owned.good", scope: "ok", payload: {} });
tx.append({ kind: "owned.bad", scope: "bad", payload: {} });
tx.append({ kind: "other.bad", scope: "ok", payload: {} });
`,
    );
    const failures = collectNamespaceFailures(root);
    if (
      failures.filter((failure) => failure.includes('"owned.bad"')).length !== 1 ||
      !failures.some((failure) => failure.includes('"resource."'))
    ) {
      return [
        `event namespace self-test expected owned.bad and resource overlap failures; observed=${JSON.stringify(
          failures,
        )}`,
      ];
    }
    return [];
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
};

const selfTest = process.argv.includes("--self-test");
const failures = selfTest ? collectSelfTestFailures() : collectNamespaceFailures(repoRoot);

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(
  selfTest ? "event namespace gate self-test passed" : "event namespace ownership gate passed",
);
