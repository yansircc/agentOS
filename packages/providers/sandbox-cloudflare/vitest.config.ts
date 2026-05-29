import { defineConfig } from "vite-plus";

export default defineConfig({
  resolve: {
    alias: {
      "@agent-os/kernel/tools": new URL("../../kernel/src/tools.ts", import.meta.url).pathname,
      "@agent-os/sandbox": new URL("../../carriers/sandbox/src/index.ts", import.meta.url).pathname,
    },
  },
  test: {
    fileParallelism: false,
  },
});
