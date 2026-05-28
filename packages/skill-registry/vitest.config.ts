import { defineConfig } from "vite-plus";

export default defineConfig({
  resolve: {
    alias: {
      "@agent-os/kernel/effect-claim": new URL("../kernel/src/effect-claim.ts", import.meta.url)
        .pathname,
      "@agent-os/kernel/material-ref": new URL("../kernel/src/material-ref.ts", import.meta.url)
        .pathname,
      "@agent-os/kernel/tools": new URL("../kernel/src/tools.ts", import.meta.url).pathname,
    },
  },
  test: {
    fileParallelism: false,
    globals: true,
  },
});
