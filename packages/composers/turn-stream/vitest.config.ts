import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    fileParallelism: false,
    globals: true,
  },
});
