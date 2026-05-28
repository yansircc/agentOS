import { defineConfig } from "vite-plus";

export default defineConfig({
  resolve: {
    alias: {
      "@agent-os/sandbox": new URL("../../carriers/sandbox/src/index.ts", import.meta.url).pathname,
    },
  },
  test: {
    fileParallelism: false,
  },
});
