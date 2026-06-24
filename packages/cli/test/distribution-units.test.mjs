import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  consumerFacingSpecifierFailuresForContent,
  distributionRootsRegistryFindings,
  distributionEffectPeerFindings,
  distributionFindingsForPackage,
  distributionManifestFindings,
  distributionUnitNegativeFixtureFailures,
  distributionUnitRegistryFindings,
  markdownLinkFailuresForContent,
  packageConstraintNameFailures,
  packageUnitOptionalPeerAllowsEdge,
  packageUnitsRegistryFindings,
} from "../src/check/algorithmic-checks.mjs";
import { runtimePublicSurfaceFindings } from "../src/check/algorithmic/convergence-smoke-checks.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const record = {
  name: "@agent-os/runtime",
  path: "packages/runtime",
};

const runtimeSurface = (entrypoints) => ({
  name: "@agent-os/runtime",
  path: "packages/runtime",
  entrypoints,
});

const runtimePackage = (subpaths) => ({
  exports: Object.fromEntries(subpaths.map((subpath) => [subpath, { default: "./src/index.ts" }])),
});

void test("runtime public surface guard accepts classified stable and host substrate", () => {
  assert.deepEqual(
    runtimePublicSurfaceFindings({
      surfacePackage: runtimeSurface([
        {
          subpath: ".",
          audiences: ["advanced"],
          capability: "runtime algebra",
          surfaceClass: "stable-contract",
        },
        {
          subpath: "./local",
          audiences: ["generated-only", "advanced"],
          capability: "local host substrate",
          surfaceClass: "first-party-host-substrate",
        },
        {
          subpath: "./workspace-binding",
          audiences: ["generated-only"],
          capability: "generated workspace binding",
          surfaceClass: "generated-target-wiring",
        },
        {
          subpath: "./llm-effect-ai/openai-compatible",
          audiences: ["generated-only", "advanced"],
          capability: "OpenAI-compatible transport",
          surfaceClass: "stable-contract",
        },
      ]),
      runtimePackageJson: runtimePackage([
        ".",
        "./local",
        "./workspace-binding",
        "./llm-effect-ai/openai-compatible",
      ]),
    }),
    [],
  );
});

void test("runtime public surface guard rejects unclassified extension-shaped exports", () => {
  const findings = runtimePublicSurfaceFindings({
    surfacePackage: runtimeSurface([
      {
        subpath: ".",
        audiences: ["advanced"],
        capability: "runtime algebra",
        surfaceClass: "stable-contract",
      },
      {
        subpath: "./slack",
        audiences: ["advanced"],
        capability: "Slack channel helper",
      },
    ]),
    runtimePackageJson: runtimePackage([".", "./slack"]),
  });

  assert.equal(
    findings.includes(
      "@agent-os/runtime/slack: runtime surfaceClass must be one of stable-contract, first-party-host-substrate, generated-target-wiring, app-owned-integration-recipe",
    ),
    true,
  );
});

void test("runtime public surface guard rejects blueprint-owned integration as runtime export", () => {
  const findings = runtimePublicSurfaceFindings({
    surfacePackage: runtimeSurface([
      {
        subpath: ".",
        audiences: ["advanced"],
        capability: "runtime algebra",
        surfaceClass: "stable-contract",
      },
      {
        subpath: "./sentry",
        audiences: ["advanced"],
        capability: "Sentry observability helper",
        surfaceClass: "app-owned-integration-recipe",
      },
    ]),
    runtimePackageJson: runtimePackage([".", "./sentry"]),
  });

  assert.equal(
    findings.includes(
      "@agent-os/runtime/sentry: runtime public export cannot be classified app-owned-integration-recipe; keep app-owned integrations in blueprint recipes",
    ),
    true,
  );
  assert.equal(
    findings.includes(
      "@agent-os/runtime/sentry: observability integration-shaped runtime export must be classified as stable substrate, not app-owned-integration-recipe",
    ),
    true,
  );
});

void test("runtime public surface guard requires package exports and surface facts to agree", () => {
  const findings = runtimePublicSurfaceFindings({
    surfacePackage: runtimeSurface([
      {
        subpath: ".",
        audiences: ["advanced"],
        capability: "runtime algebra",
        surfaceClass: "stable-contract",
      },
      {
        subpath: "./local",
        audiences: ["generated-only", "advanced"],
        capability: "local host substrate",
        surfaceClass: "first-party-host-substrate",
      },
    ]),
    runtimePackageJson: runtimePackage([".", "./local", "./discord"]),
  });

  assert.deepEqual(findings, [
    "@agent-os/runtime/discord: runtime package export is missing docs/surface.json entrypoint",
  ]);
});

void test("distribution architecture sources are valid", () => {
  const moduleBuckets = JSON.parse(
    fs.readFileSync(path.join(repoRoot, "architecture/module-buckets.json"), "utf8"),
  );
  const packageUnits = JSON.parse(
    fs.readFileSync(path.join(repoRoot, "architecture/package-units.json"), "utf8"),
  );
  const distributionRoots = JSON.parse(
    fs.readFileSync(path.join(repoRoot, "architecture/distribution-roots.json"), "utf8"),
  );
  const bucketIds = new Set(moduleBuckets.buckets.map((bucket) => bucket.id));
  const ambientIds = new Set(moduleBuckets.ambients.map((ambient) => ambient.id));
  const packageUnitIds = new Set(packageUnits.packageUnits.map((unit) => unit.id));
  const targetProfileIds = new Set(distributionRoots.targetProfiles.map((profile) => profile.id));
  const workspacePackageRecordsByName = new Map(
    ["core", "runtime", "client", "cli"].map((id) => [
      `@agent-os/${id}`,
      { name: `@agent-os/${id}`, path: `packages/${id}` },
    ]),
  );
  const packageUnitsById = new Map(packageUnits.packageUnits.map((unit) => [unit.id, unit]));

  assert.deepEqual(
    packageUnitsRegistryFindings({
      registry: packageUnits,
      bucketIds,
      ambientIds,
      targetProfileIds,
      workspacePackageRecordsByName,
    }),
    [],
  );
  assert.deepEqual(
    distributionRootsRegistryFindings({
      registry: distributionRoots,
      packageUnitIds,
      ambientIds,
      packageUnitsById,
    }),
    [],
  );
});

void test("package-unit registry exactness rejects public/export drift", () => {
  const findings = packageUnitsRegistryFindings({
    registry: {
      schemaVersion: 1,
      policy: {
        packageBoundary: "policy",
        namespaceSplit: "policy",
        effectPeer: "policy",
      },
      packageUnits: [
        {
          id: "runtime",
          targetSourcePackageName: "@agent-os/runtime",
          publicPackageName: "@yansirplus/not-runtime",
          status: "target",
          hardInstallEnvelope: {
            dependencies: [],
            installScripts: [],
            nativeArtifacts: [],
            packageWideMetadata: [],
            requiredPeers: [],
          },
          runtimeConditions: ["neutral"],
          targetProfiles: ["neutral"],
          publicSubpaths: [{ subpath: ".", moduleBuckets: ["ledger"], optionalPeers: [] }],
        },
      ],
    },
    bucketIds: new Set(["ledger"]),
    ambientIds: new Set(["neutral"]),
    targetProfileIds: new Set(["neutral"]),
    workspacePackageRecordsByName: new Map([
      ["@agent-os/runtime", { name: "@agent-os/runtime", path: "packages/runtime" }],
    ]),
  });

  assert.equal(
    findings.some((finding) => finding.includes("publicPackageName must be @yansirplus/runtime")),
    true,
  );
  assert.equal(
    findings.some((finding) =>
      finding.includes("publicSubpaths missing package.json export @agent-os/runtime/admission"),
    ),
    true,
  );
});

void test("distribution roots require exact profile coverage for public subpaths", () => {
  const packageUnitsById = new Map([
    [
      "runtime",
      {
        id: "runtime",
        publicPackageName: "@yansirplus/runtime",
        publicSubpaths: [
          { subpath: ".", targetProfiles: ["neutral"] },
          { subpath: "./cloudflare", targetProfiles: ["cloudflare-worker"] },
        ],
      },
    ],
  ]);
  const base = {
    schemaVersion: 1,
    policy: {
      rootTruth: "policy",
      dogfoodWitness: "policy",
      targetSelection: "policy",
    },
    roots: [
      {
        id: "public-runtime",
        kind: "public-package",
        packageUnit: "runtime",
        publicPackageName: "@yansirplus/runtime",
        consumerRoot: "runtime",
      },
    ],
    dogfoodRoots: [
      {
        id: "spike",
        kind: "external-consumer",
        path: "spikes/",
        witnessLevel: "capability",
        gate: "gate",
        requiredCapabilities: ["runtime"],
      },
    ],
  };

  const missing = distributionRootsRegistryFindings({
    registry: {
      ...base,
      targetProfiles: [
        {
          id: "neutral",
          ambient: "neutral",
          packageUnits: ["runtime"],
          selectedSubpaths: ["@yansirplus/runtime"],
          forbiddenSpecifiers: [],
        },
        {
          id: "cloudflare-worker",
          ambient: "cloudflare-worker",
          packageUnits: ["runtime"],
          selectedSubpaths: [],
          forbiddenSpecifiers: [],
        },
      ],
    },
    packageUnitIds: new Set(["runtime"]),
    ambientIds: new Set(["neutral", "cloudflare-worker"]),
    packageUnitsById,
  });
  assert.equal(
    missing.some((finding) =>
      finding.includes(
        "selectedSubpaths is missing @yansirplus/runtime/cloudflare, which package-units assigns to targetProfile cloudflare-worker",
      ),
    ),
    true,
  );

  const wrongProfile = distributionRootsRegistryFindings({
    registry: {
      ...base,
      targetProfiles: [
        {
          id: "neutral",
          ambient: "neutral",
          packageUnits: ["runtime"],
          selectedSubpaths: ["@yansirplus/runtime", "@yansirplus/runtime/cloudflare"],
          forbiddenSpecifiers: [],
        },
      ],
    },
    packageUnitIds: new Set(["runtime"]),
    ambientIds: new Set(["neutral", "cloudflare-worker"]),
    packageUnitsById,
  });
  assert.equal(
    wrongProfile.some((finding) =>
      finding.includes(
        "selectedSubpaths includes @yansirplus/runtime/cloudflare, which package-units does not assign to targetProfile neutral",
      ),
    ),
    true,
  );
});

void test("distribution manifest scanner reports package-wide install obligations", () => {
  const findings = distributionManifestFindings(
    record,
    {
      scripts: {
        install: "node-gyp rebuild",
      },
      dependencies: {
        "@agent-os/core": "workspace:*",
        sharp: "^1.0.0",
      },
      devDependencies: {
        "node-gyp": "^10.0.0",
      },
      engines: {
        node: ">=22",
      },
      os: ["darwin"],
      gypfile: true,
    },
    ["packages/runtime/binding.gyp", "packages/runtime/build/addon.node"],
  );

  assert.deepEqual(
    findings.map((finding) => finding.kind),
    [
      "package-install-script",
      "native-marker",
      "native-marker",
      "native-marker",
      "native-tool-dependency",
      "package-wide-metadata",
      "package-wide-metadata",
      "hard-dependency",
    ],
  );
  assert.equal(findings.find((finding) => finding.kind === "hard-dependency")?.specifier, "sharp");
});

void test("optional peer locality is a subpath fact, not a hard package split", () => {
  const findings = distributionFindingsForPackage({
    record,
    manifest: {
      peerDependencies: {
        react: "^19",
      },
      peerDependenciesMeta: {
        react: {
          optional: true,
        },
      },
      exports: {
        ".": "./src/index.ts",
        "./react": "./src/react.ts",
      },
    },
    sourceByFile: new Map([
      ["packages/runtime/src/index.ts", "export const root = 1;"],
      ["packages/runtime/src/react.ts", 'import { useMemo } from "react"; export { useMemo };'],
    ]),
    edges: [],
  });

  assert.deepEqual(
    findings.map((finding) => [finding.kind, finding.severity, finding.specifier]),
    [
      ["optional-peer", "info", "react"],
      ["optional-peer-locality", "info", "react"],
    ],
  );
});

void test("package import DAG allows only declared subpath optional peer edges", () => {
  const registry = {
    packageUnits: [
      {
        targetSourcePackageName: "@agent-os/runtime",
        publicSubpaths: [
          {
            subpath: ".",
            optionalPeers: [],
          },
          {
            subpath: "./cloudflare",
            optionalPeers: ["@agent-os/sse-http"],
          },
        ],
      },
    ],
  };
  const to = { name: "@agent-os/sse-http", path: "packages/transports/sse-http" };

  assert.equal(
    packageUnitOptionalPeerAllowsEdge({
      registry,
      edge: {
        from: record,
        to,
        file: "packages/runtime/src/cloudflare/ag-ui-sse.ts",
      },
    }),
    true,
  );
  assert.equal(
    packageUnitOptionalPeerAllowsEdge({
      registry,
      edge: {
        from: record,
        to,
        file: "packages/runtime/src/index.ts",
      },
    }),
    false,
  );
  assert.equal(
    packageUnitOptionalPeerAllowsEdge({
      registry,
      edge: {
        from: record,
        to: {
          name: "@agent-os/workspace-env",
          path: "packages/execution-domains/workspace-env",
        },
        file: "packages/runtime/src/index.ts",
      },
    }),
    false,
  );
});

void test("package unit semantics reject root and hard-obligation optional peers", () => {
  const findings = distributionUnitRegistryFindings({
    expectedEffectRange: "^4.0.0",
    registry: {
      packageUnits: [
        {
          id: "client",
          hardInstallEnvelope: {
            dependencies: ["react"],
            installScripts: [],
            nativeArtifacts: [],
            packageWideMetadata: [],
            requiredPeers: [{ name: "effect", range: "^5.0.0" }],
          },
          publicSubpaths: [
            { subpath: ".", optionalPeers: ["react"] },
            { subpath: "./react", optionalPeers: ["react"] },
          ],
        },
      ],
    },
  });

  assert.deepEqual(
    findings.map((finding) => [finding.kind, finding.specifier]),
    [
      ["package-unit-root-optional-peer", "react"],
      ["package-unit-hard-locality", "react"],
      ["package-unit-hard-locality", "react"],
      ["package-unit-effect-peer-invariant", "effect"],
    ],
  );
});

void test("root closure catches value and d.ts optional peer leaks", () => {
  const findings = distributionFindingsForPackage({
    record,
    manifest: {
      peerDependencies: {
        react: "^19",
      },
      peerDependenciesMeta: {
        react: {
          optional: true,
        },
      },
      exports: {
        ".": "./src/index.ts",
        "./react": "./src/react.ts",
      },
    },
    sourceByFile: new Map([
      ["packages/runtime/src/index.ts", 'export type { ReactNode } from "./react";'],
      [
        "packages/runtime/src/react.ts",
        'import type { ReactNode } from "react"; import { useMemo } from "react"; export type { ReactNode }; export { useMemo };',
      ],
    ]),
    edges: [
      {
        from: record,
        to: record,
        fromFile: "packages/runtime/src/index.ts",
        toFile: "packages/runtime/src/react.ts",
        specifier: "./react",
      },
    ],
  });

  assert.deepEqual(
    findings.filter((finding) => finding.kind.startsWith("root-")).map((finding) => finding.kind),
    ["root-dts-peer-type-leak", "root-subpath-peer-leak"],
  );
});

void test("effect peer range scanner reports version drift", () => {
  const findings = distributionEffectPeerFindings([
    {
      record,
      manifest: {
        peerDependencies: {
          effect: "^4.0.0-beta.84",
        },
      },
    },
    {
      record: {
        name: "@agent-os/adapter",
        path: "packages/adapter",
      },
      manifest: {
        peerDependencies: {
          effect: "^5.0.0",
        },
      },
    },
  ]);

  assert.deepEqual(
    findings.map((finding) => [finding.kind, finding.file, finding.specifier]),
    [["effect-peer-invariant", "packages/adapter/package.json", "effect"]],
  );
});

void test("distribution unit negative fixtures prove enforce gates are live", () => {
  assert.deepEqual(distributionUnitNegativeFixtureFailures(), []);
});

void test("consumer-facing docs reject obsolete package specifiers", () => {
  const findings = consumerFacingSpecifierFailuresForContent({
    file: "docs/tutorials/example.md",
    content: [
      "Use @agent-os/runtime and @yansirplus/runtime.",
      "Do not install @agent-os/agent-authoring or @yansirplus/backend-cloudflare-do.",
      "Do not document wildcard install sets like @agent-os/* or @yansirplus/*.",
      "",
    ].join("\n"),
    sourceSpecifiers: new Set(["@agent-os/runtime"]),
    publicSpecifiers: new Set(["@yansirplus/runtime"]),
    toolingSourceSpecifiers: new Set(),
  });

  assert.deepEqual(findings, [
    "docs/tutorials/example.md:2:16: obsolete consumer-facing package specifier @agent-os/agent-authoring",
    "docs/tutorials/example.md:2:45: obsolete consumer-facing package specifier @yansirplus/backend-cloudflare-do",
    "docs/tutorials/example.md:3:44: obsolete consumer-facing package specifier @agent-os/*",
    "docs/tutorials/example.md:3:59: obsolete consumer-facing package specifier @yansirplus/*",
  ]);
});

void test("docs link integrity rejects relative links to deleted docs", () => {
  const findings = markdownLinkFailuresForContent({
    file: "docs/guides/example.md",
    content:
      "Read [old package](../packages/attached-stream.md) and [external](https://example.com).\n",
  });

  assert.deepEqual(findings, [
    "docs/guides/example.md:1:6: markdown link target ../packages/attached-stream.md does not resolve to docs/packages/attached-stream.md",
  ]);
});

void test("package import DAG constraints reject stale package names", () => {
  const findings = packageConstraintNameFailures({
    ruleId: "substrate-import-dag",
    records: [{ name: "@agent-os/core", path: "packages/core" }],
    constraints: {
      forbiddenEdges: [
        {
          fromPackageNames: ["@agent-os/runtime-protocol"],
          allowedTargetPackageNames: ["@agent-os/backend-protocol"],
        },
      ],
    },
  });

  assert.deepEqual(findings, [
    "substrate-import-dag: constraints.forbiddenEdges[0].fromPackageNames references non-workspace package @agent-os/runtime-protocol",
    "substrate-import-dag: constraints.forbiddenEdges[0].allowedTargetPackageNames references non-workspace package @agent-os/backend-protocol",
  ]);
});
