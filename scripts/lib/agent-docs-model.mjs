import fs from "node:fs";
import path from "node:path";
import { collectNamespaceModel } from "../check-event-namespaces.mjs";
import { sourceTsdocRecordsForPackage } from "../public-api-model.mjs";

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
      const decisions = tagValues(record, "agentosDecision");
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
      for (const decision of decisions) {
        ensurePath(root, failures, decision, `${pkg.name}:${record.key}`);
      }

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
        decisions,
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
      decisions: invariant.decisions,
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
    for (const decision of invariant.decisions) ensurePath(root, failures, decision, invariant.id);
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
