import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  deriveAffectedGateProjection,
  deriveAffectedGates,
  projectAffectedGraphFacts,
} from "../src/check/gate-selector.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const manifest = JSON.parse(
  readFileSync(path.join(repoRoot, "docs/agent/gates.source.json"), "utf8"),
);
const compare = (left, right) => left.localeCompare(right);
const expectedAlways = Object.entries(manifest.proofClasses)
  .filter(([, proof]) => proof.always === true)
  .map(([proofClass]) => proofClass)
  .sort(compare);
const expectedFull = [...new Set([...expectedAlways, ...manifest.fullAffectedProofClasses])].sort(
  compare,
);

void test("affected selector fails closed for global surfaces and unknown paths", () => {
  for (const changedPath of ["docs/agent/gates.source.json", ".node-version", "unknown/path.txt"]) {
    const result = deriveAffectedGates({ changedPaths: [changedPath] });
    assert.equal(result.mode, "full", changedPath);
    assert.deepEqual(result.proofClasses, expectedFull, changedPath);
  }
  assert.match(
    deriveAffectedGates({ changedPaths: [".node-version"] }).provenance[0].reason,
    /global config surface/u,
  );
});

void test("affected selector executes manifest-owned always proofs even without changes", () => {
  const ordinary = deriveAffectedGates({ changedPaths: ["packages/core/src/index.ts"] });
  assert.equal(ordinary.mode, "affected");
  assert.ok(expectedAlways.every((proofClass) => ordinary.proofClasses.includes(proofClass)));
  assert.ok(
    expectedAlways.every((proofClass) =>
      ordinary.run.some((entry) => entry.proofClass === proofClass),
    ),
  );

  const unchanged = deriveAffectedGates({ changedPaths: [] });
  assert.equal(unchanged.mode, "affected");
  assert.deepEqual(unchanged.proofClasses, expectedAlways);
  assert.deepEqual(
    unchanged.run.map((entry) => entry.proofClass),
    expectedAlways,
  );
});

void test("affected selector routes runtime package changes to runtime proof", () => {
  const result = deriveAffectedGates({
    changedPaths: ["packages/runtime/src/node/index.ts"],
  });
  assert.equal(result.mode, "affected");
  assert.ok(expectedAlways.every((proofClass) => result.proofClasses.includes(proofClass)));
  assert.ok(result.proofClasses.includes("runtime"));
  assert.ok(result.run.some((entry) => entry.command === "pnpm run check:runtime"));
});

void test("affected selector uses reverse dependency closure", () => {
  const result = deriveAffectedGates({ changedPaths: ["packages/core/src/index.ts"] });
  assert.equal(result.mode, "affected");
  assert.ok(result.affectedPackages.includes("@agent-os/runtime"));
  assert.ok(result.proofClasses.includes("runtime"));
});

void test("affected selector maps package manifest changes to distribution proof", () => {
  const result = deriveAffectedGates({
    changedPaths: ["packages/runtime/package.json"],
  });
  assert.equal(result.mode, "affected");
  assert.ok(result.proofClasses.includes("distribution"));
});

void test("affected selector promotes dependency and graph-fidelity drift to full mode", () => {
  const core = { name: "@agent-os/core", path: "packages/core" };
  const runtime = { name: "@agent-os/runtime", path: "packages/runtime" };
  const graph = projectAffectedGraphFacts({
    sourceEdges: [
      {
        from: runtime,
        to: core,
        file: "packages/runtime/src/drift.ts",
        specifier: "@agent-os/core",
      },
    ],
    manifestEdges: [],
    tsconfigEdges: [],
    declaredExtraEdges: [],
  });

  assert.deepEqual(
    graph.dependencyDrift.map((entry) => entry.kind),
    ["dependency-drift"],
  );
  assert.deepEqual(
    graph.fidelityFailures.map((entry) => entry.kind),
    ["graph-fidelity-drift"],
  );

  const result = deriveAffectedGateProjection({
    manifest,
    records: [core, runtime],
    changedPaths: ["packages/core/src/index.ts"],
    graph,
  });
  assert.equal(result.mode, "full");
  assert.deepEqual(result.proofClasses, expectedFull);
  assert.deepEqual(result.diagnostics.map((entry) => entry.kind).sort(compare), [
    "dependency-drift",
    "graph-fidelity-drift",
  ]);
});
