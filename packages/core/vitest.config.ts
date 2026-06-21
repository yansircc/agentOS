import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    fileParallelism: false,
    include: ["test/**/*.test.ts"],
  },
});
