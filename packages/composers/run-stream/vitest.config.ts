import { defineConfig } from "vite-plus";

const file = (path: string): string => new URL(path, import.meta.url).pathname;

export default defineConfig({
  resolve: {
    alias: {
      "@agent-os/kernel/llm": file("../../kernel/src/llm.ts"),
      "@agent-os/kernel/effect-claim": file("../../kernel/src/effect-claim.ts"),
      "@agent-os/kernel/material-ref": file("../../kernel/src/material-ref.ts"),
      "@agent-os/kernel/tools": file("../../kernel/src/tools.ts"),
      "@agent-os/kernel": file("../../kernel/src/index.ts"),
      "@agent-os/runtime": file("../../runtime/src/index.ts"),
      "@agent-os/turn-stream": file("../turn-stream/src/index.ts"),
    },
  },
  test: {
    fileParallelism: false,
    globals: true,
  },
});
