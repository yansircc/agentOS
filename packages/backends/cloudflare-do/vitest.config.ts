import { defineConfig } from "vite-plus";

/**
 * Default @agent-os/backend-cloudflare-do test config.
 *
 * This is the pure algebra runner. It must not load the Cloudflare Workers
 * pool; Worker runtime contracts live in vitest.cloudflare.config.ts.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@agent-os/backend-protocol": "../protocol/src/index.ts",
      "@agent-os/kernel/abort": "../../kernel/src/abort.ts",
      "@agent-os/kernel/boundary-contract": "../../kernel/src/boundary-contract.ts",
      "@agent-os/kernel/context": "../../kernel/src/context.ts",
      "@agent-os/kernel/effect-claim": "../../kernel/src/effect-claim.ts",
      "@agent-os/kernel/errors": "../../kernel/src/errors.ts",
      "@agent-os/kernel/extensions": "../../kernel/src/extensions.ts",
      "@agent-os/kernel/json-schema": "../../kernel/src/json-schema.ts",
      "@agent-os/kernel/llm": "../../kernel/src/llm.ts",
      "@agent-os/kernel/material-ref": "../../kernel/src/material-ref.ts",
      "@agent-os/kernel/quota": "../../kernel/src/quota.ts",
      "@agent-os/kernel/ref-resolver": "../../kernel/src/ref-resolver.ts",
      "@agent-os/kernel/runtime-scope": "../../kernel/src/runtime-scope.ts",
      "@agent-os/kernel/settlement-contract": "../../kernel/src/settlement-contract.ts",
      "@agent-os/kernel/tools": "../../kernel/src/tools.ts",
      "@agent-os/kernel/types": "../../kernel/src/types.ts",
      "@agent-os/kernel": "../../kernel/src/index.ts",
      "@agent-os/runtime": "../../runtime/src/index.ts",
      "@agent-os/image": "../../carriers/image/src/index.ts",
    },
  },
  test: {
    fileParallelism: false,
    include: ["test/**/*.test.ts"],
    exclude: ["test/**/*.worker.test.ts"],
  },
});
