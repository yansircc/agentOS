import { defineConfig } from "vite-plus";

/**
 * Default @agent-os/core test config.
 *
 * This is the pure algebra runner. It must not load the Cloudflare Workers
 * pool; Worker runtime contracts live in vitest.cloudflare.config.ts.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@agent-os/image": "../image/src/index.ts",
    },
  },
  test: {
    fileParallelism: false,
    include: ["test/**/*.test.ts"],
    exclude: ["test/**/*.worker.test.ts"],
  },
});
