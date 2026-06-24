import type { EventHandler } from "@agent-os/core";
import type { ExtensionDeclaration } from "@agent-os/core/extensions";
import type { AnyMaterializedProjectionDefinition } from "@agent-os/runtime";
import {
  createWorkspaceOperationInstall,
  type WorkspaceOperationInstallContext,
  type WorkspaceOperationsOptions,
} from "../capability/workspace-operations";

export interface CloudflareWorkspaceOperationInstallContext {
  readonly capabilities: WorkspaceOperationInstallContext["capabilities"];
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
    readonly boundaryOwnerId: string;
  }>;
  readonly projections: ReadonlyArray<AnyMaterializedProjectionDefinition>;
  readonly eventHandlers: CloudflareWorkspaceOperationProviderHandlers["eventHandlers"];
}

export type InstallCloudflareWorkspaceOperationProviderOptions = WorkspaceOperationsOptions;

// Cloudflare adapter names keep the subpath API anchored to the host boundary.
export type {
  WorkspaceOperationEnvResolverInput as CloudflareWorkspaceOperationEnvResolverInput,
  WorkspaceOperationEnvResolver as CloudflareWorkspaceOperationEnvResolver,
} from "../capability/workspace-operations";

/**
 * Installs workspace-op provider glue for Cloudflare DO hosts.
 *
 * This adapter keeps existing Cloudflare generated targets on the same
 * workspace-op install algebra as the host-neutral capability.
 *
 * @agentosPrimitive primitive.cloudflare-do.installCloudflareWorkspaceOperationProvider
 * @agentosInvariant invariant.workspace-op.carrier-single-writer
 * @agentosDocs docs/packages/runtime.md
 * @public
 */
export const installCloudflareWorkspaceOperationProvider = (
  options: InstallCloudflareWorkspaceOperationProviderOptions,
): CloudflareWorkspaceOperationInstall => {
  const install = createWorkspaceOperationInstall(options);
  return {
    extensions: install.extensions,
    declaredIntents: install.declaredIntents,
    projections: install.projections,
    eventHandlers: (context) => install.eventHandlers(context),
  };
};
