import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  distributionRootsRegistryFindings,
  distributionEffectPeerFindings,
  distributionFindingsForPackage,
  distributionManifestFindings,
  distributionUnitNegativeFixtureFailures,
  distributionUnitRegistryFindings,
  packageUnitOptionalPeerAllowsEdge,
  packageUnitsRegistryFindings,
} from "../src/check/algorithmic-checks.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const record = {
  name: "@agent-os/runtime",
  path: "packages/runtime",
};

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

  assert.deepEqual(
    packageUnitsRegistryFindings({
      registry: packageUnits,
      bucketIds,
      ambientIds,
      targetProfileIds,
    }),
    [],
  );
  assert.deepEqual(
    distributionRootsRegistryFindings({
      registry: distributionRoots,
      packageUnitIds,
      ambientIds,
    }),
    [],
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
        to: { name: "@agent-os/ops-api", path: "tooling/ops-api" },
        file: "packages/runtime/src/cloudflare/ops-api.ts",
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
