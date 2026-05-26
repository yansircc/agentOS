import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@agent-os/core/effect-claim": new URL(
        "../core/src/effect-claim.ts",
        import.meta.url,
      ).pathname,
      "@agent-os/core/runtime-scope": new URL(
        "../core/src/runtime-scope.ts",
        import.meta.url,
      ).pathname,
    },
  },
  test: {
    fileParallelism: false,
  },
});
