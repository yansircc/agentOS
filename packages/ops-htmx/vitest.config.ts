import { defineConfig } from "vite-plus";

export default defineConfig({
  resolve: {
    alias: {
      "@agent-os/core": new URL("../core/src/index.ts", import.meta.url).pathname,
      "@agent-os/ops-api": new URL("../ops-api/src/index.ts", import.meta.url).pathname,
      "@agent-os/run-stream": new URL("../run-stream/src/index.ts", import.meta.url).pathname,
      "@agent-os/turn-stream": new URL("../turn-stream/src/index.ts", import.meta.url).pathname,
    },
  },
  test: {
    fileParallelism: false,
    globals: true,
  },
});
