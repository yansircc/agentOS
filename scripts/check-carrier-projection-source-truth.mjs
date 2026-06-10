#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const failures = [];

const slash = (value) => value.split(path.sep).join("/");
const repoPath = (file) => slash(path.relative(root, file));
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

const carrierDefinitionFiles = () => {
  const carrierRoot = path.join(root, "packages/carriers");
  if (!fs.existsSync(carrierRoot)) return [];
  return fs
    .readdirSync(carrierRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(carrierRoot, entry.name, "src/definition.ts"))
    .filter((file) => fs.existsSync(file))
    .sort((left, right) => left.localeCompare(right));
};

const failMatches = (file, source, checks) => {
  for (const { pattern, message } of checks) {
    for (const match of source.matchAll(pattern)) {
      const line = source.slice(0, match.index ?? 0).split("\n").length;
      failures.push(`${file}:${line}: ${message}`);
    }
  }
};

const kernelCarrier = read("packages/kernel/src/carrier.ts");
failMatches("packages/kernel/src/carrier.ts", kernelCarrier, [
  {
    pattern: /\bCarrierProjection\b/gu,
    message: "carrier projection type is not a source of truth",
  },
  {
    pattern: /\bledgerProjection\b/gu,
    message: "ledgerProjection helper reintroduces a synthetic carrier projection axis",
  },
  {
    pattern: /readonly\s+projection\s*:/gu,
    message: "defineCarrier must not expose carrier-local projection state",
  },
]);

for (const file of carrierDefinitionFiles()) {
  const source = fs.readFileSync(file, "utf8");
  failMatches(repoPath(file), source, [
    {
      pattern: /\bledgerProjection\b/gu,
      message: "carrier definitions must not import or call ledgerProjection",
    },
    {
      pattern: /\bprojection\s*:/gu,
      message: "carrier definitions must not declare projection facts",
    },
  ]);
}

const generator = read("scripts/generate-carrier-reference.mjs");
failMatches("scripts/generate-carrier-reference.mjs", generator, [
  {
    pattern: /Projection:\s*derivedFromLedger/gu,
    message: "carrier reference must not render synthetic boundary projection booleans",
  },
  {
    pattern: /projection reference facts/gu,
    message: "carrier reference ownership text must not claim projection facts",
  },
]);

const carrierReference = read("docs/reference/carriers.md");
failMatches("docs/reference/carriers.md", carrierReference, [
  {
    pattern: /^Projection:\s*/gmu,
    message: "generated carrier reference must not contain carrier projection rows",
  },
  {
    pattern: /projection reference facts/gu,
    message: "generated carrier reference must not claim projection fact ownership",
  },
]);

for (const file of ["docs/api/kernel.md", "packages/kernel/PUBLIC_API.md"]) {
  const source = read(file);
  failMatches(file, source, [
    {
      pattern: /\bCarrierProjection\b/gu,
      message: "kernel API docs must not advertise the removed carrier projection type",
    },
    {
      pattern: /\bledgerProjection\b/gu,
      message: "kernel API docs must not advertise the removed ledgerProjection helper",
    },
  ]);
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log("carrier projection source truth holds");
