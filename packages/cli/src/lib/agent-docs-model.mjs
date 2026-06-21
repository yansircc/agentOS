import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { sourceTsdocRecordsForPackage } from "./public-api-model.mjs";

const repoRoot = process.cwd();
const sourceRoots = ["packages"];
const writerNames = new Set(["append", "insertEvent", "logLedgerEvent", "commit", "commitEvents"]);
const runtimeProtocolOwnerId = "@agent-os/runtime-protocol";
const backendProtocolOwnerId = "@agent-os/backend-protocol";

const toRepoPath = (file) =>
  (path.isAbsolute(file) ? path.relative(repoRoot, file) : file).split(path.sep).join("/");

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

const variableNamespaceDeclarations = (sourceFile, name) => {
  const constants = localConstants(sourceFile);
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== name) continue;
      const initializer = unwrapExpression(declaration.initializer);
      if (!initializer || !ts.isArrayLiteralExpression(initializer)) return [];
      return initializer.elements.flatMap((element) => {
        const namespace = objectLiteral(element);
        if (namespace === undefined) return [];
        const ownerId = literalValue(objectProperty(namespace, "ownerId", constants), constants);
        const prefixesNode = objectProperty(namespace, "kindPrefixes", constants);
        const prefixes = arrayLiteralStrings(
          prefixesNode === undefined ? undefined : unwrapExpression(prefixesNode),
          constants,
        );
        return ownerId === undefined || prefixes.length === 0 ? [] : [{ owner: ownerId, prefixes }];
      });
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
        const ownerIdNode = objectProperty(spec, "ownerId", constants);
        const prefixesNode = objectProperty(spec, "kindPrefixes", constants);
        const versionNode = objectProperty(spec, "version", constants);
        const ownerId =
          ownerIdNode === undefined ? undefined : literalValue(ownerIdNode, constants);
        const prefixes = arrayLiteralStrings(prefixesNode, constants);
        const version =
          versionNode === undefined ? undefined : literalValue(versionNode, constants);
        if (ownerId !== undefined && version !== undefined && prefixes.length > 0) {
          const packageValues = vocabularyByPackage.get(sourcePackageRoot(filePath)) ?? [];
          declarations.push({
            owner: ownerId,
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
          const ownerIdNode = objectProperty(spec, "ownerId", constants);
          const prefixNode = objectProperty(spec, "prefix", constants);
          const eventsNode = objectProperty(spec, "events", constants);
          const ownerId =
            ownerIdNode === undefined ? "unknown carrier" : literalValue(ownerIdNode, constants);
          const prefix = prefixNode === undefined ? undefined : literalValue(prefixNode, constants);
          if (prefix !== undefined) {
            declarations.push({
              owner: ownerId ?? "unknown carrier",
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
          const ownerIdNode = objectProperty(spec, "ownerId", constants);
          const prefixesNode = objectProperty(spec, "kindPrefixes", constants);
          const eventsNode = objectProperty(spec, "events", constants);
          const ownerId =
            ownerIdNode === undefined ? "unknown boundary" : literalValue(ownerIdNode, constants);
          const prefixes = arrayLiteralStrings(prefixesNode, constants);
          if (prefixes.length > 0) {
            declarations.push({
              owner: ownerId ?? "unknown boundary",
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
          const ownerIdNode = objectProperty(spec, "ownerId", constants);
          const prefixesNode = objectProperty(spec, "kindPrefixes", constants);
          const ownerId =
            ownerIdNode === undefined ? "unknown namespace" : literalValue(ownerIdNode, constants);
          const prefixes = arrayLiteralStrings(prefixesNode, constants);
          if (prefixes.length > 0) {
            const packageValues = vocabularyByPackage.get(sourcePackageRoot(filePath)) ?? [];
            declarations.push({
              owner: ownerId ?? "unknown namespace",
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
    file.endsWith(path.join("packages", "core", "src", "errors.ts")),
  );
  const backendProtocol = parsed.find(({ file }) =>
    file.endsWith(path.join("packages", "core", "src", "backend-protocol", "index.ts")),
  );
  const namespaceDeclarations =
    kernel === undefined
      ? []
      : variableNamespaceDeclarations(kernel.sourceFile, "CORE_CLAIMED_EVENT_NAMESPACES");
  const backendPrefixes =
    namespaceDeclarations.find((namespace) => namespace.owner === backendProtocolOwnerId)
      ?.prefixes ??
    (backendProtocol === undefined
      ? []
      : variableArrayStrings(backendProtocol.sourceFile, "BACKEND_PROTOCOL_EVENT_PREFIXES"));
  const coreNamespaces =
    namespaceDeclarations.length === 0
      ? [
          {
            owner: runtimeProtocolOwnerId,
            prefixes:
              kernel === undefined
                ? []
                : variableArrayStrings(kernel.sourceFile, "CORE_CLAIMED_PREFIXES").filter(
                    (prefix) => !new Set(backendPrefixes).has(prefix),
                  ),
          },
        ]
      : namespaceDeclarations.filter((namespace) => namespace.owner !== backendProtocolOwnerId);
  return [
    ...coreNamespaces.flatMap((namespace) => {
      const events = parsed.flatMap(({ sourceFile }) =>
        ownedProtocolEvents(sourceFile, namespace.prefixes),
      );
      return kernel === undefined || namespace.prefixes.length === 0
        ? []
        : [
            {
              owner: namespace.owner,
              filePath: kernel.file,
              prefixes: namespace.prefixes,
              events,
            },
          ];
    }),
    ...(backendProtocol === undefined
      ? []
      : [
          {
            owner: backendProtocolOwnerId,
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

const collectNamespaceModel = (root) => {
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
      filePath: toRepoPath(declaration.filePath),
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
  return { owners, writes, failures };
};

const posix = (file) => file.split(path.sep).join("/");
const unique = (values) => [...new Set(values)].sort((left, right) => left.localeCompare(right));

const tagValues = (record, name) =>
  record.tags
    .filter((tag) => tag.name === name)
    .map((tag) => tag.text)
    .filter(Boolean);

const defaultReadFile = (root, file) => fs.readFileSync(path.join(root, file), "utf8");

const readJson = (root, file) => JSON.parse(defaultReadFile(root, file));

const exists = (root, file) => fs.existsSync(path.join(root, file));

const rel = (root, file) => posix(path.relative(root, file));

const walk = (root, dir) => {
  const start = path.join(root, dir);
  if (!fs.existsSync(start)) return [];
  const out = [];
  for (const entry of fs.readdirSync(start, { withFileTypes: true })) {
    const full = path.join(start, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(root, posix(path.relative(root, full))));
      continue;
    }
    if (entry.isFile()) out.push(posix(path.relative(root, full)));
  }
  return out.sort((left, right) => left.localeCompare(right));
};

const ensureUnique = (failures, items, key, label) => {
  const seen = new Set();
  for (const item of items) {
    const value = key(item);
    if (seen.has(value)) failures.push(`duplicate ${label}: ${value}`);
    seen.add(value);
  }
};

const ensurePath = (root, failures, file, owner) => {
  if (!exists(root, file)) failures.push(`${owner} references missing path ${file}`);
};

const classifyCapabilityKind = (primitive) => {
  const id = primitive.id.toLowerCase();
  const symbol = primitive.symbol.toLowerCase();
  const pkg = primitive.packagePath.toLowerCase();
  const identity = `${id} ${symbol}`;

  if (identity.includes("workspacejobprofile") || identity.includes("profile")) return "profile";
  if (pkg.includes("/composers/")) return "composer";
  if (identity.includes("facade") || identity.includes("response")) return "facade";
  if (symbol.startsWith("project") || identity.includes("projection")) return "projection";
  if (pkg.includes("/wire-adapters/")) return "adapter";
  if (pkg.includes("/backends/")) return "backend";
  if (pkg.includes("/providers/")) return "provider";
  if (pkg.includes("/carriers/")) return "carrier";
  if (pkg.includes("/runtime") || id.includes(".runtime.")) return "runtime";
  if (pkg.includes("/kernel") || id.includes(".kernel.")) return "kernel";
  return "package";
};

const collectPrimitiveAnnotations = ({ root, surface, invariantIds, failures }) => {
  const primitivesById = new Map();
  for (const pkg of surface.packages) {
    if (!exists(root, `${pkg.path}/package.json`)) continue;
    for (const record of sourceTsdocRecordsForPackage(root, pkg)) {
      const primitiveIds = tagValues(record, "agentosPrimitive");
      if (primitiveIds.length === 0) continue;
      if (primitiveIds.length > 1) {
        failures.push(`${pkg.name}:${record.key} has multiple @agentosPrimitive tags`);
        continue;
      }

      const docs = tagValues(record, "agentosDocs");
      const invariants = tagValues(record, "agentosInvariant");
      if (docs.length !== 1) {
        failures.push(`${pkg.name}:${record.key} must have exactly one @agentosDocs tag`);
      }
      if (invariants.length === 0) {
        failures.push(`${pkg.name}:${record.key} must have at least one @agentosInvariant tag`);
      }

      for (const invariant of invariants) {
        if (!invariantIds.has(invariant)) {
          failures.push(`${pkg.name}:${record.key} references unknown invariant ${invariant}`);
        }
      }
      for (const doc of docs) ensurePath(root, failures, doc, `${pkg.name}:${record.key}`);

      const primitive = {
        id: primitiveIds[0],
        package: pkg.name,
        packagePath: pkg.path,
        entrypoints: [record.entrypoint],
        symbol: record.name,
        exportKey: record.key,
        sourceFile: rel(root, record.file),
        summary: record.summary,
        aliases: tagValues(record, "agentosAlias"),
        invariants,
        docs: docs[0] ?? "",
      };
      const noRouteReasons = tagValues(record, "agentosNoRouteReason");
      if (noRouteReasons.length > 1) {
        failures.push(`${pkg.name}:${record.key} has multiple @agentosNoRouteReason tags`);
      }
      if (noRouteReasons.length === 1) primitive.noRouteReason = noRouteReasons[0];
      primitive.capabilityKind = classifyCapabilityKind(primitive);

      const existing = primitivesById.get(primitive.id);
      if (existing === undefined) {
        primitivesById.set(primitive.id, primitive);
        continue;
      }
      if (
        existing.package !== primitive.package ||
        existing.symbol !== primitive.symbol ||
        existing.sourceFile !== primitive.sourceFile
      ) {
        failures.push(
          `primitive id ${primitive.id} is attached to multiple exported symbols: ${existing.package}:${existing.symbol} and ${primitive.package}:${primitive.symbol}`,
        );
        continue;
      }
      existing.entrypoints = unique([...existing.entrypoints, ...primitive.entrypoints]);
    }
  }
  return [...primitivesById.values()].sort((left, right) => left.id.localeCompare(right.id));
};

const discoverErrorTags = ({ root, readFile }) => {
  const agentOsTagPattern = /agent_os\.[a-z0-9]+(?:_[a-z0-9]+)*(?![a-z0-9_])/gu;
  const sources = new Map();
  const codeFiles = walk(root, "packages").filter((file) => file.endsWith(".ts"));
  for (const file of codeFiles) {
    const text = readFile(file);
    for (const match of text.matchAll(agentOsTagPattern)) {
      const tag = match[0];
      const list = sources.get(tag) ?? [];
      if (!list.includes(file)) list.push(file);
      sources.set(tag, list);
    }
  }
  return [...sources.entries()]
    .map(([tag, sourceFiles]) => ({ tag, sourceFiles }))
    .sort((left, right) => left.tag.localeCompare(right.tag));
};

const attachPrimitiveEvidence = ({ root, failures, primitiveEvidenceSource, primitives }) => {
  const primitiveIds = new Set(primitives.map((primitive) => primitive.id));
  const primitiveEvidenceById = new Map();

  for (const entry of primitiveEvidenceSource.evidence) {
    if (!primitiveIds.has(entry.primitive)) {
      failures.push(`primitive evidence references unknown primitive ${entry.primitive}`);
      continue;
    }
    const hasTests = Array.isArray(entry.tests) && entry.tests.length > 0;
    const hasNoTestReason =
      typeof entry.noTestReason === "string" && entry.noTestReason.trim().length > 0;
    if (hasTests === hasNoTestReason) {
      failures.push(
        `${entry.primitive} must have exactly one of tests[] or non-empty noTestReason`,
      );
      continue;
    }
    if (hasTests) {
      for (const test of entry.tests) ensurePath(root, failures, test, entry.primitive);
      primitiveEvidenceById.set(entry.primitive, {
        tests: [...entry.tests].sort((left, right) => left.localeCompare(right)),
      });
    } else {
      primitiveEvidenceById.set(entry.primitive, { noTestReason: entry.noTestReason.trim() });
    }
  }

  for (const primitive of primitives) {
    const evidence = primitiveEvidenceById.get(primitive.id);
    if (evidence === undefined) {
      failures.push(`${primitive.id} is missing primitive test evidence`);
      primitive.testEvidence = { noTestReason: "missing evidence source" };
      continue;
    }
    primitive.testEvidence = evidence;
  }
};

const buildErrors = ({ root, failures, errorsSource, invariantIds, readFile }) => {
  const errorMetadataByTag = new Map(errorsSource.errors.map((error) => [error.tag, error]));
  const discoveredErrors = discoverErrorTags({ root, readFile });
  for (const discovered of discoveredErrors) {
    const metadata = errorMetadataByTag.get(discovered.tag);
    if (metadata === undefined) {
      failures.push(`missing docs/agent/error-metadata.source.json entry for ${discovered.tag}`);
      continue;
    }
    for (const invariant of metadata.invariants) {
      if (!invariantIds.has(invariant)) {
        failures.push(`${discovered.tag} references unknown invariant ${invariant}`);
      }
    }
    ensurePath(root, failures, metadata.docs, discovered.tag);
  }

  return discoveredErrors
    .map((discovered) => {
      const metadata = errorMetadataByTag.get(discovered.tag);
      if (metadata === undefined) return null;
      return {
        tag: discovered.tag,
        invariants: metadata.invariants,
        docs: metadata.docs,
        fix: metadata.fix,
        sourceFiles: discovered.sourceFiles,
      };
    })
    .filter(Boolean);
};

const buildInvariantMatrix = ({ root, failures, invariantsSource, primitives, errors }) =>
  invariantsSource.invariants.map((invariant) => {
    const invariantPrimitives = primitives
      .filter((primitive) => primitive.invariants.includes(invariant.id))
      .map((primitive) => primitive.id);
    const invariantErrors = errors
      .filter((error) => error.invariants.includes(invariant.id))
      .map((error) => error.tag);
    const docs = unique([
      invariant.docs,
      ...primitives
        .filter((primitive) => primitive.invariants.includes(invariant.id))
        .map((primitive) => primitive.docs),
      ...errors
        .filter((error) => error.invariants.includes(invariant.id))
        .map((error) => error.docs),
    ]);
    const row = {
      invariant: invariant.id,
      statement: invariant.statement,
      primitives: invariantPrimitives,
      errors: invariantErrors,
      docs,
      tests: invariant.tests,
    };
    if (row.docs.length === 0) failures.push(`${row.invariant} has no docs mapping`);
    for (const test of row.tests) ensurePath(root, failures, test, row.invariant);
    return row;
  });

export const collectAgentDocsModel = (root) => {
  const failures = [];
  const readFile = (file) => defaultReadFile(root, file);
  const surface = readJson(root, "docs/surface.json");
  const rootPackage = readJson(root, "package.json");
  const recipesSource = readJson(root, "docs/agent/recipes.source.json");
  const capabilityRulesSource = readJson(root, "docs/agent/capability-rules.source.json");
  const invariantsSource = readJson(root, "docs/agent/invariants.source.json");
  const primitiveEvidenceSource = readJson(root, "docs/agent/primitive-evidence.source.json");
  const errorsSource = readJson(root, "docs/agent/error-metadata.source.json");
  const externalVocabularySource = readJson(root, "docs/agent/external-vocabulary.source.json");

  ensureUnique(failures, recipesSource.recipes, (recipe) => recipe.id, "recipe id");
  ensureUnique(
    failures,
    capabilityRulesSource.rules,
    (rule) => rule.primitive,
    "capability rule primitive",
  );
  ensureUnique(failures, invariantsSource.invariants, (invariant) => invariant.id, "invariant id");
  ensureUnique(
    failures,
    primitiveEvidenceSource.evidence,
    (entry) => entry.primitive,
    "primitive evidence id",
  );
  ensureUnique(failures, errorsSource.errors, (error) => error.tag, "error tag metadata");
  ensureUnique(
    failures,
    externalVocabularySource.vocabulary,
    (entry) => entry.id,
    "external vocabulary id",
  );

  const invariantIds = new Set(invariantsSource.invariants.map((invariant) => invariant.id));
  for (const invariant of invariantsSource.invariants) {
    ensurePath(root, failures, invariant.docs, invariant.id);
    for (const test of invariant.tests) ensurePath(root, failures, test, invariant.id);
  }

  const primitives = collectPrimitiveAnnotations({ root, surface, invariantIds, failures });
  ensureUnique(failures, primitives, (primitive) => primitive.id, "primitive id");
  const primitiveIds = new Set(primitives.map((primitive) => primitive.id));
  attachPrimitiveEvidence({ root, failures, primitiveEvidenceSource, primitives });

  for (const recipe of recipesSource.recipes) {
    ensurePath(root, failures, recipe.tutorial, recipe.id);
    for (const primitive of recipe.primitives) {
      if (!primitiveIds.has(primitive)) {
        failures.push(`${recipe.id} references unknown primitive ${primitive}`);
      }
    }
    for (const evidence of recipe.evidence) ensurePath(root, failures, evidence, recipe.id);
    if (
      recipe.noRouteReason !== undefined &&
      (typeof recipe.noRouteReason !== "string" || recipe.noRouteReason.trim().length === 0)
    ) {
      failures.push(`${recipe.id} noRouteReason must be a non-empty string when present`);
    }
  }

  for (const entry of externalVocabularySource.vocabulary) {
    ensurePath(root, failures, entry.docs, entry.id);
    for (const primitive of entry.mapsTo) {
      if (!primitiveIds.has(primitive)) {
        failures.push(`${entry.id} references unknown primitive ${primitive}`);
      }
    }
  }

  const errors = buildErrors({ root, failures, errorsSource, invariantIds, readFile });
  const invariantMatrix = buildInvariantMatrix({
    root,
    failures,
    invariantsSource,
    primitives,
    errors,
  });
  const namespaceModel = collectNamespaceModel(root);
  failures.push(...namespaceModel.failures);

  return {
    root,
    failures,
    surface,
    rootPackage,
    rootScripts: rootPackage.scripts ?? {},
    recipesSource,
    capabilityRulesSource,
    invariantsSource,
    primitiveEvidenceSource,
    errorsSource,
    externalVocabularySource,
    primitives,
    primitiveIds,
    errors,
    invariantMatrix,
    namespaceModel,
  };
};
