import { defineConfig } from "vite-plus";
import { agentOsSourceAliases } from "../../../tooling/vitest-config/source-aliases";

export default defineConfig({
  resolve: {
    alias: agentOsSourceAliases(),
  },
  test: {
    fileParallelism: false,
    include: ["test/**/*.runtime.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
