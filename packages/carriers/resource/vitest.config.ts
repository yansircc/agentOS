import { defineConfig } from "vite-plus";

export default defineConfig({
  resolve: {
    alias: {
      "@agent-os/kernel/boundary-contract": new URL(
        "../../kernel/src/boundary-contract.ts",
        import.meta.url,
      ).pathname,
      "@agent-os/kernel/effect-claim": new URL("../../kernel/src/effect-claim.ts", import.meta.url)
        .pathname,
      "@agent-os/kernel/extensions": new URL("../../kernel/src/extensions.ts", import.meta.url)
        .pathname,
      "@agent-os/kernel/material-ref": new URL("../../kernel/src/material-ref.ts", import.meta.url)
        .pathname,
      "@agent-os/kernel/ref-resolver": new URL("../../kernel/src/ref-resolver.ts", import.meta.url)
        .pathname,
    },
  },
  test: {
    fileParallelism: false,
    globals: true,
  },
});
