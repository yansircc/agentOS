#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import {
  apiSourceMode,
  exportedNamesForPackage,
  sourceTsdocApiMarkdown,
  sourceTsdocModes,
  sourceTsdocRecordsForPackage,
  validateSourceTsdocRecords,
} from "./public-api-model.mjs";

const root = process.cwd();
const surface = JSON.parse(fs.readFileSync(path.join(root, "docs/surface.json"), "utf8"));
const targets = surface.packages.filter((pkg) => pkg.apiSource !== undefined);

const manifestNames = (manifest, section) => {
  const source = fs.readFileSync(manifest, "utf8");
  const start = source.indexOf(`## ${section}`);
  if (start === -1) return new Set();
  const rest = source.slice(start + section.length + 3);
  const next = rest.search(/^## /m);
  const body = next === -1 ? rest : rest.slice(0, next);
  return new Set([...body.matchAll(/`([^`:]+):([^`]+)`/g)].map((match) => match[0].slice(1, -1)));
};

let failed = false;

const fail = (message) => {
  console.error(message);
  failed = true;
};

for (const target of targets) {
  const manifest = path.join(root, target.apiSource);
  if (!fs.existsSync(manifest)) {
    fail(`missing public API intent source for ${target.name}: ${target.apiSource}`);
    continue;
  }

  const mode = apiSourceMode(target);
  if (sourceTsdocModes.has(mode)) {
    const records = sourceTsdocRecordsForPackage(root, target);
    for (const message of validateSourceTsdocRecords(target, records)) fail(message);

    const expected = `${sourceTsdocApiMarkdown(target, records).replace(/\s+$/u, "")}\n`;
    const actual = fs.readFileSync(manifest, "utf8");
    if (actual !== expected) {
      fail(`${target.apiSource} is stale; run bun run docs:generate`);
    }
  } else if (mode !== "manual") {
    fail(`${target.name}: unsupported apiSourceMode ${mode}`);
  }

  const publicExports = manifestNames(manifest, "Public exports");
  const experimental = manifestNames(manifest, "Experimental exports");
  const deprecated = manifestNames(manifest, "Deprecated exports");
  const internal = manifestNames(manifest, "Internal-only exports");
  const declaredPublic = new Set([...publicExports, ...experimental, ...deprecated]);

  const actual = exportedNamesForPackage(root, target)
    .map((record) => record.key)
    .sort();

  for (const name of actual) {
    if (!declaredPublic.has(name)) {
      fail(`${target.name}: exported but not declared in ${target.apiSource}: ${name}`);
    }
    if (internal.has(name)) {
      fail(`${target.name}: internal export is still exported: ${name}`);
    }
  }

  for (const name of declaredPublic) {
    const key = String(name);
    if (!actual.includes(key)) {
      fail(`${target.name}: ${target.apiSource} lists missing export: ${key}`);
    }
  }
}

if (failed) process.exit(1);
console.log("public API manifests match package exports");
