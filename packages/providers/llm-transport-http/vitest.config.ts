import { defineConfig } from "vite-plus";

const file = (path: string): string => new URL(path, import.meta.url).pathname;

export default defineConfig({
  resolve: {
    alias: [
      { find: "@agent-os/kernel/llm", replacement: file("../../kernel/src/llm.ts") },
      {
        find: "@agent-os/kernel/effect-claim",
        replacement: file("../../kernel/src/effect-claim.ts"),
      },
      {
        find: "@agent-os/kernel/material-ref",
        replacement: file("../../kernel/src/material-ref.ts"),
      },
      {
        find: "@agent-os/kernel/ref-resolver",
        replacement: file("../../kernel/src/ref-resolver.ts"),
      },
      { find: "@agent-os/kernel/tools", replacement: file("../../kernel/src/tools.ts") },
      { find: "@agent-os/kernel", replacement: file("../../kernel/src/index.ts") },
      {
        find: "@agent-os/turn-stream",
        replacement: file("../../composers/turn-stream/src/index.ts"),
      },
    ],
  },
  test: {
    fileParallelism: false,
    globals: true,
  },
});
