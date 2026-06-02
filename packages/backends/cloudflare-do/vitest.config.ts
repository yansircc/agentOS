import { defineConfig } from "vite-plus";
import { agentOsSourceAliases } from "../../../tooling/vitest-config/source-aliases";

/**
 * Default @agent-os/backend-cloudflare-do test config.
 *
 * This is the pure algebra runner. It must not load the Cloudflare Workers
 * pool; Worker runtime contracts live in vitest.cloudflare.config.ts.
 */
export default defineConfig({
  resolve: {
    alias: agentOsSourceAliases(),
  },
  test: {
    fileParallelism: false,
    include: ["test/**/*.test.ts"],
    exclude: ["test/**/*.worker.test.ts"],
  },
});
