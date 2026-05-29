import { defineConfig } from "vite-plus";

export default defineConfig({
  resolve: {
    alias: [
      {
        find: "@agent-os/kernel/effect-claim",
        replacement: new URL("../../kernel/src/effect-claim.ts", import.meta.url).pathname,
      },
      {
        find: "@agent-os/kernel/material-ref",
        replacement: new URL("../../kernel/src/material-ref.ts", import.meta.url).pathname,
      },
      {
        find: "@agent-os/kernel/settlement-contract",
        replacement: new URL("../../kernel/src/settlement-contract.ts", import.meta.url).pathname,
      },
      {
        find: "@agent-os/kernel/types",
        replacement: new URL("../../kernel/src/types.ts", import.meta.url).pathname,
      },
      {
        find: "@agent-os/kernel",
        replacement: new URL("../../kernel/src/index.ts", import.meta.url).pathname,
      },
      {
        find: "@agent-os/runtime",
        replacement: new URL("../../runtime/src/index.ts", import.meta.url).pathname,
      },
    ],
  },
});
