import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  moduleGraphOracleFailures,
  packageSourceImportEdges,
  sourceModuleImportEdges,
  workspacePackageRecords,
} from "../src/check/package-graph.mjs";

const write = (root, file, content) => {
  const absolutePath = path.join(root, file);
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content);
};

const fixtureRepo = () => {
  const root = mkdtempSync(path.join(tmpdir(), "agentos-module-graph-"));
  write(
    root,
    "package.json",
    JSON.stringify(
      {
        private: true,
        type: "module",
        workspaces: ["packages/*"],
      },
      null,
      2,
    ),
  );
  write(
    root,
    "tsconfig.source-paths.json",
    JSON.stringify(
      {
        compilerOptions: {
          paths: {
            "@agent-os/a": ["./packages/a/src/index.ts"],
            "@agent-os/a/subpath": ["./packages/a/src/subpath.ts"],
            "@agent-os/b": ["./packages/b/src/index.ts"],
          },
        },
      },
      null,
      2,
    ),
  );
  write(
    root,
    "tsconfig.json",
    JSON.stringify(
      {
        extends: "./tsconfig.source-paths.json",
        compilerOptions: {
          module: "ESNext",
          moduleResolution: "Bundler",
          target: "ES2022",
          strict: true,
        },
      },
      null,
      2,
    ),
  );
  write(root, "packages/a/package.json", '{"name":"@agent-os/a","type":"module"}\n');
  write(root, "packages/b/package.json", '{"name":"@agent-os/b","type":"module"}\n');
  write(
    root,
    "packages/a/src/index.ts",
    [
      'import type { SharedType } from "@agent-os/b";',
      'export { localValue } from "./barrel";',
      'export type { LocalType } from "./types";',
      'export { subpathValue } from "@agent-os/a/subpath";',
      'export const loadDynamic = () => import("./dynamic");',
      "export type Public = SharedType;",
      "",
    ].join("\n"),
  );
  write(root, "packages/a/src/barrel.ts", 'export { localValue } from "./local";\n');
  write(root, "packages/a/src/local.ts", "export const localValue = 1;\n");
  write(root, "packages/a/src/types.ts", "export interface LocalType { readonly id: string }\n");
  write(root, "packages/a/src/subpath.ts", "export const subpathValue = 2;\n");
  write(root, "packages/a/src/dynamic.ts", "export const dynamicValue = 3;\n");
  write(root, "packages/b/src/index.ts", "export interface SharedType { readonly id: string }\n");
  return root;
};

void test("source module graph keeps same-package, type, re-export, dynamic, and alias edges", () => {
  const root = fixtureRepo();
  const records = workspacePackageRecords(root);
  const edges = sourceModuleImportEdges(root, records);

  assert.equal(moduleGraphOracleFailures(root, records).join("\n"), "");
  assert.ok(
    edges.some(
      (edge) =>
        edge.fromFile === "packages/a/src/index.ts" &&
        edge.toFile === "packages/a/src/barrel.ts" &&
        edge.syntaxKind === "export",
    ),
    "re-export edge from index.ts to barrel.ts was not retained",
  );
  assert.ok(
    edges.some(
      (edge) =>
        edge.fromFile === "packages/a/src/index.ts" &&
        edge.toFile === "packages/a/src/types.ts" &&
        edge.importKind === "type",
    ),
    "type-only edge from index.ts to types.ts was not retained",
  );
  assert.ok(
    edges.some(
      (edge) =>
        edge.fromFile === "packages/a/src/index.ts" &&
        edge.toFile === "packages/a/src/dynamic.ts" &&
        edge.importKind === "dynamic",
    ),
    "dynamic import edge from index.ts to dynamic.ts was not retained",
  );
  assert.ok(
    edges.some(
      (edge) =>
        edge.fromFile === "packages/a/src/index.ts" &&
        edge.toFile === "packages/a/src/subpath.ts" &&
        edge.specifier === "@agent-os/a/subpath",
    ),
    "same-package subpath alias edge was not retained",
  );
  assert.ok(
    edges.some(
      (edge) =>
        edge.fromFile === "packages/a/src/index.ts" &&
        edge.to.name === "@agent-os/b" &&
        edge.importKind === "type",
    ),
    "cross-package type edge was not retained",
  );
});

void test("package graph remains a projection of module graph and drops only same-package package edges", () => {
  const root = fixtureRepo();
  const records = workspacePackageRecords(root);
  const packageEdges = packageSourceImportEdges(root, records);

  assert.ok(
    packageEdges.some((edge) => edge.from.name === "@agent-os/a" && edge.to.name === "@agent-os/b"),
  );
  assert.ok(
    packageEdges.every((edge) => edge.from.name !== edge.to.name),
    "package projection must not expose same-package package self-edges",
  );
});
