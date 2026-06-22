// @ts-nocheck
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@effect/vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const tsc = path.join(root, "node_modules/.bin/tsc");
const fixtureDir = path.join(root, "packages/runtime/test/cloudflare/consumer-fixture");
const packageLinks = {
  core: "packages/core",
  runtime: "packages/runtime",
};
const dependencyLinks = ["@effect", "effect"];
const scopedDependencyLinks = {
  "@cloudflare": ["node_modules/@cloudflare"],
};

const isPackageRuntimeDependencyPath = (source: string): boolean =>
  source.split(path.sep).includes("node_modules");

const makeExternalFixture = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentos-consumer-"));
  fs.mkdirSync(path.join(dir, "node_modules/@agent-os"), { recursive: true });
  for (const [name, target] of Object.entries(packageLinks)) {
    fs.cpSync(path.join(root, target), path.join(dir, "node_modules/@agent-os", name), {
      recursive: true,
      filter: (source) => !isPackageRuntimeDependencyPath(source),
    });
  }
  for (const name of dependencyLinks) {
    fs.symlinkSync(path.join(root, "node_modules", name), path.join(dir, "node_modules", name));
  }
  for (const [scope, sources] of Object.entries(scopedDependencyLinks)) {
    const targetScope = path.join(dir, "node_modules", scope);
    fs.mkdirSync(targetScope, { recursive: true });
    for (const source of sources) {
      const sourceScope = path.join(root, source);
      if (!fs.existsSync(sourceScope)) continue;
      for (const entry of fs.readdirSync(sourceScope)) {
        const target = path.join(targetScope, entry);
        if (!fs.existsSync(target)) fs.symlinkSync(path.join(sourceScope, entry), target);
      }
    }
  }
  for (const file of fs.readdirSync(fixtureDir)) {
    const target = file.endsWith(".fixture") ? file.slice(0, -".fixture".length) : file;
    fs.copyFileSync(path.join(fixtureDir, file), path.join(dir, target));
  }
  fs.writeFileSync(path.join(dir, "package.json"), '{"type":"module"}\n');
  return dir;
};

const runTsc = (config: string) => {
  const cwd = makeExternalFixture();
  return execFileSync(tsc, ["-p", path.join(cwd, config)], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
};

describe("Cloudflare DO public consumer boundary", () => {
  it("accepts public imports under Bundler source-package resolution", () => {
    expect(() => runTsc("tsconfig.public.bundler.json")).not.toThrow();
  });

  it("documents that NodeNext needs built distribution artifacts, not source packages", () => {
    expect(() => runTsc("tsconfig.public.nodenext.json")).toThrow();
  });

  it("rejects backend internals under Bundler and NodeNext resolution", () => {
    expect(() => runTsc("tsconfig.internal.bundler.json")).toThrow();
    expect(() => runTsc("tsconfig.internal.nodenext.json")).toThrow();
  });
});
