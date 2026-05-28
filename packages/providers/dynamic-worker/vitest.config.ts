import { defineConfig } from "vite-plus";

export default defineConfig({
  resolve: {
    alias: {
      "@agent-os/kernel/effect-claim": new URL("../../kernel/src/effect-claim.ts", import.meta.url)
        .pathname,
      "@agent-os/kernel/runtime-scope": new URL(
        "../../kernel/src/runtime-scope.ts",
        import.meta.url,
      ).pathname,
    },
  },
  test: {
    fileParallelism: false,
  },
});
