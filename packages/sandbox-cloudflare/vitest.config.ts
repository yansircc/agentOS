import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@agent-os/sandbox": new URL(
        "../sandbox/src/index.ts",
        import.meta.url,
      ).pathname,
    },
  },
  test: {
    fileParallelism: false,
  },
});
