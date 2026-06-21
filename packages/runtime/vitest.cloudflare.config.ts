import { defineConfig } from "vite-plus";
import { agentOsSourceAliases } from "../../tooling/vitest-config/source-aliases";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

const sourceAliases = agentOsSourceAliases();
const workerOnlyAnthropicTokenizerStub = new URL(
  "./test/cloudflare/_anthropic-tokenizer-worker-stub.ts",
  import.meta.url,
).pathname;

/**
 * vitest config for @agent-os/runtime/cloudflare runtime contract tests.
 *
 * Tests run inside the Workers runtime via vitest-pool-workers so they have
 * access to real DO SQLite + transactionSync semantics. LLM-dependent tests
 * inject a LlmTransport test layer in-process and bypass provider credentials.
 *
 * Bound: AGENT_DO (a minimal TestAgentDO subclass of DurableObject — just
 * a vehicle for runInDurableObject(stub, callback) to acquire a real
 * DurableObjectState).
 *
 * Runtime tests do not exercise Anthropic routes. @effect/ai-anthropic imports
 * @anthropic-ai/tokenizer at module load, and that package currently declares a
 * CommonJS package while exposing TypeScript source that the worker test
 * evaluator cannot load. The alias is test-only and must be removed once this
 * harness adds Anthropic route coverage or the upstream package ships a worker
 * compatible ESM entry.
 */
export default defineConfig({
  resolve: {
    alias: {
      ...sourceAliases,
      "@anthropic-ai/tokenizer": workerOnlyAnthropicTokenizerStub,
    },
  },
  test: {
    fileParallelism: false,
    globals: true,
    include: ["test/cloudflare/**/*.runtime.test.ts"],
  },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler-cloudflare-test.jsonc" },
    }),
  ],
});
