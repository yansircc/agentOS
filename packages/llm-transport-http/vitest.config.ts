import { defineConfig } from "vite-plus";

const file = (path: string): string => new URL(path, import.meta.url).pathname;

export default defineConfig({
  resolve: {
    alias: [
      { find: "@agent-os/core/material-ref", replacement: file("../core/src/material-ref.ts") },
      { find: "@agent-os/core/ref-resolver", replacement: file("../core/src/ref-resolver.ts") },
      { find: "@agent-os/core", replacement: file("../core/src/index.ts") },
      { find: "@agent-os/turn-stream", replacement: file("../turn-stream/src/index.ts") },
    ],
  },
  test: {
    fileParallelism: false,
    globals: true,
  },
});
