import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { build } from "esbuild";

const compare = (left, right) => left.localeCompare(right);

export const bundleModuleForNode = async (
  entryPoint,
  { external = [], prefix = "agentos-ts-module-", tempRoot = os.tmpdir() } = {},
) => {
  const outDir = path.join(tempRoot, `${prefix}${randomUUID()}`);
  const outfile = path.join(outDir, "entry.mjs");
  await mkdir(outDir, { recursive: true });
  await build({
    entryPoints: [entryPoint],
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    external: [...new Set(["esbuild", "cloudflare:*", ...external])].sort(compare),
    logLevel: "silent",
  });
  return {
    outfile,
    cleanup: async () => {
      await rm(outDir, { recursive: true, force: true });
    },
  };
};

export const importBundledModule = async (entryPoint, options = {}) => {
  const bundled = await bundleModuleForNode(entryPoint, options);
  try {
    return await import(`${pathToFileURL(bundled.outfile).href}?agentos=${Date.now()}`);
  } finally {
    await bundled.cleanup();
  }
};
