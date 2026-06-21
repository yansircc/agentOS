import assert from "node:assert/strict";
import test from "node:test";
import {
  distributionEffectPeerFindings,
  distributionFindingsForPackage,
  distributionManifestFindings,
} from "../src/check/algorithmic-checks.mjs";

const record = {
  name: "@agent-os/runtime",
  path: "packages/runtime",
};

void test("distribution manifest scanner reports package-wide install obligations", () => {
  const findings = distributionManifestFindings(
    record,
    {
      scripts: {
        install: "node-gyp rebuild",
      },
      dependencies: {
        "@agent-os/kernel": "workspace:*",
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
