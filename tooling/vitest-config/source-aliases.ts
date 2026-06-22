export type AgentOsSourceAliasSpec = readonly [specifier: string, sourcePath: string];
export const agentOsSourceAliasSpecs = [
  ["@agent-os/core", "packages/core/src/index.ts"],
  ["@agent-os/core/abort", "packages/core/src/abort.ts"],
  ["@agent-os/core/agent-schema", "packages/core/src/agent-schema.ts"],
  ["@agent-os/core/authored-value", "packages/core/src/authored-value.ts"],
  ["@agent-os/core/backend-protocol", "packages/core/src/backend-protocol/index.ts"],
  [
    "@agent-os/core/backend-protocol/reference",
    "packages/core/src/backend-protocol/reference/index.ts",
  ],
  ["@agent-os/core/boundary-contract", "packages/core/src/boundary-contract.ts"],
  ["@agent-os/core/carrier", "packages/core/src/carrier.ts"],
  ["@agent-os/core/context", "packages/core/src/context.ts"],
  ["@agent-os/core/effect-claim", "packages/core/src/effect-claim.ts"],
  ["@agent-os/core/errors", "packages/core/src/errors.ts"],
  ["@agent-os/core/extensions", "packages/core/src/extensions.ts"],
  ["@agent-os/core/live-edge", "packages/core/src/live-edge.ts"],
  ["@agent-os/core/llm-protocol", "packages/core/src/llm-protocol/index.ts"],
  ["@agent-os/core/material-ref", "packages/core/src/material-ref.ts"],
  ["@agent-os/core/projection", "packages/core/src/projection.ts"],
  ["@agent-os/core/quota", "packages/core/src/quota.ts"],
  ["@agent-os/core/recorded-value", "packages/core/src/recorded-value.ts"],
  ["@agent-os/core/ref-resolver", "packages/core/src/ref-resolver.ts"],
  ["@agent-os/core/runtime-protocol", "packages/core/src/runtime-protocol/index.ts"],
  ["@agent-os/core/runtime-scope", "packages/core/src/runtime-scope.ts"],
  ["@agent-os/core/settlement-contract", "packages/core/src/settlement-contract.ts"],
  ["@agent-os/core/telemetry-protocol", "packages/core/src/telemetry-protocol/index.ts"],
  ["@agent-os/core/tools", "packages/core/src/tools.ts"],
  ["@agent-os/core/types", "packages/core/src/types.ts"],
  ["@agent-os/core/workspace-agent", "packages/core/src/workspace-agent.ts"],
  ["@agent-os/cli", "packages/cli/src/index.ts"],
  ["@agent-os/runtime", "packages/runtime/src/index.ts"],
  ["@agent-os/runtime/admission", "packages/runtime/src/admission.ts"],
  ["@agent-os/runtime/ag-ui", "packages/runtime/src/ag-ui.ts"],
  ["@agent-os/runtime/cloudflare", "packages/runtime/src/cloudflare/index.ts"],
  ["@agent-os/runtime/cloudflare/do-rpc", "packages/runtime/src/cloudflare/do-rpc.ts"],
  ["@agent-os/runtime/cloudflare/ops-api", "packages/runtime/src/cloudflare/ops-api/index.ts"],
  ["@agent-os/runtime/in-memory", "packages/runtime/src/in-memory/index.ts"],
  ["@agent-os/runtime/llm-effect-ai", "packages/runtime/src/llm-effect-ai/index.ts"],
  ["@agent-os/runtime/node", "packages/runtime/src/node/index.ts"],
  ["@agent-os/runtime/run-projector", "packages/runtime/src/run-projector.ts"],
  ["@agent-os/runtime/sse-http", "packages/runtime/src/sse-http.ts"],
  ["@agent-os/runtime/telemetry-otlp", "packages/runtime/src/telemetry-otlp/index.ts"],
  ["@agent-os/runtime/workspace-agent", "packages/runtime/src/workspace-agent.ts"],
  ["@agent-os/runtime/workspace-binding", "packages/runtime/src/workspace-binding.ts"],
  ["@agent-os/client", "packages/client/src/index.ts"],
  ["@agent-os/client/react", "packages/client/src/react/index.ts"],
  ["@agent-os/client/svelte", "packages/client/src/svelte/index.ts"],
  ["@agent-os/client/workspace-agent", "packages/client/src/workspace-agent.ts"],
] as const satisfies readonly AgentOsSourceAliasSpec[];

const repoRoot = new URL("../../", (import.meta as { readonly url: string }).url);

export const agentOsSourceAliases = (): Record<string, string> =>
  Object.fromEntries(
    [...agentOsSourceAliasSpecs]
      .sort(([left], [right]) => right.length - left.length || left.localeCompare(right))
      .map(([specifier, sourcePath]) => [specifier, new URL(sourcePath, repoRoot).pathname]),
  );
