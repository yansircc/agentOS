import { Option } from "effect";
import { CapabilityRejected, type EventHandler, type LedgerEventRpc } from "@agent-os/kernel";
import type { ExtensionCapability, ExtensionDeclaration } from "@agent-os/kernel/extensions";
import {
  WORKSPACE_OP_FACT_OWNER,
  WORKSPACE_OP_KIND,
  workspaceOpBoundaryPackage,
  type WorkspaceOperationRequestedPayload,
} from "@agent-os/workspace-op";
import {
  createWorkspaceOperationLocalProvider,
  type CreateWorkspaceOperationLocalProviderOptions,
  type WorkspaceOperationLocalProvider,
} from "@agent-os/workspace-op-local";

export interface CloudflareWorkspaceOperationInstallContext {
  readonly capabilities: ReadonlyMap<string, ExtensionCapability>;
}

export interface CloudflareWorkspaceOperationProviderHandlers {
  readonly eventHandlers: (
    context: CloudflareWorkspaceOperationInstallContext,
  ) => Iterable<{ readonly kind: string; readonly handler: EventHandler }>;
}

export interface CloudflareWorkspaceOperationInstall {
  readonly extensions: ReadonlyArray<ExtensionDeclaration>;
  readonly declaredIntents: ReadonlyArray<{
    readonly kind: string;
    readonly boundaryPackageId: string;
  }>;
  readonly eventHandlers: CloudflareWorkspaceOperationProviderHandlers["eventHandlers"];
}

type WorkspaceEnv = CreateWorkspaceOperationLocalProviderOptions["env"];

export interface CloudflareWorkspaceOperationEnvResolverInput {
  readonly event: LedgerEventRpc;
  readonly payload: WorkspaceOperationRequestedPayload;
  readonly workspaceRef: string;
  readonly runId?: string;
}

export type CloudflareWorkspaceOperationEnvResolver = (
  input: CloudflareWorkspaceOperationEnvResolverInput,
) => WorkspaceEnv | Promise<WorkspaceEnv>;

export type InstallCloudflareWorkspaceOperationProviderOptions = Omit<
  CreateWorkspaceOperationLocalProviderOptions,
  "env"
> & {
  readonly env: WorkspaceEnv | CloudflareWorkspaceOperationEnvResolver;
  readonly boundaryVersion?: string;
};

const DEFAULT_WORKSPACE_OP_BOUNDARY_VERSION = "0.2.9";

const requestedPayload = (event: LedgerEventRpc): WorkspaceOperationRequestedPayload | null =>
  event.kind === WORKSPACE_OP_KIND.REQUESTED &&
  event.factOwnerRef === WORKSPACE_OP_FACT_OWNER &&
  event.payload !== null &&
  typeof event.payload === "object"
    ? (event.payload as WorkspaceOperationRequestedPayload)
    : null;

const workspaceOpCapability = (
  capabilities: ReadonlyMap<string, ExtensionCapability>,
): ExtensionCapability => {
  const capability = capabilities.get(WORKSPACE_OP_FACT_OWNER);
  return Option.getOrThrowWith(
    Option.fromNullable(capability),
    () =>
      new CapabilityRejected({
        event: WORKSPACE_OP_KIND.COMPLETED,
        capability: `extension:${WORKSPACE_OP_FACT_OWNER}`,
      }),
  );
};

const runIdFromRequest = (request: WorkspaceOperationRequestedPayload): string | undefined => {
  const origin = request.claim.originRef;
  if (origin.originKind !== "submit" && origin.originKind !== "run") return undefined;
  return origin.originId.startsWith("run:") ? origin.originId.slice(4) : origin.originId;
};

const isEnvResolver = (
  env: InstallCloudflareWorkspaceOperationProviderOptions["env"],
): env is CloudflareWorkspaceOperationEnvResolver => typeof env === "function";

const providerOptions = (
  options: InstallCloudflareWorkspaceOperationProviderOptions,
  env: WorkspaceEnv,
): CreateWorkspaceOperationLocalProviderOptions => ({
  env,
  ...(options.maxFileBytes === undefined ? {} : { maxFileBytes: options.maxFileBytes }),
  ...(options.maxCommandChars === undefined ? {} : { maxCommandChars: options.maxCommandChars }),
  ...(options.execTimeoutMs === undefined ? {} : { execTimeoutMs: options.execTimeoutMs }),
  ...(options.maxOutputBytes === undefined ? {} : { maxOutputBytes: options.maxOutputBytes }),
});

/**
 * Installs workspace-op provider glue for Cloudflare DO hosts.
 *
 * Products still declare the WorkspaceEnv and tool exposure policy. This
 * helper owns the host-side reducer/provider commit loop: requested facts are
 * executed by the local provider and completed/rejected facts are committed
 * only through the workspace-op boundary capability.
 *
 * @agentosPrimitive primitive.cloudflare-do.installCloudflareWorkspaceOperationProvider
 * @agentosInvariant invariant.workspace-op.carrier-single-writer
 * @agentosDocs docs/packages/backend-cloudflare-do.md
 * @public
 */
export const installCloudflareWorkspaceOperationProvider = (
  options: InstallCloudflareWorkspaceOperationProviderOptions,
): CloudflareWorkspaceOperationInstall => {
  const boundaryPackage = workspaceOpBoundaryPackage(
    options.boundaryVersion ?? DEFAULT_WORKSPACE_OP_BOUNDARY_VERSION,
  );
  const providers = new Map<string, WorkspaceOperationLocalProvider>();
  const providerFor = async (
    event: LedgerEventRpc,
    payload: WorkspaceOperationRequestedPayload,
  ): Promise<WorkspaceOperationLocalProvider> => {
    const runId = runIdFromRequest(payload);
    const key = `${payload.workspaceRef}\u0000${runId ?? ""}`;
    const existing = providers.get(key);
    if (existing !== undefined) return existing;
    const env = isEnvResolver(options.env)
      ? await options.env({
          event,
          payload,
          workspaceRef: payload.workspaceRef,
          ...(runId === undefined ? {} : { runId }),
        })
      : options.env;
    const provider = createWorkspaceOperationLocalProvider(providerOptions(options, env));
    providers.set(key, provider);
    return provider;
  };
  return {
    extensions: [boundaryPackage],
    declaredIntents: [
      {
        kind: WORKSPACE_OP_KIND.REQUESTED,
        boundaryPackageId: boundaryPackage.packageId,
      },
    ],
    eventHandlers: (context) => [
      {
        kind: WORKSPACE_OP_KIND.REQUESTED,
        handler: async (event) => {
          const request = requestedPayload(event);
          if (request === null) return;
          const provider = await providerFor(event, request);
          const result = await provider.execute({ id: event.id, payload: request });
          const capability = workspaceOpCapability(context.capabilities);
          await capability.commit({
            event: result.ok ? WORKSPACE_OP_KIND.COMPLETED : WORKSPACE_OP_KIND.REJECTED,
            data: result.payload,
          });
        },
      },
    ],
  };
};
