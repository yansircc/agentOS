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

export interface CloudflareWorkspaceIdentityInput {
  readonly scope: string;
}

export interface CloudflareWorkspaceLeaseIdentity extends CloudflareWorkspaceIdentityInput {
  readonly runId: string;
}

export interface CloudflareWorkspaceEnvBinding {
  readonly getSandbox: (
    sandboxId: string,
    input: CloudflareWorkspaceIdentityInput,
  ) => CloudflareWorkspaceEnvClient | Promise<CloudflareWorkspaceEnvClient>;
}

export interface CloudflareWorkspaceEnvResolverOptions {
  readonly binding: CloudflareWorkspaceEnvBinding;
  readonly cwd?: string;
  readonly shellFileOperationTimeoutMs?: CloudflareWorkspaceEnvOptions["shellFileOperationTimeoutMs"];
  readonly sandboxId?: (input: CloudflareWorkspaceIdentityInput) => string;
  readonly workspaceRef?: (input: CloudflareWorkspaceIdentityInput) => string;
  readonly cleanup?: (input: CloudflareWorkspaceLeaseIdentity) => void | Promise<void>;
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
  readonly workspaceRef?: (input: CloudflareWorkspaceIdentityInput) => string;
  readonly cleanup?: (input: CloudflareWorkspaceLeaseIdentity) => void | Promise<void>;
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

const defaultSandboxId = (input: CloudflareWorkspaceIdentityInput): string =>
  `workspace-job:${input.scope}`;

const defaultWorkspaceRef = (input: CloudflareWorkspaceIdentityInput): string =>
  `cloudflare-sandbox:${input.scope}`;

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
  input: CloudflareWorkspaceIdentityInput,
  scopePrefix: string | undefined,
): string => {
  const source = [scopePrefix ?? "", input.scope].join(":");
  const suffix = hashBase36(source);
  const parts = [labelPart(scopePrefix ?? ""), "wj", labelPart(input.scope)].filter(
    (part) => part.length > 0,
  );
  const base = parts.join("-");
  const maxBaseLength = 63 - suffix.length - 1;
  const boundedBase = (base.length === 0 ? "wj" : base).slice(0, maxBaseLength).replace(/-+$/g, "");
  return `${boundedBase.length === 0 ? "wj" : boundedBase}-${suffix}`;
};

const scopedWorkspaceRef = (
  input: CloudflareWorkspaceIdentityInput,
  scopePrefix: string | undefined,
): string => {
  const prefix = scopePrefix === undefined || scopePrefix.length === 0 ? "" : `${scopePrefix}:`;
  return `${prefix}${defaultWorkspaceRef(input)}`;
};

const workspaceScope = (
  input: CloudflareWorkspaceEnvResolverInput,
): CloudflareWorkspaceIdentityInput => {
  if (input.scope.trim().length === 0) {
    throw new CloudflareWorkspaceEnvResolverError("Cloudflare workspace scope must be non-empty");
  }
  return { scope: input.scope };
};

const runLeaseKey = (input: CloudflareWorkspaceEnvResolverInput): string => {
  if (input.runId.trim().length === 0) {
    throw new CloudflareWorkspaceEnvResolverError("Cloudflare workspace runId must be non-empty");
  }
  return `${input.scope}\u0000${input.runId}`;
};

const runLeaseIdentity = (
  input: CloudflareWorkspaceEnvResolverInput,
): CloudflareWorkspaceLeaseIdentity => ({ scope: input.scope, runId: input.runId });

interface CloudflareWorkspaceResource {
  readonly sandboxId: string;
  readonly workspaceRef: string;
  readonly env: WorkspaceEnv;
}

const resolveWorkspaceResource = async (
  resources: Map<string, Promise<CloudflareWorkspaceResource>>,
  scope: CloudflareWorkspaceIdentityInput,
  create: () => Promise<CloudflareWorkspaceResource>,
): Promise<CloudflareWorkspaceResource> => {
  const existing = resources.get(scope.scope);
  if (existing !== undefined) return existing;
  const pending = create();
  resources.set(scope.scope, pending);
  try {
    return await pending;
  } catch (error) {
    resources.delete(scope.scope);
    throw error;
  }
};

const resolveRunLease = async (
  leases: Map<string, Promise<CloudflareWorkspaceEnvLease>>,
  key: string,
  create: () => Promise<CloudflareWorkspaceEnvLease>,
): Promise<CloudflareWorkspaceEnvLease> => {
  const existing = leases.get(key);
  if (existing !== undefined) return existing;
  const pending = create();
  leases.set(key, pending);
  try {
    return await pending;
  } catch (error) {
    leases.delete(key);
    throw error;
  }
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

const defineCloudflareWorkspaceLease = (
  resource: CloudflareWorkspaceResource,
  input: CloudflareWorkspaceEnvResolverInput,
  cleanup: () => Promise<void>,
): CloudflareWorkspaceEnvLease => ({
  ...resource,
  session: defineWorkspaceSessionLease({
    identity: {
      scope: input.scope,
      runId: input.runId,
      workspaceRef: resource.workspaceRef,
    },
    env: resource.env,
    ...(input.repo === undefined ? {} : { repo: input.repo }),
    ...(input.permissions === undefined ? {} : { permissions: input.permissions }),
    ...(input.resourceLimits === undefined ? {} : { resourceLimits: input.resourceLimits }),
    ...(input.artifactReadback === undefined ? {} : { artifactReadback: input.artifactReadback }),
    cleanup,
  }),
  cleanup,
});

/**
 * Resolves a scope-owned Cloudflare Sandbox workspace into a run lease.
 *
 * Authenticated scope is the sole persistent workspace identity. Runtime-owned
 * run id selects only a transient lease over that shared WorkspaceEnv.
 *
 * @agentosPrimitive primitive.cloudflare-do.createCloudflareWorkspaceEnvResolver
 * @agentosInvariant invariant.workspace-job.host-workspace-lifecycle
 * @agentosDocs docs/packages/runtime.md
 * @public
 */
export const createCloudflareWorkspaceEnvResolver = (
  options: CloudflareWorkspaceEnvResolverOptions,
): CloudflareWorkspaceEnvResolver => {
  const resources = new Map<string, Promise<CloudflareWorkspaceResource>>();
  const leases = new Map<string, Promise<CloudflareWorkspaceEnvLease>>();
  return {
    resolve: async (input) => {
      const scope = workspaceScope(input);
      const key = runLeaseKey(input);
      return resolveRunLease(leases, key, async () => {
        const resource = await resolveWorkspaceResource(resources, scope, async () => {
          const sandboxId = options.sandboxId?.(scope) ?? defaultSandboxId(scope);
          const workspaceRef = options.workspaceRef?.(scope) ?? defaultWorkspaceRef(scope);
          const client = await options.binding.getSandbox(sandboxId, scope);
          validateClient(client);
          const env = makeCloudflareWorkspaceEnv({
            client,
            cwd: options.cwd,
            workspaceRef,
            ...(options.shellFileOperationTimeoutMs === undefined
              ? {}
              : { shellFileOperationTimeoutMs: options.shellFileOperationTimeoutMs }),
          });
          return { sandboxId, workspaceRef, env };
        });
        const cleanup = async () => {
          try {
            await options.cleanup?.(runLeaseIdentity(input));
          } finally {
            leases.delete(key);
          }
        };
        return defineCloudflareWorkspaceLease(resource, input, cleanup);
      });
    },
  };
};

/**
 * Resolves a scope-owned Cloudflare Sandbox binding into a run lease.
 *
 * This high-level host helper owns the Sandbox binding composition: products
 * choose the Durable Object namespace, while agentOS fixes
 * `scope -> sandbox resource`, validates the binding/client shape, disables
 * implicit default sessions, and pins one transport per workspace. The lower-level
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
  const resources = new Map<string, Promise<CloudflareWorkspaceResource>>();
  const leases = new Map<string, Promise<CloudflareWorkspaceEnvLease>>();
  return {
    resolve: async (input) => {
      const scope = workspaceScope(input);
      const key = runLeaseKey(input);
      return resolveRunLease(leases, key, async () => {
        const resource = await resolveWorkspaceResource(resources, scope, async () => {
          const sandboxId = scopedSandboxId(scope, options.scopePrefix);
          const workspaceRef =
            options.workspaceRef?.(scope) ?? scopedWorkspaceRef(scope, options.scopePrefix);
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
          return { sandboxId, workspaceRef, env };
        });
        const cleanup = async () => {
          try {
            await options.cleanup?.(runLeaseIdentity(input));
          } finally {
            leases.delete(key);
          }
        };
        return defineCloudflareWorkspaceLease(resource, input, cleanup);
      });
    },
  };
};
