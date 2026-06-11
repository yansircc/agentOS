import {
  makeCloudflareWorkspaceEnv,
  type CloudflareWorkspaceEnvClient,
} from "@agent-os/workspace-env-cloudflare";
import type { WorkspaceEnv } from "@agent-os/workspace-env";

export interface CloudflareWorkspaceEnvResolverInput {
  readonly scope: string;
  readonly runId: string;
}

export interface CloudflareWorkspaceEnvBinding {
  readonly getSandbox: (
    sandboxId: string,
    input: CloudflareWorkspaceEnvResolverInput,
  ) => CloudflareWorkspaceEnvClient | Promise<CloudflareWorkspaceEnvClient>;
}

export interface CloudflareWorkspaceEnvResolverOptions {
  readonly binding: CloudflareWorkspaceEnvBinding;
  readonly cwd?: string;
  readonly sandboxId?: (input: CloudflareWorkspaceEnvResolverInput) => string;
  readonly workspaceRef?: (input: CloudflareWorkspaceEnvResolverInput) => string;
  readonly cleanup?: (
    env: WorkspaceEnv,
    input: CloudflareWorkspaceEnvResolverInput,
  ) => void | Promise<void>;
}

export interface CloudflareWorkspaceEnvLease {
  readonly sandboxId: string;
  readonly workspaceRef: string;
  readonly env: WorkspaceEnv;
  readonly cleanup: () => Promise<void>;
}

export interface CloudflareWorkspaceEnvResolver {
  readonly resolve: (
    input: CloudflareWorkspaceEnvResolverInput,
  ) => Promise<CloudflareWorkspaceEnvLease>;
}

export class CloudflareWorkspaceEnvResolverError extends Error {
  override readonly name = "CloudflareWorkspaceEnvResolverError";
}

const defaultSandboxId = (input: CloudflareWorkspaceEnvResolverInput): string =>
  `workspace-job:${input.scope}:${input.runId}`;

const defaultWorkspaceRef = (input: CloudflareWorkspaceEnvResolverInput): string =>
  `cloudflare-sandbox:${input.scope}:${input.runId}`;

const validateClient = (client: CloudflareWorkspaceEnvClient): void => {
  if (typeof client !== "object" || client === null) {
    throw new CloudflareWorkspaceEnvResolverError(
      "Cloudflare workspace binding returned no client",
    );
  }
  if (typeof client.exec !== "function") {
    throw new CloudflareWorkspaceEnvResolverError("Cloudflare workspace client missing exec");
  }
};

/**
 * Resolves a run-scoped Cloudflare Sandbox workspace into a WorkspaceEnv.
 *
 * The resolver owns the host lifecycle axis: `scope/runId` determines the
 * sandbox id, so a run receives one sandbox lease and products receive only
 * the provider-neutral WorkspaceEnv.
 *
 * @agentosPrimitive primitive.cloudflare-do.createCloudflareWorkspaceEnvResolver
 * @agentosInvariant invariant.workspace-job.host-workspace-lifecycle
 * @agentosDocs docs/packages/backend-cloudflare-do.md
 * @public
 */
export const createCloudflareWorkspaceEnvResolver = (
  options: CloudflareWorkspaceEnvResolverOptions,
): CloudflareWorkspaceEnvResolver => {
  const leases = new Map<string, CloudflareWorkspaceEnvLease>();
  const keyOf = (input: CloudflareWorkspaceEnvResolverInput): string =>
    `${input.scope}\u0000${input.runId}`;
  return {
    resolve: async (input) => {
      const key = keyOf(input);
      const existing = leases.get(key);
      if (existing !== undefined) return existing;

      const sandboxId = options.sandboxId?.(input) ?? defaultSandboxId(input);
      const workspaceRef = options.workspaceRef?.(input) ?? defaultWorkspaceRef(input);
      const client = await options.binding.getSandbox(sandboxId, input);
      validateClient(client);
      const env = makeCloudflareWorkspaceEnv({
        client,
        cwd: options.cwd,
        workspaceRef,
      });
      const lease = {
        sandboxId,
        workspaceRef,
        env,
        cleanup: async () => {
          try {
            await options.cleanup?.(env, input);
          } finally {
            leases.delete(key);
          }
        },
      };
      leases.set(key, lease);
      return lease;
    },
  };
};
