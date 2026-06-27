import {
  makeCloudflareWorkspaceEnv,
  type CloudflareWorkspaceEnvClient,
  type CloudflareWorkspaceEnvExecOptions,
  type CloudflareWorkspaceEnvExecRawResult,
  type CloudflareWorkspaceEnvOptions,
} from "./workspace-env-adapter";
import type { WorkspaceEnv } from "../workspace-env-core";
import {
  defineWorkspaceSessionLease,
  type WorkspaceSessionArtifactReadback,
  type WorkspaceSessionLease,
  type WorkspaceSessionPermissionInput,
  type WorkspaceSessionRepoBinding,
  type WorkspaceSessionResourceLimits,
} from "../workspace-session";

export interface CloudflareWorkspaceEnvResolverInput {
  readonly scope: string;
  readonly runId: string;
  readonly repo?: WorkspaceSessionRepoBinding;
  readonly permissions?: WorkspaceSessionPermissionInput;
  readonly resourceLimits?: WorkspaceSessionResourceLimits;
  readonly artifactReadback?: WorkspaceSessionArtifactReadback;
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
  readonly shellFileOperationTimeoutMs?: CloudflareWorkspaceEnvOptions["shellFileOperationTimeoutMs"];
  readonly sandboxId?: (input: CloudflareWorkspaceEnvResolverInput) => string;
  readonly workspaceRef?: (input: CloudflareWorkspaceEnvResolverInput) => string;
  readonly cleanup?: (
    env: WorkspaceEnv,
    input: CloudflareWorkspaceEnvResolverInput,
  ) => void | Promise<void>;
}

export interface CloudflareSandboxWorkspaceNamespace {
  readonly idFromName: (name: string) => DurableObjectId;
  readonly get: (id: DurableObjectId) => unknown;
}

export type CloudflareSandboxTransport = "http" | "websocket" | "rpc";

export interface CloudflareSandboxWorkspaceClient extends Omit<
  CloudflareWorkspaceEnvClient,
  "exec"
> {
  readonly setSandboxName: (name: string, normalizeId?: boolean) => void | Promise<void>;
  readonly setTransport: (transport: CloudflareSandboxTransport) => void | Promise<void>;
  readonly execWithSessionToken: (
    command: string,
    sessionToken: string,
    options?: CloudflareWorkspaceEnvExecOptions,
  ) => Promise<CloudflareWorkspaceEnvExecRawResult>;
}

export interface CloudflareSandboxWorkspaceEnvResolverOptions {
  readonly binding: CloudflareSandboxWorkspaceNamespace;
  readonly transport?: CloudflareSandboxTransport;
  readonly cwd?: string;
  readonly shellFileOperationTimeoutMs?: CloudflareWorkspaceEnvOptions["shellFileOperationTimeoutMs"];
  readonly scopePrefix?: string;
  readonly workspaceRef?: (input: CloudflareWorkspaceEnvResolverInput) => string;
  readonly cleanup?: (input: {
    readonly scope: string;
    readonly runId: string;
    readonly sandboxId: string;
    readonly workspaceRef: string;
    readonly env: WorkspaceEnv;
    readonly client: CloudflareWorkspaceEnvClient;
  }) => void | Promise<void>;
}

export interface CloudflareWorkspaceEnvLease {
  readonly sandboxId: string;
  readonly workspaceRef: string;
  readonly env: WorkspaceEnv;
  readonly session: WorkspaceSessionLease;
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

const validateSandboxNamespace = (
  binding: CloudflareSandboxWorkspaceNamespace,
): CloudflareSandboxWorkspaceNamespace => {
  if (typeof binding !== "object" || binding === null) {
    throw new CloudflareWorkspaceEnvResolverError(
      "Cloudflare Sandbox binding missing Durable Object namespace",
    );
  }
  const candidate = binding as {
    readonly idFromName?: unknown;
    readonly get?: unknown;
  };
  if (typeof candidate.idFromName !== "function" || typeof candidate.get !== "function") {
    throw new CloudflareWorkspaceEnvResolverError(
      "Cloudflare Sandbox binding missing Durable Object namespace methods",
    );
  }
  return binding;
};

const validateSandboxClient = (client: unknown): CloudflareSandboxWorkspaceClient => {
  if (typeof client !== "object" || client === null) {
    throw new CloudflareWorkspaceEnvResolverError("Cloudflare Sandbox binding returned no client");
  }
  const candidate = client as {
    readonly setSandboxName?: unknown;
    readonly setTransport?: unknown;
    readonly execWithSessionToken?: unknown;
  };
  if (typeof candidate.setSandboxName !== "function") {
    throw new CloudflareWorkspaceEnvResolverError(
      "Cloudflare Sandbox client missing setSandboxName",
    );
  }
  if (typeof candidate.setTransport !== "function") {
    throw new CloudflareWorkspaceEnvResolverError("Cloudflare Sandbox client missing setTransport");
  }
  if (typeof candidate.execWithSessionToken !== "function") {
    throw new CloudflareWorkspaceEnvResolverError(
      "Cloudflare Sandbox client missing execWithSessionToken",
    );
  }
  return client as CloudflareSandboxWorkspaceClient;
};

const scopedSandboxId = (
  input: CloudflareWorkspaceEnvResolverInput,
  scopePrefix: string | undefined,
): string => {
  const source = [scopePrefix ?? "", input.scope, input.runId].join(":");
  const suffix = hashBase36(source);
  const parts = [labelPart(scopePrefix ?? ""), "wj", labelPart(input.runId)].filter(
    (part) => part.length > 0,
  );
  const base = parts.join("-");
  const maxBaseLength = 63 - suffix.length - 1;
  const boundedBase = (base.length === 0 ? "wj" : base).slice(0, maxBaseLength).replace(/-+$/g, "");
  return `${boundedBase.length === 0 ? "wj" : boundedBase}-${suffix}`;
};

const scopedWorkspaceRef = (
  input: CloudflareWorkspaceEnvResolverInput,
  scopePrefix: string | undefined,
): string => {
  const prefix = scopePrefix === undefined || scopePrefix.length === 0 ? "" : `${scopePrefix}:`;
  return `${prefix}${defaultWorkspaceRef(input)}`;
};

const labelPart = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");

const hashBase36 = (value: string): string => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
};

const DISABLED_SANDBOX_SESSION_TOKEN = "__DISABLE_SESSION__";

const makeSessionlessCloudflareWorkspaceClient = (
  client: CloudflareSandboxWorkspaceClient,
): CloudflareWorkspaceEnvClient => ({
  ...client,
  exec: (command, options) =>
    client.execWithSessionToken(command, DISABLED_SANDBOX_SESSION_TOKEN, options),
});

/**
 * Resolves a run-scoped Cloudflare Sandbox workspace into a WorkspaceEnv.
 *
 * The resolver owns the host lifecycle axis: `scope/runId` determines the
 * sandbox id, so a run receives one sandbox lease and products receive only
 * the provider-neutral WorkspaceEnv.
 *
 * @agentosPrimitive primitive.cloudflare-do.createCloudflareWorkspaceEnvResolver
 * @agentosInvariant invariant.workspace-job.host-workspace-lifecycle
 * @agentosDocs docs/packages/runtime.md
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
        ...(options.shellFileOperationTimeoutMs === undefined
          ? {}
          : { shellFileOperationTimeoutMs: options.shellFileOperationTimeoutMs }),
      });
      const cleanup = async () => {
        try {
          await options.cleanup?.(env, input);
        } finally {
          leases.delete(key);
        }
      };
      const session = defineWorkspaceSessionLease({
        identity: { scope: input.scope, runId: input.runId, workspaceRef },
        env,
        ...(input.repo === undefined ? {} : { repo: input.repo }),
        ...(input.permissions === undefined ? {} : { permissions: input.permissions }),
        ...(input.resourceLimits === undefined ? {} : { resourceLimits: input.resourceLimits }),
        ...(input.artifactReadback === undefined
          ? {}
          : { artifactReadback: input.artifactReadback }),
        cleanup,
      });
      const lease = {
        sandboxId,
        workspaceRef,
        env,
        session,
        cleanup,
      };
      leases.set(key, lease);
      return lease;
    },
  };
};

/**
 * Resolves a run-scoped Cloudflare Sandbox binding into a WorkspaceEnv.
 *
 * This high-level host helper owns the Sandbox binding composition: products
 * choose the Durable Object namespace, while agentOS fixes
 * `scope/runId -> sandbox lease`, validates the binding/client shape, disables
 * implicit default sessions, and pins one transport per run. The lower-level
 * resolver remains available for tests or non-Sandbox hosts.
 *
 * @agentosPrimitive primitive.cloudflare-do.createCloudflareSandboxWorkspaceEnvResolver
 * @agentosInvariant invariant.workspace-job.host-workspace-lifecycle
 * @agentosDocs docs/packages/runtime.md
 * @public
 */
export const createCloudflareSandboxWorkspaceEnvResolver = (
  options: CloudflareSandboxWorkspaceEnvResolverOptions,
): CloudflareWorkspaceEnvResolver => {
  const leases = new Map<string, CloudflareWorkspaceEnvLease>();
  const keyOf = (input: CloudflareWorkspaceEnvResolverInput): string =>
    `${input.scope}\u0000${input.runId}`;
  return {
    resolve: async (input) => {
      const key = keyOf(input);
      const existing = leases.get(key);
      if (existing !== undefined) return existing;

      const sandboxId = scopedSandboxId(input, options.scopePrefix);
      const workspaceRef =
        options.workspaceRef?.(input) ?? scopedWorkspaceRef(input, options.scopePrefix);
      const binding = validateSandboxNamespace(options.binding);
      const client = validateSandboxClient(binding.get(binding.idFromName(sandboxId)));
      await client.setSandboxName(sandboxId, true);
      await client.setTransport(options.transport ?? "rpc");
      const workspaceClient = makeSessionlessCloudflareWorkspaceClient(client);
      validateClient(workspaceClient);
      const env = makeCloudflareWorkspaceEnv({
        client: workspaceClient,
        cwd: options.cwd,
        workspaceRef,
        ...(options.shellFileOperationTimeoutMs === undefined
          ? {}
          : { shellFileOperationTimeoutMs: options.shellFileOperationTimeoutMs }),
      });
      const cleanup = async () => {
        try {
          await options.cleanup?.({
            ...input,
            sandboxId,
            workspaceRef,
            env,
            client: workspaceClient,
          });
        } finally {
          leases.delete(key);
        }
      };
      const session = defineWorkspaceSessionLease({
        identity: { scope: input.scope, runId: input.runId, workspaceRef },
        env,
        ...(input.repo === undefined ? {} : { repo: input.repo }),
        ...(input.permissions === undefined ? {} : { permissions: input.permissions }),
        ...(input.resourceLimits === undefined ? {} : { resourceLimits: input.resourceLimits }),
        ...(input.artifactReadback === undefined
          ? {}
          : { artifactReadback: input.artifactReadback }),
        cleanup,
      });
      const lease = {
        sandboxId,
        workspaceRef,
        env,
        session,
        cleanup,
      };
      leases.set(key, lease);
      return lease;
    },
  };
};
