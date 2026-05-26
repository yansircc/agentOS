import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@agent-os/core/extensions": new URL(
        "../core/src/extensions.ts",
        import.meta.url,
      ).pathname,
    },
  },
  test: {
    fileParallelism: false,
    globals: true,
  },
});
