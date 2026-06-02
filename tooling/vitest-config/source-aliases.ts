export type AgentOsSourceAliasSpec = readonly [specifier: string, sourcePath: string];
export const agentOsSourceAliasSpecs = [
  ["@agent-os/kernel", "packages/kernel/src/index.ts"],
  ["@agent-os/kernel/abort", "packages/kernel/src/abort.ts"],
  ["@agent-os/kernel/boundary-contract", "packages/kernel/src/boundary-contract.ts"],
  ["@agent-os/kernel/carrier", "packages/kernel/src/carrier.ts"],
  ["@agent-os/kernel/context", "packages/kernel/src/context.ts"],
  ["@agent-os/kernel/effect-claim", "packages/kernel/src/effect-claim.ts"],
  ["@agent-os/kernel/errors", "packages/kernel/src/errors.ts"],
  ["@agent-os/kernel/extensions", "packages/kernel/src/extensions.ts"],
  ["@agent-os/kernel/llm", "packages/kernel/src/llm.ts"],
  ["@agent-os/kernel/json-schema", "packages/kernel/src/json-schema.ts"],
  ["@agent-os/kernel/material-ref", "packages/kernel/src/material-ref.ts"],
  ["@agent-os/kernel/quota", "packages/kernel/src/quota.ts"],
  ["@agent-os/kernel/ref-resolver", "packages/kernel/src/ref-resolver.ts"],
  ["@agent-os/kernel/runtime-scope", "packages/kernel/src/runtime-scope.ts"],
  ["@agent-os/kernel/settlement-contract", "packages/kernel/src/settlement-contract.ts"],
  ["@agent-os/kernel/tools", "packages/kernel/src/tools.ts"],
  ["@agent-os/kernel/types", "packages/kernel/src/types.ts"],
  ["@agent-os/runtime", "packages/runtime/src/index.ts"],
  ["@agent-os/runtime/admission", "packages/runtime/src/admission.ts"],
  ["@agent-os/runtime/abort", "packages/runtime/src/abort.ts"],
  ["@agent-os/backend-cloudflare-do", "packages/backends/cloudflare-do/src/index.ts"],
  ["@agent-os/backend-cloudflare-do/testing", "packages/backends/cloudflare-do/src/testing.ts"],
  ["@agent-os/backend-in-memory", "packages/backends/in-memory/src/index.ts"],
  ["@agent-os/backend-protocol", "packages/backends/protocol/src/index.ts"],
  ["@agent-os/decision-gate", "packages/carriers/decision-gate/src/index.ts"],
  ["@agent-os/deploy", "packages/carriers/deploy/src/index.ts"],
  ["@agent-os/git-carrier", "packages/carriers/git/src/index.ts"],
  ["@agent-os/image", "packages/carriers/image/src/index.ts"],
  ["@agent-os/resource-carrier", "packages/carriers/resource/src/index.ts"],
  ["@agent-os/sandbox", "packages/carriers/sandbox/src/index.ts"],
  ["@agent-os/staging-artifact", "packages/carriers/staging-artifact/src/index.ts"],
  ["@agent-os/tenant-material", "packages/carriers/tenant-material/src/index.ts"],
  ["@agent-os/verification", "packages/carriers/verification/src/index.ts"],
  ["@agent-os/workspace-session", "packages/carriers/workspace-session/src/index.ts"],
  ["@agent-os/run-stream", "packages/composers/run-stream/src/index.ts"],
  ["@agent-os/turn-stream", "packages/composers/turn-stream/src/index.ts"],
  ["@agent-os/deploy-cloudflare", "packages/providers/deploy-cloudflare/src/index.ts"],
  ["@agent-os/dynamic-worker", "packages/providers/dynamic-worker/src/index.ts"],
  ["@agent-os/llm-transport-http", "packages/providers/llm-transport-http/src/index.ts"],
  ["@agent-os/resource-cloudflare", "packages/providers/resource-cloudflare/src/index.ts"],
  ["@agent-os/sandbox-cloudflare", "packages/providers/sandbox-cloudflare/src/index.ts"],
  [
    "@agent-os/workspace-session-cloudflare",
    "packages/providers/workspace-session-cloudflare/src/index.ts",
  ],
  ["@agent-os/ops-api", "tooling/ops-api/src/index.ts"],
  ["@agent-os/ops-htmx", "tooling/ops-htmx/src/index.ts"],
  ["@agent-os/skill-registry", "tooling/skill-registry/src/index.ts"],
] as const satisfies readonly AgentOsSourceAliasSpec[];

const repoRoot = new URL("../../", (import.meta as { readonly url: string }).url);

export const agentOsSourceAliases = (): Record<string, string> =>
  Object.fromEntries(
    [...agentOsSourceAliasSpecs]
      .sort(([left], [right]) => right.length - left.length || left.localeCompare(right))
      .map(([specifier, sourcePath]) => [specifier, new URL(sourcePath, repoRoot).pathname]),
  );
