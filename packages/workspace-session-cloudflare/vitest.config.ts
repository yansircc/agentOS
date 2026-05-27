import { defineConfig } from "vite-plus";

export default defineConfig({
  resolve: {
    alias: {
      "@agent-os/core/boundary-contract": new URL(
        "../core/src/boundary-contract.ts",
        import.meta.url,
      ).pathname,
      "@agent-os/core/effect-claim": new URL("../core/src/effect-claim.ts", import.meta.url)
        .pathname,
      "@agent-os/core/extensions": new URL("../core/src/extensions.ts", import.meta.url).pathname,
      "@agent-os/core/runtime-scope": new URL("../core/src/runtime-scope.ts", import.meta.url)
        .pathname,
      "@agent-os/workspace-session": new URL("../workspace-session/src/index.ts", import.meta.url)
        .pathname,
    },
  },
  test: {
    fileParallelism: false,
    globals: true,
  },
});
