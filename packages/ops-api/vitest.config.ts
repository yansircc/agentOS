import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@agent-os/core/abort": new URL(
        "../core/src/abort.ts",
        import.meta.url,
      ).pathname,
      "@agent-os/core": new URL(
        "../core/src/index.ts",
        import.meta.url,
      ).pathname,
    },
  },
  test: {
    fileParallelism: false,
    globals: true,
  },
});
