import { defineConfig } from "vite-plus";

export default defineConfig({
  resolve: {
    alias: {
      "@agent-os/kernel/material-ref": new URL("../kernel/src/material-ref.ts", import.meta.url)
        .pathname,
      "@agent-os/kernel/ref-resolver": new URL("../kernel/src/ref-resolver.ts", import.meta.url)
        .pathname,
    },
  },
  test: {
    fileParallelism: false,
  },
});
