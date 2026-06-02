import { defineConfig } from "vite-plus";

export default defineConfig({
  resolve: {
    alias: [
      {
        find: "@agent-os/staging-artifact",
        replacement: new URL("../../carriers/staging-artifact/src/index.ts", import.meta.url)
          .pathname,
      },
      {
        find: "@agent-os/workspace-session",
        replacement: new URL("../../carriers/workspace-session/src/index.ts", import.meta.url)
          .pathname,
      },
    ],
  },
  test: {
    fileParallelism: false,
    globals: true,
  },
});
