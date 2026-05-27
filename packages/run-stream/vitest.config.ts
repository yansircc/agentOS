import { defineConfig } from "vite-plus";

const file = (path: string): string => new URL(path, import.meta.url).pathname;

export default defineConfig({
  resolve: {
    alias: {
      "@agent-os/core": file("../core/src/index.ts"),
      "@agent-os/turn-stream": file("../turn-stream/src/index.ts"),
    },
  },
  test: {
    fileParallelism: false,
    globals: true,
  },
});
