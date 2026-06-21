import type { LedgerEventRpc } from "@agent-os/core/types";
import type { WorkspaceJobObservabilityProjection } from "@agent-os/runtime";
import {
  createCloudflareLedgerAgUiHistorySseResponse,
  createCloudflareLedgerAgUiSseResponse,
} from "./ag-ui-sse";
import {
  createCloudflareWorkspaceJobResponse,
  type CloudflareWorkspaceJobProjectionReader,
  type CloudflareWorkspaceJobResponseOptions,
} from "./workspace-job-facade";
import type { CloudflareWorkspaceEnvResolver } from "./workspace-env";
import {
  installCloudflareWorkspaceOperationProvider,
  type CloudflareWorkspaceOperationEnvResolverInput,
  type CloudflareWorkspaceOperationInstall,
  type InstallCloudflareWorkspaceOperationProviderOptions,
} from "./workspace-op";

export interface CloudflareWorkspaceJobObservabilityProjectionReader extends CloudflareWorkspaceJobProjectionReader<WorkspaceJobObservabilityProjection> {}

export type CloudflareWorkspaceJobProfileResponseOptions = Omit<
  CloudflareWorkspaceJobResponseOptions<WorkspaceJobObservabilityProjection>,
  "readProjection"
> & {
  readonly readProjection?: CloudflareWorkspaceJobObservabilityProjectionReader["readProjection"];
};

export interface InstallCloudflareWorkspaceJobProfileOptions extends CloudflareWorkspaceJobObservabilityProjectionReader {
  readonly workspaceResolver: CloudflareWorkspaceEnvResolver;
  readonly workspaceOperation?: Omit<InstallCloudflareWorkspaceOperationProviderOptions, "env">;
  readonly scopeForWorkspaceOperation?: (
    input: CloudflareWorkspaceOperationEnvResolverInput,
  ) => string;
}

export interface CloudflareWorkspaceJobProfile {
  readonly workspaceResolver: CloudflareWorkspaceEnvResolver;
  readonly readProjection: CloudflareWorkspaceJobObservabilityProjectionReader["readProjection"];
  readonly workspaceOperations: CloudflareWorkspaceOperationInstall;
  readonly createWorkspaceJobResponse: (
    options: CloudflareWorkspaceJobProfileResponseOptions,
  ) => Promise<Response>;
  readonly createAgUiSseResponse: typeof createCloudflareLedgerAgUiSseResponse;
  readonly createAgUiHistorySseResponse: typeof createCloudflareLedgerAgUiHistorySseResponse;
}

export class CloudflareWorkspaceJobProfileError extends Error {
  override readonly name = "CloudflareWorkspaceJobProfileError";
}

const defaultScopeForWorkspaceOperation = (input: {
  readonly event: Pick<LedgerEventRpc, "scopeRef">;
}): string => input.event.scopeRef.scopeId;

/**
 * Installs the Cloudflare workspace-job consumer profile.
 *
 * The profile is a thin composition surface: workspace leases come from the
 * supplied resolver, workspace-op provider glue is the existing installer,
 * AG-UI responses are the existing SSE helpers, and job responses read the
 * runtime-owned observability projection. It does not parse workspace-job
 * facts or own failure classification.
 *
 * @agentosPrimitive primitive.cloudflare-do.installCloudflareWorkspaceJobProfile
 * @agentosInvariant invariant.workspace-job.failure-observability-join
 * @agentosDocs docs/packages/backend-cloudflare-do.md
 * @public
 */
export const installCloudflareWorkspaceJobProfile = (
  options: InstallCloudflareWorkspaceJobProfileOptions,
): CloudflareWorkspaceJobProfile => {
  const workspaceOperations = installCloudflareWorkspaceOperationProvider({
    ...options.workspaceOperation,
    env: (input) => {
      if (input.runId === undefined) {
        return Promise.reject(
          new CloudflareWorkspaceJobProfileError(
            "Cloudflare workspace-job profile requires workspace-op events to carry a run id",
          ),
        );
      }
      return options.workspaceResolver
        .resolve({
          scope:
            options.scopeForWorkspaceOperation?.(input) ?? defaultScopeForWorkspaceOperation(input),
          runId: input.runId,
        })
        .then((lease) => lease.env);
    },
  });

  return {
    workspaceResolver: options.workspaceResolver,
    readProjection: options.readProjection,
    workspaceOperations,
    createWorkspaceJobResponse: (responseOptions) => {
      const { readProjection, ...rest } = responseOptions;
      return createCloudflareWorkspaceJobResponse<WorkspaceJobObservabilityProjection>({
        ...rest,
        readProjection: readProjection ?? options.readProjection,
      });
    },
    createAgUiSseResponse: createCloudflareLedgerAgUiSseResponse,
    createAgUiHistorySseResponse: createCloudflareLedgerAgUiHistorySseResponse,
  };
};
