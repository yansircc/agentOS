#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  apiSourceMode,
  exportedNamesForPackage,
  sourceTsdocApiMarkdown,
  sourceTsdocModes,
  sourceTsdocRecordsForPackage,
  validateSourceTsdocRecords,
} from "../check/public-api-model.mjs";

const targetPackages = (root) => {
  const surface = JSON.parse(fs.readFileSync(path.join(root, "docs/surface.json"), "utf8"));
  return surface.packages.filter((pkg) => {
    const packageJson = path.join(root, pkg.path, "package.json");
    if (!fs.existsSync(packageJson)) return false;
    const manifest = JSON.parse(fs.readFileSync(packageJson, "utf8"));
    return (
      pkg.apiSource !== undefined || (pkg.published === true && manifest.exports !== undefined)
    );
  });
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

const collectPublicApiFailures = (root) => {
  const failures = [];
  const fail = (message) => failures.push(message);

  for (const target of targetPackages(root)) {
    if (target.apiSource === undefined) {
      fail(`${target.name}: published package exports require apiSource in docs/surface.json`);
      continue;
    }

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
  return failures;
};

const collectSelfTestFailures = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentos-public-api-"));
  try {
    fs.mkdirSync(path.join(root, "docs"), { recursive: true });
    fs.mkdirSync(path.join(root, "packages/missing-api"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "docs/surface.json"),
      JSON.stringify(
        {
          packages: [
            {
              slug: "missing-api",
              name: "@agent-os/missing-api",
              path: "packages/missing-api",
              published: true,
            },
          ],
        },
        null,
        2,
      ),
    );
    fs.writeFileSync(
      path.join(root, "packages/missing-api/package.json"),
      JSON.stringify(
        {
          name: "@agent-os/missing-api",
          private: true,
          type: "module",
          exports: { ".": "./src/index.ts" },
        },
        null,
        2,
      ),
    );

    const failures = collectPublicApiFailures(root);
    if (
      !failures.includes(
        "@agent-os/missing-api: published package exports require apiSource in docs/surface.json",
      )
    ) {
      return [
        `public API self-test did not reject published package exports without apiSource; failures=${JSON.stringify(failures)}`,
      ];
    }
    return [];
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
};

const selfTest = process.argv.includes("--self-test");
const failures = selfTest ? collectSelfTestFailures() : collectPublicApiFailures(process.cwd());

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(
  selfTest ? "public API gate self-test passed" : "public API manifests match package exports",
);
