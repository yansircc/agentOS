import { defineConfig } from "vite-plus";

export default defineConfig({
  resolve: {
    alias: {
      "@agent-os/kernel/effect-claim": new URL(
        "../../packages/kernel/src/effect-claim.ts",
        import.meta.url,
      ).pathname,
      "@agent-os/kernel/material-ref": new URL(
        "../../packages/kernel/src/material-ref.ts",
        import.meta.url,
      ).pathname,
      "@agent-os/kernel/tools": new URL("../../packages/kernel/src/tools.ts", import.meta.url)
        .pathname,
    },
  },
  test: {
    fileParallelism: false,
    globals: true,
  },
});
