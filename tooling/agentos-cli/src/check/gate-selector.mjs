import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCommand } from "./command-runner.mjs";
import {
  packageManifestDependencyEdges,
  packageSourceImportEdges,
  tsconfigReferenceEdges,
  workspacePackageRecords,
} from "./package-graph.mjs";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const gatesPath = "docs/agent/gates.source.json";
const compare = (left, right) => left.localeCompare(right);
const readJson = (relativePath) =>
  JSON.parse(fs.readFileSync(path.join(repoRoot, relativePath), "utf8"));

const git = (args) => execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
const gitLines = (args) =>
  git(args)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.split(path.sep).join("/"));

const escapeRegex = (value) => value.replace(/[.+^${}()|[\]\\]/gu, "\\$&");
const globToRegex = (pattern) => {
  let regex = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    const next = pattern[index + 1];
    if (char === "*" && next === "*") {
      regex += ".*";
      index += 1;
    } else if (char === "*") {
      regex += "[^/]*";
    } else {
      regex += escapeRegex(char);
    }
  }
  return new RegExp(`${regex}$`, "u");
};

const matchesPattern = (file, pattern) => globToRegex(pattern).test(file);
const matchesAny = (file, patterns) => patterns.some((pattern) => matchesPattern(file, pattern));

const loadGates = () => readJson(gatesPath);

const edgeKey = (edge) => `${edge.from.name}->${edge.to.name}`;

const extraEdges = (manifest, records) => {
  const byPath = new Map(records.map((record) => [record.path, record]));
  const byName = new Map(records.map((record) => [record.name, record]));
  const edges = [];
  for (const edge of manifest.extraEdges ?? []) {
    const from = byPath.get(edge.from) ?? byName.get(edge.from);
    const to = byPath.get(edge.to) ?? byName.get(edge.to);
    if (from !== undefined && to !== undefined && from.name !== to.name) {
      edges.push({ from, to, source: "extra-edge", reason: edge.reason ?? "declared extra edge" });
    }
  }
  return edges;
};

const affectedGraph = (manifest, records) => {
  const sourceEdges = packageSourceImportEdges(repoRoot, records);
  const manifestEdges = packageManifestDependencyEdges(repoRoot, records);
  const tsconfigEdges = tsconfigReferenceEdges(repoRoot, records);
  const declaredExtraEdges = extraEdges(manifest, records);
  const edges = [...sourceEdges, ...manifestEdges, ...tsconfigEdges, ...declaredExtraEdges];
  const manifestEdgeKeys = new Set(manifestEdges.map(edgeKey));
  const dependencyDrift = sourceEdges
    .filter((edge) => !manifestEdgeKeys.has(edgeKey(edge)))
    .map((edge) => ({
      from: edge.from.name,
      to: edge.to.name,
      file: edge.file,
      specifier: edge.specifier,
      reason: "source import edge is not declared in package manifest dependencies",
    }));
  const sourceEdgeKeys = new Set(sourceEdges.map(edgeKey));
  const graphEdgeKeys = new Set(edges.map(edgeKey));
  const fidelityFailures = [...sourceEdgeKeys]
    .filter((key) => !graphEdgeKeys.has(key))
    .map((key) => `affected graph is missing source import edge ${key}`);
  return { edges, sourceEdges, dependencyDrift, fidelityFailures };
};

const owningPackage = (records, file) =>
  records
    .filter((record) => file === record.path || file.startsWith(`${record.path}/`))
    .sort((left, right) => right.path.length - left.path.length)[0];

const reverseClosure = (records, edges, startNames) => {
  const reverse = new Map(records.map((record) => [record.name, []]));
  for (const edge of edges) reverse.get(edge.to.name)?.push(edge);
  const affected = new Map();
  const queue = [...startNames];
  while (queue.length > 0) {
    const name = queue.shift();
    if (name === undefined || affected.has(name)) continue;
    affected.set(name, true);
    for (const edge of reverse.get(name) ?? []) queue.push(edge.from.name);
  }
  return [...affected.keys()].sort(compare);
};

const packageProof = (manifest, record) => {
  const override = (manifest.packageOverrides ?? []).find(
    (entry) => record.path === entry.path || record.name === entry.name,
  );
  return override ?? manifest.defaultPackageProof;
};

const proofClassCommand = (manifest, proofClass) => {
  const command = manifest.proofClasses?.[proofClass]?.command;
  if (typeof command !== "string" || command.length === 0) {
    throw new Error(`${gatesPath}: proof class ${proofClass} has no command`);
  }
  return command;
};

const fullResult = (manifest, changedPaths, reason) => ({
  mode: "full",
  changedPaths,
  proofClasses: [...(manifest.fullAffectedProofClasses ?? [])].sort(compare),
  run: [...(manifest.fullAffectedProofClasses ?? [])].sort(compare).map((proofClass) => ({
    proofClass,
    command: proofClassCommand(manifest, proofClass),
    reason,
  })),
  skip: [],
  provenance: [{ kind: "full", reason }],
  diagnostics: [],
});

const defaultBase = () => {
  const detached = (() => {
    try {
      git(["symbolic-ref", "--quiet", "--short", "HEAD"]);
      return false;
    } catch {
      return true;
    }
  })();
  if (detached) return { ok: false, reason: "detached HEAD cannot derive a safe default base" };
  if (git(["rev-parse", "--is-shallow-repository"]) === "true") {
    return { ok: false, reason: "shallow repository cannot derive a safe default base" };
  }
  try {
    return { ok: true, base: git(["merge-base", "HEAD", "main"]) };
  } catch {
    return { ok: false, reason: "git merge-base HEAD main failed" };
  }
};

const changedPaths = ({ base, head }) => {
  const paths = new Set();
  if (head !== undefined) {
    for (const file of gitLines(["diff", "--name-only", `${base}..${head}`])) paths.add(file);
    return [...paths].sort(compare);
  }
  for (const file of gitLines(["diff", "--name-only", `${base}...HEAD`])) paths.add(file);
  for (const file of gitLines(["diff", "--name-only"])) paths.add(file);
  for (const file of gitLines(["diff", "--name-only", "--cached"])) paths.add(file);
  return [...paths].sort(compare);
};

export const deriveAffectedGates = (options = {}) => {
  const manifest = loadGates();
  const records = workspacePackageRecords(repoRoot).filter((record) =>
    record.name?.startsWith("@agent-os/"),
  );
  let changed;
  if (options.changedPaths !== undefined) {
    changed = [...options.changedPaths].sort(compare);
  } else {
    const baseResolution =
      options.base === undefined ? defaultBase() : { ok: true, base: options.base };
    if (!baseResolution.ok) return fullResult(manifest, [], baseResolution.reason);

    try {
      changed = changedPaths({ base: baseResolution.base, head: options.head });
    } catch (error) {
      return fullResult(
        manifest,
        [],
        `git diff failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (changed.length === 0) {
    return {
      mode: "affected",
      changedPaths: [],
      proofClasses: [],
      run: [],
      skip: (manifest.expensiveProofClasses ?? []).map((proofClass) => ({
        proofClass,
        reason: "no changed paths",
      })),
      provenance: [],
      diagnostics: [],
    };
  }

  for (const file of changed) {
    for (const surface of manifest.globalSurfaces ?? []) {
      if (matchesAny(file, surface.patterns ?? [])) {
        return fullResult(manifest, changed, `${file}: ${surface.reason ?? "global surface"}`);
      }
    }
  }

  const graph = affectedGraph(manifest, records);
  if (graph.fidelityFailures.length > 0) {
    return fullResult(manifest, changed, graph.fidelityFailures.join("; "));
  }

  const owning = new Map();
  const directProofClasses = new Map();
  for (const file of changed) {
    for (const rule of manifest.changedPathProofRules ?? []) {
      if (matchesAny(file, rule.patterns ?? [])) {
        for (const proofClass of rule.proofClasses ?? []) {
          directProofClasses.set(proofClass, `${file}: ${rule.reason ?? "changed path rule"}`);
        }
      }
    }
    const owner = owningPackage(records, file);
    if (owner === undefined) {
      return fullResult(manifest, changed, `${file}: unknown path owner`);
    }
    owning.set(owner.name, owner);
  }

  const affectedNames = reverseClosure(records, graph.edges, owning.keys());
  const affectedRecords = affectedNames
    .map((name) => records.find((record) => record.name === name))
    .filter(Boolean);
  const proofReasons = new Map(directProofClasses);
  for (const record of affectedRecords) {
    const proof = packageProof(manifest, record);
    for (const proofClass of proof?.affectedProofClasses ?? []) {
      proofReasons.set(proofClass, `${record.name}: affected package declares ${proofClass} proof`);
    }
  }

  const proofClasses = [...proofReasons.keys()].sort(compare);
  const run = proofClasses.map((proofClass) => ({
    proofClass,
    command: proofClassCommand(manifest, proofClass),
    reason: proofReasons.get(proofClass),
  }));
  const skip = (manifest.expensiveProofClasses ?? [])
    .filter((proofClass) => !proofReasons.has(proofClass))
    .sort(compare)
    .map((proofClass) => ({
      proofClass,
      reason: "no affected package or changed-path rule declares this proof",
    }));

  return {
    mode: "affected",
    changedPaths: changed,
    owningPackages: [...owning.values()].map((record) => record.name).sort(compare),
    affectedPackages: affectedNames,
    proofClasses,
    run,
    skip,
    provenance: [
      ...changed.map((file) => ({
        kind: "changed-path",
        file,
        owner: owningPackage(records, file)?.name,
      })),
      ...affectedNames.map((name) => ({ kind: "affected-package", package: name })),
    ],
    diagnostics: graph.dependencyDrift,
  };
};

export const printAffectedGates = (result, { json = false } = {}) => {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`affected mode: ${result.mode}`);
  for (const entry of result.run) {
    console.log(`run   ${entry.proofClass} <- ${entry.reason}`);
  }
  for (const entry of result.skip) {
    console.log(`skip  ${entry.proofClass} <- ${entry.reason}`);
  }
  for (const diagnostic of result.diagnostics ?? []) {
    console.log(
      `diag  dependency-drift <- ${diagnostic.file}: ${diagnostic.from} imports ${diagnostic.specifier}`,
    );
  }
};

export const runAffectedGates = (result) => {
  for (const entry of result.run) runCommand(entry.command, { cwd: repoRoot });
};
