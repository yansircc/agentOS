import { defineConfig } from "vite-plus";

export default defineConfig({
  resolve: {
    alias: {
      "@agent-os/core/effect-claim": new URL("../core/src/effect-claim.ts", import.meta.url)
        .pathname,
      "@agent-os/core/material-ref": new URL("../core/src/material-ref.ts", import.meta.url)
        .pathname,
      "@agent-os/core/tools": new URL("../core/src/tools.ts", import.meta.url).pathname,
    },
  },
  test: {
    fileParallelism: false,
    globals: true,
  },
});
