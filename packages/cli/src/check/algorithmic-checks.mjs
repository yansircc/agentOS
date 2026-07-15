#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "../lib/typescript-native.mjs";
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
import { walkRepoSourceFiles } from "../lib/repo-source-files.mjs";
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
import { createRuntimeProofChecks } from "./algorithmic/runtime-proof-checks.mjs";
import { createRootOwnerChecks } from "./algorithmic/root-owner-checks.mjs";
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

const walk = (relativePath, options = {}) => walkRepoSourceFiles(repoRoot, relativePath, options);

const failIfAny = (label, failures) => {
  if (failures.length === 0) {
    console.log(`${label} passed`);
    return;
  }
  throw new Error(failures.join("\n"));
};

const rootOwnerChecks = createRootOwnerChecks({ fs, path, ts, repoRoot, readJson });
const rootOwnerProofFailures = rootOwnerChecks.rootOwnerProofFailures;

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
  rootOwnerProofFailures,
});
const manifestNames = repoSurfaceChecks.manifestNames;
const ruleConstraints = repoSurfaceChecks.ruleConstraints;
const checkPublicApi = repoSurfaceChecks.checkPublicApi;
const checkEventNamespaces = repoSurfaceChecks.checkEventNamespaces;
const checkEvalResultArtifactBoundary = repoSurfaceChecks.checkEvalResultArtifactBoundary;
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

const runtimeProofChecks = createRuntimeProofChecks({
  fs,
  path,
  ts,
  repoRoot,
  read,
  readJson,
  walk,
  execFileSync,
  failIfAny,
});
const checkBackendProviderAxisBoundary = runtimeProofChecks.checkBackendProviderAxisBoundary;
const checkBackendNeutralProductionRuntimeProof =
  runtimeProofChecks.checkBackendNeutralProductionRuntimeProof;
const checkNodePostgresRuntimeImportBoundary =
  runtimeProofChecks.checkNodePostgresRuntimeImportBoundary;

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
const checkConvergencePublicSurface = convergenceSmokeChecks.checkConvergencePublicSurface;
const checkDocsSiteBuild = convergenceSmokeChecks.checkDocsSiteBuild;
const checkCliSurface = convergenceSmokeChecks.checkCliSurface;
const checkConsumerImports = convergenceSmokeChecks.checkConsumerImports;
const checkDogfoodSmoke = convergenceSmokeChecks.checkDogfoodSmoke;
const checkBlueprintRecipes = convergenceSmokeChecks.checkBlueprintRecipes;

const source = (path, symbol) => ({ path, symbol });
const checker = (run, options = {}) => ({ run, ...options });
const convergenceBoundaryComponents = [
  "client-boundaries",
  "generated-static-target-linking",
  "blueprint-recipes",
  "spike-hygiene",
];
const runConvergenceBoundary = async () => {
  for (const checkerId of convergenceBoundaryComponents) {
    await Promise.resolve(checkerById.get(checkerId).run([]));
  }
  console.log("convergence boundary passed");
};

const checkerById = new Map([
  ["architecture-sources", checker(checkArchitectureSources)],
  [
    "backend-neutrality",
    checker(checkBackendNeutrality, {
      source: source(
        "packages/cli/src/check/algorithmic/runtime-structural-checks.mjs",
        "checkBackendNeutrality",
      ),
    }),
  ],
  [
    "backend-neutral-production-runtime-proof",
    checker(checkBackendNeutralProductionRuntimeProof, {
      source: source(
        "packages/cli/src/check/algorithmic/runtime-proof-checks.mjs",
        "backendNeutralProductionRuntimeProof",
      ),
    }),
  ],
  [
    "backend-provider-axis-boundary",
    checker(checkBackendProviderAxisBoundary, {
      source: source(
        "packages/cli/src/check/algorithmic/runtime-proof-checks.mjs",
        "backendProviderAxisFailures",
      ),
    }),
  ],
  [
    "blueprint-recipes",
    checker(checkBlueprintRecipes, {
      source: source(
        "packages/cli/src/check/algorithmic/convergence-smoke-checks.mjs",
        "checkBlueprintRecipes",
      ),
    }),
  ],
  ["cli-surface", checker(checkCliSurface)],
  [
    "client-boundaries",
    checker(checkClientBoundaries, {
      source: source(
        "packages/cli/src/check/algorithmic/client-boundary-checks.mjs",
        "checkClientBoundaries",
      ),
    }),
  ],
  ["consumer-imports", checker(checkConsumerImports, { acceptsArgs: true })],
  [
    "convergence-boundary",
    checker(runConvergenceBoundary, {
      source: source("packages/cli/src/check/algorithmic-checks.mjs", "runConvergenceBoundary"),
      components: convergenceBoundaryComponents,
    }),
  ],
  [
    "convergence-import-dag",
    checker(checkConvergenceImportDag, {
      source: source(
        "packages/cli/src/check/algorithmic/package-boundary-checks.mjs",
        "checkConvergenceImportDag",
      ),
    }),
  ],
  [
    "convergence-public-surface",
    checker(checkConvergencePublicSurface, {
      source: source(
        "packages/cli/src/check/algorithmic/convergence-smoke-checks.mjs",
        "checkConvergencePublicSurface",
      ),
    }),
  ],
  ["distribution-units", checker(checkDistributionUnits, { acceptsArgs: true })],
  ["dogfood-smoke", checker(checkDogfoodSmoke, { acceptsArgs: true })],
  [
    "docs-link-integrity",
    checker(checkDocsLinkIntegrity, {
      source: source(
        "packages/cli/src/check/algorithmic/package-boundary-checks.mjs",
        "checkDocsLinkIntegrity",
      ),
    }),
  ],
  [
    "docs-site-build",
    checker(checkDocsSiteBuild, {
      source: source(
        "packages/cli/src/check/algorithmic/convergence-smoke-checks.mjs",
        "checkDocsSiteBuild",
      ),
    }),
  ],
  [
    "event-namespaces",
    checker(checkEventNamespaces, {
      source: source(
        "packages/cli/src/check/algorithmic/repo-surface-checks.mjs",
        "checkEventNamespaces",
      ),
    }),
  ],
  [
    "eval-result-artifact-boundary",
    checker(checkEvalResultArtifactBoundary, {
      source: source(
        "packages/cli/src/check/algorithmic/repo-surface-checks.mjs",
        "checkEvalResultArtifactBoundary",
      ),
    }),
  ],
  [
    "limit-registry",
    checker(checkLimitRegistry, {
      source: source(
        "packages/cli/src/check/algorithmic/projection-boundary-checks.mjs",
        "checkLimitRegistry",
      ),
    }),
  ],
  [
    "generated-static-target-linking",
    checker(checkGeneratedStaticTargetLinking, {
      source: source(
        "packages/cli/src/check/algorithmic/static-target-checks.mjs",
        "checkGeneratedStaticTargetLinking",
      ),
    }),
  ],
  [
    "gate-tier-governance",
    checker(checkGateTierGovernance, {
      source: source(
        "packages/cli/src/check/algorithmic/runtime-structural-checks.mjs",
        "checkGateTierGovernance",
      ),
    }),
  ],
  ["module-graph-oracle", checker(checkModuleGraphOracle)],
  ["module-buckets", checker(checkModuleBuckets, { acceptsArgs: true })],
  [
    "node-postgres-runtime-import-boundary",
    checker(checkNodePostgresRuntimeImportBoundary, {
      source: source(
        "packages/cli/src/check/algorithmic/runtime-proof-checks.mjs",
        "nodePostgresRuntimeImportBoundaryFailures",
      ),
    }),
  ],
  ["no-obsolete-public-packages", checker(checkNoObsoletePublicPackages)],
  ["owner-coupling", checker(checkOwnerCoupling, { acceptsArgs: true })],
  ["owner-identity-boundary", checker(checkOwnerIdentityBoundary, { acceptsArgs: true })],
  ["owner-ids", checker(checkOwnerIds)],
  ["profile-verification", checker(checkProfileVerification, { acceptsArgs: true })],
  ["projection-fold-boundary", checker(checkProjectionFoldBoundary)],
  [
    "public-api",
    checker(checkPublicApi, {
      source: source(
        "packages/cli/src/check/algorithmic/repo-surface-checks.mjs",
        "checkPublicApi",
      ),
    }),
  ],
  [
    "repo-tooling-surface",
    checker(checkRepoToolingSurface, {
      source: source(
        "packages/cli/src/check/algorithmic/repo-surface-checks.mjs",
        "checkRepoToolingSurface",
      ),
    }),
  ],
  [
    "source-aliases",
    checker(checkSourceAliases, {
      source: source(
        "packages/cli/src/check/algorithmic/source-alias-checks.mjs",
        "checkSourceAliases",
      ),
    }),
  ],
  [
    "spike-hygiene",
    checker(checkSpikeHygiene, {
      source: source(
        "packages/cli/src/check/algorithmic/runtime-structural-checks.mjs",
        "checkSpikeHygiene",
      ),
    }),
  ],
  ["subpath-no-leak", checker(checkSubpathNoLeak, { acceptsArgs: true })],
  [
    "substrate-import-dag",
    checker(checkSubstrateImportDag, {
      source: source(
        "packages/cli/src/check/algorithmic/package-boundary-checks.mjs",
        "checkSubstrateImportDag",
      ),
    }),
  ],
  [
    "transaction-sync",
    checker(checkTransactionSync, {
      source: source(
        "packages/cli/src/check/algorithmic/runtime-structural-checks.mjs",
        "checkTransactionSync",
      ),
    }),
  ],
]);

export const listAlgorithmicCheckers = () => [...checkerById.keys()].sort(compare);
export const hasAlgorithmicChecker = (checkerId) => checkerById.has(checkerId);
export const algorithmicCheckerSource = (checkerId) => checkerById.get(checkerId)?.source;
export const algorithmicCheckerComponents = (checkerId) => checkerById.get(checkerId)?.components;
export const algorithmicCheckerAcceptsArgs = (checkerId) =>
  checkerById.get(checkerId)?.acceptsArgs === true;

export const runAlgorithmicChecker = async (checkerId, args = []) => {
  const definition = checkerById.get(checkerId);
  if (definition === undefined) throw new Error(`unknown algorithmic checker ${checkerId}`);
  console.log(`$ agentos algorithmic-check ${checkerId}`);
  const resolutionSession = ts.beginModuleResolutionSession();
  try {
    await Promise.resolve(definition.run(args));
  } finally {
    resolutionSession.dispose();
  }
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
