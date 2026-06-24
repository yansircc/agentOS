#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { runCommand } from "./command-runner.mjs";
import {
  importSpecifierRecords,
  packageImportCycles as graphPackageImportCycles,
  packageManifestDependencyEdges,
  packageSourceImportEdges as graphPackageSourceImportEdges,
  moduleGraphOracleFailures,
  sourceModuleGraph,
  tsconfigReferenceEdges,
  workspacePackageRecords as graphWorkspacePackageRecords,
} from "./package-graph.mjs";
import { workspacePackagePatterns } from "../lib/workspace-manifest.mjs";
import { collectAgentDocsModel } from "../lib/agent-docs-model.mjs";
import { createOwnerChecks } from "./algorithmic/owner-checks.mjs";
import { createArchitectureChecks } from "./algorithmic/architecture-checks.mjs";
import { createDistributionChecks } from "./algorithmic/distribution-checks.mjs";
import { createClientBoundaryChecks } from "./algorithmic/client-boundary-checks.mjs";
import {
  createPackageBoundaryChecks,
  packageExportSubpaths,
} from "./algorithmic/package-boundary-checks.mjs";
import { createRuntimeStructuralChecks } from "./algorithmic/runtime-structural-checks.mjs";
import { createStaticTargetChecks } from "./algorithmic/static-target-checks.mjs";
import { createRepoSurfaceChecks } from "./algorithmic/repo-surface-checks.mjs";
import { createProjectionBoundaryChecks } from "./algorithmic/projection-boundary-checks.mjs";
import { createConvergenceSmokeChecks } from "./algorithmic/convergence-smoke-checks.mjs";
import { createSourceAliasChecks } from "./algorithmic/source-alias-checks.mjs";
import {
  apiSourceMode,
  exportedNamesForPackage,
  sourceTsdocApiMarkdown,
  sourceTsdocModes,
  sourceTsdocRecordsForPackage,
  validateSourceTsdocRecords,
} from "../lib/public-api-model.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const compare = (left, right) => left.localeCompare(right);
const toRepoPath = (file) => path.relative(repoRoot, file).split(path.sep).join("/");
const read = (relativePath) => fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
const readJson = (relativePath) => JSON.parse(read(relativePath));
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

const walk = (relativePath, options = {}) => {
  const absolutePath = path.join(repoRoot, relativePath);
  if (!fs.existsSync(absolutePath)) return [];
  const stat = fs.statSync(absolutePath);
  if (stat.isFile()) return [relativePath];
  const ignored = options.ignored ?? new Set(["node_modules", "dist", ".wrangler", ".turbo"]);
  const files = [];
  for (const entry of fs.readdirSync(absolutePath, { withFileTypes: true })) {
    if (entry.isDirectory() && ignored.has(entry.name)) continue;
    const child = path.join(relativePath, entry.name);
    if (entry.isDirectory()) files.push(...walk(child, options));
    if (entry.isFile()) files.push(child.split(path.sep).join("/"));
  }
  return files.sort(compare);
};

const failIfAny = (label, failures) => {
  if (failures.length === 0) {
    console.log(`${label} passed`);
    return;
  }
  throw new Error(failures.join("\n"));
};

const repoSurfaceChecks = createRepoSurfaceChecks({
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
});
const manifestNames = repoSurfaceChecks.manifestNames;
const ruleConstraints = repoSurfaceChecks.ruleConstraints;
const checkPublicApi = repoSurfaceChecks.checkPublicApi;
const checkEventNamespaces = repoSurfaceChecks.checkEventNamespaces;
const checkRepoToolingSurface = repoSurfaceChecks.checkRepoToolingSurface;

const clientBoundaryChecks = createClientBoundaryChecks({
  fs,
  path,
  repoRoot,
  read,
  readJson,
  walk,
  failIfAny,
});
const workspacePackageRecords = clientBoundaryChecks.workspacePackageRecords;
const clientSectionBody = clientBoundaryChecks.clientSectionBody;
const checkClientBoundaries = clientBoundaryChecks.checkClientBoundaries;

const sourceAliasChecks = createSourceAliasChecks({
  fs,
  path,
  pathToFileURL,
  repoRoot,
  readJson,
  toRepoPath,
  compare,
  isRecord,
  failIfAny,
});
const checkSourceAliases = sourceAliasChecks.checkSourceAliases;

const packageSourceFiles = () =>
  walk("packages").filter(
    (file) =>
      /\.(?:ts|tsx|mts|cts)$/u.test(file) &&
      !file.endsWith(".d.ts") &&
      file.split("/").includes("src"),
  );

const packageTestFiles = () =>
  walk("packages").filter(
    (file) =>
      /\.(?:ts|tsx|mts|cts)$/u.test(file) &&
      !file.endsWith(".d.ts") &&
      file.split("/").includes("test"),
  );

const nodeLabel = (sourceFile, node) => {
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return `${toRepoPath(sourceFile.fileName)}:${position.line + 1}:${position.character + 1}`;
};

const unwrap = (node) => {
  let current = node;
  while (
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isParenthesizedExpression(current)
  ) {
    current = current.expression;
  }
  return current;
};

const callName = (expression) => {
  const unwrapped = unwrap(expression);
  if (ts.isIdentifier(unwrapped)) return unwrapped.text;
  if (ts.isPropertyAccessExpression(unwrapped)) return unwrapped.name.text;
  return undefined;
};

const runtimeStructuralChecks = createRuntimeStructuralChecks({
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
});
const checkTransactionSync = runtimeStructuralChecks.checkTransactionSync;
const checkBackendNeutrality = runtimeStructuralChecks.checkBackendNeutrality;
const checkGateTierGovernance = runtimeStructuralChecks.checkGateTierGovernance;
const checkSpikeHygiene = runtimeStructuralChecks.checkSpikeHygiene;

const ownerChecks = createOwnerChecks({
  ts,
  graphWorkspacePackageRecords,
  repoRoot,
  read,
  walk,
  compare,
  isRecord,
  unwrap,
  callName,
  packageSourceFiles,
  packageTestFiles,
});

export const ownerCouplingFindingsForSource = ownerChecks.ownerCouplingFindingsForSource;
export const ownerIdentityBoundaryFindingsForSource =
  ownerChecks.ownerIdentityBoundaryFindingsForSource;
export const ownerIdentityBoundaryNegativeFixtureFailures =
  ownerChecks.ownerIdentityBoundaryNegativeFixtureFailures;
export const ownerIdDeclarationFindingsForSource = ownerChecks.ownerIdDeclarationFindingsForSource;
export const coreClaimedNamespaceFindingsForSource =
  ownerChecks.coreClaimedNamespaceFindingsForSource;
export const ownerIdRegistryFindings = ownerChecks.ownerIdRegistryFindings;
const ownerIdRegistry = ownerChecks.ownerIdRegistry;
const checkOwnerCoupling = ownerChecks.checkOwnerCoupling;
const checkOwnerIdentityBoundary = ownerChecks.checkOwnerIdentityBoundary;
const checkOwnerIds = ownerChecks.checkOwnerIds;

const architectureChecks = createArchitectureChecks({
  fs,
  path,
  graphWorkspacePackageRecords,
  sourceModuleGraph,
  importSpecifierRecords,
  repoRoot,
  read,
  readJson,
  walk,
  compare,
  isRecord,
  failIfAny,
  ownerIdRegistry,
  ownerIdRegistryFindings,
  packageExportSubpaths,
});

const distributionRootsRegistryPath = architectureChecks.distributionRootsRegistryPath;
const packageUnitsRegistryPath = architectureChecks.packageUnitsRegistryPath;
const moduleBucketRegistry = architectureChecks.moduleBucketRegistry;
export const moduleBucketForPath = architectureChecks.moduleBucketForPath;
export const moduleAmbientForPath = architectureChecks.moduleAmbientForPath;
export const moduleBucketRegistryFindings = architectureChecks.moduleBucketRegistryFindings;
export const packageUnitsRegistryFindings = architectureChecks.packageUnitsRegistryFindings;
export const distributionRootsRegistryFindings =
  architectureChecks.distributionRootsRegistryFindings;
export const moduleBucketFindingsForEdges = architectureChecks.moduleBucketFindingsForEdges;
export const moduleBucketNegativeFixtureFailures =
  architectureChecks.moduleBucketNegativeFixtureFailures;
const checkModuleBuckets = architectureChecks.checkModuleBuckets;
const checkArchitectureSources = architectureChecks.checkArchitectureSources;

let packageBoundaryChecks;
const distributionChecks = createDistributionChecks({
  fs,
  path,
  ts,
  repoRoot,
  compare,
  isRecord,
  readJson,
  walk,
  failIfAny,
  importSpecifierRecords,
  graphWorkspacePackageRecords,
  sourceModuleGraph,
  moduleBucketRegistry,
  packageUnitsRegistryFindings,
  distributionRootsRegistryFindings,
  packageUnitsRegistryPath,
  distributionRootsRegistryPath,
  distributionMinimalityFailures: () => packageBoundaryChecks.distributionMinimalityFailures(),
});

export const distributionManifestFindings = distributionChecks.distributionManifestFindings;
export const distributionSourceProbeFindingsForSource =
  distributionChecks.distributionSourceProbeFindingsForSource;
export const distributionSubpathFindings = distributionChecks.distributionSubpathFindings;
export const distributionFindingsForPackage = distributionChecks.distributionFindingsForPackage;
export const distributionEffectPeerFindings = distributionChecks.distributionEffectPeerFindings;
export const distributionUnitRegistryFindings = distributionChecks.distributionUnitRegistryFindings;
export const distributionUnitNegativeFixtureFailures =
  distributionChecks.distributionUnitNegativeFixtureFailures;
const distributionUnitFinding = distributionChecks.distributionUnitFinding;
const packageUnitOptionalPeerEntries = distributionChecks.packageUnitOptionalPeerEntries;
const formatDistributionFinding = distributionChecks.formatDistributionFinding;
const checkDistributionUnits = distributionChecks.checkDistributionUnits;

packageBoundaryChecks = createPackageBoundaryChecks({
  fs,
  path,
  execFileSync,
  repoRoot,
  read,
  readJson,
  walk,
  compare,
  isRecord,
  failIfAny,
  ruleConstraints,
  graphWorkspacePackageRecords,
  graphPackageSourceImportEdges,
  graphPackageImportCycles,
  sourceModuleGraph,
  moduleGraphOracleFailures,
  importSpecifierRecords,
  distributionExportEntries: distributionChecks.distributionExportEntries,
  distributionClosureForRoots: distributionChecks.distributionClosureForRoots,
  distributionUnitFinding,
  packageUnitOptionalPeerEntries,
  formatDistributionFinding,
  checkModuleBuckets,
  moduleAmbientForPath,
  allowedAmbientImports: architectureChecks.allowedAmbientImports,
  packageUnitsRegistryPath,
  distributionRootsRegistryPath,
});
export const packageConstraintNameFailures = packageBoundaryChecks.packageConstraintNameFailures;
export const packageUnitOptionalPeerAllowsEdge =
  packageBoundaryChecks.packageUnitOptionalPeerAllowsEdge;
export const consumerFacingSpecifierFailuresForContent =
  packageBoundaryChecks.consumerFacingSpecifierFailuresForContent;
export const markdownLinkFailuresForContent = packageBoundaryChecks.markdownLinkFailuresForContent;
export const obsoletePublicPackageFailures = packageBoundaryChecks.obsoletePublicPackageFailures;
const consumerFacingSpecifierFailures = packageBoundaryChecks.consumerFacingSpecifierFailures;
const checkDocsLinkIntegrity = packageBoundaryChecks.checkDocsLinkIntegrity;
const packageUnitOptionalPeerFindings = packageBoundaryChecks.packageUnitOptionalPeerFindings;
const checkNoObsoletePublicPackages = packageBoundaryChecks.checkNoObsoletePublicPackages;
const packageUnitsRegistry = packageBoundaryChecks.packageUnitsRegistry;
const distributionRootsRegistry = packageBoundaryChecks.distributionRootsRegistry;
const packageUnitRecords = packageBoundaryChecks.packageUnitRecords;
const packageUnitSourceNames = packageBoundaryChecks.packageUnitSourceNames;
const packageUnitPublicSpecifiers = packageBoundaryChecks.packageUnitPublicSpecifiers;
const packageUnitPublicSpecifierForSource =
  packageBoundaryChecks.packageUnitPublicSpecifierForSource;
const selectedSourceSpecifiersForProfileUnit =
  packageBoundaryChecks.selectedSourceSpecifiersForProfileUnit;
const specifierMatchesPackage = packageBoundaryChecks.specifierMatchesPackage;
const checkSubstrateImportDag = packageBoundaryChecks.checkSubstrateImportDag;
const checkConvergenceImportDag = packageBoundaryChecks.checkConvergenceImportDag;
const checkModuleGraphOracle = packageBoundaryChecks.checkModuleGraphOracle;
const checkSubpathNoLeak = packageBoundaryChecks.checkSubpathNoLeak;
const checkProfileVerification = packageBoundaryChecks.checkProfileVerification;

const staticTargetChecks = createStaticTargetChecks({ read, readJson, failIfAny });
const checkGeneratedStaticTargetLinking = staticTargetChecks.checkGeneratedStaticTargetLinking;

const projectionBoundaryChecks = createProjectionBoundaryChecks({
  fs,
  path,
  ts,
  repoRoot,
  read,
  readJson,
  walk,
  isRecord,
  failIfAny,
  graphWorkspacePackageRecords,
  sourceModuleGraph,
  workspacePackageRecords,
});
const projectionFoldBoundaryFailures = projectionBoundaryChecks.projectionFoldBoundaryFailures;
const checkProjectionFoldBoundary = projectionBoundaryChecks.checkProjectionFoldBoundary;
const checkLimitRegistry = projectionBoundaryChecks.checkLimitRegistry;

const convergenceSmokeChecks = createConvergenceSmokeChecks({
  fs,
  os,
  path,
  execFileSync,
  repoRoot,
  read,
  readJson,
  walk,
  isRecord,
  failIfAny,
  manifestNames,
  checkPublicApi,
  checkClientBoundaries,
  clientSectionBody,
  checkGeneratedStaticTargetLinking,
  checkSpikeHygiene,
  moduleBucketRegistry,
  workspacePackagePatterns: () => workspacePackagePatterns(repoRoot),
  workspacePackageRecords,
  consumerFacingSpecifierFailures,
  packageUnitPublicSpecifiers,
  packageUnitPublicSpecifierForSource,
  packageUnitRecords,
  packageUnitSourceNames,
  packageUnitsRegistry,
  distributionRootsRegistry,
  selectedSourceSpecifiersForProfileUnit,
  runProfileTypecheck: packageBoundaryChecks.runProfileTypecheck,
  obsoletePublicPackageFailures,
  packageUnitOptionalPeerFindings,
  specifierMatchesPackage,
  projectionFoldBoundaryFailures,
});
const checkConvergenceBoundary = convergenceSmokeChecks.checkConvergenceBoundary;
const checkConvergencePublicSurface = convergenceSmokeChecks.checkConvergencePublicSurface;
const checkDocsSiteBuild = convergenceSmokeChecks.checkDocsSiteBuild;
const checkCliSurface = convergenceSmokeChecks.checkCliSurface;
const checkConsumerImports = convergenceSmokeChecks.checkConsumerImports;
const checkDogfoodSmoke = convergenceSmokeChecks.checkDogfoodSmoke;

const checkBoundaryProjection = () => runCommand("vp check", { cwd: repoRoot });

const checkerById = new Map([
  ["architecture-sources", checkArchitectureSources],
  ["backend-neutrality", checkBackendNeutrality],
  ["boundaries", checkBoundaryProjection],
  ["cli-surface", checkCliSurface],
  ["client-boundaries", checkClientBoundaries],
  ["consumer-imports", checkConsumerImports],
  ["convergence-boundary", checkConvergenceBoundary],
  ["convergence-import-dag", checkConvergenceImportDag],
  ["convergence-public-surface", checkConvergencePublicSurface],
  ["d12-a155-substrate-absorption", checkBoundaryProjection],
  ["distribution-units", checkDistributionUnits],
  ["dogfood-smoke", checkDogfoodSmoke],
  ["docs-link-integrity", checkDocsLinkIntegrity],
  ["docs-site-build", checkDocsSiteBuild],
  ["event-namespaces", checkEventNamespaces],
  ["limit-registry", checkLimitRegistry],
  ["generated-static-target-linking", checkGeneratedStaticTargetLinking],
  ["gate-tier-governance", checkGateTierGovernance],
  ["module-graph-oracle", checkModuleGraphOracle],
  ["module-buckets", checkModuleBuckets],
  ["no-obsolete-public-packages", checkNoObsoletePublicPackages],
  ["owner-coupling", checkOwnerCoupling],
  ["owner-identity-boundary", checkOwnerIdentityBoundary],
  ["owner-ids", checkOwnerIds],
  ["profile-verification", checkProfileVerification],
  ["projection-fold-boundary", checkProjectionFoldBoundary],
  ["public-api", checkPublicApi],
  ["repo-tooling-surface", checkRepoToolingSurface],
  ["source-aliases", checkSourceAliases],
  ["spike-hygiene", checkSpikeHygiene],
  ["subpath-no-leak", checkSubpathNoLeak],
  ["substrate-import-dag", checkSubstrateImportDag],
  ["transaction-sync", checkTransactionSync],
]);
const checkerIdsWithArgs = new Set([
  "distribution-units",
  "dogfood-smoke",
  "consumer-imports",
  "module-buckets",
  "owner-coupling",
  "owner-identity-boundary",
  "profile-verification",
  "subpath-no-leak",
]);

export const listAlgorithmicCheckers = () => [...checkerById.keys()].sort(compare);
export const hasAlgorithmicChecker = (checkerId) => checkerById.has(checkerId);
export const algorithmicCheckerAcceptsArgs = (checkerId) => checkerIdsWithArgs.has(checkerId);

export const runAlgorithmicChecker = async (checkerId, args = []) => {
  const checker = checkerById.get(checkerId);
  if (checker === undefined) throw new Error(`unknown algorithmic checker ${checkerId}`);
  console.log(`$ agentos algorithmic-check ${checkerId}`);
  await Promise.resolve(checker(args));
};

const isCli =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isCli) {
  const [checkerId, ...rest] = process.argv.slice(2);
  if (checkerId === undefined || checkerId === "--help" || checkerId === "-h") {
    console.log("usage: node packages/cli/src/check/algorithmic-checks.mjs <checker-id>");
    process.exit(checkerId === undefined ? 1 : 0);
  }
  if (!algorithmicCheckerAcceptsArgs(checkerId) && rest.length > 0) {
    console.error(`unexpected argument(s): ${rest.join(" ")}`);
    process.exit(1);
  }
  try {
    await runAlgorithmicChecker(checkerId, rest);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
