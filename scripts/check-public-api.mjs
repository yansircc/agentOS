#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const targets = [
  "core",
  "workspace-session",
  "cloudflare-resource",
  "context-pack",
  "decision-gate",
  "turn-stream",
  "run-stream",
];

const stripComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "");

const exportedNamesFromSource = (file, seen = new Set()) => {
  const abs = path.resolve(file);
  if (seen.has(abs)) return new Set();
  seen.add(abs);
  const source = stripComments(fs.readFileSync(abs, "utf8"));
  const names = new Set();

  for (const match of source.matchAll(
    /\bexport\s+(?:declare\s+)?(?:interface|type|class|const|function)\s+([A-Za-z_$][\w$]*)/g,
  )) {
    names.add(match[1]);
  }

  for (const match of source.matchAll(/\bexport\s+(?:type\s+)?\{([\s\S]*?)\}/g)) {
    for (const rawPart of match[1].split(",")) {
      const cleaned = rawPart.trim().replace(/^type\s+/, "");
      if (cleaned.length === 0) continue;
      const alias = cleaned.match(/\bas\s+([A-Za-z_$][\w$]*)$/);
      const direct = cleaned.match(/^([A-Za-z_$][\w$]*)$/);
      if (alias !== null) names.add(alias[1]);
      else if (direct !== null) names.add(direct[1]);
    }
  }

  for (const match of source.matchAll(/\bexport\s+\*\s+from\s+["']([^"']+)["']/g)) {
    const specifier = match[1];
    if (!specifier.startsWith(".")) continue;
    const target = path.resolve(path.dirname(abs), `${specifier}.ts`);
    for (const name of exportedNamesFromSource(target, seen)) {
      names.add(name);
    }
  }

  return names;
};

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

for (const target of targets) {
  const pkgDir = path.join(root, "packages", target);
  const manifest = path.join(pkgDir, "PUBLIC_API.md");
  if (!fs.existsSync(manifest)) {
    console.error(`missing PUBLIC_API.md for ${target}`);
    failed = true;
    continue;
  }

  const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"));
  const exports = pkg.exports ?? {};
  const frozen = manifestNames(manifest, "Frozen exports");
  const experimental = manifestNames(manifest, "Experimental exports");
  const internal = manifestNames(manifest, "Internal-only exports");
  const declaredPublic = new Set([...frozen, ...experimental]);

  for (const [entrypoint, exportSpec] of Object.entries(exports)) {
    const source = exportSpec?.default ?? exportSpec;
    if (typeof source !== "string" || !source.startsWith("./")) continue;
    const file = path.join(pkgDir, source);
    const actual = [...exportedNamesFromSource(file)]
      .map((name) => `${entrypoint}:${String(name)}`)
      .sort();

    for (const name of actual) {
      if (!declaredPublic.has(name)) {
        console.error(`${target}: exported but not in PUBLIC_API.md: ${name}`);
        failed = true;
      }
      if (internal.has(name)) {
        console.error(`${target}: internal export is still exported: ${name}`);
        failed = true;
      }
    }

    for (const name of declaredPublic) {
      const [declaredEntrypoint] = name.split(":");
      if (declaredEntrypoint === entrypoint && !actual.includes(name)) {
        console.error(`${target}: PUBLIC_API.md lists missing export: ${name}`);
        failed = true;
      }
    }
  }
}

if (failed) process.exit(1);
console.log("public API manifests match package exports");
