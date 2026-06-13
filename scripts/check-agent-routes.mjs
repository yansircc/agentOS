#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { buildCapabilityRouteProjection } from "./lib/capability-routes.mjs";
import { collectNamespaceModel } from "./check-event-namespaces.mjs";

const root = process.cwd();
const selfTest = process.argv.includes("--self-test");

const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const readJson = (file) => JSON.parse(read(file));

const baseContext = () => ({
  primitives: [
    {
      id: "primitive.valid",
      package: "@agent-os/valid",
      invariants: ["invariant.valid"],
      docs: "docs/valid.md",
      testEvidence: { tests: ["packages/valid/test/valid.test.ts"] },
    },
    {
      id: "primitive.extra",
      package: "@agent-os/extra",
      invariants: ["invariant.valid"],
      docs: "docs/extra.md",
      testEvidence: { tests: ["packages/extra/test/extra.test.ts"] },
    },
  ],
  invariants: [{ id: "invariant.valid", docs: "docs/valid.md" }],
  rootScripts: { check: "node check.mjs" },
  namespaceOwners: [
    { prefix: "valid.", owner: "@agent-os/valid", filePath: "packages/valid/src/index.ts" },
  ],
});

const baseSource = () => ({
  schemaVersion: 1,
  rules: [
    {
      primitive: "primitive.valid",
      intents: ["do valid work"],
      sourceFactPrefixes: ["valid."],
      allowedPrimitives: ["primitive.valid", "primitive.extra"],
      forbiddenWrites: [
        {
          actor: "product",
          action: "write_fact",
          target: { kind: "eventPrefix", value: "valid." },
          invariant: "invariant.valid",
        },
      ],
      gates: ["check"],
    },
  ],
});

const selfTestFailures = () => {
  const failures = [];
  const assertFails = (label, mutate) => {
    const source = baseSource();
    const context = baseContext();
    mutate(source, context);
    const result = buildCapabilityRouteProjection({ source, ...context });
    if (result.failures.length === 0) failures.push(`${label}: expected failure`);
  };

  const valid = buildCapabilityRouteProjection({ source: baseSource(), ...baseContext() });
  if (valid.failures.length > 0) {
    failures.push(`valid fixture failed: ${JSON.stringify(valid.failures)}`);
  }

  assertFails("unknown primitive", (source) => {
    source.rules[0].primitive = "primitive.missing";
  });
  assertFails("duplicate primitive rule", (source) => {
    source.rules.push({ ...source.rules[0] });
  });
  assertFails("missing primary primitive", (source) => {
    source.rules[0].allowedPrimitives = ["primitive.extra"];
  });
  assertFails("unknown invariant", (source) => {
    source.rules[0].forbiddenWrites[0].invariant = "invariant.missing";
  });
  assertFails("unknown gate", (source) => {
    source.rules[0].gates = ["missing"];
  });
  assertFails("zero gates", (source) => {
    source.rules[0].gates = [];
  });
  assertFails("unowned event prefix", (source) => {
    source.rules[0].sourceFactPrefixes = ["missing."];
  });
  assertFails("generated fields in source", (source) => {
    source.rules[0].coordinationPackage = "@agent-os/valid";
  });
  assertFails("source prefix with multiple owners", (_source, context) => {
    context.namespaceOwners.push({
      prefix: "valid.",
      owner: "@agent-os/other",
      filePath: "packages/other/src/index.ts",
    });
  });

  return failures;
};

const regularFailures = () => {
  const failures = [];
  const primitivesJson = readJson("docs/agent/primitives.json");
  const source = readJson("docs/agent/capability-rules.source.json");
  const invariantsSource = readJson("docs/agent/invariants.source.json");
  const rootPackage = readJson("package.json");
  const namespaceModel = collectNamespaceModel(root);
  failures.push(...namespaceModel.failures);

  const projection = buildCapabilityRouteProjection({
    source,
    primitives: primitivesJson.primitives ?? [],
    invariants: invariantsSource.invariants ?? [],
    rootScripts: rootPackage.scripts ?? {},
    namespaceOwners: namespaceModel.owners,
  });
  failures.push(...projection.failures);

  const expected = {
    generatedBy: "scripts/generate-agent-docs.mjs",
    source: [
      "docs/agent/capability-rules.source.json",
      "exported TSDoc @agentosPrimitive tags",
      "BoundaryContract/event namespace declarations",
      "package.json scripts",
    ],
    routes: projection.routes,
  };
  const graphPath = path.join(root, "docs/agent/decision-graph.json");
  const actual = fs.existsSync(graphPath) ? readJson("docs/agent/decision-graph.json") : undefined;
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failures.push("docs/agent/decision-graph.json is stale");
  }

  return failures;
};

const failures = selfTest ? selfTestFailures() : regularFailures();

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(selfTest ? "agent route gate self-test passed" : "agent route gate passed");
