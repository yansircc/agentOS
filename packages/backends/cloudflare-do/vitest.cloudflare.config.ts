import { defineConfig } from "vite-plus";
import { agentOsSourceAliases } from "../../../tooling/vitest-config/source-aliases";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

/**
 * vitest config for @agent-os/backend-cloudflare-do contract tests.
 *
 * Tests run inside the Workers runtime via vitest-pool-workers so they have
 * access to real DO SQLite + transactionSync semantics. The AI binding is
 * NOT defined in wrangler-test.jsonc — tests stub it in-process by composing
 * a Layer.succeed(AiBinding, stubAiObj) and bypassing the DO facade entirely.
 *
 * Bound: AGENT_DO (a minimal TestAgentDO subclass of DurableObject — just
 * a vehicle for runInDurableObject(stub, callback) to acquire a real
 * DurableObjectState).
 */
export default defineConfig({
  resolve: {
    alias: agentOsSourceAliases(),
  },
  test: {
    fileParallelism: false,
    globals: true,
    include: ["test/**/*.worker.test.ts"],
  },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler-test.jsonc" },
    }),
  ],
});
