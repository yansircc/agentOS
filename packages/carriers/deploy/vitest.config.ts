import { defineConfig } from "vite-plus";
import { agentOsSourceAliases } from "../../../tooling/vitest-config/source-aliases";

export default defineConfig({
  resolve: {
    alias: agentOsSourceAliases(),
  },
  test: {
    fileParallelism: false,
    globals: true,
  },
});
